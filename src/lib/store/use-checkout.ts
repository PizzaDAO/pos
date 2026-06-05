/**
 * Checkout hook (client) — drives the payment screen.
 *
 * Loads an order + its tenders, takes new tenders (split payment across rails),
 * polls pending crypto tenders until confirmed, and issues refunds. Every tender
 * carries a freshly-generated client UUID that is the idempotency key end-to-end
 * (`/api/payments` upserts by it), so a retry/double-tap never double-charges.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Order, Payment } from "@/lib/db";
import type { PaymentRailKey } from "@/lib/payments/PaymentRail";

function newUuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `pay-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export interface CheckoutState {
  order: Order | null;
  payments: Payment[];
  balanceCents: number;
  loading: boolean;
  error: string | null;
  /** Take one tender. Resolves when the tender is recorded (may be pending). */
  takeTender: (input: TakeTenderInput) => Promise<Payment | null>;
  /** Refund/void a tender (full unless amountCents given). */
  refund: (paymentId: string, amountCents?: number) => Promise<void>;
  refresh: () => Promise<void>;
}

export interface TakeTenderInput {
  rail: PaymentRailKey | "cash";
  /** Base amount applied to balance, in cents. */
  amountCents: number;
  tipCents: number;
  cashTenderedCents?: number;
}

interface PaymentsResponse {
  order: Order;
  payments: Payment[];
  balanceCents: number;
}

export function useCheckout(
  orderId: string | null,
  tenantId: string,
  locationId: string,
  currency: string,
): CheckoutState {
  const [order, setOrder] = useState<Order | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [balanceCents, setBalanceCents] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    if (!orderId) return;
    try {
      const res = await fetch(`/api/payments?orderId=${encodeURIComponent(orderId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as PaymentsResponse;
      setOrder(data.order);
      setPayments(data.payments);
      setBalanceCents(data.balanceCents);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load payments.");
    }
  }, [orderId]);

  // Initial load.
  useEffect(() => {
    if (orderId) void refresh();
  }, [orderId, refresh]);

  // Poll pending crypto tenders until confirmed.
  useEffect(() => {
    const pending = payments.filter(
      (p) =>
        (p.rail === "crypto_onchain_usdc" || p.rail === "crypto_coinbase") &&
        p.status === "pending",
    );
    if (pending.length === 0) {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    if (pollRef.current) return; // already polling
    pollRef.current = window.setInterval(async () => {
      const stillPending = payments.filter(
        (p) =>
          (p.rail === "crypto_onchain_usdc" || p.rail === "crypto_coinbase") &&
          p.status === "pending",
      );
      for (const p of stillPending) {
        await fetch(`/api/payments/status?paymentId=${encodeURIComponent(p.id)}`);
      }
      await refresh();
    }, 2_500);
    return () => {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [payments, refresh]);

  const takeTender = useCallback(
    async (input: TakeTenderInput): Promise<Payment | null> => {
      if (!orderId) return null;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/payments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            paymentId: newUuid(),
            orderId,
            tenantId,
            locationId,
            rail: input.rail,
            amountCents: input.amountCents,
            tipCents: input.tipCents,
            currency,
            cashTenderedCents: input.cashTenderedCents,
          }),
        });
        const data = (await res.json()) as {
          payment?: Payment;
          balanceCents?: number;
          error?: string;
        };
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        await refresh();
        return data.payment ?? null;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Payment failed.");
        return null;
      } finally {
        setLoading(false);
      }
    },
    [orderId, tenantId, locationId, currency, refresh],
  );

  const refund = useCallback(
    async (paymentId: string, amountCents?: number) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/payments/refund", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paymentId, amountCents }),
        });
        const data = (await res.json()) as { error?: string };
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Refund failed.");
      } finally {
        setLoading(false);
      }
    },
    [refresh],
  );

  return {
    order,
    payments,
    balanceCents,
    loading,
    error,
    takeTender,
    refund,
    refresh,
  };
}
