/**
 * Open (unpaid) in-store orders — so an order whose payment screen was closed
 * can be found again and paid. Read-only UI over GET /api/orders and
 * GET /api/payments (which already compute the balance); no payment logic here.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import type { OrderStatus } from "@/lib/db";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { formatMoney } from "@/lib/pricing";
import { statusLabel } from "@/lib/kds/status";

export interface OpenOrder {
  id: string;
  order_number: string;
  status: OrderStatus;
  currency: string;
  balanceCents: number;
}

/** Unpaid in-store orders for a location (one server call, polled; refresh() after paying). */
export function useOpenOrders(
  tenantId: string | undefined,
  locationId: string | undefined,
  pollMs = 30_000,
) {
  const [open, setOpen] = useState<OpenOrder[]>([]);

  const refresh = useCallback(async () => {
    if (!tenantId || !locationId) return;
    try {
      const res = await fetch(
        `/api/orders/open?tenantId=${encodeURIComponent(tenantId)}&locationId=${encodeURIComponent(locationId)}`,
        { cache: "no-store" },
      );
      if (!res.ok) return;
      const { orders } = (await res.json()) as { orders: OpenOrder[] };
      setOpen(orders);
    } catch {
      // Offline or transient: keep the last known list.
    }
  }, [tenantId, locationId]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(t);
  }, [refresh, pollMs]);

  return { open, refresh };
}

export function OpenOrdersPanel({
  orders,
  currency,
  onPay,
  onClose,
}: {
  orders: OpenOrder[];
  currency: string;
  onPay: (orderId: string) => void;
  onClose: () => void;
}) {
  return (
    <Dialog onClose={onClose} labelledBy="open-orders-title">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-lg border bg-background p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="open-orders-title" className="text-lg font-semibold">
            Open orders ({orders.length})
          </h2>
          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-11"
            aria-label="Close open orders"
            onClick={onClose}
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </Button>
        </div>
        {orders.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No unpaid orders. Everything placed has been paid.
          </p>
        ) : (
          <ul className="space-y-2">
            {orders.map((order) => (
              <li
                key={order.id}
                className="flex items-center justify-between gap-3 rounded-lg border p-3"
              >
                <div className="min-w-0">
                  <div className="font-semibold">{order.order_number}</div>
                  <div className="text-xs text-muted-foreground">
                    {statusLabel(order.status)} · due{" "}
                    {formatMoney(order.balanceCents, currency)}
                  </div>
                </div>
                <Button
                  className="h-11 px-5"
                  onClick={() => onPay(order.id)}
                  aria-label={`Take payment for order ${order.order_number}`}
                >
                  Pay
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
