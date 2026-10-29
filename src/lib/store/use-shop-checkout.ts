/**
 * Online checkout hook (Phase 4, client). Orchestrates the customer order:
 *  1. `quoteDelivery` — POST /api/delivery/quote to price + GATE a delivery
 *     address (out-of-zone/below-minimum rejected with a message).
 *  2. `placeOrder` — POST /api/shop/orders to create the online order with the
 *     right channel + fulfillment (the server re-validates hours + zone). The
 *     order starts `awaiting_payment`: not on the KDS until it is paid. The
 *     caller keeps ONE order id per checkout (see `checkout-order-id.ts`) so a
 *     retry reuses the same order.
 *  3. `pay` — POST /api/payments REUSING the existing stripe_online / crypto
 *     rails (simulated when unkeyed) with an optional tip. For online orders the
 *     SERVER derives the tender id from the order id + rail, so a retry is the
 *     same tender; the `paymentId` sent here is only a placeholder it ignores.
 *     The result's `orderStatus` is `paid` only once the order is settled.
 *  4. `sync` — POST /api/shop/orders/[id]/pay/sync: the server re-checks open
 *     tenders (a crypto payment confirming) and reports the order status.
 *
 * All money is integer cents.
 */
"use client";

import { useCallback, useRef, useState } from "react";
import type {
  DeliveryAddress,
  Order,
  OrderItem,
  OrderStatus,
  Payment,
} from "@/lib/db";
import type { PaymentRailKey } from "@/lib/payments/PaymentRail";
import { createPendingTenderIds, tenderSignature } from "./pending-tender";

function newUuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export interface DeliveryQuoteResult {
  provider: string;
  feeCents: number;
  currency: string;
  etaMinutes: number | null;
  zoneId: string | null;
}

export interface PlaceOrderInput {
  orderId: string;
  tenantSlug: string;
  locationSlug: string;
  items: OrderItem[];
  fulfillmentType: "pickup" | "delivery";
  scheduledFor: "asap" | string;
  customer: { email: string; name?: string; phone?: string };
  address?: DeliveryAddress;
  deliveryNotes?: string;
  notes?: string;
  tipCents: number;
}

export interface PayResult {
  payment: Payment;
  /** `paid` only once the order is settled; otherwise the customer must act/wait. */
  orderStatus: OrderStatus;
}

export interface SyncResult {
  orderStatus: OrderStatus;
  balanceCents: number;
  expiresAt: string | null;
  payments: Payment[];
}

export function useShopCheckout() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingIds = useRef(createPendingTenderIds(newUuid));
  /** Machine-readable code of the last failed call (e.g. `checkout_abandoned`). */
  const lastCode = useRef<string | null>(null);

  /** Price + gate a delivery address. Returns null + sets `error` on rejection. */
  const quoteDelivery = useCallback(
    async (input: {
      tenantId: string;
      locationId: string;
      dropoff: DeliveryAddress;
      subtotalCents: number;
      currency: string;
      scheduledFor?: string;
    }): Promise<DeliveryQuoteResult | null> => {
      setError(null);
      try {
        const res = await fetch("/api/delivery/quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        const data = (await res.json()) as DeliveryQuoteResult & {
          error?: string;
        };
        if (!res.ok) {
          setError(data.error ?? "Delivery unavailable.");
          return null;
        }
        return data;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Delivery quote failed.");
        return null;
      }
    },
    [],
  );

  /** Create the online order. Returns the order (with delivery) or null. */
  const placeOrder = useCallback(
    async (
      input: PlaceOrderInput,
    ): Promise<{ order: Order; customerId: string | null } | null> => {
      setLoading(true);
      setError(null);
      lastCode.current = null;
      try {
        const res = await fetch("/api/shop/orders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: input.orderId,
            tenantSlug: input.tenantSlug,
            locationSlug: input.locationSlug,
            items: input.items,
            fulfillmentType: input.fulfillmentType,
            scheduledFor: input.scheduledFor,
            customer: input.customer,
            address: input.address,
            deliveryNotes: input.deliveryNotes,
            notes: input.notes,
            tipCents: input.tipCents,
          }),
        });
        const data = (await res.json()) as {
          order?: Order;
          customer?: { id: string };
          error?: string;
          code?: string;
        };
        if (!res.ok || !data.order) {
          lastCode.current = data.code ?? null;
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }
        return { order: data.order, customerId: data.customer?.id ?? null };
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not place order.");
        return null;
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  /** Pay an order via an online rail (stripe_online / crypto), with tip. */
  const pay = useCallback(
    async (input: {
      order: Order;
      rail: PaymentRailKey;
      amountCents: number;
      tipCents: number;
    }): Promise<PayResult | null> => {
      setLoading(true);
      setError(null);
      lastCode.current = null;
      try {
        const res = await fetch("/api/payments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            // Same id on retry of the same tender (lost response / double-tap).
            paymentId: pendingIds.current.get(
              tenderSignature({
                orderId: input.order.id,
                rail: input.rail,
                amountCents: input.amountCents,
                tipCents: input.tipCents,
              }),
            ),
            orderId: input.order.id,
            tenantId: input.order.tenant_id,
            locationId: input.order.location_id,
            rail: input.rail,
            amountCents: input.amountCents,
            tipCents: input.tipCents,
            currency: input.order.currency,
          }),
        });
        const data = (await res.json()) as {
          payment?: Payment;
          orderStatus?: OrderStatus;
          error?: string;
          code?: string;
        };
        if (!res.ok || !data.payment) {
          lastCode.current = data.code ?? null;
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }
        pendingIds.current.clear();
        return {
          payment: data.payment,
          orderStatus: data.orderStatus ?? input.order.status,
        };
      } catch (e) {
        setError(e instanceof Error ? e.message : "Payment failed.");
        return null;
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  /**
   * Ask the server to re-check an unpaid order's open tenders. Returns the
   * order's status (`paid` is the only "money received" signal) or null.
   */
  const sync = useCallback(
    async (orderId: string): Promise<SyncResult | null> => {
      try {
        const res = await fetch(`/api/shop/orders/${orderId}/pay/sync`, {
          method: "POST",
        });
        if (!res.ok) return null;
        return (await res.json()) as SyncResult;
      } catch {
        return null;
      }
    },
    [],
  );

  /** Fire-and-forget cancel of a SUPERSEDED unpaid order (cart changed). */
  const cancelQuietly = useCallback((orderId: string): void => {
    void fetch("/api/shop/orders/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId }),
    }).catch(() => undefined);
  }, []);

  /** Cancel an unpaid order (declined a changed total, or gave up waiting). */
  const cancelOrder = useCallback(async (orderId: string): Promise<boolean> => {
    setLoading(true);
    try {
      const res = await fetch("/api/shop/orders/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `HTTP ${res.status}`);
        return false;
      }
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not cancel the order.");
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    loading,
    error,
    setError,
    quoteDelivery,
    placeOrder,
    pay,
    sync,
    cancelOrder,
    cancelQuietly,
    newUuid,
    lastCode,
  };
}
