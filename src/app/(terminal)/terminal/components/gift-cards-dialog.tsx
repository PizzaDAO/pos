/**
 * Gift cards at the till: sell (generated code or a physical card number),
 * reload, check a balance, and issue store credit.
 *
 * Selling / reloading creates an order (no menu lines, no tax) and hands it to
 * the normal payment screen (`onTakePayment`): the card activates / is loaded
 * once that order is paid. A generated code is shown ONCE, here: write it on
 * the card or the receipt before closing. Store credit above the approval
 * threshold needs a manager switched in (the server enforces it).
 */
"use client";

import { useRef, useState } from "react";
import { Gift, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { formatMoney } from "@/lib/pricing";
import { cn } from "@/lib/utils";

type Tab = "sell" | "reload" | "balance" | "credit";

const TABS: { id: Tab; label: string }[] = [
  { id: "sell", label: "Sell" },
  { id: "reload", label: "Reload" },
  { id: "balance", label: "Balance" },
  { id: "credit", label: "Store credit" },
];

const PRESETS = [2500, 5000, 10000];

function toCents(v: string): number | null {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

interface AccountView {
  id: string;
  kind: "gift_card" | "store_credit";
  status: string;
  balance_cents: number;
  code_last4: string;
}

export function GiftCardsDialog({
  tenantId,
  locationId,
  currency,
  onTakePayment,
  onClose,
}: {
  tenantId: string;
  locationId: string;
  currency: string;
  /** Open the payment screen for a sale / reload order. */
  onTakePayment: (orderId: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("sell");
  const [amount, setAmount] = useState("");
  const [code, setCode] = useState("");
  const [physical, setPhysical] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState<AccountView | null>(null);
  /** A code shown once (generated sale / store credit). */
  const [shownCode, setShownCode] = useState<string | null>(null);
  const [saleOrderId, setSaleOrderId] = useState<string | null>(null);
  // Stable per attempt: a retry after a lost response is the same sale.
  const requestId = useRef(crypto.randomUUID());

  function reset(next: Tab) {
    setTab(next);
    setAmount("");
    setCode("");
    setReason("");
    setPhysical(false);
    setError(null);
    setAccount(null);
    setShownCode(null);
    setSaleOrderId(null);
    requestId.current = crypto.randomUUID();
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const cents = toCents(amount);

  const sell = () =>
    run(async () => {
      const out = await post<{ order: { id: string }; code: string | null; account: AccountView }>(
        "/api/gift-cards/sales",
        {
          tenantId,
          locationId,
          orderId: requestId.current,
          amountCents: cents,
          physicalCode: physical ? code : undefined,
        },
      );
      setAccount(out.account);
      setShownCode(out.code);
      setSaleOrderId(out.order.id);
    });

  const reload = () =>
    run(async () => {
      const out = await post<{ order: { id: string }; account: AccountView }>("/api/gift-cards/reloads", {
        tenantId,
        locationId,
        orderId: requestId.current,
        code,
        amountCents: cents,
      });
      onTakePayment(out.order.id);
    });

  const balance = () =>
    run(async () => {
      const out = await post<{ account: AccountView }>("/api/gift-cards/balance", { tenantId, code });
      setAccount(out.account);
    });

  const credit = () =>
    run(async () => {
      const out = await post<{ account: AccountView; code: string | null }>("/api/gift-cards/store-credit", {
        tenantId,
        locationId,
        accountId: requestId.current,
        amountCents: cents,
        reason,
      });
      setAccount(out.account);
      setShownCode(out.code);
    });

  const amountField = (
    <div className="space-y-2">
      <label htmlFor="gc-dialog-amount" className="block text-sm text-muted-foreground">
        Amount
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-lg text-muted-foreground">$</span>
        <input
          id="gc-dialog-amount"
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="h-12 w-32 rounded-md border bg-background px-3 text-right text-lg"
        />
        {tab !== "credit" &&
          PRESETS.map((p) => (
            <Button key={p} type="button" variant="outline" className="h-12" onClick={() => setAmount((p / 100).toFixed(2))}>
              {formatMoney(p, currency)}
            </Button>
          ))}
      </div>
    </div>
  );

  const codeField = (label: string) => (
    <div className="space-y-2">
      <label htmlFor="gc-dialog-code" className="block text-sm text-muted-foreground">
        {label}
      </label>
      <input
        id="gc-dialog-code"
        autoComplete="off"
        spellCheck={false}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="XXXX-XXXX-XXXX-XXXX"
        className="h-12 w-full rounded-md border bg-background px-3 font-mono text-lg uppercase tracking-wider"
      />
    </div>
  );

  return (
    <Dialog onClose={onClose} labelledBy="gift-cards-title">
      <div className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-y-auto rounded-2xl bg-background p-4 shadow-xl">
        <h2 id="gift-cards-title" className="mb-3 flex items-center gap-2 text-lg font-bold">
          <Gift className="h-5 w-5" aria-hidden="true" /> Gift cards
        </h2>
        <div role="tablist" className="mb-4 grid grid-cols-4 gap-1 rounded-lg bg-muted p-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              type="button"
              aria-selected={tab === t.id}
              onClick={() => reset(t.id)}
              className={cn(
                "h-10 rounded-md text-sm font-medium touch-manipulation",
                tab === t.id && "bg-background shadow",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="space-y-4">
          {tab === "sell" && !saleOrderId && (
            <>
              {amountField}
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={physical} onChange={(e) => setPhysical(e.target.checked)} />
                Use a physical card number
              </label>
              {physical && codeField("Card number")}
              <Button className="h-12 w-full" disabled={busy || !cents || (physical && !code.trim())} onClick={sell}>
                {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : `Sell ${cents ? formatMoney(cents, currency) : "gift card"}`}
              </Button>
            </>
          )}
          {tab === "sell" && saleOrderId && (
            <>
              {shownCode ? (
                <div role="status" className="rounded-md border-2 border-dashed p-3 text-center">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">
                    Gift card code (shown once: write it down)
                  </div>
                  <div data-testid="gift-card-code" className="font-mono text-2xl font-bold tracking-wider">
                    {shownCode}
                  </div>
                </div>
              ) : (
                <p className="text-sm">Card ••••{account?.code_last4} registered.</p>
              )}
              <p className="text-sm text-muted-foreground">The card works once this sale is paid.</p>
              <Button className="h-12 w-full" onClick={() => onTakePayment(saleOrderId)}>
                Take payment
              </Button>
            </>
          )}

          {tab === "reload" && (
            <>
              {codeField("Gift card code")}
              {amountField}
              <Button className="h-12 w-full" disabled={busy || !cents || !code.trim()} onClick={reload}>
                {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : `Reload ${cents ? formatMoney(cents, currency) : ""}`}
              </Button>
            </>
          )}

          {tab === "balance" && (
            <>
              {codeField("Code or card number")}
              <Button className="h-12 w-full" disabled={busy || !code.trim()} onClick={balance}>
                Check balance
              </Button>
            </>
          )}

          {tab === "credit" && !shownCode && (
            <>
              {amountField}
              <div className="space-y-2">
                <label htmlFor="gc-dialog-reason" className="block text-sm text-muted-foreground">
                  Reason (instead of a refund, a late order...)
                </label>
                <input
                  id="gc-dialog-reason"
                  value={reason}
                  maxLength={300}
                  onChange={(e) => setReason(e.target.value)}
                  className="h-12 w-full rounded-md border bg-background px-3"
                />
              </div>
              <Button className="h-12 w-full" disabled={busy || !cents || !reason.trim()} onClick={credit}>
                {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : "Issue store credit"}
              </Button>
            </>
          )}
          {tab === "credit" && shownCode && (
            <div role="status" className="rounded-md border-2 border-dashed p-3 text-center">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Store credit code (shown once: give it to the customer)
              </div>
              <div className="font-mono text-2xl font-bold tracking-wider">{shownCode}</div>
              <div className="mt-1 text-sm">{account && formatMoney(account.balance_cents, currency)}</div>
            </div>
          )}

          {account && tab === "balance" && (
            <p role="status" className="rounded-md bg-muted p-3 text-sm">
              {account.kind === "store_credit" ? "Store credit" : "Gift card"} ••••{account.code_last4}:{" "}
              <strong>{formatMoney(account.balance_cents, currency)}</strong>
              {account.status !== "active" && ` (${account.status})`}
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button variant="outline" className="h-12 w-full" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
