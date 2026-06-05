/**
 * Checkout flow (Phase 4) — the customer-facing checkout for /shop.
 *
 * Steps: (1) fulfillment (pickup/delivery) + scheduling (ASAP/scheduled, gated
 * by store hours + prep) + delivery address (zone-gated quote w/ fee+ETA);
 * (2) identity (guest, or optional magic-link account stub); (3) payment via the
 * existing online rails (stripe_online card / crypto, simulated when unkeyed) +
 * optional tip; (4) confirmation with a tracking link. The server re-validates
 * everything in /api/shop/orders.
 */
"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Loader2, X } from "lucide-react";
import type { DeliveryAddress } from "@/lib/db";
import type { PaymentRailKey } from "@/lib/payments/PaymentRail";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { computeOrderTotals, formatMoney } from "@/lib/pricing";
import { useCustomerCart } from "@/lib/store/customer-cart";
import {
  useShopCheckout,
  type DeliveryQuoteResult,
} from "@/lib/store/use-shop-checkout";
import {
  asapAvailability,
  generateSlots,
} from "@/lib/shop/scheduling";
import type { ShopResponse } from "@/lib/store/use-shop";

type Fulfillment = "pickup" | "delivery";
type Step = "fulfillment" | "identity" | "payment" | "done";

const ONLINE_RAILS: { key: PaymentRailKey; label: string }[] = [
  { key: "stripe_online", label: "Card" },
  { key: "crypto_onchain_usdc", label: "Crypto — USDC (Base)" },
];

export function CheckoutFlow({
  slug,
  shop,
  onClose,
}: {
  slug: string;
  shop: ShopResponse;
  onClose: () => void;
}) {
  const checkout = useShopCheckout();
  const items = useCustomerCart((s) => s.items);
  const subtotalCents = useCustomerCart((s) => s.subtotalCents());
  const clearCart = useCustomerCart((s) => s.clear);

  const { settings, paymentSettings, location } = shop;
  const currency = settings.currency;
  const fulfillmentSettings = settings.fulfillment;

  const [step, setStep] = useState<Step>("fulfillment");

  // Fulfillment + schedule
  const deliveryAllowed = fulfillmentSettings?.delivery_enabled ?? false;
  const pickupAllowed = fulfillmentSettings?.pickup_enabled ?? true;
  const [fulfillment, setFulfillment] = useState<Fulfillment>(
    pickupAllowed ? "pickup" : "delivery",
  );
  const [when, setWhen] = useState<"asap" | string>("asap");
  const [address, setAddress] = useState<DeliveryAddress>({
    line1: "",
    line2: "",
    city: "",
    region: "",
    postal_code: "",
    country: "US",
  });
  const [quote, setQuote] = useState<DeliveryQuoteResult | null>(null);

  // Identity
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [magicLinkUrl, setMagicLinkUrl] = useState<string | null>(null);

  // Payment
  const [rail, setRail] = useState<PaymentRailKey>("stripe_online");
  const [tipCents, setTipCents] = useState(0);
  const [placedOrderId, setPlacedOrderId] = useState<string | null>(null);
  const [placedOrderNumber, setPlacedOrderNumber] = useState<string | null>(
    null,
  );

  const now = useMemo(() => new Date(), []);
  const asap = fulfillmentSettings
    ? asapAvailability(fulfillmentSettings, now)
    : { available: false, reason: "Unavailable" };
  const slots = useMemo(
    () =>
      fulfillmentSettings ? generateSlots(fulfillmentSettings, now) : [],
    [fulfillmentSettings, now],
  );

  const deliveryFee = fulfillment === "delivery" ? quote?.feeCents ?? 0 : 0;
  const totals = useMemo(
    () =>
      computeOrderTotals({
        items,
        discountCents: 0,
        taxRateBps: settings.tax_rate_bps,
        tipCents,
      }),
    [items, settings.tax_rate_bps, tipCents],
  );
  const grandTotal = totals.total_cents + deliveryFee;

  async function handleGetQuote() {
    const q = await checkout.quoteDelivery({
      tenantId: location.tenant_id,
      locationId: location.id,
      dropoff: address,
      subtotalCents,
      currency,
      scheduledFor: when === "asap" ? undefined : when,
    });
    setQuote(q);
  }

  const fulfillmentValid =
    (when === "asap" ? asap.available : Boolean(when)) &&
    (fulfillment === "pickup" || (Boolean(quote) && Boolean(address.line1)));

  async function handlePlaceAndPay() {
    const orderId = checkout.newUuid();
    const placed = await checkout.placeOrder({
      orderId,
      locationSlug: slug,
      items,
      fulfillmentType: fulfillment,
      scheduledFor: when,
      customer: { email, name: name || undefined, phone: phone || undefined },
      address: fulfillment === "delivery" ? address : undefined,
      notes: undefined,
      tipCents,
    });
    if (!placed) return;
    const pay = await checkout.pay({
      order: placed.order,
      rail,
      amountCents: placed.order.totals.total_cents,
      tipCents,
    });
    if (!pay) return;
    setPlacedOrderId(placed.order.id);
    setPlacedOrderNumber(placed.order.order_number);
    clearCart();
    setStep("done");
  }

  async function handleMagicLink() {
    if (!email) return;
    const res = await fetch("/api/shop/auth/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locationSlug: slug, email, name }),
    });
    const data = (await res.json()) as { magicLinkUrl?: string };
    setMagicLinkUrl(data.magicLinkUrl ?? null);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center">
      <div className="flex max-h-[94vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-background shadow-xl sm:rounded-2xl">
        <div className="flex items-center justify-between border-b p-4">
          <h2 className="text-lg font-bold">
            {step === "done" ? "Order confirmed" : "Checkout"}
          </h2>
          <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
            <X className="h-5 w-5" />
          </Button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          {checkout.error && step !== "done" && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-sm text-destructive">
              {checkout.error}
            </div>
          )}

          {/* STEP 1 — Fulfillment + schedule */}
          {step === "fulfillment" && fulfillmentSettings && (
            <>
              <section>
                <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Fulfillment
                </h3>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    disabled={!pickupAllowed}
                    onClick={() => setFulfillment("pickup")}
                    className={cn(
                      "rounded-lg border p-3 text-sm font-medium disabled:opacity-40",
                      fulfillment === "pickup" &&
                        "border-primary bg-primary/10",
                    )}
                  >
                    Pickup
                  </button>
                  <button
                    type="button"
                    disabled={!deliveryAllowed}
                    onClick={() => setFulfillment("delivery")}
                    className={cn(
                      "rounded-lg border p-3 text-sm font-medium disabled:opacity-40",
                      fulfillment === "delivery" &&
                        "border-primary bg-primary/10",
                    )}
                  >
                    Delivery
                    {!deliveryAllowed && (
                      <span className="block text-[10px] text-muted-foreground">
                        not available here
                      </span>
                    )}
                  </button>
                </div>
              </section>

              {/* Delivery address + zone quote */}
              {fulfillment === "delivery" && (
                <section className="space-y-2">
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                    Delivery address
                  </h3>
                  <input
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    placeholder="Street address"
                    value={address.line1}
                    onChange={(e) => {
                      setAddress({ ...address, line1: e.target.value });
                      setQuote(null);
                    }}
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      className="rounded-md border bg-background px-3 py-2 text-sm"
                      placeholder="City"
                      value={address.city}
                      onChange={(e) =>
                        setAddress({ ...address, city: e.target.value })
                      }
                    />
                    <input
                      className="rounded-md border bg-background px-3 py-2 text-sm"
                      placeholder="State"
                      value={address.region}
                      onChange={(e) =>
                        setAddress({ ...address, region: e.target.value })
                      }
                    />
                  </div>
                  <input
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    placeholder="ZIP / postal code"
                    value={address.postal_code}
                    onChange={(e) => {
                      setAddress({ ...address, postal_code: e.target.value });
                      setQuote(null);
                    }}
                  />
                  <Button
                    variant="outline"
                    className="w-full"
                    disabled={!address.line1 || !address.postal_code}
                    onClick={handleGetQuote}
                  >
                    Check delivery & get a quote
                  </Button>
                  {quote && (
                    <div className="rounded-md border border-emerald-500/50 bg-emerald-500/10 p-2 text-sm">
                      Delivery available:{" "}
                      <span className="font-semibold">
                        {formatMoney(quote.feeCents, currency)}
                      </span>
                      {quote.etaMinutes != null && (
                        <span> · ~{quote.etaMinutes} min</span>
                      )}
                      <span className="block text-[11px] text-muted-foreground">
                        via {quote.provider.replace(/_/g, " ")}
                      </span>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Tip: in-zone ZIPs include 10001–10003 and 10010–10012.
                  </p>
                </section>
              )}

              {/* Scheduling */}
              <section className="space-y-2">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  When
                </h3>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={!asap.available}
                    onClick={() => setWhen("asap")}
                    className={cn(
                      "flex-1 rounded-lg border p-3 text-sm font-medium disabled:opacity-40",
                      when === "asap" && "border-primary bg-primary/10",
                    )}
                  >
                    ASAP
                    {!asap.available && (
                      <span className="block text-[10px] text-muted-foreground">
                        {asap.reason}
                      </span>
                    )}
                  </button>
                  <select
                    value={when === "asap" ? "" : when}
                    onChange={(e) =>
                      setWhen(e.target.value || "asap")
                    }
                    className="flex-1 rounded-lg border bg-background px-2 text-sm"
                  >
                    <option value="">Schedule for later…</option>
                    {slots.map((s) => (
                      <option key={s.iso} value={s.iso}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>
              </section>

              <Button
                className="h-12 w-full"
                disabled={!fulfillmentValid}
                onClick={() => setStep("identity")}
              >
                Continue
              </Button>
            </>
          )}

          {/* STEP 2 — Identity */}
          {step === "identity" && (
            <>
              <section className="space-y-2">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Your details
                </h3>
                <input
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  placeholder="Email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <input
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  placeholder="Name (optional)"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <input
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  placeholder="Phone (optional)"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Checkout as a guest, or create an account via a magic link.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!email}
                  onClick={handleMagicLink}
                >
                  Email me a sign-in link (optional)
                </Button>
                {magicLinkUrl && (
                  <div className="rounded-md border bg-muted p-2 text-xs">
                    Simulated magic link (no email sent):{" "}
                    <Link
                      href={magicLinkUrl}
                      className="break-all underline"
                      target="_blank"
                    >
                      verify account
                    </Link>
                  </div>
                )}
              </section>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => setStep("fulfillment")}
                >
                  Back
                </Button>
                <Button
                  className="flex-1"
                  disabled={!email}
                  onClick={() => setStep("payment")}
                >
                  Continue
                </Button>
              </div>
            </>
          )}

          {/* STEP 3 — Payment */}
          {step === "payment" && (
            <>
              <section className="space-y-2">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Payment
                </h3>
                <div className="grid grid-cols-1 gap-2">
                  {ONLINE_RAILS.map((r) => (
                    <button
                      key={r.key}
                      type="button"
                      onClick={() => setRail(r.key)}
                      className={cn(
                        "rounded-md border px-3 py-2 text-left text-sm",
                        rail === r.key && "border-primary bg-primary/10",
                      )}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              </section>

              {/* Tip */}
              <section>
                <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Tip
                </h3>
                <div className="flex gap-2">
                  {[0, ...paymentSettings.tip_presets_bps].map((bps) => {
                    const cents =
                      bps === 0
                        ? 0
                        : Math.round((totals.subtotal_cents * bps) / 10_000);
                    return (
                      <button
                        key={bps}
                        type="button"
                        onClick={() => setTipCents(cents)}
                        className={cn(
                          "flex-1 rounded-md border py-2 text-sm",
                          tipCents === cents && "border-primary bg-primary/10",
                        )}
                      >
                        {bps === 0 ? "None" : `${bps / 100}%`}
                      </button>
                    );
                  })}
                </div>
              </section>

              {/* Totals */}
              <section className="space-y-1 rounded-md bg-muted p-3 text-sm">
                <Row label="Subtotal" value={formatMoney(totals.subtotal_cents, currency)} />
                {deliveryFee > 0 && (
                  <Row label="Delivery" value={formatMoney(deliveryFee, currency)} />
                )}
                <Row label="Tax" value={formatMoney(totals.tax_cents, currency)} />
                {tipCents > 0 && (
                  <Row label="Tip" value={formatMoney(tipCents, currency)} />
                )}
                <div className="mt-1 flex justify-between border-t pt-1 font-bold">
                  <span>Total</span>
                  <span>{formatMoney(grandTotal, currency)}</span>
                </div>
              </section>

              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => setStep("identity")}
                >
                  Back
                </Button>
                <Button
                  className="flex-1"
                  disabled={checkout.loading}
                  onClick={handlePlaceAndPay}
                >
                  {checkout.loading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Placing…
                    </>
                  ) : (
                    `Pay ${formatMoney(grandTotal, currency)}`
                  )}
                </Button>
              </div>
              <p className="text-center text-[11px] text-muted-foreground">
                Payments are simulated in this preview (no live keys).
              </p>
            </>
          )}

          {/* STEP 4 — Confirmation */}
          {step === "done" && placedOrderId && (
            <div className="space-y-4 py-6 text-center">
              <CheckCircle2 className="mx-auto h-14 w-14 text-emerald-500" />
              <div>
                <h3 className="text-xl font-bold">Thanks for your order!</h3>
                <p className="mt-1 text-3xl font-extrabold">
                  {placedOrderNumber}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {fulfillment === "delivery"
                    ? "We'll deliver it soon."
                    : "We'll have it ready for pickup."}
                </p>
              </div>
              <Link href={`/shop/${slug}/track/${placedOrderId}`}>
                <Button className="h-12 w-full">Track your order</Button>
              </Link>
              <Button variant="outline" className="w-full" onClick={onClose}>
                Back to menu
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span>{value}</span>
    </div>
  );
}
