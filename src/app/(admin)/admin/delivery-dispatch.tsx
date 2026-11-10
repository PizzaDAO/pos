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
import type { DeliveryRecord } from "@/lib/db";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/pricing";
import { driverAttention } from "@/lib/delivery/attention";
import { startPolling } from "@/lib/realtime/visibility";

interface DriverOption {
  id: string;
  name: string;
  clockedIn: boolean;
}

const OTHER = "__other__";

interface Row {
  delivery: DeliveryRecord;
  orderNumber: string | null;
  orderStatus: string | null;
}

const STATUS_LABELS: Record<string, string> = {
  pending_assignment: "Needs a driver",
  assigned: "Assigned",
  picked_up: "Picked up",
  en_route: "On the way",
  delivered: "Delivered",
  failed: "Failed",
  canceled: "Canceled",
};

export function DeliveryDispatch({
  tenantId,
  locationId,
}: {
  tenantId: string;
  locationId: string;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [draftDriver, setDraftDriver] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  /** Staff tagged with the Driver role (clocked-in first). */
  const [drivers, setDrivers] = useState<DriverOption[]>([]);
  /** Rows where the dispatcher picked "Other…" and types a name. */
  const [other, setOther] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!tenantId || !locationId) return;
    let alive = true;
    fetch(
      `/api/admin/staff?tenantId=${encodeURIComponent(tenantId)}&locationId=${encodeURIComponent(locationId)}`,
      { cache: "no-store" },
    )
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (d: {
          staff: { id: string; name: string; module_roles?: string[] }[];
          openShifts: Record<string, unknown>;
        } | null) => {
          if (!alive || !d) return;
          const list = d.staff
            .filter((s) => (s.module_roles ?? []).includes("driver"))
            .map((s) => ({
              id: s.id,
              name: s.name,
              clockedIn: Boolean(d.openShifts?.[s.id]),
            }))
            .sort((a, b) => Number(b.clockedIn) - Number(a.clockedIn));
          setDrivers(list);
        },
      )
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [tenantId, locationId]);

  const load = useCallback(async () => {
    if (!tenantId || !locationId) return;
    const res = await fetch(
      `/api/delivery/dispatch?tenantId=${encodeURIComponent(tenantId)}&locationId=${encodeURIComponent(locationId)}`,
      { cache: "no-store" },
    );
    if (!res.ok) return;
    const data = (await res.json()) as { deliveries: Row[] };
    setRows(data.deliveries);
  }, [tenantId, locationId]);

  useEffect(() => {
    // Every 5 s while the tab is visible (paused when hidden).
    const poll = startPolling(load, 5000);
    return () => poll.stop();
  }, [load]);

  async function assign(deliveryId: string) {
    const driverName = (draftDriver[deliveryId] ?? "").trim();
    if (!driverName) return;
    setBusy(deliveryId);
    setNotice(null);
    try {
      const res = await fetch("/api/delivery/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deliveryId, driverName }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setNotice(data.error ?? "Could not assign the driver.");
      } else {
        setNotice(`Assigned ${driverName}.`);
      }
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function dispatchManually(deliveryId: string, confirmNotWithDriver = false) {
    setBusy(deliveryId);
    setNotice(null);
    setConfirming(null);
    try {
      const res = await fetch("/api/delivery/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deliveryId,
          action: "dispatchManually",
          ...(confirmNotWithDriver ? { confirmNotWithDriver: true } : {}),
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setNotice(data.error ?? "Could not switch this delivery.");
      }
      await load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <section>
      <div className="mx-auto max-w-3xl">
        <div className="mb-4 flex items-center gap-2">
          <Truck className="h-5 w-5" />
          <h2 className="text-base font-semibold">Delivery dispatch (in-house)</h2>
        </div>
        {notice && (
          <p
            role="alert"
            className={
              notice.startsWith("Assigned ")
                ? "mb-3 text-sm text-emerald-700"
                : "mb-3 text-sm text-destructive"
            }
          >
            {notice}
          </p>
        )}
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No deliveries yet. Place an online delivery order from the shop to
            see it here.
          </p>
        ) : (
          <ul className="space-y-3">
            {rows.map(({ delivery, orderNumber, orderStatus }) => {
              const attention = driverAttention(delivery, Date.now(), orderStatus);
              return (
                <li key={delivery.id} className="rounded-xl border p-4 text-sm">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="font-semibold">
                        Order {orderNumber ?? delivery.order_id.slice(0, 8)}
                      </span>
                      <span className="ml-2 rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">
                        {STATUS_LABELS[delivery.status] ??
                          delivery.status.replace(/_/g, " ")}
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

                  {attention.reason && (
                    <div className="mt-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-xs">
                      <span className="mr-2 rounded-full bg-amber-500/20 px-2 py-0.5 font-semibold text-amber-800">
                        Needs attention
                      </span>
                      {attention.reason}
                      {attention.canDispatchManually && (
                        <div className="mt-2">
                          <Button
                            className="h-11"
                            variant="outline"
                            disabled={busy === delivery.id}
                            onClick={() => void dispatchManually(delivery.id)}
                          >
                            Dispatch manually instead
                          </Button>
                        </div>
                      )}
                      {attention.canOverrideConflict && (
                        <div className="mt-2">
                          {confirming === delivery.id ? (
                            <div role="group" className="space-y-2">
                              <p>
                                Only continue if the driver confirmed it does
                                NOT have this delivery. Otherwise two couriers
                                may be sent.
                              </p>
                              <div className="flex gap-2">
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  disabled={busy === delivery.id}
                                  onClick={() =>
                                    void dispatchManually(delivery.id, true)
                                  }
                                >
                                  Yes, dispatch manually
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => setConfirming(null)}
                                >
                                  Cancel
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy === delivery.id}
                              onClick={() => setConfirming(delivery.id)}
                            >
                              Driver confirms it doesn&apos;t have it: dispatch
                              manually
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {delivery.status === "pending_assignment" ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <select
                        aria-label={`Driver for order ${orderNumber ?? delivery.order_id.slice(0, 8)}`}
                        className="h-11 min-w-48 flex-1 rounded-md border bg-background px-3 text-sm"
                        value={
                          other[delivery.id]
                            ? OTHER
                            : (draftDriver[delivery.id] ?? "")
                        }
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === OTHER) {
                            setOther((o) => ({ ...o, [delivery.id]: true }));
                            setDraftDriver((d) => ({ ...d, [delivery.id]: "" }));
                          } else {
                            setOther((o) => ({ ...o, [delivery.id]: false }));
                            setDraftDriver((d) => ({ ...d, [delivery.id]: v }));
                          }
                        }}
                      >
                        <option value="">Choose a driver…</option>
                        {drivers.map((d) => (
                          <option key={d.id} value={d.name}>
                            {d.name}
                            {d.clockedIn ? " (clocked in)" : ""}
                          </option>
                        ))}
                        <option value={OTHER}>Other…</option>
                      </select>
                      {other[delivery.id] && (
                        <input
                          aria-label="Driver name"
                          className="h-11 flex-1 rounded-md border bg-background px-3 text-sm"
                          placeholder="Driver name"
                          value={draftDriver[delivery.id] ?? ""}
                          onChange={(e) =>
                            setDraftDriver((d) => ({
                              ...d,
                              [delivery.id]: e.target.value,
                            }))
                          }
                        />
                      )}
                      <Button
                        className="h-11 px-5"
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
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
