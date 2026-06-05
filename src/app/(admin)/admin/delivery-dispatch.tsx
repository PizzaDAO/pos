/**
 * In-house delivery dispatch board (Phase 4, /admin).
 *
 * Lists the location's deliveries and lets a dispatcher ASSIGN A DRIVER to an
 * in-house delivery awaiting assignment. Assigning flips the delivery to
 * `assigned` and the order to `out_for_delivery` (surfaces on the KDS + the
 * customer tracker). Polls the dispatch feed on an interval. No env vars.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Truck } from "lucide-react";
import {
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_TENANT_ID,
  type DeliveryRecord,
} from "@/lib/db";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/pricing";

interface Row {
  delivery: DeliveryRecord;
  orderNumber: string | null;
  orderStatus: string | null;
}

export function DeliveryDispatch() {
  const [rows, setRows] = useState<Row[]>([]);
  const [draftDriver, setDraftDriver] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(
      `/api/delivery/dispatch?tenantId=${DEMO_TENANT_ID}&locationId=${DEMO_LOCATION_DOWNTOWN_ID}`,
      { cache: "no-store" },
    );
    if (!res.ok) return;
    const data = (await res.json()) as { deliveries: Row[] };
    setRows(data.deliveries);
  }, []);

  useEffect(() => {
    void load();
    const h = setInterval(() => void load(), 5000);
    return () => clearInterval(h);
  }, [load]);

  async function assign(deliveryId: string) {
    const driverName = (draftDriver[deliveryId] ?? "").trim();
    if (!driverName) return;
    setBusy(deliveryId);
    try {
      await fetch("/api/delivery/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deliveryId, driverName }),
      });
      await load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="border-t p-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-4 flex items-center gap-2">
          <Truck className="h-5 w-5" />
          <h2 className="text-lg font-bold">Delivery dispatch (in-house)</h2>
        </div>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No deliveries yet. Place an online delivery order from the shop to see
            it here.
          </p>
        ) : (
          <ul className="space-y-3">
            {rows.map(({ delivery, orderNumber }) => (
              <li
                key={delivery.id}
                className="rounded-xl border p-4 text-sm"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-semibold">
                      Order {orderNumber ?? delivery.order_id.slice(0, 8)}
                    </span>
                    <span className="ml-2 rounded-full bg-secondary px-2 py-0.5 text-xs capitalize text-secondary-foreground">
                      {delivery.status.replace(/_/g, " ")}
                    </span>
                  </div>
                  <span className="text-muted-foreground">
                    {formatMoney(delivery.fee_cents, delivery.currency)}
                    {delivery.eta_minutes != null &&
                      ` · ~${delivery.eta_minutes} min`}
                  </span>
                </div>
                <p className="mt-1 text-muted-foreground">
                  {delivery.dropoff.line1}, {delivery.dropoff.city}{" "}
                  {delivery.dropoff.postal_code} · via{" "}
                  {delivery.provider.replace(/_/g, " ")}
                  {delivery.simulated && " (simulated)"}
                </p>

                {delivery.status === "pending_assignment" ? (
                  <div className="mt-3 flex gap-2">
                    <input
                      className="flex-1 rounded-md border bg-background px-3 py-1.5 text-sm"
                      placeholder="Driver name"
                      value={draftDriver[delivery.id] ?? ""}
                      onChange={(e) =>
                        setDraftDriver((d) => ({
                          ...d,
                          [delivery.id]: e.target.value,
                        }))
                      }
                    />
                    <Button
                      size="sm"
                      disabled={
                        busy === delivery.id ||
                        !(draftDriver[delivery.id] ?? "").trim()
                      }
                      onClick={() => assign(delivery.id)}
                    >
                      Assign driver
                    </Button>
                  </div>
                ) : (
                  delivery.driver_name && (
                    <p className="mt-2 text-xs">
                      Driver:{" "}
                      <span className="font-medium">
                        {delivery.driver_name}
                      </span>
                    </p>
                  )
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
