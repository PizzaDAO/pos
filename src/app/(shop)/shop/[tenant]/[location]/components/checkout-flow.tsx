/**
 * Checkout flow (Phase 4) — the customer-facing checkout for /shop.
 *
 * Steps: (1) fulfillment (pickup/delivery) + scheduling (ASAP/scheduled, gated
 * by store hours + prep) + delivery address (zone-gated quote w/ fee+ETA);
 * (2) identity (guest, or optional magic-link account stub); (3) payment via the
 * existing online rails (stripe_online card / crypto, simulated when unkeyed) +
 * optional tip; (4) confirmation with a tracking link. The server re-validates
 * everything in /api/shop/orders.
 *
 * LIFECYCLE: the order is created `awaiting_payment` and only becomes a real
 * (kitchen) order once the server reports it `paid`. "Order confirmed" is shown
 * ONLY then; a tender that is still pending (crypto confirming) parks the flow in
 * a "waiting" step that polls the server. One order id is kept per checkout
 * (sessionStorage), so a retry or reload reuses the same order.
 */
"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Loader2, X } from "lucide-react";
import type { DeliveryAddress, Order } from "@/lib/db";
import { hasProgressedPastPayment } from "@/lib/shop/order-status";
import type { PaymentRailKey } from "@/lib/payments/PaymentRail";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { computeOrderTotals, formatMoney } from "@/lib/pricing";
import { useCustomerCart } from "@/lib/store/customer-cart";
import {
  useShopCheckout,
  type DeliveryQuoteResult,
} from "@/lib/store/use-shop-checkout";
import {
  forgetCheckoutOrderId,
  getCheckoutOrderId,
} from "@/lib/store/checkout-order-id";
import {
  asapAvailability,
  generateSlots,
} from "@/lib/shop/scheduling";
import type { ShopResponse } from "@/lib/store/use-shop";
import { storefrontKey } from "@/lib/shop/storefront";

type Fulfillment = "pickup" | "delivery";
type Step = "fulfillment" | "identity" | "payment" | "waiting" | "done";

const ONLINE_RAILS: { key: PaymentRailKey; label: string }[] = [
  { key: "stripe_online", label: "Card" },
  { key: "crypto_onchain_usdc", label: "Crypto — USDC (Base)" },
];

export function CheckoutFlow({
  tenantSlug,
  slug,
  shop,
  onClose,
}: {
  tenantSlug: string;
  slug: string;
  shop: ShopResponse;
  onClose: () => void;
}) {
  const checkout = useShopCheckout();
  // Location slugs are unique only within a tenant: key the stored checkout
  // order id by the storefront (tenant + location), like the cart.
  const checkoutKey = storefrontKey({ tenantSlug, locationSlug: slug });
  const items = useCustomerCart((s) => s.items);
  const subtotalCents = useCustomerCart((s) => s.subtotalCents());
  const clearCart = useCustomerCart((s) => s.clear);
  const replaceCartItems = useCustomerCart((s) => s.replaceItems);

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
  // Card is hidden when the tenant isn't Stripe-onboarded (it would be refused
  // after the order is already placed); default to the first available rail.
  const cardReady = shop.cardReady !== false;
  const availableRails = ONLINE_RAILS.filter(
    (r) =>
      (cardReady || r.key !== "stripe_online") &&
      // Hide crypto rails the server reports as not configured.
      (r.key !== "crypto_onchain_usdc" && r.key !== "crypto_coinbase"
        ? true
        : shop.cryptoReady?.[r.key] !== false),
  );
  // Nothing the customer could pay with (e.g. training mode on a live store).
  const noOnlinePayment = availableRails.length === 0;
  const [rail, setRail] = useState<PaymentRailKey>(
    availableRails[0]?.key ?? "stripe_online",
  );
  const [tipCents, setTipCents] = useState(0);
  // Set when the server's repriced total differs from the displayed total.
  const [priceChange, setPriceChange] = useState<Order | null>(null);
  const [placedOrderId, setPlacedOrderId] = useState<string | null>(null);
  const [placedOrderNumber, setPlacedOrderNumber] = useState<string | null>(
    null,
  );

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());

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

  /** Leave the checkout as paid: the only path to the confirmation screen. */
  function finishPaid(order: Order) {
    forgetCheckoutOrderId(checkoutKey);
    setPlacedOrderId(order.id);
    setPlacedOrderNumber(order.order_number);
    setPriceChange(null);
    clearCart();
    setStep("done");
  }

  async function handlePlaceAndPay() {
    // One order id per checkout: a retry / reload reuses it. A material change
    // (cart, time, address, tip...) mints a new one and cancels the old unpaid
    // order best-effort.
    const input = {
      slug: checkoutKey,
      items,
      fulfillmentType: fulfillment,
      scheduledFor: when,
      address: fulfillment === "delivery" ? address : undefined,
      email,
      name,
      phone,
      notes: undefined,
      deliveryNotes: undefined,
      tipCents,
    };
    let placed: Awaited<ReturnType<typeof checkout.placeOrder>> = null;
    for (let attempt = 0; attempt < 2 && !placed; attempt += 1) {
      const { id: orderId, superseded } = getCheckoutOrderId(
        input,
        checkout.newUuid,
      );
      if (superseded) checkout.cancelQuietly(superseded);
      placed = await checkout.placeOrder({
        orderId,
        tenantSlug,
        locationSlug: slug,
        items,
        fulfillmentType: fulfillment,
        scheduledFor: when,
        customer: { email, name: name || undefined, phone: phone || undefined },
        address: fulfillment === "delivery" ? address : undefined,
        notes: undefined,
        tipCents,
      });
      // The stored order was abandoned (expired / cancelled): start a new one.
      if (!placed && checkout.lastCode.current === "checkout_abandoned") {
        forgetCheckoutOrderId(checkoutKey);
        continue;
      }
      break;
    }
    if (!placed) return;
    // A retry after a lost response (or a reload): the order may already have
    // progressed past payment (paid, in the kitchen, ready...). It exists and is
    // not waiting for money, so confirm it instead of paying again. (An
    // abandoned order never gets here: the server answers 409 and we start over.)
    if (hasProgressedPastPayment(placed.order.status)) {
      finishPaid(placed.order);
      return;
    }
    // The server reprices from the menu. If its total differs from what the
    // customer saw, STOP and let them confirm the new total before any charge.
    if (placed.order.totals.total_cents !== grandTotal) {
      setPriceChange(placed.order);
      return;
    }
    await payPlacedOrder(placed.order);
  }

  /**
   * The customer declined the changed total: cancel the unpaid order (it was never
   * on the KDS; the server abandons it), then adopt the server's repriced lines
   * and delivery fee so the next attempt matches and the prompt can't loop.
   */
  async function declinePriceChange(order: Order) {
    if (!(await checkout.cancelOrder(order.id))) return;
    forgetCheckoutOrderId(checkoutKey);
    replaceCartItems(order.items);
    if (order.fulfillment?.type === "delivery") {
      const fee = order.fulfillment.delivery_fee_cents ?? 0;
      setQuote((q) => (q ? { ...q, feeCents: fee } : q));
    }
    setPriceChange(null);
  }

  async function payPlacedOrder(order: Order) {
    // The order total already INCLUDES the tip, and the tender carries the tip
    // separately, so base = total - tip (charging total + tip would double-count
    // it). The server re-derives both from the order anyway.
    const orderTip = order.totals.tip_cents;
    const result = await checkout.pay({
      order,
      rail,
      amountCents: order.totals.total_cents - orderTip,
      tipCents: orderTip,
    });
    if (!result) {
      if (checkout.lastCode.current === "payment_pending") {
        // A payment already exists and is still being confirmed: keep waiting on it.
        setPlacedOrderId(order.id);
        setPlacedOrderNumber(order.order_number);
        setPriceChange(null);
        checkout.setError(null);
        setStep("waiting");
        return;
      }
      if (checkout.lastCode.current === "checkout_abandoned") {
        forgetCheckoutOrderId(checkoutKey);
        setPriceChange(null);
        checkout.setError("Your checkout expired. Please try again.");
      }
      return;
    }
    setPlacedOrderId(order.id);
    setPlacedOrderNumber(order.order_number);
    setPriceChange(null);
    // "Confirmed" only when the server says paid; otherwise (a crypto payment
    // still confirming) wait for it.
    if (result.orderStatus === "paid") finishPaid(order);
    else setStep("waiting");
  }

  // WAITING step: ask the server to re-check the open tender until it settles.
  useEffect(() => {
    if (step !== "waiting" || !placedOrderId) return;
    let cancelled = false;
    const tick = async () => {
      const res = await checkout.sync(placedOrderId);
      if (cancelled || !res) return;
      if (res.orderStatus === "paid") {
        forgetCheckoutOrderId(checkoutKey);
        clearCart();
        setStep("done");
      } else if (res.orderStatus === "abandoned") {
        forgetCheckoutOrderId(checkoutKey);
        checkout.setError("Your checkout expired. Please try again.");
        setStep("payment");
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, placedOrderId, checkoutKey]);

  async function handleCancelWaiting() {
    if (!placedOrderId) return;
    if (!(await checkout.cancelOrder(placedOrderId))) return;
    forgetCheckoutOrderId(checkoutKey);
    setPlacedOrderId(null);
    setStep("payment");
  }

  async function handleMagicLink() {
    if (!emailValid) return;
    const res = await fetch("/api/shop/auth/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantSlug, locationSlug: slug, email, name }),
    });
    const data = (await res.json()) as { magicLinkUrl?: string };
    setMagicLinkUrl(data.magicLinkUrl ?? null);
  }

  return (
    <Dialog
      onClose={onClose}
      labelledBy="checkout-title"
      placement="center"
      className="bg-black/50"
    >
      <div className="flex max-h-[94vh] w-screen max-w-lg flex-col overflow-hidden rounded-t-2xl bg-background shadow-xl sm:w-[32rem] sm:max-w-[calc(100vw-2rem)] sm:rounded-2xl">
        <div className="flex items-center justify-between border-b p-4">
          <h2 id="checkout-title" className="text-lg font-bold">
            {step === "done" ? "Order confirmed" : "Checkout"}
          </h2>
          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-11"
            aria-label="Close checkout"
            onClick={onClose}
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </Button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          {checkout.error && step !== "done" && (
            <div
              role="alert"
              className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-sm text-destructive"
            >
              {checkout.error}
            </div>
          )}

          {noOnlinePayment && step !== "done" && step !== "waiting" && (
            <div
              role="status"
              data-testid="online-payment-unavailable"
              className="flex items-start gap-3 rounded-lg border border-amber-500/60 bg-amber-500/10 p-4"
            >
              <AlertTriangle
                className="mt-0.5 h-5 w-5 shrink-0 text-amber-600"
                aria-hidden="true"
              />
              <div className="text-sm">
                <p className="font-semibold">
                  Online payment is unavailable right now
                </p>
                <p className="mt-1 text-muted-foreground">
                  {location.name} can’t take online payments at the moment.
                  Please order in person or call the store.
                </p>
              </div>
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
                      "min-h-11 rounded-lg border p-3 text-sm font-medium disabled:opacity-40",
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
                      "min-h-11 rounded-lg border p-3 text-sm font-medium disabled:opacity-40",
                      fulfillment === "delivery" &&
                        "border-primary bg-primary/10",
                    )}
                  >
                    Delivery
                    {!deliveryAllowed && (
                      <span className="block text-xs text-muted-foreground">
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
                  <Field label="Street address" htmlFor="co-line1">
                    <input
                      id="co-line1"
                      className={INPUT}
                      autoComplete="address-line1"
                      value={address.line1}
                      onChange={(e) => {
                        setAddress({ ...address, line1: e.target.value });
                        setQuote(null);
                      }}
                    />
                  </Field>
                  <Field label="Apt / unit (optional)" htmlFor="co-line2">
                    <input
                      id="co-line2"
                      className={INPUT}
                      autoComplete="address-line2"
                      value={address.line2 ?? ""}
                      onChange={(e) =>
                        setAddress({ ...address, line2: e.target.value })
                      }
                    />
                  </Field>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="City" htmlFor="co-city">
                      <input
                        id="co-city"
                        className={INPUT}
                        autoComplete="address-level2"
                        value={address.city}
                        onChange={(e) =>
                          setAddress({ ...address, city: e.target.value })
                        }
                      />
                    </Field>
                    <Field label="State" htmlFor="co-region">
                      <input
                        id="co-region"
                        className={INPUT}
                        autoComplete="address-level1"
                        value={address.region}
                        onChange={(e) =>
                          setAddress({ ...address, region: e.target.value })
                        }
                      />
                    </Field>
                  </div>
                  <Field label="ZIP / postal code" htmlFor="co-zip">
                    <input
                      id="co-zip"
                      className={INPUT}
                      autoComplete="postal-code"
                      inputMode="numeric"
                      value={address.postal_code}
                      onChange={(e) => {
                        setAddress({ ...address, postal_code: e.target.value });
                        setQuote(null);
                      }}
                    />
                  </Field>
                  <Button
                    variant="outline"
                    className="h-11 w-full"
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
                    </div>
                  )}
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
                      "min-h-11 flex-1 rounded-lg border p-3 text-sm font-medium disabled:opacity-40",
                      when === "asap" && "border-primary bg-primary/10",
                    )}
                  >
                    ASAP
                    {!asap.available && (
                      <span className="block text-xs text-muted-foreground">
                        {asap.reason}
                      </span>
                    )}
                  </button>
                  <select
                    aria-label="Schedule for later"
                    value={when === "asap" ? "" : when}
                    onChange={(e) =>
                      setWhen(e.target.value || "asap")
                    }
                    className="min-h-11 flex-1 rounded-lg border bg-background px-2 text-base sm:text-sm"
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
                <Field label="Email" htmlFor="co-email">
                  <input
                    id="co-email"
                    className={INPUT}
                    type="email"
                    autoComplete="email"
                    inputMode="email"
                    required
                    aria-invalid={email !== "" && !emailValid}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </Field>
                <Field label="Name (optional)" htmlFor="co-name">
                  <input
                    id="co-name"
                    className={INPUT}
                    autoComplete="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </Field>
                <Field label="Phone (optional)" htmlFor="co-phone">
                  <input
                    id="co-phone"
                    className={INPUT}
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </Field>
                {email !== "" && !emailValid && (
                  <p role="alert" className="text-sm text-destructive">
                    Enter a valid email address.
                  </p>
                )}
                <p className="text-sm text-muted-foreground">
                  Checking out as a guest. You can also save your details for
                  next time.
                </p>
                <Button
                  variant="outline"
                  className="h-11"
                  disabled={!emailValid}
                  onClick={handleMagicLink}
                >
                  Save my details (we’ll email a sign-in link)
                </Button>
                {magicLinkUrl && (
                  <div className="rounded-md border bg-muted p-2 text-sm">
                    {shop.demo ? "Demo sign-in link (no email sent): " : "Sign-in link: "}
                    <Link
                      href={magicLinkUrl}
                      className="break-all underline"
                      target="_blank"
                    >
                      {shop.demo ? "open sign-in link" : "verify account"}
                    </Link>
                  </div>
                )}
              </section>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="h-11 flex-1"
                  onClick={() => setStep("fulfillment")}
                >
                  Back
                </Button>
                <Button
                  className="h-11 flex-1"
                  disabled={!emailValid}
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
                  {availableRails.map((r) => (
                    <button
                      key={r.key}
                      type="button"
                      onClick={() => setRail(r.key)}
                      className={cn(
                        "min-h-11 rounded-md border px-3 py-2 text-left text-sm",
                        r.key === rail && "font-semibold",
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
                          "min-h-11 flex-1 rounded-md border py-1 text-sm",
                          tipCents === cents && "border-primary bg-primary/10",
                        )}
                      >
                        {bps === 0 ? "None" : `${bps / 100}%`}
                        {bps !== 0 && (
                          <span className="block text-xs text-muted-foreground">
                            {formatMoney(cents, currency)}
                          </span>
                        )}
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

              {priceChange && (
                <div
                  role="alert"
                  data-testid="price-change"
                  className="space-y-2 rounded-md border border-amber-500/60 bg-amber-500/10 p-3 text-sm"
                >
                  <p>
                    Prices have changed since you built your cart. The new total
                    is{" "}
                    <strong>
                      {formatMoney(priceChange.totals.total_cents, currency)}
                    </strong>{" "}
                    (was {formatMoney(grandTotal, currency)}).
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      className="flex-1"
                      disabled={checkout.loading}
                      onClick={() => void declinePriceChange(priceChange)}
                    >
                      Cancel
                    </Button>
                    <Button
                      className="flex-1"
                      disabled={checkout.loading}
                      onClick={() => void payPlacedOrder(priceChange)}
                    >
                      {`Pay ${formatMoney(priceChange.totals.total_cents, currency)}`}
                    </Button>
                  </div>
                </div>
              )}

              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="h-11 flex-1"
                  onClick={() => setStep("identity")}
                >
                  Back
                </Button>
                <Button
                  className="h-11 flex-1"
                  disabled={
                    checkout.loading || priceChange !== null || noOnlinePayment
                  }
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
              {shop.demo && (
                <p className="text-center text-xs text-muted-foreground">
                  {shop.demo}
                </p>
              )}
            </>
          )}

          {/* STEP 3b — Waiting for the payment to settle (e.g. crypto confirming) */}
          {step === "waiting" && placedOrderId && (
            <div
              className="space-y-4 py-6 text-center"
              data-testid="waiting-for-payment"
            >
              <Loader2 className="mx-auto h-12 w-12 animate-spin text-primary" />
              <div>
                <h3 className="text-xl font-bold">Waiting for payment</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Order {placedOrderNumber} is held until your payment is
                  confirmed. It is not sent to the kitchen before that.
                </p>
              </div>
              <Button
                variant="outline"
                className="w-full"
                disabled={checkout.loading}
                onClick={() => void handleCancelWaiting()}
              >
                Cancel and choose another way to pay
              </Button>
            </div>
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
              <Button asChild className="h-12 w-full">
                <Link href={`/shop/${tenantSlug}/${slug}/track/${placedOrderId}`}>
                  Track your order
                </Link>
              </Button>
              <Button variant="outline" className="w-full" onClick={onClose}>
                Back to menu
              </Button>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

const INPUT =
  "h-11 w-full rounded-md border bg-background px-3 text-base sm:text-sm";

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      {children}
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
