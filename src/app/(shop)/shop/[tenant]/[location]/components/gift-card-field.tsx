/**
 * Storefront checkout: an optional gift card / store credit code. "Check" shows
 * the balance; the card itself is applied when the customer pays
 * (`applyShopGiftCard`, after the order exists): the server takes as much of
 * the order as the card covers and the rest is paid by card as usual.
 */
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/pricing";
import type { OrderStatus } from "@/lib/db";

export interface AppliedGiftCard {
  orderStatus: OrderStatus;
  /** What the order still owes after the card. */
  balanceCents: number;
}

/** Apply a code to an unpaid online order. Throws with a customer-safe message. */
export async function applyShopGiftCard(orderId: string, code: string): Promise<AppliedGiftCard> {
  const res = await fetch("/api/shop/gift-cards/redeem", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId, code }),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<AppliedGiftCard> & { error?: string };
  if (!res.ok) throw new Error(data.error ?? "Could not apply the gift card.");
  return { orderStatus: data.orderStatus as OrderStatus, balanceCents: data.balanceCents ?? 0 };
}

export function GiftCardField({
  tenantSlug,
  locationSlug,
  currency,
  code,
  onCodeChange,
}: {
  tenantSlug: string;
  locationSlug: string;
  currency: string;
  code: string;
  onCodeChange: (code: string) => void;
}) {
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function check() {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const res = await fetch("/api/shop/gift-cards/balance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantSlug, locationSlug, code }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        balanceCents?: number;
        status?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "That code was not found.");
      setInfo(
        data.status === "active"
          ? `Balance ${formatMoney(data.balanceCents ?? 0, currency)}: applied when you pay.`
          : "This card can no longer be used.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not check the card.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-2">
      <label
        htmlFor="shop-gift-code"
        className="block text-sm font-semibold uppercase tracking-wide text-muted-foreground"
      >
        Gift card or store credit (optional)
      </label>
      <div className="flex gap-2">
        <input
          id="shop-gift-code"
          autoComplete="off"
          spellCheck={false}
          value={code}
          onChange={(e) => {
            onCodeChange(e.target.value);
            setInfo(null);
            setError(null);
          }}
          placeholder="XXXX-XXXX-XXXX-XXXX"
          className="h-11 min-w-0 flex-1 rounded-md border bg-background px-3 font-mono uppercase"
        />
        <Button type="button" variant="outline" className="h-11" disabled={busy || !code.trim()} onClick={check}>
          Check
        </Button>
      </div>
      {info && (
        <p role="status" className="text-sm text-muted-foreground">
          {info}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
