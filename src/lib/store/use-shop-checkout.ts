/**
 * Online checkout hook (Phase 4, client). Orchestrates the customer order:
 *  1. `quoteDelivery` — POST /api/delivery/quote to price + GATE a delivery
 *     address (out-of-zone/below-minimum rejected with a message).
 *  2. `placeOrder` — POST /api/shop/orders to create the online order with the
 *     right channel + fulfillment (the server re-validates hours + zone).
 *  3. `pay` — POST /api/payments REUSING the existing stripe_online / crypto
 *     rails (simulated when unkeyed) with an optional tip; the same idempotency
 *     model as the terminal (client UUID per tender).
 *
 * All money is integer cents.
 */
"use client";

import { useCallback, useRef, useState } from "react";
import {
  idForAttempt,
  newUuid,
  settleAttempt,
  type RetryIdSlot,
} from "./retry-id";
import type { DeliveryAddress, Order, OrderItem, Payment } from "@/lib/db";
import type { PaymentRailKey } from "@/lib/payments/PaymentRail";

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
  /** The rail the customer chose (validated server-side before creating). */
  rail?: string;
}

export function useShopCheckout() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Payment id kept across an AMBIGUOUS failure so the retry can't charge twice.
  const paySlot = useRef<RetryIdSlot["current"]>(null);

  /** Price + gate a delivery address. Returns null + sets `error` on rejection. */
  const quoteDelivery = useCallback(
    async (input: {
      tenantSlug: string;
      locationSlug: string;
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
            rail: input.rail,
          }),
        });
        const data = (await res.json()) as {
          order?: Order;
          customer?: { id: string };
          error?: string;
        };
        if (!res.ok || !data.order) {
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
    }): Promise<Payment | null> => {
      setLoading(true);
      setError(null);
      try {
        const paymentId = idForAttempt(
          paySlot,
          `${input.order.id}:${input.rail}:${input.amountCents}:${input.tipCents}`,
        );
        let res: Response;
        try {
          res = await fetch("/api/payments", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              paymentId,
              orderId: input.order.id,
              tenantId: input.order.tenant_id,
              locationId: input.order.location_id,
              rail: input.rail,
              amountCents: input.amountCents,
              tipCents: input.tipCents,
              currency: input.order.currency,
            }),
          });
        } catch (netErr) {
          settleAttempt(paySlot, { networkError: true });
          throw netErr;
        }
        const data = (await res.json().catch(() => ({}))) as {
          payment?: Payment;
          error?: string;
          retry?: boolean;
        };
        settleAttempt(paySlot, { status: res.status, retry: data.retry });
        if (!res.ok || !data.payment) {
          throw new Error(
            data.retry
              ? `${data.error ?? "Payment not confirmed."} Please try again — you won't be charged twice.`
              : (data.error ?? `HTTP ${res.status}`),
          );
        }
        return data.payment;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Payment failed.");
        return null;
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  return { loading, error, setError, quoteDelivery, placeOrder, pay, newUuid };
}
