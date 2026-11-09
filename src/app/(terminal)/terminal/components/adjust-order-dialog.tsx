/**
 * Refund / void / comp dialog for one order (the till).
 *
 *  - Refund: chosen items (with quantities) or an amount, plus an optional TIP
 *    refund (kept separate and flagged), back to a chosen tender or
 *    automatically (card first, then cash). The preview uses the same math as
 *    the server (`src/lib/adjustments/math.ts`).
 *  - Void: items (some units or all) or the whole order. A paid order can only
 *    be voided whole, which refunds it.
 *  - Comp / discount: comp an item, or discount the order by $ or %. Applied
 *    comps/discounts can be removed.
 *
 * A reason is always required. When the server answers `approval_required`
 * (above the location threshold) the dialog asks for an owner/manager PIN and
 * resends the SAME request id, so a retry can never apply the action twice.
 */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, ShieldCheck, X } from "lucide-react";
import type { AdjustmentKind, AdjustmentPolicy, AdjustmentRecord, Order, Payment } from "@/lib/db";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { formatMoney } from "@/lib/pricing";
import { reasonOptions } from "@/lib/adjustments/reasons";
import {
  currentAdjustments,
  lineRefundAmounts,
  refundableTotals,
  refundedQuantities,
} from "@/lib/adjustments/math";
import { refundableParts } from "@/lib/payments/refund-state";
import { isDefiniteRefusal } from "@/lib/adjustments/retry";
import { tenderRailLabel } from "@/lib/payments/registry";
import type { AdjustAction, AdjustResponse } from "@/lib/store/use-checkout";
import { cn } from "@/lib/utils";

export type AdjustMode = "refund" | "void" | "comp";

function newRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `adj-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function centsFrom(v: string): number {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
}

interface ManagerOption {
  id: string;
  name: string;
  role: string;
}

export function AdjustOrderDialog({
  mode,
  order,
  payments,
  records,
  policy,
  currency,
  busy,
  onSubmit,
  onClose,
}: {
  mode: AdjustMode;
  order: Order;
  payments: Payment[];
  records: AdjustmentRecord[];
  policy: AdjustmentPolicy | null;
  currency: string;
  busy: boolean;
  onSubmit: (action: AdjustAction, body: Record<string, unknown>) => Promise<AdjustResponse>;
  onClose: () => void;
}) {
  const paid = payments.some(
    (p) =>
      (p.status === "captured" || p.status === "authorized") &&
      p.amount_cents + p.tip_cents > p.refunded_cents,
  );
  // One request id per action attempt: reused on retry / approval resend.
  const requestId = useRef(newRequestId());

  // ---- shared: reason + approval -----------------------------------------
  const [sub, setSub] = useState<"items" | "amount" | "whole" | "comp" | "discount">(
    mode === "refund" ? "items" : mode === "void" ? (paid ? "whole" : "items") : "comp",
  );
  const reasonKind: AdjustmentKind =
    mode === "refund"
      ? "refund"
      : mode === "void"
        ? sub === "whole"
          ? "void_order"
          : "void_line"
        : sub === "discount"
          ? "discount"
          : "comp";
  const reasons = reasonOptions(reasonKind);
  const [reasonCode, setReasonCode] = useState("");
  const [reasonText, setReasonText] = useState("");
  const [needApproval, setNeedApproval] = useState(false);
  const [managers, setManagers] = useState<ManagerOption[]>([]);
  const [approverId, setApproverId] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!needApproval || managers.length > 0) return;
    void (async () => {
      try {
        const res = await fetch(`/api/terminal/pin?tenantId=${encodeURIComponent(order.tenant_id)}`);
        if (!res.ok) return;
        const { staff } = (await res.json()) as { staff: ManagerOption[] };
        setManagers(staff.filter((s) => s.role === "owner" || s.role === "manager"));
      } catch {
        // offline: the PIN field stays empty and the submit fails loudly
      }
    })();
  }, [needApproval, managers.length, order.tenant_id]);

  // ---- lines ---------------------------------------------------------------
  const live = order.items.filter((i) => !i.voided);
  const refundedQty = useMemo(() => refundedQuantities(records), [records]);
  const [qty, setQty] = useState<Record<string, number>>({});
  const setLineQty = (id: string, n: number) => setQty((q) => ({ ...q, [id]: Math.max(0, n) }));
  const maxQty = (lineId: string, quantity: number) =>
    mode === "refund" ? Math.max(0, quantity - (refundedQty.get(lineId) ?? 0)) : quantity;
  const selected = live
    .map((l) => ({ line_id: l.id, quantity: qty[l.id] ?? 0 }))
    .filter((s) => s.quantity > 0);

  // ---- refund amounts --------------------------------------------------------
  const left = useMemo(() => refundableTotals(payments), [payments]);
  const [amount, setAmount] = useState("");
  const [tipOn, setTipOn] = useState(false);
  const [tipAmount, setTipAmount] = useState("");
  const [tender, setTender] = useState<string>("");
  const refundTenders = payments.filter((p) => {
    const l = refundableParts(p);
    return p.rail !== "external" && l.baseCents + l.tipCents > 0;
  });
  let previewBase = 0;
  let previewError: string | null = null;
  if (mode === "refund" && sub === "items" && selected.length) {
    try {
      previewBase = lineRefundAmounts(order, selected, refundedQty).reduce(
        (n, l) => n + l.amount_cents,
        0,
      );
    } catch (e) {
      previewError = e instanceof Error ? e.message : "Invalid selection.";
    }
  } else if (mode === "refund" && sub === "amount") {
    previewBase = centsFrom(amount);
  }
  const previewTip = mode === "refund" && tipOn ? centsFrom(tipAmount) : 0;

  // ---- comp / discount -------------------------------------------------------
  const [compLine, setCompLine] = useState(live[0]?.id ?? "");
  const [compQty, setCompQty] = useState(1);
  const [discKind, setDiscKind] = useState<"amount" | "percent">("percent");
  const [discValue, setDiscValue] = useState("");
  const applied = currentAdjustments(order);

  const threshold =
    policy &&
    (mode === "refund"
      ? policy.refund_approval_cents
      : mode === "void"
        ? policy.void_approval_cents
        : policy.comp_approval_cents);

  function buildBody(): { action: AdjustAction; body: Record<string, unknown> } | string {
    if (!reasonCode) return "Pick a reason.";
    if (reasonCode === "other" && !reasonText.trim()) return "Describe the reason.";
    const base: Record<string, unknown> = {
      requestId: requestId.current,
      reasonCode,
      reasonText: reasonText.trim() || undefined,
      ...(needApproval ? { approval: { staffId: approverId, pin } } : {}),
    };
    if (mode === "refund") {
      if (sub === "items" && selected.length === 0) return "Choose the items to refund.";
      if (previewError) return previewError;
      if (previewBase + previewTip <= 0) return "Nothing to refund.";
      return {
        action: "refund",
        body: {
          ...base,
          ...(sub === "items"
            ? { lines: selected.map((s) => ({ lineId: s.line_id, quantity: s.quantity })) }
            : { amountCents: previewBase }),
          ...(previewTip > 0 ? { tipCents: previewTip } : {}),
          ...(tender ? { paymentId: tender } : {}),
        },
      };
    }
    if (mode === "void") {
      if (sub === "whole") return { action: "void", body: { ...base, wholeOrder: true } };
      if (selected.length === 0) return "Choose the items to void.";
      return {
        action: "void",
        body: {
          ...base,
          lines: selected.map((s) => ({ lineId: s.line_id, quantity: s.quantity })),
        },
      };
    }
    if (sub === "comp") {
      if (!compLine) return "Choose the item to comp.";
      return {
        action: "discount",
        body: { ...base, type: "comp", lineId: compLine, quantity: compQty },
      };
    }
    const v = discKind === "percent" ? Math.round(parseFloat(discValue) * 100) : centsFrom(discValue);
    if (!Number.isFinite(v) || v <= 0) return "Enter the discount.";
    return {
      action: "discount",
      body: {
        ...base,
        type: "discount",
        ...(discKind === "percent" ? { percentBps: Math.min(10_000, v) } : { amountCents: v }),
      },
    };
  }

  async function submit(override?: { action: AdjustAction; body: Record<string, unknown> }) {
    setError(null);
    const built = override ?? buildBody();
    if (typeof built === "string") {
      setError(built);
      return;
    }
    if (needApproval && !override && (!approverId || !/^[0-9]{4,8}$/.test(pin))) {
      setError("Pick the approving manager and enter their PIN.");
      return;
    }
    const res = await onSubmit(built.action, built.body);
    if (res.code === "approval_required") {
      setNeedApproval(true);
      setError("Above your limit: a manager must approve.");
      return;
    }
    if (res.code === "approval_pin_incorrect" || res.code === "approval_locked") {
      setPin("");
      setError(res.error ?? "Manager PIN incorrect.");
      return;
    }
    if (!res.ok) {
      // Only a DEFINITE refusal (a 4xx: use_refund, exceeds, reason, ...) did
      // nothing, so only then does the next attempt get a new request id. A lost
      // response (offline, status 0), a 5xx, a timeout or a partial / pending
      // refund may have moved money: the retry MUST reuse the same id so the
      // server resumes it instead of refunding again.
      if (isDefiniteRefusal(res)) requestId.current = newRequestId();
      setError(res.error ?? "That didn't go through.");
      return;
    }
    requestId.current = newRequestId();
    setDone(res.note ?? "Done.");
  }

  async function removeAdjustment(id: string) {
    setError(null);
    const res = await onSubmit("discount", {
      requestId: newRequestId(),
      reasonCode: "manager_discretion",
      type: "discount",
      removeId: id,
    });
    if (!res.ok) setError(res.error ?? "Couldn't remove it.");
  }

  const title =
    mode === "refund" ? "Refund" : mode === "void" ? "Void" : "Comp / discount";
  const tabs: { id: typeof sub; label: string; disabled?: boolean }[] =
    mode === "refund"
      ? [
          { id: "items", label: "Items" },
          { id: "amount", label: "Amount" },
        ]
      : mode === "void"
        ? [
            { id: "items", label: "Items", disabled: paid },
            { id: "whole", label: "Whole order" },
          ]
        : [
            { id: "comp", label: "Comp item" },
            { id: "discount", label: "Discount order" },
          ];

  return (
    <Dialog onClose={onClose} labelledBy="adjust-title" closeOnBackdrop={false}>
      <div className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-background shadow-xl">
        <div className="flex items-center justify-between border-b p-4">
          <div>
            <h2 id="adjust-title" className="text-lg font-bold">
              {title} · order {order.order_number}
            </h2>
            {threshold !== null && threshold !== undefined && (
              <p className="text-xs text-muted-foreground">
                {threshold === 0
                  ? "Needs an owner or manager."
                  : `A manager approves above ${formatMoney(threshold, currency)}.`}
              </p>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-11"
            aria-label={`Close ${title.toLowerCase()}`}
            onClick={onClose}
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {done ? (
            <div role="status" className="rounded-md border border-emerald-600/50 bg-emerald-600/10 p-3 text-sm">
              {done}
            </div>
          ) : (
            <>
              <div className="flex gap-2" role="tablist">
                {tabs.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={sub === t.id}
                    disabled={t.disabled}
                    onClick={() => {
                      setSub(t.id);
                      setReasonCode("");
                    }}
                    className={cn(
                      "h-11 flex-1 rounded-md border text-sm font-semibold disabled:opacity-40",
                      sub === t.id && "border-primary bg-primary/10 ring-2 ring-primary",
                    )}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              {mode === "void" && paid && (
                <p className="rounded-md border border-amber-500/60 bg-amber-500/10 p-2 text-sm">
                  This order is paid: voiding it refunds everything (refund single items with Refund).
                </p>
              )}

              {/* Line pickers (refund items / void items) */}
              {((mode === "refund" && sub === "items") || (mode === "void" && sub === "items")) && (
                <ul className="space-y-2" aria-label="Items">
                  {live.map((l) => {
                    const max = maxQty(l.id, l.quantity);
                    const n = qty[l.id] ?? 0;
                    return (
                      <li key={l.id} className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm">
                        <span className="min-w-0">
                          <span className="font-medium">
                            {l.quantity}× {l.item_name}
                            {l.size_name ? ` · ${l.size_name}` : ""}
                          </span>
                          {mode === "refund" && max < l.quantity && (
                            <span className="ml-1 text-xs text-muted-foreground">
                              ({l.quantity - max} refunded)
                            </span>
                          )}
                        </span>
                        <span className="flex items-center gap-1">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-9 w-9"
                            aria-label={`Fewer ${l.item_name}`}
                            disabled={n <= 0}
                            onClick={() => setLineQty(l.id, n - 1)}
                          >
                            −
                          </Button>
                          <span className="w-6 text-center tabular-nums" aria-label={`${l.item_name} selected`}>
                            {n}
                          </span>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-9 w-9"
                            aria-label={`More ${l.item_name}`}
                            disabled={n >= max}
                            onClick={() => setLineQty(l.id, n + 1)}
                          >
                            +
                          </Button>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}

              {mode === "refund" && sub === "amount" && (
                <label className="block text-sm">
                  <span className="text-muted-foreground">
                    Amount (up to {formatMoney(left.baseCents, currency)})
                  </span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="mt-1 h-11 w-full rounded-md border bg-background px-3 text-right"
                  />
                </label>
              )}

              {mode === "refund" && left.tipCents > 0 && (
                <div className="space-y-2 rounded-md border border-amber-500/40 p-2 text-sm">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={tipOn} onChange={(e) => setTipOn(e.target.checked)} />
                    Also refund tip (up to {formatMoney(left.tipCents, currency)})
                  </label>
                  {tipOn && (
                    <>
                      <input
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step="0.01"
                        aria-label="Tip refund amount"
                        value={tipAmount}
                        onChange={(e) => setTipAmount(e.target.value)}
                        className="h-11 w-full rounded-md border bg-background px-3 text-right"
                      />
                      <p className="text-xs text-amber-700">
                        Tip refunds are recorded separately and flagged for review.
                      </p>
                    </>
                  )}
                </div>
              )}

              {mode === "refund" && refundTenders.length > 1 && (
                <label className="block text-sm">
                  <span className="text-muted-foreground">Refund to</span>
                  <select
                    value={tender}
                    onChange={(e) => setTender(e.target.value)}
                    className="mt-1 h-11 w-full rounded-md border bg-background px-2"
                  >
                    <option value="">Automatic (card first, then cash)</option>
                    {refundTenders.map((p) => {
                      const l = refundableParts(p);
                      return (
                        <option key={p.id} value={p.id}>
                          {tenderRailLabel(p.rail)} · {formatMoney(l.baseCents + l.tipCents, currency)} left
                        </option>
                      );
                    })}
                  </select>
                </label>
              )}

              {mode === "refund" && (previewBase > 0 || previewTip > 0) && (
                <div className="flex justify-between rounded-md bg-muted p-3 text-sm font-semibold">
                  <span>Refund</span>
                  <span>
                    {formatMoney(previewBase + previewTip, currency)}
                    {previewTip > 0 && (
                      <span className="ml-1 text-xs font-normal text-amber-700">
                        (incl. {formatMoney(previewTip, currency)} tip)
                      </span>
                    )}
                  </span>
                </div>
              )}

              {mode === "comp" && sub === "comp" && (
                <div className="flex gap-2">
                  <select
                    aria-label="Item to comp"
                    value={compLine}
                    onChange={(e) => {
                      setCompLine(e.target.value);
                      setCompQty(1);
                    }}
                    className="h-11 flex-1 rounded-md border bg-background px-2 text-sm"
                  >
                    {live.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.quantity}× {l.item_name} · {formatMoney(l.unit_price_cents, currency)}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min={1}
                    max={live.find((l) => l.id === compLine)?.quantity ?? 1}
                    aria-label="Units to comp"
                    value={compQty}
                    onChange={(e) => setCompQty(Math.max(1, Math.round(Number(e.target.value) || 1)))}
                    className="h-11 w-20 rounded-md border bg-background px-2 text-right"
                  />
                </div>
              )}

              {mode === "comp" && sub === "discount" && (
                <div className="flex gap-2">
                  <select
                    aria-label="Discount type"
                    value={discKind}
                    onChange={(e) => setDiscKind(e.target.value as "amount" | "percent")}
                    className="h-11 rounded-md border bg-background px-2 text-sm"
                  >
                    <option value="percent">%</option>
                    <option value="amount">$</option>
                  </select>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step={discKind === "percent" ? "1" : "0.01"}
                    aria-label="Discount"
                    value={discValue}
                    onChange={(e) => setDiscValue(e.target.value)}
                    className="h-11 flex-1 rounded-md border bg-background px-3 text-right"
                  />
                </div>
              )}

              {mode === "comp" && applied.length > 0 && (
                <ul className="space-y-1 text-sm" aria-label="Applied comps and discounts">
                  {applied.map((a) => (
                    <li key={a.id} className="flex items-center justify-between gap-2">
                      <span>
                        {a.label} · −{formatMoney(a.amount_cents, currency)}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void removeAdjustment(a.id)}
                      >
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
              )}

              {/* Reason (required) */}
              <div className="space-y-2">
                <label className="block text-sm">
                  <span className="text-muted-foreground">Reason</span>
                  <select
                    aria-label="Reason"
                    value={reasonCode}
                    onChange={(e) => setReasonCode(e.target.value)}
                    className="mt-1 h-11 w-full rounded-md border bg-background px-2"
                    required
                  >
                    <option value="" disabled>
                      Pick a reason…
                    </option>
                    {reasons.map((r) => (
                      <option key={r.code} value={r.code}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </label>
                <input
                  type="text"
                  aria-label="Reason details"
                  placeholder={reasonCode === "other" ? "Describe the reason (required)" : "Details (optional)"}
                  maxLength={300}
                  value={reasonText}
                  onChange={(e) => setReasonText(e.target.value)}
                  className="h-11 w-full rounded-md border bg-background px-3 text-sm"
                />
              </div>

              {needApproval && (
                <div className="space-y-2 rounded-md border border-primary/50 p-3">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <ShieldCheck className="h-4 w-4" aria-hidden="true" /> Manager approval
                  </div>
                  <select
                    aria-label="Approving manager"
                    value={approverId}
                    onChange={(e) => setApproverId(e.target.value)}
                    className="h-11 w-full rounded-md border bg-background px-2 text-sm"
                  >
                    <option value="" disabled>
                      Manager…
                    </option>
                    {managers.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} ({m.role})
                      </option>
                    ))}
                  </select>
                  <input
                    type="password"
                    inputMode="numeric"
                    autoComplete="off"
                    aria-label="Manager PIN"
                    placeholder="PIN"
                    value={pin}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
                    className="h-11 w-full rounded-md border bg-background px-3 text-center tracking-widest"
                  />
                </div>
              )}

              {error && (
                <div role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-sm text-destructive">
                  {error}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex gap-2 border-t p-4">
          {done ? (
            <Button className="h-12 flex-1" onClick={onClose}>
              Close
            </Button>
          ) : (
            <>
              <Button variant="outline" className="h-12 flex-1" onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant={mode === "comp" ? "default" : "destructive"}
                className="h-12 flex-1"
                disabled={busy}
                onClick={() => void submit()}
              >
                {busy ? (
                  <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
                ) : needApproval ? (
                  "Approve & submit"
                ) : mode === "refund" ? (
                  "Refund"
                ) : mode === "void" ? (
                  "Void"
                ) : (
                  "Apply"
                )}
              </Button>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
