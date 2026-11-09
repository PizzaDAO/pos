/**
 * Checkout hook (client) — drives the payment screen.
 *
 * Loads an order + its tenders, takes new tenders (split payment across rails),
 * polls pending crypto tenders until confirmed, and posts refunds / voids / comps
 * (`adjust`, /api/orders/[id]/*). Every tender
 * carries a client UUID that is the idempotency key end-to-end (`/api/payments`
 * upserts by it). The UUID is minted ONCE per pending tender and reused on retry
 * (lost response, double-tap) until the tender is recorded or its amount/rail
 * changes, so a retry never double-charges.
 *
 * Card (in-store reader) tenders are different: they are handed to a physical
 * reader and complete later, so `takeTender` delegates that rail to
 * `use-card-reader` (`/api/terminal/payments`), which polls the tender and
 * reloads this balance when it settles.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AdjustmentPolicy, AdjustmentRecord, Order, Payment } from "@/lib/db";
import type { PaymentRailKey } from "@/lib/payments/PaymentRail";
import { createPendingTenderIds, tenderSignature } from "./pending-tender";
import { useCardReader, type UseCardReader } from "./use-card-reader";

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
  /** Non-error information to show (e.g. a crypto refund that must be sent by hand). */
  notice: string | null;
  /** The in-store card reader + this order's card tender (see use-card-reader). */
  card: UseCardReader;
  /** Take one tender. Resolves when the tender is recorded (may be pending). */
  takeTender: (input: TakeTenderInput) => Promise<Payment | null>;
  /** Refund / void / comp history of the order (oldest first). */
  adjustments: AdjustmentRecord[];
  /** The location's approval thresholds (null until loaded). */
  policy: AdjustmentPolicy | null;
  /**
   * POST a refund / void / comp to `/api/orders/[id]/<action>` and apply the
   * fresh order + tenders it returns. Never throws: the caller reads `code`
   * (`approval_required`, `use_refund`, ...) to decide what to show.
   */
  adjust: (action: AdjustAction, body: Record<string, unknown>) => Promise<AdjustResponse>;
  refresh: () => Promise<void>;
}

export type AdjustAction = "refund" | "void" | "discount";

export interface AdjustResponse {
  ok: boolean;
  status: number;
  error?: string;
  code?: string;
  /** Non-error information (manual crypto refund, no open drawer, ...). */
  note?: string;
  /** Partial refunds: what landed. */
  partial?: boolean;
  /** A card refund whose outcome at Stripe is not known yet (retry the same request). */
  pending?: boolean;
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
  adjustments?: AdjustmentRecord[];
  policy?: AdjustmentPolicy;
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
  const [adjustments, setAdjustments] = useState<AdjustmentRecord[]>([]);
  const [policy, setPolicy] = useState<AdjustmentPolicy | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Non-error information the cashier must read (e.g. a manual crypto refund). */
  const [notice, setNotice] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);
  const pendingIds = useRef(createPendingTenderIds(newUuid));

  const refresh = useCallback(async () => {
    if (!orderId) return;
    // The terminal opens this screen immediately after placing the order, while
    // the order is still flushing to the server via the offline queue
    // (fire-and-forget). So a freshly-opened checkout can transiently 404 until
    // the upsert lands. Retry a bounded number of times on "not found" before
    // surfacing an error, so the cashier isn't shown a $0.00 / disabled charge.
    const maxAttempts = 8;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const res = await fetch(
          `/api/payments?orderId=${encodeURIComponent(orderId)}`,
        );
        if (res.status === 404 && attempt < maxAttempts - 1) {
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as PaymentsResponse;
        setOrder(data.order);
        setPayments(data.payments);
        setBalanceCents(data.balanceCents);
        setAdjustments(data.adjustments ?? []);
        if (data.policy) setPolicy(data.policy);
        setError(null);
        return;
      } catch (e) {
        if (attempt < maxAttempts - 1) {
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
        setError(e instanceof Error ? e.message : "Failed to load payments.");
      }
    }
  }, [orderId]);

  const card = useCardReader({ tenantId, locationId, orderId, onSettled: refresh });
  const startCard = card.start;

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
        await fetch(
          `/api/payments/status?paymentId=${encodeURIComponent(p.id)}`,
        );
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
      // Card: the reader flow owns the tender (it stays open until the customer
      // taps), so there is no Payment to hand back yet.
      if (input.rail === "stripe_terminal") {
        return startCard({
          amountCents: input.amountCents,
          tipCents: input.tipCents,
        });
      }
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/payments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            paymentId: pendingIds.current.get(
              tenderSignature({
                orderId,
                rail: input.rail,
                amountCents: input.amountCents,
                tipCents: input.tipCents,
                cashTenderedCents: input.cashTenderedCents,
              }),
            ),
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
        if (!res.ok) {
          // 409: the balance changed under us (another tender landed, a card is
          // live, ...). Reload it and drop the pending id so the next tap uses
          // the new balance and a new tender id.
          if (res.status === 409) {
            pendingIds.current.clear();
            await refresh();
          }
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }
        // Recorded: the next tender (even an identical one) is a new tender.
        pendingIds.current.clear();
        await refresh();
        return data.payment ?? null;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Payment failed.");
        return null;
      } finally {
        setLoading(false);
      }
    },
    [orderId, tenantId, locationId, currency, refresh, startCard],
  );

  const adjust = useCallback(
    async (action: AdjustAction, body: Record<string, unknown>): Promise<AdjustResponse> => {
      if (!orderId) return { ok: false, status: 0, error: "No order." };
      setLoading(true);
      try {
        const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = (await res.json().catch(() => ({}))) as Partial<PaymentsResponse> & {
          error?: string;
          code?: string;
          note?: string;
          partial?: boolean;
          pending?: boolean;
          manualRefund?: boolean;
        };
        if (data.order) setOrder(data.order);
        if (data.payments) setPayments(data.payments);
        if (typeof data.balanceCents === "number") setBalanceCents(data.balanceCents);
        if (data.adjustments) setAdjustments(data.adjustments);
        if (res.ok && data.note) setNotice(data.note);
        return {
          ok: res.ok && !data.error,
          status: res.status,
          error: data.error,
          code: data.code,
          note: data.note,
          partial: data.partial,
          pending: data.pending,
        };
      } catch (e) {
        return {
          ok: false,
          status: 0,
          error: e instanceof Error ? e.message : "Request failed (offline?).",
        };
      } finally {
        setLoading(false);
      }
    },
    [orderId],
  );

  return {
    order,
    payments,
    balanceCents,
    loading,
    error,
    notice,
    card,
    takeTender,
    adjustments,
    policy,
    adjust,
    refresh,
  };
}
