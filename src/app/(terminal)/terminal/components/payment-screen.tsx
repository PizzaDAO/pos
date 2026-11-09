/**
 * Payment screen (modal) — taken after an order is placed.
 *
 * Pick a rail → set a tip → take payment. Supports SPLIT PAYMENT: each tender
 * applies to the remaining balance and the screen stays open until the balance
 * reaches zero, at which point the order is `paid` and the full receipt shows.
 * Cash captures a tendered amount and shows change due; cash SHORT of the
 * balance is taken as a partial tender for what was handed over (no tip: the tip
 * rides on the tender that finishes the order, see lib/payments/cash-tender),
 * and the rest stays due for more cash or a card. Crypto tenders show a
 * pay-to address/QR placeholder and poll until confirmed. Card tenders go to the
 * selected card reader (server-driven Stripe Terminal; a virtual reader when no
 * Stripe key): the card panel shows present card / approved / declined with
 * Try again / Cancel / Reset reader (+ Simulate in sandbox). Card needs internet,
 * so offline the screen says to take cash. Completed orders can be
 * refunded (see "Adjust order" below).
 *
 * Every tender uses a client UUID as its idempotency key (stable across retries),
 * so retries never double-charge.
 *
 * "Adjust order" opens the refund / void / comp dialog (AdjustOrderDialog):
 * partial refunds by item or amount (tip refunds kept separate), voids before
 * payment (a paid order voids by refund), comps and $/% discounts, with a
 * required reason and manager PIN approval above the location threshold.
 */
"use client";

import { useMemo, useState } from "react";
import { Ban, CreditCard, Loader2, Percent, RotateCcw, X } from "lucide-react";
import type { AdjustmentKind, AdjustmentRecord } from "@/lib/db";
import { reasonLabel } from "@/lib/adjustments/reasons";
import { AdjustOrderDialog, type AdjustMode } from "./adjust-order-dialog";
import type { PaymentSettings } from "@/lib/db";
import type { PaymentRailKey } from "@/lib/payments/PaymentRail";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { formatMoney } from "@/lib/pricing";
import { isFullyRefunded } from "@/lib/payments/refund-state";
import { planCashTender } from "@/lib/payments/cash-tender";
import { PAYMENT_RAIL_KEYS } from "@/lib/payments/registry";
import { useCheckout } from "@/lib/store/use-checkout";
import { isLiveCardTender, tenderReaderId } from "@/lib/store/use-card-reader";
import { TipSelector } from "./tip-selector";
import { GiftCardTender } from "./gift-card-tender";
import { ReceiptView } from "./receipt-view";

/** Short staff-facing method names (provider detail lives in Admin). */
const STAFF_RAIL_LABELS: Record<PaymentRailKey, string> = {
  cash: "Cash",
  stripe_terminal: "Card",
  stripe_online: "Card (online)",
  crypto_onchain_usdc: "USDC",
  crypto_coinbase: "Coinbase",
  gift_card: "Gift card",
  store_credit: "Store credit",
};

/** Quick-cash note choices at or above what is owed (plus Exact, always). */
function quickCashChoices(dueCents: number): number[] {
  const notes = [2000, 5000, 10000].filter((n) => n >= dueCents);
  if (notes.length === 0 && dueCents > 0) {
    notes.push(Math.ceil(dueCents / 10000) * 10000);
  }
  return notes;
}

const ADJUSTMENT_LABELS: Record<AdjustmentKind, string> = {
  refund: "Refund",
  void_line: "Void item",
  void_order: "Void order",
  comp: "Comp",
  discount: "Discount",
};

export interface PaymentScreenProps {
  /** Location display name for the receipt header. */
  locationName?: string;
  orderId: string;
  tenantId: string;
  locationId: string;
  paymentSettings: PaymentSettings;
  /** False hides card tenders (tenant not Stripe-onboarded in real mode). */
  cardReady?: boolean;
  /** Offer the gift card / store credit tender. */
  giftCards?: boolean;
  onClose: () => void;
  onPaid: () => void;
}

export function PaymentScreen({
  orderId,
  tenantId,
  locationId,
  paymentSettings,
  cardReady = true,
  giftCards = false,
  locationName,
  onClose,
  onPaid,
}: PaymentScreenProps) {
  const checkout = useCheckout(
    orderId,
    tenantId,
    locationId,
    paymentSettings.currency,
  );
  const currency = paymentSettings.currency;

  const [rail, setRail] = useState<PaymentRailKey | "cash">("cash");
  const [tipCents, setTipCents] = useState(0);
  const [cashTendered, setCashTendered] = useState("");

  const [adjustMode, setAdjustMode] = useState<AdjustMode | null>(null);
  /** The last partial cash tender taken (shown until the order is finished). */
  const [partialCashCents, setPartialCashCents] = useState<number | null>(null);

  const balance = checkout.balanceCents;
  // Fully refunded: the order is closed out, so never re-offer "Charge".
  const refunded = isFullyRefunded(checkout.order, checkout.payments);
  const voided = checkout.order?.status === "voided";
  const paid = balance === 0 && checkout.payments.length > 0 && !refunded && !voided;
  const finished = paid || refunded || voided;
  const closedOut = refunded || voided;
  // Money still held on a tender (refundable); a paid order is adjusted by refund.
  const holdsMoney = checkout.payments.some(
    (p) =>
      (p.status === "captured" || p.status === "authorized") &&
      p.amount_cents + p.tip_cents > p.refunded_cents,
  );
  const canRefund = holdsMoney && checkout.payments.some((p) => p.rail !== "external");
  const [adjustError, setAdjustError] = useState<string | null>(null);

  /**
   * Resume (same request id: finishes what is left, never twice) or cancel (so
   * its item units are released) a refund that did not finish.
   */
  async function unfinishedRefund(a: AdjustmentRecord, action: "resume" | "cancel") {
    setAdjustError(null);
    const res = await checkout.adjust("refund", {
      requestId: a.id,
      reasonCode: a.reason_code,
      reasonText: a.reason_text ?? undefined,
      ...(action === "cancel" ? { cancel: true } : {}),
    });
    if (!res.ok) setAdjustError(res.error ?? "That didn't go through.");
  }
  const changeGivenCents = checkout.payments
    .filter((p) => p.status === "captured")
    .reduce((sum, p) => sum + (p.cash_change_cents ?? 0), 0);

  // --- Card reader ---------------------------------------------------------
  const card = checkout.card;
  const cardRail = rail === "stripe_terminal";
  const cardLive = isLiveCardTender(card.tender);
  const selectedReader =
    card.list?.readers.find((r) => r.id === card.selectedReaderId) ?? null;
  // Why Card can't be used right now (null: it can).
  const cardBlocked: string | null = !card.online
    ? "Card needs internet: take cash."
    : card.list?.notReadyReason === "connect_not_ready"
      ? "Finish Stripe onboarding in Admin → Payments."
      : card.list?.notReadyReason === "no_reader"
        ? "Add a card reader in Admin → Payments."
        : !cardReady
          ? "Card isn't set up for this location."
          : null;
  // On-reader tipping (or no tipping): our tip selector is not used for card.
  const hideTip = cardRail && card.list?.tipMode !== "pos";
  const effectiveTipCents = hideTip ? 0 : tipCents;
  // Simulate buttons only where a simulator exists (never while the mode is unknown).
  const sandboxReader =
    card.list?.mode === "simulated" || card.list?.mode === "stripe_test";
  // The reader the tender is actually on (it may differ from the dropdown after a switch).
  const tenderReader =
    card.list?.readers.find((r) => r.id === tenderReaderId(card.tender)) ??
    selectedReader;

  // Cash change preview.
  const cashTenderedCents = useMemo(() => {
    const v = parseFloat(cashTendered);
    return Number.isFinite(v) ? Math.round(v * 100) : 0;
  }, [cashTendered]);
  const dueWithTip = balance + effectiveTipCents;
  // What the typed cash means: exact (nothing typed), full with change, a
  // partial tender (short of the balance), or short of the tip (refused).
  const cashPlan = planCashTender({
    balanceCents: balance,
    tipCents: effectiveTipCents,
    tenderedCents: cashTenderedCents,
  });
  const changeDue = cashPlan.kind === "full" ? cashPlan.changeCents : 0;
  const cashPartial = rail === "cash" && cashPlan.kind === "partial";
  const cashShortOfTip = rail === "cash" && cashPlan.kind === "short_of_tip";
  /** What this tender puts through (base + tip). */
  const thisTenderCents = cashPartial ? cashPlan.amountCents : dueWithTip;

  async function handleTake() {
    if (balance <= 0) return;
    let input: Parameters<typeof checkout.takeTender>[0];
    if (rail === "cash") {
      if (cashPlan.kind !== "full" && cashPlan.kind !== "partial") return;
      input = {
        rail,
        amountCents: cashPlan.amountCents,
        tipCents: cashPlan.tipCents,
        cashTenderedCents: cashPlan.cashTenderedCents,
      };
    } else {
      input = { rail, amountCents: balance, tipCents: effectiveTipCents };
    }
    const recorded = await checkout.takeTender(input);
    // Only a tender that was actually recorded (or a card tender now on the
    // reader) consumes the entered tip / cash amount; a failed or lost request
    // keeps them so the cashier can simply press Charge again.
    if (!recorded) return;
    if (rail !== "stripe_terminal") card.clearError();
    setPartialCashCents(
      rail === "cash" && cashPlan.kind === "partial" ? cashPlan.amountCents : null,
    );
    // A partial cash tender keeps the tip for the tender that finishes the order.
    if (!(rail === "cash" && cashPlan.kind === "partial")) setTipCents(0);
    setCashTendered("");
  }

  const pendingCrypto = checkout.payments.find(
    (p) =>
      (p.rail === "crypto_onchain_usdc" || p.rail === "crypto_coinbase") &&
      p.status === "pending",
  );

  return (
    <Dialog
      onClose={onClose}
      labelledBy="payment-screen-title"
      closeOnBackdrop={false}
      // While a balance is due, Esc must not silently drop the sale (the X
      // still works, and the order stays in Open orders).
      closeOnEsc={finished}
    >
      <div className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-background shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b p-4">
          <div>
            <h2 id="payment-screen-title" className="text-lg font-bold">
              {voided
                ? "Order voided"
                : refunded
                ? "Order refunded"
                : paid
                  ? "Payment complete"
                  : "Take payment"}
            </h2>
            <p className="text-sm text-muted-foreground">
              {voided
                ? "This order was voided."
                : refunded
                ? "All tenders on this order were refunded."
                : paid
                  ? "Order paid in full."
                  : `Balance due ${formatMoney(balance, currency)}`}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-11"
            aria-label="Close payment"
            onClick={onClose}
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </Button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 md:grid-cols-2">
          {/* Left: take payment / done */}
          <div className="space-y-4">
            {checkout.notice && (
              <div
                role="alert"
                data-testid="manual-refund-notice"
                className="rounded-md border border-amber-500/60 bg-amber-500/10 p-2 text-sm"
              >
                {checkout.notice}
              </div>
            )}
            {[checkout.error, card.error].map(
              (msg, i) =>
                msg && (
                  <div
                    key={i}
                    className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-sm text-destructive"
                  >
                    {msg}
                  </div>
                ),
            )}

            {!finished && partialCashCents !== null && (
              <div
                role="status"
                data-testid="partial-cash"
                className="rounded-md border border-amber-500/60 bg-amber-500/10 p-3 text-base font-semibold"
              >
                Cash {formatMoney(partialCashCents, currency)} taken,{" "}
                {formatMoney(balance, currency)} still due
              </div>
            )}

            {!finished && (
              <>
                {/* Gift card / store credit (never on a gift card sale itself) */}
                {giftCards && checkout.order && !checkout.order.core_ext?.stored_value && (
                  <GiftCardTender
                    orderId={orderId}
                    tenantId={tenantId}
                    balanceCents={balance}
                    currency={currency}
                    onApplied={() => void checkout.refresh()}
                  />
                )}

                {/* Rail picker */}
                <div>
                  <div className="mb-2 text-sm font-medium text-muted-foreground">
                    Payment method
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {/* "Card — Stripe (online)" makes no sense at the till. */}
                    {PAYMENT_RAIL_KEYS.filter(
                      (key) => key !== "stripe_online",
                    ).map((key) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => {
                          setRail(key);
                          card.clearError();
                        }}
                        aria-pressed={rail === key}
                        className={cn(
                          "h-16 rounded-lg border px-3 text-center text-base font-semibold touch-manipulation hover:bg-secondary",
                          rail === key &&
                            "border-primary bg-primary/10 ring-2 ring-primary",
                        )}
                      >
                        {STAFF_RAIL_LABELS[key]}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Tip (the card reader asks the customer itself unless tip mode is POS) */}
                {!hideTip && (
                  <TipSelector
                    baseCents={balance}
                    presetsBps={paymentSettings.tip_presets_bps}
                    currency={currency}
                    tipCents={tipCents}
                    onChange={setTipCents}
                  />
                )}

                {/* Card reader panel */}
                {(cardRail || card.phase !== "idle") && (
                  <div
                    data-testid="card-panel"
                    className="space-y-3 rounded-md border p-3"
                  >
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <CreditCard className="h-4 w-4" aria-hidden="true" />
                      Card reader
                    </div>

                    {card.list && card.list.readers.length > 1 &&
                    (!cardLive || card.phase === "declined") ? (
                      <select
                        aria-label="Card reader"
                        value={card.selectedReaderId ?? ""}
                        onChange={(e) => card.selectReader(e.target.value)}
                        className="w-full rounded-md border bg-background px-2 py-1 text-sm"
                      >
                        <option value="" disabled>
                          Select a reader…
                        </option>
                        {card.list.readers.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.label} ({r.status})
                          </option>
                        ))}
                      </select>
                    ) : (
                      selectedReader && (
                        <div className="text-sm text-muted-foreground">
                          {selectedReader.label}
                          {" · "}
                          {selectedReader.status === "online"
                            ? "online"
                            : selectedReader.status}
                        </div>
                      )
                    )}

                    {cardBlocked && cardRail && (
                      <p role="alert" className="text-sm text-amber-700">
                        {cardBlocked}
                      </p>
                    )}

                    {card.phase === "present" && (
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        Present card on {tenderReader?.label ?? "the reader"}…
                      </div>
                    )}
                    {card.phase === "approved" && (
                      <div className="text-sm font-semibold text-emerald-700">
                        Approved
                      </div>
                    )}
                    {card.phase === "declined" && (
                      <div role="alert" className="text-sm font-medium text-destructive">
                        {card.lastError?.message ?? "The card did not go through."}
                      </div>
                    )}

                    {(card.phase === "present" || card.phase === "declined") && (
                      <div className="flex flex-wrap gap-2">
                        {card.phase === "declined" && (
                          <Button
                            size="sm"
                            disabled={card.busy || !card.online}
                            onClick={() => void card.retry()}
                          >
                            Try again
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={card.busy}
                          onClick={() => void card.cancel()}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={card.busy || !card.online}
                          onClick={() => void card.resetReader()}
                        >
                          Reset reader
                        </Button>
                      </div>
                    )}

                    {card.phase === "present" && sandboxReader && (
                      <div className="flex flex-wrap gap-2 border-t pt-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={card.busy}
                          onClick={() => void card.simulate("approve")}
                        >
                          Simulate approve
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={card.busy}
                          onClick={() => void card.simulate("decline")}
                        >
                          Simulate decline
                        </Button>
                      </div>
                    )}
                  </div>
                )}

                {/* Cash entry */}
                {rail === "cash" && (
                  <div className="space-y-3 rounded-md border p-3">
                    <label
                      htmlFor="cash-tendered"
                      className="text-sm text-muted-foreground"
                    >
                      Amount tendered
                    </label>
                    <div className="flex items-center gap-2">
                      <span className="text-lg text-muted-foreground">$</span>
                      <input
                        id="cash-tendered"
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step="0.01"
                        value={cashTendered}
                        onChange={(e) => setCashTendered(e.target.value)}
                        placeholder={(dueWithTip / 100).toFixed(2)}
                        className="h-12 w-full max-w-40 rounded-md border bg-background px-3 text-right text-lg"
                      />
                    </div>
                    <div
                      className="flex flex-wrap gap-2"
                      role="group"
                      aria-label="Quick cash"
                    >
                      <Button
                        type="button"
                        variant="outline"
                        className="h-12 px-5 text-base"
                        onClick={() =>
                          setCashTendered((dueWithTip / 100).toFixed(2))
                        }
                      >
                        Exact
                      </Button>
                      {quickCashChoices(dueWithTip).map((n) => (
                        <Button
                          key={n}
                          type="button"
                          variant="outline"
                          className="h-12 px-5 text-base"
                          onClick={() => setCashTendered((n / 100).toFixed(2))}
                        >
                          {formatMoney(n, currency)}
                        </Button>
                      ))}
                    </div>
                    {cashPartial && cashPlan.kind === "partial" ? (
                      <p
                        role="status"
                        data-testid="cash-short"
                        className="rounded-md bg-amber-500/10 p-2 text-sm font-medium"
                      >
                        Short {formatMoney(cashPlan.remainingCents, currency)}:
                        this takes {formatMoney(cashPlan.amountCents, currency)}{" "}
                        as a partial payment and the rest stays due
                        {effectiveTipCents > 0 ? " (the tip goes on the last payment)" : ""}.
                      </p>
                    ) : cashShortOfTip && cashPlan.kind === "short_of_tip" ? (
                      <p
                        role="alert"
                        className="rounded-md bg-destructive/10 p-2 text-sm font-medium text-destructive"
                      >
                        Short {formatMoney(cashPlan.shortCents, currency)} for
                        the tip: lower the tip or take more cash.
                      </p>
                    ) : (
                      <div className="flex items-baseline justify-between">
                        <span className="text-sm text-muted-foreground">
                          Change due
                        </span>
                        <span className="text-2xl font-bold">
                          {formatMoney(changeDue, currency)}
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {/* Crypto pending notice */}
                {pendingCrypto && (
                  <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
                    <div className="flex items-center gap-2 font-medium text-amber-700">
                      <Loader2 className="h-4 w-4 animate-spin" /> Awaiting
                      confirmation…
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {pendingCrypto.rail === "crypto_onchain_usdc"
                        ? `Send USDC on Base to ${String(
                            pendingCrypto.raw?.payToAddress ??
                              "the pay-to address",
                          )}.`
                        : "Complete the Coinbase Commerce checkout."}{" "}
                      Confirming automatically.
                    </p>
                  </div>
                )}

                <div className="flex items-center justify-between rounded-md bg-muted p-3 text-sm">
                  <span className="text-muted-foreground">This tender</span>
                  <span className="font-bold">
                    {formatMoney(thisTenderCents, currency)}
                  </span>
                </div>

                <Button
                  className="h-14 w-full text-base"
                  disabled={
                    checkout.loading ||
                    card.busy ||
                    balance <= 0 ||
                    // A card tender is on the reader: finish or cancel it first.
                    cardLive ||
                    cashShortOfTip ||
                    (cardRail && (!!cardBlocked || !card.selectedReaderId))
                  }
                  onClick={handleTake}
                >
                  {checkout.loading || card.busy ? (
                    <>
                      <Loader2 className="mr-2 h-5 w-5 animate-spin" />{" "}
                      Processing…
                    </>
                  ) : (
                    cashPartial
                      ? `Take ${formatMoney(thisTenderCents, currency)} cash (partial)`
                      : `Charge ${formatMoney(thisTenderCents, currency)}`
                  )}
                </Button>
              </>
            )}

            {finished && (
              <div className="space-y-3">
                {paid && changeGivenCents > 0 && (
                  <div
                    data-testid="change-due"
                    role="status"
                    className="rounded-xl bg-emerald-700 px-4 py-5 text-center text-white"
                  >
                    <div className="text-sm font-medium uppercase tracking-wide">
                      Change due
                    </div>
                    <div className="text-5xl font-bold tabular-nums">
                      {formatMoney(changeGivenCents, currency)}
                    </div>
                  </div>
                )}
                <Button className="h-14 w-full text-base" onClick={onPaid}>
                  Done — new order
                </Button>
                {!closedOut && (
                  <Button
                    variant="outline"
                    className="h-12 w-full"
                    onClick={onClose}
                  >
                    Keep order open
                  </Button>
                )}
              </div>
            )}
          </div>

          {/* Right: receipt + tenders + refunds */}
          <div className="space-y-3">
            {checkout.order && (
              <ReceiptView
                order={checkout.order}
                payments={checkout.payments}
                businessName={locationName}
              />
            )}

            {/* Refund / void / comp (each opens the adjust dialog) */}
            {checkout.order && (
              <div className="rounded-md border p-3" data-testid="adjust-panel">
                <div className="mb-2 text-sm font-medium">Adjust order</div>
                <div className="grid grid-cols-3 gap-2">
                  <Button
                    variant="outline"
                    className="h-11 border-destructive px-2 text-destructive"
                    disabled={checkout.loading || !canRefund}
                    onClick={() => setAdjustMode("refund")}
                  >
                    <RotateCcw className="mr-1 h-3.5 w-3.5" /> Refund
                  </Button>
                  <Button
                    variant="outline"
                    className="h-11 px-2"
                    disabled={checkout.loading || closedOut}
                    onClick={() => setAdjustMode("void")}
                  >
                    <Ban className="mr-1 h-3.5 w-3.5" /> Void
                  </Button>
                  <Button
                    variant="outline"
                    className="h-11 px-2"
                    disabled={checkout.loading || closedOut || holdsMoney}
                    onClick={() => setAdjustMode("comp")}
                  >
                    <Percent className="mr-1 h-3.5 w-3.5" /> Comp
                  </Button>
                </div>
                {adjustError && (
                  <p role="alert" className="mt-2 text-xs text-destructive">
                    {adjustError}
                  </p>
                )}
                {checkout.adjustments.length > 0 && (
                  <ul className="mt-3 space-y-1 text-xs text-muted-foreground" aria-label="Adjustment history">
                    {checkout.adjustments.map((a) => (
                      <li key={a.id} className="flex justify-between gap-2">
                        <span>
                          {ADJUSTMENT_LABELS[a.kind]} · {reasonLabel(a.kind, a.reason_code)}
                          {a.tip_cents > 0 && (
                            <span className="ml-1 font-semibold text-amber-700">tip refund</span>
                          )}
                          {a.approved_by && <span className="ml-1">· approved</span>}
                          {a.status !== "completed" && (
                            <span className="ml-1 font-semibold text-destructive">{a.status}</span>
                          )}
                        </span>
                        <span className="flex items-center gap-2 tabular-nums">
                          {formatMoney(a.amount_cents + a.tip_cents, currency)}
                          {a.kind === "refund" && a.status !== "completed" && (
                              <>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-8 px-2"
                                  disabled={checkout.loading}
                                  onClick={() => void unfinishedRefund(a, "resume")}
                                >
                                  Resume
                                </Button>
                                {a.status !== "failed" && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-8 px-2"
                                    disabled={checkout.loading}
                                    onClick={() => void unfinishedRefund(a, "cancel")}
                                  >
                                    Cancel
                                  </Button>
                                )}
                              </>
                            )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      {adjustMode && checkout.order && (
        <AdjustOrderDialog
          mode={adjustMode}
          order={checkout.order}
          payments={checkout.payments}
          records={checkout.adjustments}
          policy={checkout.policy}
          currency={currency}
          busy={checkout.loading}
          onSubmit={checkout.adjust}
          onClose={() => setAdjustMode(null)}
        />
      )}
    </Dialog>
  );
}
