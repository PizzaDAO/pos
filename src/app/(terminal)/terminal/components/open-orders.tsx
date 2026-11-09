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
import { MarketplaceBadge } from "@/components/marketplace-badge";
import { providerLabel } from "@/lib/marketplace/types";

export interface OpenOrder {
  id: string;
  order_number: string;
  status: OrderStatus;
  currency: string;
  balanceCents: number;
  /** Marketplace order: already paid by the marketplace, never a balance due. */
  marketplace?: {
    provider: string;
    display_id: string | null;
    acceptance: "pending" | "accepted" | "rejected";
  };
}

/** Unpaid in-store orders for a location (one server call, polled; refresh() after paying). */
export function useOpenOrders(
  tenantId: string | undefined,
  locationId: string | undefined,
  pollMs = 15_000,
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
  onMarketplaceChanged,
}: {
  orders: OpenOrder[];
  currency: string;
  onPay: (orderId: string) => void;
  onClose: () => void;
  /** Called after a marketplace accept / reject so the list refreshes. */
  onMarketplaceChanged?: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function respond(id: string, action: "accept" | "reject") {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/marketplace/orders/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Could not update the order.");
      }
      onMarketplaceChanged?.();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusyId(null);
    }
  }
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
            {error && (
              <li role="alert" className="text-sm text-destructive">
                {error}
              </li>
            )}
            {orders.map((order) =>
              order.marketplace ? (
                <li
                  key={order.id}
                  className="flex items-center justify-between gap-3 rounded-lg border p-3"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{order.order_number}</span>
                      <MarketplaceBadge
                        provider={order.marketplace.provider}
                        displayId={order.marketplace.display_id}
                      />
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {order.marketplace.acceptance === "pending"
                        ? "Needs acceptance"
                        : statusLabel(order.status)}{" "}
                      · Paid by {providerLabel(order.marketplace.provider)}
                    </div>
                  </div>
                  {order.marketplace.acceptance === "pending" && (
                    <div className="flex gap-2">
                      <Button
                        className="h-11 px-4"
                        disabled={busyId === order.id}
                        onClick={() => void respond(order.id, "accept")}
                        aria-label={`Accept order ${order.order_number}`}
                      >
                        Accept
                      </Button>
                      <Button
                        variant="outline"
                        className="h-11 px-4"
                        disabled={busyId === order.id}
                        onClick={() => void respond(order.id, "reject")}
                        aria-label={`Reject order ${order.order_number}`}
                      >
                        Reject
                      </Button>
                    </div>
                  )}
                </li>
              ) : (
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
              ),
            )}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
