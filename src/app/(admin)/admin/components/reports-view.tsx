/**
 * Reports (Phase 5, /admin → Reports).
 *
 * Sales sliced by day / item / category / channel / location, the cash-card-
 * crypto payment mix (with tips + platform fees), and void/refund tallies.
 * Supports a TENANT ROLLUP (all locations) or a single-location filter plus a
 * date range. Charts are lightweight inline CSS bars (no chart-lib dependency).
 * Data comes from /api/admin/reports (mock driver derives it from orders +
 * payments). No env vars.
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3 } from "lucide-react";
import type {
  PaymentMixSlice,
  SalesBucket,
  SalesReport,
} from "@/lib/db";
import { formatMoney } from "@/lib/pricing";
import { railFamily } from "@/lib/reports";
import { LOCATIONS } from "./admin-shell";

interface Props {
  tenantId: string;
}

const ROLLUP = "all";

export function ReportsView({ tenantId }: Props) {
  const [scope, setScope] = useState<string>(ROLLUP);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [report, setReport] = useState<SalesReport | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ tenantId, locationId: scope });
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const res = await fetch(`/api/admin/reports?${params.toString()}`, {
        cache: "no-store",
      });
      if (res.ok) {
        const d = (await res.json()) as { report: SalesReport };
        setReport(d.report);
      }
    } finally {
      setLoading(false);
    }
  }, [tenantId, scope, from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  const familyTotals = useMemo(() => {
    const totals = { cash: 0, card: 0, crypto: 0 };
    for (const s of report?.paymentMix ?? []) {
      totals[railFamily(s.rail)] += s.amount_cents + s.tip_cents;
    }
    return totals;
  }, [report]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5" />
          <h2 className="text-base font-semibold">Reports</h2>
        </div>
        <div className="flex flex-wrap items-end gap-2 text-sm">
          <label className="flex items-center gap-1">
            <span className="text-muted-foreground">Scope</span>
            <select
              className="rounded-md border bg-background px-2 py-1.5"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            >
              <option value={ROLLUP}>Tenant rollup (all)</option>
              {LOCATIONS.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1">
            <span className="text-muted-foreground">From</span>
            <input
              type="date"
              className="rounded-md border bg-background px-2 py-1.5"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-1">
            <span className="text-muted-foreground">To</span>
            <input
              type="date"
              className="rounded-md border bg-background px-2 py-1.5"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
        </div>
      </div>

      {!report ? (
        <p className="text-sm text-muted-foreground">
          {loading ? "Loading…" : "No data."}
        </p>
      ) : (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Kpi label="Orders" value={String(report.order_count)} />
            <Kpi label="Gross" value={formatMoney(report.gross_cents)} />
            <Kpi label="Net (after disc.)" value={formatMoney(report.net_cents)} />
            <Kpi label="Tax" value={formatMoney(report.tax_cents)} />
            <Kpi label="Tips" value={formatMoney(report.tip_cents)} />
            <Kpi label="Platform fees" value={formatMoney(report.fees_cents)} />
            <Kpi
              label="Voids"
              value={`${report.void_count} · ${formatMoney(report.void_cents)}`}
            />
            <Kpi
              label="Refunds"
              value={`${report.refund_count} · ${formatMoney(report.refund_cents)}`}
            />
          </div>

          {/* Payment mix */}
          <section className="rounded-xl border p-4">
            <h3 className="mb-3 text-sm font-semibold">
              Payment mix (cash / card / crypto)
            </h3>
            <div className="mb-4 grid grid-cols-3 gap-3 text-center">
              <MixCard label="Cash" cents={familyTotals.cash} />
              <MixCard label="Card" cents={familyTotals.card} />
              <MixCard label="Crypto" cents={familyTotals.crypto} />
            </div>
            <MixBars slices={report.paymentMix} />
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <BucketTable title="By location" buckets={report.byLocation} />
            <BucketTable title="By channel" buckets={report.byChannel} />
            <BucketTable title="Top items" buckets={report.byItem} />
            <BucketTable title="By category" buckets={report.byCategory} />
          </div>

          <BucketTable title="By day" buckets={report.byDay} dense />
        </>
      )}
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border p-3">
      <div className="text-xs uppercase text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-bold">{value}</div>
    </div>
  );
}

function MixCard({ label, cents }: { label: string; cents: number }) {
  return (
    <div className="rounded-lg bg-muted/40 p-3">
      <div className="text-xs uppercase text-muted-foreground">{label}</div>
      <div className="mt-1 text-base font-semibold">{formatMoney(cents)}</div>
    </div>
  );
}

function MixBars({ slices }: { slices: PaymentMixSlice[] }) {
  const max = Math.max(1, ...slices.map((s) => s.amount_cents + s.tip_cents));
  if (slices.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No tenders in range. Take payments in the terminal/shop to populate.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {slices.map((s) => {
        const total = s.amount_cents + s.tip_cents;
        const pct = Math.round((total / max) * 100);
        return (
          <div key={s.rail} className="text-sm">
            <div className="mb-0.5 flex justify-between">
              <span>
                {s.label}{" "}
                <span className="text-muted-foreground">
                  ({s.count}, tips {formatMoney(s.tip_cents)}, fees{" "}
                  {formatMoney(s.application_fee_cents)})
                </span>
              </span>
              <span className="font-medium">{formatMoney(total)}</span>
            </div>
            <div className="h-2 w-full rounded-full bg-muted">
              <div
                className="h-2 rounded-full bg-primary"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function BucketTable({
  title,
  buckets,
  dense,
}: {
  title: string;
  buckets: SalesBucket[];
  dense?: boolean;
}) {
  const max = Math.max(1, ...buckets.map((b) => b.gross_cents));
  return (
    <section className="rounded-xl border p-4">
      <h3 className="mb-3 text-sm font-semibold">{title}</h3>
      {buckets.length === 0 ? (
        <p className="text-sm text-muted-foreground">No data.</p>
      ) : (
        <div className="space-y-1.5">
          {buckets.slice(0, dense ? 60 : 10).map((b) => {
            const pct = Math.round((b.gross_cents / max) * 100);
            return (
              <div key={b.key} className="text-sm">
                <div className="flex justify-between">
                  <span className="truncate">
                    {b.label}{" "}
                    <span className="text-xs text-muted-foreground">
                      ×{b.count}
                    </span>
                  </span>
                  <span className="font-medium">{formatMoney(b.gross_cents)}</span>
                </div>
                <div className="mt-0.5 h-1.5 w-full rounded-full bg-muted">
                  <div
                    className="h-1.5 rounded-full bg-primary/70"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
