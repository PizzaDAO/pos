/**
 * Payment screen (modal) — taken after an order is placed.
 *
 * Pick a rail → set a tip → take payment. Supports SPLIT PAYMENT: each tender
 * applies to the remaining balance and the screen stays open until the balance
 * reaches zero, at which point the order is `paid` and the full receipt shows.
 * Cash captures a tendered amount and shows change due; crypto tenders show a
 * pay-to address/QR placeholder and poll until confirmed; card tenders approve
 * (simulated when no Stripe key). Completed tenders can be refunded/voided.
 *
 * Every tender uses a fresh client UUID as its idempotency key, so retries never
 * double-charge.
 */
"use client";

import { useMemo, useState } from "react";
import { Loader2, RotateCcw, X } from "lucide-react";
import type { PaymentSettings } from "@/lib/db";
import type { PaymentRailKey } from "@/lib/payments/PaymentRail";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { formatMoney } from "@/lib/pricing";
import {
  PAYMENT_RAIL_KEYS,
  PAYMENT_RAIL_LABELS,
} from "@/lib/payments/registry";
import { useCheckout } from "@/lib/store/use-checkout";
import { TipSelector } from "./tip-selector";
import { ReceiptView } from "./receipt-view";

export interface PaymentScreenProps {
  orderId: string;
  tenantId: string;
  locationId: string;
  paymentSettings: PaymentSettings;
  onClose: () => void;
  onPaid: () => void;
}

export function PaymentScreen({
  orderId,
  tenantId,
  locationId,
  paymentSettings,
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

  const balance = checkout.balanceCents;
  const paid = balance === 0 && checkout.payments.length > 0;

  // Cash change preview.
  const cashTenderedCents = useMemo(() => {
    const v = parseFloat(cashTendered);
    return Number.isFinite(v) ? Math.round(v * 100) : 0;
  }, [cashTendered]);
  const dueWithTip = balance + tipCents;
  const changeDue = Math.max(0, cashTenderedCents - dueWithTip);

  async function handleTake() {
    if (balance <= 0) return;
    await checkout.takeTender({
      rail,
      amountCents: balance,
      tipCents,
      cashTenderedCents:
        rail === "cash" ? cashTenderedCents || dueWithTip : undefined,
    });
    setTipCents(0);
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
    >
      <div className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-background shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b p-4">
          <div>
            <h2 id="payment-screen-title" className="text-lg font-bold">
              {paid ? "Payment complete" : "Take payment"}
            </h2>
            <p className="text-sm text-muted-foreground">
              {paid
                ? "Order paid in full."
                : `Balance due ${formatMoney(balance, currency)}`}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close payment"
            onClick={onClose}
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </Button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 md:grid-cols-2">
          {/* Left: take payment / done */}
          <div className="space-y-4">
            {checkout.error && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-sm text-destructive">
                {checkout.error}
              </div>
            )}

            {!paid && (
              <>
                {/* Rail picker */}
                <div>
                  <div className="mb-2 text-sm font-medium text-muted-foreground">
                    Payment method
                  </div>
                  <div className="grid grid-cols-1 gap-2">
                    {PAYMENT_RAIL_KEYS.map((key) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setRail(key)}
                        className={cn(
                          "rounded-md border px-3 py-2 text-left text-sm",
                          rail === key && "border-primary bg-primary/10",
                        )}
                      >
                        {PAYMENT_RAIL_LABELS[key]}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Tip */}
                <TipSelector
                  baseCents={balance}
                  presetsBps={paymentSettings.tip_presets_bps}
                  currency={currency}
                  tipCents={tipCents}
                  onChange={setTipCents}
                />

                {/* Cash entry */}
                {rail === "cash" && (
                  <div className="space-y-2 rounded-md border p-3">
                    <label className="text-sm text-muted-foreground">
                      Amount tendered
                    </label>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">$</span>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={cashTendered}
                        onChange={(e) => setCashTendered(e.target.value)}
                        placeholder={(dueWithTip / 100).toFixed(2)}
                        className="w-32 rounded-md border bg-background px-2 py-1 text-right text-sm"
                      />
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Change due</span>
                      <span className="font-semibold">
                        {formatMoney(changeDue, currency)}
                      </span>
                    </div>
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
                    {formatMoney(balance + tipCents, currency)}
                  </span>
                </div>

                <Button
                  className="h-14 w-full text-base"
                  disabled={checkout.loading || balance <= 0}
                  onClick={handleTake}
                >
                  {checkout.loading ? (
                    <>
                      <Loader2 className="mr-2 h-5 w-5 animate-spin" />{" "}
                      Processing…
                    </>
                  ) : (
                    `Charge ${formatMoney(balance + tipCents, currency)}`
                  )}
                </Button>
              </>
            )}

            {paid && (
              <div className="space-y-3">
                <Button className="h-14 w-full text-base" onClick={onPaid}>
                  Done — new order
                </Button>
                <Button variant="outline" className="w-full" onClick={onClose}>
                  Keep order open
                </Button>
              </div>
            )}
          </div>

          {/* Right: receipt + tenders + refunds */}
          <div className="space-y-3">
            {checkout.order && (
              <ReceiptView
                order={checkout.order}
                payments={checkout.payments}
              />
            )}

            {/* Refund / void completed tenders */}
            {checkout.payments.some(
              (p) => p.status === "captured" && p.refunded_cents === 0,
            ) && (
              <div className="rounded-md border p-3">
                <div className="mb-2 text-sm font-medium">Refund / void</div>
                <ul className="space-y-2">
                  {checkout.payments
                    .filter(
                      (p) => p.status === "captured" && p.refunded_cents === 0,
                    )
                    .map((p) => (
                      <li
                        key={p.id}
                        className="flex items-center justify-between text-sm"
                      >
                        <span>
                          {PAYMENT_RAIL_LABELS[p.rail]} ·{" "}
                          {formatMoney(p.amount_cents + p.tip_cents, currency)}
                        </span>
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={checkout.loading}
                          onClick={() => checkout.refund(p.id)}
                        >
                          <RotateCcw className="mr-1 h-3.5 w-3.5" /> Refund
                        </Button>
                      </li>
                    ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
