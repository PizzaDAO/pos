/**
 * Owner reports (/admin → Reports).
 *
 * Sales summary, hourly heatmap, items/categories, staff, channels and tenders
 * for a date range of BUSINESS days, filterable by location, with
 * previous-period comparison and a CSV export per report plus the accountant
 * export (one row per location per day). Everything is aggregated server-side
 * (/api/admin/reports/owner → SQL); this component only renders. Charts are
 * plain CSS/table bars (the repo has no chart library), readable on phones and
 * in light and dark.
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3, Download } from "lucide-react";
import type { Location } from "@/lib/db";
import { formatMoney } from "@/lib/pricing";
import { railLabel } from "@/lib/reports";
import {
  CHANNEL_LABELS,
  addDays,
  businessDay,
  heatmapGrid,
  pctOf,
  type Delta,
  type OwnerReportBundle,
  type OwnerReportKind,
  type OwnerSummary,
} from "@/lib/owner-reports";
import { ReportsView } from "./reports-view";

interface Props {
  tenantId: string;
  locations: Location[];
}

interface Payload {
  range: { from: string; to: string };
  previous: { from: string; to: string } | null;
  summary: OwnerSummary;
  previousSummary: OwnerSummary | null;
  deltas: Record<string, Delta> | null;
  bundle: OwnerReportBundle;
}

type Tab = "summary" | "hours" | "items" | "staff" | "accountant" | "classic";

const TABS: { id: Tab; label: string }[] = [
  { id: "summary", label: "Summary" },
  { id: "hours", label: "Hours" },
  { id: "items", label: "Items" },
  { id: "staff", label: "Staff" },
  { id: "accountant", label: "Accountant" },
  { id: "classic", label: "Classic" },
];

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ALL = "all";

export function OwnerReports({ tenantId, locations }: Props) {
  const [tab, setTab] = useState<Tab>("summary");
  const [scope, setScope] = useState(ALL);

  // "Today" is the business day of the chosen (or first) location, not the browser's.
  const todayFor = useCallback(
    (loc: string) => {
      const l = locations.find((x) => x.id === loc) ?? locations[0];
      return businessDay(
        new Date().toISOString(),
        l?.timezone ?? "UTC",
        l?.business_day_cutoff_minutes ?? 0,
      ).date;
    },
    [locations],
  );
  const [to, setTo] = useState(() => todayFor(ALL));
  const [from, setFrom] = useState(() => addDays(todayFor(ALL), -6));
  const [compare, setCompare] = useState(true);
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const query = useCallback(
    (extra: Record<string, string> = {}) =>
      new URLSearchParams({ tenantId, locationId: scope, from, to, ...extra }).toString(),
    [tenantId, scope, from, to],
  );

  useEffect(() => {
    if (tab === "classic") return;
    let live = true;
    setLoading(true);
    setError(null);
    fetch(`/api/admin/reports/owner?${query(compare ? { compare: "1" } : {})}`, { cache: "no-store" })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as Payload & { error?: string };
        if (!live) return;
        if (!res.ok) {
          setError(body.error ?? `Could not load reports (HTTP ${res.status}).`);
          setData(null);
        } else setData(body);
      })
      .catch(() => live && setError("Could not load reports."))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [query, compare, tab]);

  function preset(kind: "today" | "yesterday" | "7" | "30" | "month") {
    const today = todayFor(scope);
    const set = (f: string, t: string) => {
      setFrom(f);
      setTo(t);
    };
    if (kind === "today") set(today, today);
    else if (kind === "yesterday") set(addDays(today, -1), addDays(today, -1));
    else if (kind === "month") set(`${today.slice(0, 8)}01`, today);
    else set(addDays(today, -(Number(kind) - 1)), today);
  }

  const csvHref = (kind: OwnerReportKind) =>
    `/api/admin/reports/owner?${query({ report: kind, format: "csv" })}`;

  const tzNote = useMemo(() => {
    const picked = scope === ALL ? locations : locations.filter((l) => l.id === scope);
    const zones = [...new Set(picked.map((l) => l.timezone))];
    return zones.length === 1 ? `Times in ${zones[0]}` : "Each location in its own timezone";
  }, [locations, scope]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <BarChart3 className="h-5 w-5" />
        <h2 className="text-base font-semibold">Reports</h2>
        <span className="text-xs text-muted-foreground">{tzNote}</span>
      </div>

      <div className="flex flex-wrap items-end gap-2 text-sm">
        <label className="flex flex-col gap-0.5">
          <span className="text-xs text-muted-foreground">Location</span>
          <select
            className="rounded-md border bg-background px-2 py-1.5"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          >
            <option value={ALL}>All locations</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-xs text-muted-foreground">From</span>
          <input
            type="date"
            className="rounded-md border bg-background px-2 py-1.5"
            value={from}
            max={to}
            onChange={(e) => e.target.value && setFrom(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-xs text-muted-foreground">To</span>
          <input
            type="date"
            className="rounded-md border bg-background px-2 py-1.5"
            value={to}
            min={from}
            onChange={(e) => e.target.value && setTo(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-1.5 py-2">
          <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} />
          Compare to previous period
        </label>
      </div>
      <div className="flex flex-wrap gap-1.5 text-xs" role="group" aria-label="Date presets">
        {(
          [
            ["today", "Today"],
            ["yesterday", "Yesterday"],
            ["7", "Last 7 days"],
            ["30", "Last 30 days"],
            ["month", "This month"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            className="rounded-full border px-3 py-1.5 hover:bg-muted"
            onClick={() => preset(k)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex gap-1 overflow-x-auto border-b" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm ${
              tab === t.id ? "border-primary font-medium" : "border-transparent text-muted-foreground"
            }`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "classic" ? (
        <ReportsView tenantId={tenantId} locations={locations} />
      ) : error ? (
        <p role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      ) : !data ? (
        <p className="text-sm text-muted-foreground">{loading ? "Loading…" : "No data."}</p>
      ) : (
        <div className={loading ? "opacity-60" : undefined} aria-busy={loading}>
          {tab === "summary" && <SummaryTab d={data} csv={csvHref} />}
          {tab === "hours" && <HoursTab d={data} csv={csvHref} />}
          {tab === "items" && <ItemsTab d={data} csv={csvHref} />}
          {tab === "staff" && <StaffTab d={data} csv={csvHref} />}
          {tab === "accountant" && <AccountantTab d={data} csv={csvHref} />}
        </div>
      )}
    </div>
  );
}

type TabProps = { d: Payload; csv: (k: OwnerReportKind) => string };

function CsvLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      download
      className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs hover:bg-muted"
    >
      <Download className="h-3.5 w-3.5" aria-hidden /> {label}
    </a>
  );
}

function Panel({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Kpi({ label, cents, count, delta, invert }: { label: string; cents?: number; count?: number; delta?: Delta; invert?: boolean }) {
  const text = cents !== undefined ? formatMoney(cents) : String(count ?? 0);
  // For refunds/discounts an increase is bad, so the colour flips.
  const good = delta ? (invert ? delta.diff < 0 : delta.diff > 0) : false;
  return (
    <div className="rounded-xl border p-3">
      <div className="text-xs uppercase text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-bold">{text}</div>
      {delta && (
        <div
          className={`text-xs ${delta.diff === 0 ? "text-muted-foreground" : good ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
        >
          {delta.diff === 0 ? "no change" : `${delta.diff > 0 ? "+" : "−"}${delta.pct === null ? "new" : `${Math.abs(Math.round(delta.pct * 100))}%`}`}
          <span className="text-muted-foreground"> vs {cents !== undefined ? formatMoney(delta.previous) : delta.previous}</span>
        </div>
      )}
    </div>
  );
}

function Bars({ rows }: { rows: { key: string; label: string; value: number; note?: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No data in this range.</p>;
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.key} className="text-sm">
          <div className="flex justify-between gap-2">
            <span className="truncate">
              {r.label} {r.note && <span className="text-xs text-muted-foreground">{r.note}</span>}
            </span>
            <span className="shrink-0 font-medium">{formatMoney(r.value)}</span>
          </div>
          <div className="mt-0.5 h-1.5 w-full rounded-full bg-muted" aria-hidden>
            <div className="h-1.5 rounded-full bg-primary/70" style={{ width: `${Math.round((r.value / max) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function SummaryTab({ d, csv }: TabProps) {
  const s = d.summary;
  const dl = d.deltas ?? {};
  const byDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of d.bundle.daily) {
      m.set(r.business_date, (m.get(r.business_date) ?? 0) + r.gross_cents - r.discount_cents - r.refund_sales_cents);
    }
    return [...m.entries()].map(([k, v]) => ({ key: k, label: k, value: v }));
  }, [d.bundle.daily]);
  return (
    <div className="space-y-4">
      {d.previous && (
        <p className="text-xs text-muted-foreground">
          Compared with {d.previous.from} to {d.previous.to}.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="Net sales" cents={s.net_cents} delta={dl.net_cents} />
        <Kpi label="Orders" count={s.orders} delta={dl.orders} />
        <Kpi label="Avg ticket" cents={s.avg_ticket_cents} delta={dl.avg_ticket_cents} />
        <Kpi label="Gross sales" cents={s.gross_cents} delta={dl.gross_cents} />
        <Kpi label="Discounts / comps" cents={s.discount_cents} delta={dl.discount_cents} invert />
        <Kpi label="Refunds" cents={s.refund_cents} delta={dl.refund_cents} invert />
        <Kpi label="Tax" cents={s.tax_cents} delta={dl.tax_cents} />
        <Kpi label="Tips" cents={s.tip_cents} delta={dl.tip_cents} />
      </div>
      <p className="text-xs text-muted-foreground">
        Voids: {s.void_count} orders, {formatMoney(s.void_cents)} (not in sales). Net = gross − discounts − refunded sales.
        Refunded tax and tips come off tax and tips. Refunds ({formatMoney(s.refund_cents)} total) are dated to the
        original order&apos;s day, not the day the refund was issued.
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="By tender" action={<CsvLink href={csv("tenders")} label="CSV" />}>
          <Bars
            rows={d.bundle.tenders.map((t) => ({
              key: t.key,
              label: railLabel(t.key),
              value: t.amount_cents,
              note: `×${t.count}`,
            }))}
          />
        </Panel>
        <Panel title="By channel" action={<CsvLink href={csv("channels")} label="CSV" />}>
          <Bars
            rows={d.bundle.channels.map((c) => ({
              key: c.channel,
              label: CHANNEL_LABELS[c.channel] ?? c.channel,
              value: c.gross_cents - c.discount_cents - c.refund_sales_cents,
              note: `×${c.orders}`,
            }))}
          />
        </Panel>
      </div>
      <Panel title="Net sales by day" action={<CsvLink href={csv("summary")} label="CSV" />}>
        <Bars rows={byDay} />
      </Panel>
    </div>
  );
}

function HoursTab({ d, csv }: TabProps) {
  const g = useMemo(() => heatmapGrid(d.bundle.hourly), [d.bundle.hourly]);
  const hours = Array.from({ length: 24 }, (_, h) => h);
  return (
    <Panel title="Sales by weekday and hour" action={<CsvLink href={csv("hourly")} label="CSV" />}>
      <p className="mb-2 text-xs text-muted-foreground">
        Darker = more net sales. Weekday is the business day; hours are local clock time.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-separate border-spacing-0.5 text-center text-[10px]">
          <caption className="sr-only">Net sales by weekday and hour</caption>
          <thead>
            <tr>
              <th scope="col" className="w-9" />
              {hours.map((h) => (
                <th key={h} scope="col" className="font-normal text-muted-foreground">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DOW.map((day, di) => (
              <tr key={day}>
                <th scope="row" className="pr-1 text-right font-normal text-muted-foreground">
                  {day}
                </th>
                {hours.map((h) => {
                  const v = g.sales[di]![h]!;
                  const n = g.orders[di]![h]!;
                  const alpha = g.max > 0 ? Math.max(v > 0 ? 0.12 : 0, v / g.max) : 0;
                  return (
                    <td
                      key={h}
                      title={`${day} ${String(h).padStart(2, "0")}:00 · ${n} orders · ${formatMoney(v)}`}
                      aria-label={`${day} ${h}:00, ${n} orders, ${formatMoney(v)}`}
                      className="h-6 rounded-sm bg-muted/40"
                      style={alpha > 0 ? { backgroundColor: `hsl(var(--primary) / ${alpha.toFixed(2)})` } : undefined}
                    />
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function ItemsTab({ d, csv }: TabProps) {
  const total = d.bundle.item_total_cents;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="By category" action={<CsvLink href={csv("categories")} label="CSV" />}>
        <Table
          head={["Category", "Qty", "Revenue", "%"]}
          rows={d.bundle.categories.map((c) => [c.name, c.qty, formatMoney(c.revenue_cents), `${pctOf(c.revenue_cents, total)}%`])}
        />
      </Panel>
      <Panel title="By item (top 50)" action={<CsvLink href={csv("items")} label="CSV" />}>
        <Table
          head={["Item", "Qty", "Revenue", "%"]}
          rows={d.bundle.items.map((i) => [i.name, i.qty, formatMoney(i.revenue_cents), `${pctOf(i.revenue_cents, total)}%`])}
        />
      </Panel>
    </div>
  );
}

function StaffTab({ d, csv }: TabProps) {
  return (
    <Panel title="By staff" action={<CsvLink href={csv("staff")} label="CSV" />}>
      <Table
        head={["Staff", "Orders", "Sales", "Tips", "Refunds", "Voids"]}
        rows={d.bundle.staff.map((s) => [s.name, s.orders, formatMoney(s.sales_cents), formatMoney(s.tip_cents), formatMoney(s.refund_cents), s.void_count])}
      />
      <p className="mt-3 text-xs text-muted-foreground">
        Labour % is not shown: staff hours are not available to POS reports yet.
      </p>
    </Panel>
  );
}

function AccountantTab({ d, csv }: TabProps) {
  return (
    <Panel title="Accountant export: daily summary per location" action={<CsvLink href={csv("accountant")} label="Download CSV" />}>
      <p className="mb-2 text-xs text-muted-foreground">
        Refunds are dated to the original order&apos;s business day. Tax and tips are net of refunds.
      </p>
      <Table
        head={["Date", "Location", "Orders", "Gross", "Disc.", "Refunds", "Net", "Tax", "Tips", "Cash", "Card"]}
        rows={d.bundle.daily.map((r) => [
          r.business_date,
          r.location_name,
          r.orders,
          formatMoney(r.gross_cents),
          formatMoney(r.discount_cents),
          formatMoney(r.refund_cents),
          formatMoney(r.gross_cents - r.discount_cents - r.refund_sales_cents),
          formatMoney(r.tax_cents),
          formatMoney(r.tip_cents),
          formatMoney(r.cash_cents),
          formatMoney(r.card_cents),
        ])}
      />
    </Panel>
  );
}

function Table({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No data in this range.</p>;
  return (
    <div className="max-h-[28rem] overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-background text-left text-xs text-muted-foreground">
          <tr>
            {head.map((h, i) => (
              <th key={h} scope="col" className={`whitespace-nowrap px-2 py-1.5 font-medium ${i === 0 ? "" : "text-right"}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="border-t">
              {r.map((c, i) => (
                <td key={i} className={`whitespace-nowrap px-2 py-1.5 ${i === 0 ? "max-w-[14rem] truncate" : "text-right"}`}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
