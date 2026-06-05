/**
 * Order-tracking client (Phase 4). Renders a live status timeline that advances
 * through the order lifecycle (placed/paid → in_kitchen → ready →
 * out_for_delivery → completed) via the realtime polling seam, plus delivery
 * driver/ETA when applicable.
 */
"use client";

import Link from "next/link";
import { CheckCircle2, Circle, Loader2, Truck } from "lucide-react";
import type { OrderStatus } from "@/lib/db";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatMoney } from "@/lib/pricing";
import { useOrderTracking } from "@/lib/store/use-order-tracking";

/** Pickup vs delivery timelines (delivery adds out_for_delivery). */
function steps(isDelivery: boolean): { status: OrderStatus; label: string }[] {
  const base: { status: OrderStatus; label: string }[] = [
    { status: "placed", label: "Order received" },
    { status: "in_kitchen", label: "In the kitchen" },
    { status: "ready", label: isDelivery ? "Ready to dispatch" : "Ready for pickup" },
  ];
  if (isDelivery) {
    base.push({ status: "out_for_delivery", label: "Out for delivery" });
  }
  base.push({ status: "completed", label: "Completed" });
  return base;
}

/** Index of the current status within the timeline (paid counts as placed). */
function currentIndex(
  status: OrderStatus,
  list: { status: OrderStatus }[],
): number {
  const normalized: OrderStatus =
    status === "paid" || status === "recall" ? "placed" : status;
  const idx = list.findIndex((s) => s.status === normalized);
  return idx === -1 ? 0 : idx;
}

export function TrackClient({
  slug,
  orderId,
}: {
  slug: string;
  orderId: string;
}) {
  const { data, loading } = useOrderTracking(orderId);

  if (loading && !data) {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading your order…
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3">
        <p className="text-muted-foreground">We couldn’t find that order.</p>
        <Link href={`/shop/${slug}`}>
          <Button variant="outline">Back to menu</Button>
        </Link>
      </div>
    );
  }

  const { order, delivery } = data;
  const isDelivery = order.channel === "online_delivery";
  const timeline = steps(isDelivery);
  const cur = currentIndex(order.status, timeline);
  const promised = order.fulfillment?.promised_at;

  return (
    <div className="mx-auto min-h-screen max-w-md p-4">
      <header className="mb-6 text-center">
        <p className="text-xs font-medium uppercase tracking-wide text-primary">
          {isDelivery ? "Delivery" : "Pickup"}
        </p>
        <h1 className="text-2xl font-bold">Order {order.order_number}</h1>
        {promised && (
          <p className="mt-1 text-sm text-muted-foreground">
            {isDelivery ? "Arriving" : "Ready"} around{" "}
            {new Date(promised).toLocaleTimeString(undefined, {
              hour: "numeric",
              minute: "2-digit",
            })}
          </p>
        )}
      </header>

      {/* Status timeline */}
      <ol className="space-y-4">
        {timeline.map((s, idx) => {
          const done = idx < cur;
          const active = idx === cur;
          return (
            <li key={s.status} className="flex items-center gap-3">
              {done || active ? (
                active ? (
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                ) : (
                  <CheckCircle2 className="h-6 w-6 text-emerald-500" />
                )
              ) : (
                <Circle className="h-6 w-6 text-muted-foreground/40" />
              )}
              <span
                className={cn(
                  "text-sm",
                  active && "font-semibold",
                  !done && !active && "text-muted-foreground",
                )}
              >
                {s.label}
              </span>
            </li>
          );
        })}
      </ol>

      {/* Delivery detail */}
      {isDelivery && delivery && (
        <div className="mt-6 rounded-xl border p-4">
          <div className="flex items-center gap-2 font-medium">
            <Truck className="h-4 w-4" /> Delivery
          </div>
          <dl className="mt-2 space-y-1 text-sm">
            <Row label="Status" value={delivery.status.replace(/_/g, " ")} />
            <Row
              label="Provider"
              value={delivery.provider.replace(/_/g, " ")}
            />
            {delivery.eta_minutes != null && (
              <Row label="ETA" value={`~${delivery.eta_minutes} min`} />
            )}
            {delivery.driver_name && (
              <Row label="Driver" value={delivery.driver_name} />
            )}
            {delivery.fee_cents > 0 && (
              <Row
                label="Delivery fee"
                value={formatMoney(delivery.fee_cents, delivery.currency)}
              />
            )}
          </dl>
          {delivery.status === "pending_assignment" && (
            <p className="mt-2 text-xs text-muted-foreground">
              Finding a driver…
            </p>
          )}
        </div>
      )}

      {/* Total */}
      <div className="mt-6 rounded-xl border p-4 text-sm">
        <Row
          label="Order total"
          value={formatMoney(order.totals.total_cents, order.currency)}
        />
      </div>

      <div className="mt-6 text-center">
        <Link href={`/shop/${slug}`} className="text-sm underline">
          ← Back to {slug}
        </Link>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium capitalize">{value}</span>
    </div>
  );
}
