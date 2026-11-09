/**
 * Online gift card purchase (customer). Creates the sale (POST
 * /api/shop/gift-cards: an untaxed order for the card) and pays it through the
 * normal online card path (`useShopCheckout().pay`), then waits for it to
 * settle. The code comes back once, in the purchase response, and is kept in
 * this tab's session storage so a reload still shows it; failing that, this
 * browser may reveal it ONCE after paying (signed cookie, /reveal). Recipient email delivery is not wired yet (the
 * server hook is inert), so the buyer passes the code on.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Gift, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/pricing";
import { useShopCheckout } from "@/lib/store/use-shop-checkout";
import { storefrontPath } from "@/lib/shop/storefront";
import type { Order } from "@/lib/db";

const PRESETS = [2500, 5000, 10000];
const STORE_KEY = "gift-card-purchase";

interface Pending {
  orderId: string;
  code: string | null;
}

function load(): Pending | null {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as Pending) : null;
  } catch {
    return null;
  }
}

function save(p: Pending | null) {
  try {
    if (p) sessionStorage.setItem(STORE_KEY, JSON.stringify(p));
    else sessionStorage.removeItem(STORE_KEY);
  } catch {
    // Storage unavailable: the code is still on screen.
  }
}

const done = (s: string | undefined) => s === "paid" || s === "completed";

export function GiftCardPurchase({
  tenantSlug,
  locationSlug,
  locationName,
  currency,
}: {
  tenantSlug: string;
  locationSlug: string;
  locationName: string;
  currency: string;
}) {
  const checkout = useShopCheckout();
  const [amount, setAmount] = useState("50.00");
  const [email, setEmail] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [step, setStep] = useState<"form" | "waiting" | "done">("form");
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const orderId = useRef<string>("");

  useEffect(() => {
    const prior = load();
    if (prior) {
      setPending(prior);
      orderId.current = prior.orderId;
      setStep("waiting");
    } else {
      orderId.current = crypto.randomUUID();
    }
  }, []);

  // Poll until the sale settles (card confirming), like the checkout's waiting step.
  useEffect(() => {
    if (step !== "waiting" || !pending) return;
    let cancelled = false;
    const tick = async () => {
      const res = await checkout.sync(pending.orderId);
      if (cancelled || !res) return;
      if (done(res.orderStatus)) setStep("done");
      else if (res.orderStatus === "abandoned") {
        save(null);
        setPending(null);
        orderId.current = crypto.randomUUID();
        setError("The payment expired. Please try again.");
        setStep("form");
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, pending]);

  // Paid but the code is not on hand (a retried purchase never returns it): ask
  // once for this browser's one-time reveal (signed cookie set at checkout).
  useEffect(() => {
    if (step !== "done" || !pending || pending.code) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      const res = await fetch("/api/shop/gift-cards/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: pending.orderId }),
      }).catch(() => null);
      if (cancelled || !res) return;
      if (res.status === 202) {
        timer = setTimeout(() => void ask(), 3000);
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { code?: string; error?: string };
      if (res.ok && data.code) {
        const next = { ...pending, code: data.code };
        save(next);
        setPending(next);
      } else {
        setError(data.error ?? "The code can no longer be shown here.");
      }
    };
    void ask();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [step, pending]);

  const cents = Math.round(parseFloat(amount) * 100);

  async function buy() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/shop/gift-cards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: orderId.current,
          tenantSlug,
          locationSlug,
          amountCents: cents,
          email: email.trim(),
          recipientName: recipientName.trim() || undefined,
          recipientEmail: recipientEmail.trim() || undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { order?: Order; code?: string | null; error?: string };
      if (!res.ok || !data.order) throw new Error(data.error ?? `HTTP ${res.status}`);
      const next = { orderId: data.order.id, code: data.code ?? null };
      save(next);
      setPending(next);
      const paid = await checkout.pay({
        order: data.order,
        rail: "stripe_online",
        amountCents: data.order.totals.total_cents,
        tipCents: 0,
      });
      if (!paid) return; // checkout.error explains
      setStep(done(paid.orderStatus) ? "done" : "waiting");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not buy the gift card.");
    } finally {
      setBusy(false);
    }
  }

  function another() {
    save(null);
    setPending(null);
    orderId.current = crypto.randomUUID();
    setStep("form");
  }

  return (
    <main id="main-content" className="mx-auto w-full max-w-md space-y-4 px-4 py-6">
      <Link href={storefrontPath({ tenantSlug, locationSlug })} className="text-sm underline">
        Back to {locationName}
      </Link>
      <h1 className="flex items-center gap-2 text-2xl font-bold">
        <Gift className="h-6 w-6" aria-hidden="true" /> Gift card
      </h1>

      {step === "form" && (
        <div className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="gc-amount" className="block text-sm font-medium">
              Amount
            </label>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <Button
                  key={p}
                  type="button"
                  variant={cents === p ? "default" : "outline"}
                  className="h-11"
                  onClick={() => setAmount((p / 100).toFixed(2))}
                >
                  {formatMoney(p, currency)}
                </Button>
              ))}
              <input
                id="gc-amount"
                type="number"
                inputMode="decimal"
                min={5}
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="h-11 w-28 rounded-md border bg-background px-3 text-right"
              />
            </div>
          </div>
          {[
            { id: "gc-email", label: "Your email (for the receipt)", value: email, set: setEmail, type: "email" },
            { id: "gc-rname", label: "Recipient name (optional)", value: recipientName, set: setRecipientName, type: "text" },
            { id: "gc-remail", label: "Recipient email (optional)", value: recipientEmail, set: setRecipientEmail, type: "email" },
          ].map((f) => (
            <div key={f.id} className="space-y-1">
              <label htmlFor={f.id} className="block text-sm font-medium">
                {f.label}
              </label>
              <input
                id={f.id}
                type={f.type}
                value={f.value}
                onChange={(e) => f.set(e.target.value)}
                className="h-11 w-full rounded-md border bg-background px-3"
              />
            </div>
          ))}
          {(error || checkout.error) && (
            <p role="alert" className="text-sm text-destructive">
              {error ?? checkout.error}
            </p>
          )}
          <Button
            className="h-12 w-full"
            disabled={busy || !Number.isFinite(cents) || cents <= 0 || !email.includes("@")}
            onClick={buy}
          >
            {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : `Pay ${Number.isFinite(cents) && cents > 0 ? formatMoney(cents, currency) : ""}`}
          </Button>
          <p className="text-xs text-muted-foreground">
            Gift cards are not taxed; tax is charged when the card is spent.
          </p>
        </div>
      )}

      {step === "waiting" && (
        <p role="status" className="flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" /> Waiting for your payment to confirm…
        </p>
      )}

      {step === "done" && (
        <div className="space-y-3">
          <div role="status" className="rounded-md border-2 border-dashed p-4 text-center">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Your gift card code</div>
            <div data-testid="gift-card-code" className="font-mono text-2xl font-bold tracking-wider">
              {pending?.code ?? "—"}
            </div>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            Save this code: it is the gift card. Use it at checkout or in store.
          </p>
          <Button variant="outline" className="h-11 w-full" onClick={another}>
            Buy another
          </Button>
        </div>
      )}
    </main>
  );
}
