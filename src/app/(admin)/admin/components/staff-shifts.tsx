/**
 * Staff & shifts (Phase 5, /admin → Staff & shifts).
 *
 * Staff roster (role-tagged), clock in/out, the shift drawer (opening float +
 * cash tenders/payouts during the shift), and drawer RECONCILIATION at clock-out
 * (expected vs counted → over/short). No real auth — this is a demo switcher for
 * staff views. Talks to /api/admin/staff. No env vars.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { LogIn, LogOut, Users, Wallet } from "lucide-react";
import type {
  DrawerReconciliation,
  Shift,
  Staff,
} from "@/lib/db";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/pricing";
import { cn } from "@/lib/utils";

interface Props {
  tenantId: string;
  locationId: string;
}

interface StaffData {
  staff: Staff[];
  shifts: Shift[];
  openShifts: Record<string, Shift | null>;
  reconciliations: { shiftId: string; reconciliation: DrawerReconciliation }[];
}

function dollarsToCents(v: string): number {
  const n = Number.parseFloat(v);
  return Number.isNaN(n) ? 0 : Math.round(n * 100);
}

export function StaffShifts({ tenantId, locationId }: Props) {
  const [data, setData] = useState<StaffData | null>(null);
  const [busy, setBusy] = useState(false);
  const [floatDraft, setFloatDraft] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const res = await fetch(
      `/api/admin/staff?tenantId=${tenantId}&locationId=${locationId}`,
      { cache: "no-store" },
    );
    if (res.ok) setData((await res.json()) as StaffData);
  }, [tenantId, locationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    try {
      // Always carry the active tenant so the server authorizes against the
      // session (a member of this tenant), incl. clock-out / cash events.
      await fetch("/api/admin/staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId, ...body }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const reconById = new Map(
    data.reconciliations.map((r) => [r.shiftId, r.reconciliation]),
  );

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-2">
        <Users className="h-5 w-5" />
        <h2 className="text-base font-semibold">Staff &amp; shifts</h2>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {data.staff.map((s) => {
          const open = data.openShifts[s.id] ?? null;
          return (
            <div key={s.id} className="rounded-xl border p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-semibold">{s.name}</div>
                  <div className="text-xs uppercase text-muted-foreground">
                    {s.role}
                  </div>
                </div>
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-xs font-semibold",
                    open
                      ? "bg-emerald-500/15 text-emerald-700"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {open ? "Clocked in" : "Off"}
                </span>
              </div>

              {open ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  In since {new Date(open.opened_at).toLocaleTimeString()} ·
                  float {formatMoney(open.opening_float_cents)}
                </p>
              ) : (
                <div className="mt-3 flex gap-2">
                  <input
                    className="w-28 rounded-md border bg-background px-2 py-1.5 text-sm"
                    placeholder="Float $"
                    value={floatDraft[s.id] ?? ""}
                    onChange={(e) =>
                      setFloatDraft((d) => ({ ...d, [s.id]: e.target.value }))
                    }
                  />
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      post({
                        action: "clockIn",
                        tenantId,
                        locationId,
                        staffId: s.id,
                        openingFloatCents: dollarsToCents(floatDraft[s.id] ?? "0"),
                      })
                    }
                  >
                    <LogIn className="h-4 w-4" /> Clock in
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Open shifts — drawer + reconciliation */}
      <section className="space-y-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Wallet className="h-4 w-4" /> Open drawers
        </h3>
        {data.shifts.filter((s) => s.status === "open").length === 0 && (
          <p className="text-sm text-muted-foreground">
            No open shifts. Clock someone in to open a drawer.
          </p>
        )}
        {data.shifts
          .filter((s) => s.status === "open")
          .map((shift) => (
            <OpenDrawer
              key={shift.id}
              shift={shift}
              staff={data.staff.find((s) => s.id === shift.staff_id) ?? null}
              recon={reconById.get(shift.id) ?? null}
              busy={busy}
              tenantId={tenantId}
              locationId={locationId}
              onPost={post}
            />
          ))}
      </section>

      {/* Closed shift history */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Closed shifts</h3>
        <div className="overflow-hidden rounded-xl border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Staff</th>
                <th className="px-3 py-2">Closed</th>
                <th className="px-3 py-2">Expected</th>
                <th className="px-3 py-2">Counted</th>
                <th className="px-3 py-2">Over / short</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {data.shifts
                .filter((s) => s.status === "closed")
                .map((shift) => {
                  const recon = reconById.get(shift.id);
                  const os = recon?.over_short_cents ?? 0;
                  const staff = data.staff.find((s) => s.id === shift.staff_id);
                  return (
                    <tr key={shift.id}>
                      <td className="px-3 py-2">{staff?.name ?? shift.staff_id}</td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {shift.closed_at
                          ? new Date(shift.closed_at).toLocaleString()
                          : "—"}
                      </td>
                      <td className="px-3 py-2">
                        {formatMoney(recon?.expected_cents ?? 0)}
                      </td>
                      <td className="px-3 py-2">
                        {formatMoney(shift.counted_cents ?? 0)}
                      </td>
                      <td
                        className={cn(
                          "px-3 py-2 font-medium",
                          os < 0
                            ? "text-destructive"
                            : os > 0
                              ? "text-amber-600"
                              : "text-emerald-600",
                        )}
                      >
                        {os > 0 ? "+" : ""}
                        {formatMoney(os)}{" "}
                        {os === 0 ? "balanced" : os > 0 ? "over" : "short"}
                      </td>
                    </tr>
                  );
                })}
              {data.shifts.filter((s) => s.status === "closed").length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-4 text-muted-foreground">
                    No closed shifts yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function OpenDrawer({
  shift,
  staff,
  recon,
  busy,
  tenantId,
  locationId,
  onPost,
}: {
  shift: Shift;
  staff: Staff | null;
  recon: DrawerReconciliation | null;
  busy: boolean;
  tenantId: string;
  locationId: string;
  onPost: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [cash, setCash] = useState("");
  const [counted, setCounted] = useState("");

  return (
    <div className="rounded-xl border p-4">
      <div className="flex items-center justify-between">
        <div className="font-semibold">{staff?.name ?? shift.staff_id}</div>
        <div className="text-xs text-muted-foreground">
          float {formatMoney(shift.opening_float_cents)}
        </div>
      </div>

      {recon && (
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
          <Stat label="Cash sales" value={formatMoney(recon.cash_sales_cents)} />
          <Stat label="Paid in" value={formatMoney(recon.paid_in_cents)} />
          <Stat label="Payouts" value={formatMoney(recon.payouts_cents)} />
          <Stat label="Expected" value={formatMoney(recon.expected_cents)} strong />
        </dl>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          className="w-28 rounded-md border bg-background px-2 py-1.5 text-sm"
          placeholder="Cash $"
          value={cash}
          onChange={(e) => setCash(e.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !cash.trim()}
          onClick={async () => {
            await onPost({
              action: "cashEvent",
              shiftId: shift.id,
              tenantId,
              locationId,
              type: "sale",
              amountCents: dollarsToCents(cash),
              note: "Cash sale",
            });
            setCash("");
          }}
        >
          + Cash sale
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || !cash.trim()}
          onClick={async () => {
            await onPost({
              action: "cashEvent",
              shiftId: shift.id,
              tenantId,
              locationId,
              type: "payout",
              amountCents: -Math.abs(dollarsToCents(cash)),
              note: "Payout / drop",
            });
            setCash("");
          }}
        >
          − Payout
        </Button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
        <span className="text-sm text-muted-foreground">Reconcile &amp; clock out:</span>
        <input
          className="w-32 rounded-md border bg-background px-2 py-1.5 text-sm"
          placeholder="Counted $"
          value={counted}
          onChange={(e) => setCounted(e.target.value)}
        />
        <Button
          size="sm"
          disabled={busy || !counted.trim()}
          onClick={() =>
            onPost({
              action: "clockOut",
              shiftId: shift.id,
              countedCents: dollarsToCents(counted),
              note: null,
            })
          }
        >
          <LogOut className="h-4 w-4" /> Clock out
        </Button>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs uppercase text-muted-foreground">{label}</dt>
      <dd className={cn("text-sm", strong && "font-semibold")}>{value}</dd>
    </div>
  );
}
