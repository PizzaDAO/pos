/**
 * Order confirmation overlay shown after placing an order. Displays the order
 * number, total, and whether it synced immediately or is queued for sync.
 */
"use client";

import { CheckCircle2, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/pricing";

export interface PlacedOrderSummary {
  orderNumber: string;
  totalCents: number;
  currency: string;
  /** True if the order reached the server; false if only queued locally. */
  synced: boolean;
}

export function OrderConfirmation({
  order,
  onNewOrder,
}: {
  order: PlacedOrderSummary;
  onNewOrder: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-background p-6 text-center shadow-xl">
        {order.synced ? (
          <CheckCircle2 className="mx-auto h-14 w-14 text-emerald-500" />
        ) : (
          <Clock className="mx-auto h-14 w-14 text-amber-500" />
        )}
        <h2 className="mt-3 text-xl font-bold">Order placed</h2>
        <p className="mt-1 text-3xl font-extrabold tracking-tight">
          {order.orderNumber}
        </p>
        <p className="mt-1 text-muted-foreground">
          Total {formatMoney(order.totalCents, order.currency)}
        </p>
        <p className="mt-3 text-sm text-muted-foreground">
          {order.synced
            ? "Sent to the kitchen system."
            : "Saved offline — it will sync automatically when back online."}
        </p>
        <Button className="mt-5 h-12 w-full" onClick={onNewOrder}>
          New order
        </Button>
      </div>
    </div>
  );
}
