/**
 * Open (unpaid) in-store orders — so an order whose payment screen was closed
 * can be found again and paid — and Recent orders (history: paid, partially
 * refunded, refunded, voided) to find one to refund / void / comp. Read-only UI
 * over GET /api/orders/open (which computes balances and refunds server-side);
 * no payment logic here.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import type { RecentOrderRow } from "@/lib/payments/open-orders";
import { X } from "lucide-react";
import type { OrderStatus } from "@/lib/db";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { formatMoney } from "@/lib/pricing";
import { statusLabel } from "@/lib/kds/status";
import { MarketplaceBadge } from "@/components/marketplace-badge";
import { providerLabel } from "@/lib/marketplace/types";
import { startPolling } from "@/lib/realtime/visibility";

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
    accept_failed?: boolean;
    cancel_requested?: boolean;
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
    // Paused while the tab is hidden; refreshes as soon as it is visible.
    const poll = startPolling(refresh, pollMs);
    return () => poll.stop();
  }, [refresh, pollMs]);

  return { open, refresh };
}

const MONEY_LABELS: Record<RecentOrderRow["money"], string> = {
  paid: "Paid",
  partially_refunded: "Part refunded",
  refunded: "Refunded",
  voided: "Voided",
  unpaid: "Unpaid",
};

export function OpenOrdersPanel({
  orders,
  currency,
  onPay,
  onClose,
  tenantId,
  locationId,
  onMarketplaceChanged,
}: {
  orders: OpenOrder[];
  currency: string;
  onPay: (orderId: string) => void;
  onClose: () => void;
  /** With these, a "Recent" tab lists order history (to refund / void). */
  tenantId?: string;
  locationId?: string;
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
  const [tab, setTab] = useState<"open" | "recent">("open");
  const [recent, setRecent] = useState<RecentOrderRow[] | null>(null);
  useEffect(() => {
    if (tab !== "recent" || !tenantId || !locationId) return;
    let live = true;
    void (async () => {
      try {
        const res = await fetch(
          `/api/orders/open?view=recent&tenantId=${encodeURIComponent(tenantId)}&locationId=${encodeURIComponent(locationId)}`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const { orders: rows } = (await res.json()) as { orders: RecentOrderRow[] };
        if (live) setRecent(rows);
      } catch {
        // offline: keep whatever we had
      }
    })();
    return () => {
      live = false;
    };
  }, [tab, tenantId, locationId]);

  return (
    <Dialog onClose={onClose} labelledBy="open-orders-title">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-lg border bg-background p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="open-orders-title" className="text-lg font-semibold">
            {tab === "open" ? `Open orders (${orders.length})` : "Recent orders"}
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
        {tenantId && locationId && (
          <div className="mb-3 grid grid-cols-2 gap-2" role="tablist">
            {(["open", "recent"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`h-10 rounded-md border text-sm font-semibold ${tab === t ? "border-primary bg-primary/10" : ""}`}
              >
                {t === "open" ? "Open" : "Recent"}
              </button>
            ))}
          </div>
        )}
        {tab === "recent" ? (
          recent === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">No orders yet.</p>
          ) : (
            <ul className="space-y-2">
              {recent.map((order) => (
                <li
                  key={order.id}
                  className="flex items-center justify-between gap-3 rounded-lg border p-3"
                >
                  <div className="min-w-0">
                    <div className="font-semibold">{order.order_number}</div>
                    <div className="text-xs text-muted-foreground">
                      {MONEY_LABELS[order.money]} ·{" "}
                      {formatMoney(order.totalCents, order.currency || currency)}
                      {order.refundedCents > 0 &&
                        ` · refunded ${formatMoney(order.refundedCents, order.currency || currency)}`}
                      {order.discountCents > 0 &&
                        ` · discounts ${formatMoney(order.discountCents, order.currency || currency)}`}
                    </div>
                    {order.unfinishedRefunds > 0 && (
                      <div className="text-xs font-semibold text-destructive">
                        Unfinished refund: open to resume or cancel
                      </div>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    className="h-11 px-4"
                    onClick={() => onPay(order.id)}
                    aria-label={`Open order ${order.order_number}`}
                  >
                    Open
                  </Button>
                </li>
              ))}
            </ul>
          )
        ) : orders.length === 0 ? (
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
                        ? order.marketplace.accept_failed
                          ? "Accept failed at provider"
                          : "Needs acceptance"
                        : statusLabel(order.status)}{" "}
                      · Paid by {providerLabel(order.marketplace.provider)}
                    </div>
                    {order.marketplace.cancel_requested && (
                      <div className="text-xs font-semibold text-destructive">
                        Cancelled by {providerLabel(order.marketplace.provider)}{" "}
                        while in progress: check with the kitchen
                      </div>
                    )}
                  </div>
                  {order.marketplace.acceptance === "pending" && (
                    <div className="flex gap-2">
                      <Button
                        className="h-11 px-4"
                        disabled={busyId === order.id}
                        onClick={() => void respond(order.id, "accept")}
                        aria-label={`Accept order ${order.order_number}`}
                      >
                        {order.marketplace.accept_failed ? "Retry accept" : "Accept"}
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
