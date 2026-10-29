/**
 * Late payments (/admin -> Late payments).
 *
 * Lists online orders where the customer's money settled AFTER the checkout had
 * expired (the order was abandoned, so it never reached the kitchen). The owner
 * or manager either Accepts (promotes the order to paid and sends it to the
 * kitchen) or Refunds. Backed by /api/admin/late-payments.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import type { Order, Payment } from "@/lib/db";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/pricing";

interface Row {
  order: Order;
  payments: Payment[];
}

export function LatePayments({
  tenantId,
  locationId,
}: {
  tenantId: string;
  locationId: string;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(
      `/api/admin/late-payments?tenantId=${tenantId}&locationId=${locationId}`,
      { cache: "no-store" },
    );
    if (res.ok) {
      setRows(((await res.json()) as { latePayments: Row[] }).latePayments);
    } else {
      setError("Could not load late payments.");
    }
  }, [tenantId, locationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function resolve(orderId: string, action: "accept" | "refund") {
    setBusy(orderId);
    setError(null);
    try {
      const res = await fetch("/api/admin/late-payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, action }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        setError(d.error ?? `HTTP ${res.status}`);
      }
      await load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-5 w-5 text-amber-500" />
        <h2 className="text-lg font-semibold">Late payments</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        These customers paid after their checkout expired, so the order was never
        sent to the kitchen. Accept to cook it, or refund the payment.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {rows === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="no-late-payments">
          No late payments.
        </p>
      ) : (
        <ul className="space-y-3">
          {rows.map(({ order, payments }) => (
            <li
              key={order.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
              data-testid="late-payment-row"
            >
              <div className="text-sm">
                <div className="font-semibold">
                  Order {order.order_number} ·{" "}
                  {formatMoney(
                    order.fulfillment?.late_payment?.amount_cents ?? 0,
                    order.currency,
                  )}
                </div>
                <div className="text-muted-foreground">
                  {order.status} · {payments.length} payment
                  {payments.length === 1 ? "" : "s"} · flagged{" "}
                  {order.fulfillment?.late_payment
                    ? new Date(
                        order.fulfillment.late_payment.flagged_at,
                      ).toLocaleString()
                    : ""}
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={busy === order.id || order.status !== "abandoned"}
                  onClick={() => void resolve(order.id, "accept")}
                >
                  Accept
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy === order.id}
                  onClick={() => void resolve(order.id, "refund")}
                >
                  Refund
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
