/**
 * End-of-day Z-report (Phase 5, /admin → End of day).
 *
 * Per-location business-day close: gross/net, tax, tips, fees, payment mix,
 * voids/refunds, order counts by channel, and a drawer summary. CLOSE is
 * idempotent (re-closing the same day returns the frozen snapshot). Includes a
 * print-friendly layout (browser print CSS hides the chrome). Talks to
 * /api/admin/eod. No env vars.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Lock, Printer, Receipt } from "lucide-react";
import type { BusinessDayClose, SalesReport } from "@/lib/db";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/pricing";
import { railFamily } from "@/lib/reports";
import { LOCATIONS } from "./admin-shell";

interface Props {
  tenantId: string;
  locationId: string;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

interface EodData {
  close: BusinessDayClose | null;
  closed: boolean;
  report?: SalesReport;
}

export function EndOfDay({ tenantId, locationId }: Props) {
  const [date, setDate] = useState(todayIso());
  const [data, setData] = useState<EodData | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(
      `/api/admin/eod?tenantId=${tenantId}&locationId=${locationId}&date=${date}`,
      { cache: "no-store" },
    );
    if (res.ok) setData((await res.json()) as EodData);
  }, [tenantId, locationId, date]);

  useEffect(() => {
    void load();
  }, [load]);

  async function close() {
    setBusy(true);
    try {
      await fetch("/api/admin/eod", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId, locationId, date }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  const report = data?.close?.report ?? data?.report ?? null;
  const drawer = data?.close?.drawer ?? null;
  const closed = data?.closed ?? false;
  const locationName =
    LOCATIONS.find((l) => l.id === locationId)?.name ?? locationId;

  const family = { cash: 0, card: 0, crypto: 0 };
  for (const s of report?.paymentMix ?? []) {
    family[railFamily(s.rail)] += s.amount_cents + s.tip_cents;
  }

  return (
    <div className="space-y-5">
      {/* Controls — hidden when printing. */}
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div className="flex items-center gap-2">
          <Receipt className="h-5 w-5" />
          <h2 className="text-base font-semibold">End of day (Z-report)</h2>
        </div>
        <div className="flex flex-wrap items-end gap-2 text-sm">
          <label className="flex items-center gap-1">
            <span className="text-muted-foreground">Business date</span>
            <input
              type="date"
              className="rounded-md border bg-background px-2 py-1.5"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          {!closed && (
            <Button size="sm" disabled={busy} onClick={close}>
              <Lock className="h-4 w-4" /> Close day
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => window.print()}>
            <Printer className="h-4 w-4" /> Print
          </Button>
        </div>
      </div>

      {!report ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="rounded-xl border p-6 print:border-0 print:p-0">
          <div className="mb-4 text-center">
            <h1 className="text-xl font-bold">Tony&apos;s Pizza — Z-Report</h1>
            <p className="text-sm text-muted-foreground">
              {locationName} · {date}
            </p>
            <p className="mt-1 text-xs">
              {closed ? (
                <span className="font-semibold text-emerald-700">
                  CLOSED {data?.close?.closed_at
                    ? new Date(data.close.closed_at).toLocaleString()
                    : ""}
                </span>
              ) : (
                <span className="text-amber-700">
                  LIVE preview — not yet closed
                </span>
              )}
            </p>
          </div>

          <Section title="Sales">
            <Row label="Orders" value={String(report.order_count)} />
            <Row label="Gross" value={formatMoney(report.gross_cents)} />
            <Row label="Discounts" value={formatMoney(report.discount_cents)} />
            <Row label="Net" value={formatMoney(report.net_cents)} strong />
            <Row label="Tax" value={formatMoney(report.tax_cents)} />
            <Row label="Tips" value={formatMoney(report.tip_cents)} />
            <Row label="Platform fees" value={formatMoney(report.fees_cents)} />
          </Section>

          <Section title="Payment mix">
            <Row label="Cash" value={formatMoney(family.cash)} />
            <Row label="Card" value={formatMoney(family.card)} />
            <Row label="Crypto" value={formatMoney(family.crypto)} />
          </Section>

          <Section title="Orders by channel">
            {report.byChannel.length === 0 ? (
              <Row label="—" value="" />
            ) : (
              report.byChannel.map((c) => (
                <Row
                  key={c.key}
                  label={c.label}
                  value={`${c.count} · ${formatMoney(c.gross_cents)}`}
                />
              ))
            )}
          </Section>

          <Section title="Voids & refunds">
            <Row
              label="Voids"
              value={`${report.void_count} · ${formatMoney(report.void_cents)}`}
            />
            <Row
              label="Refunds"
              value={`${report.refund_count} · ${formatMoney(report.refund_cents)}`}
            />
          </Section>

          {drawer && (
            <Section title="Drawer summary">
              <Row label="Shifts closed" value={String(drawer.shift_count)} />
              <Row
                label="Opening float"
                value={formatMoney(drawer.opening_float_cents)}
              />
              <Row
                label="Cash sales"
                value={formatMoney(drawer.cash_sales_cents)}
              />
              <Row
                label="Expected drawer"
                value={formatMoney(drawer.expected_cents)}
              />
              <Row label="Counted" value={formatMoney(drawer.counted_cents)} />
              <Row
                label="Over / short"
                value={`${drawer.over_short_cents > 0 ? "+" : ""}${formatMoney(
                  drawer.over_short_cents,
                )}`}
                strong
              />
            </Section>
          )}

          <p className="mt-6 text-center text-xs text-muted-foreground">
            Generated by Tony&apos;s Pizza POS — back office
          </p>
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-4">
      <h3 className="mb-1 border-b pb-1 text-sm font-semibold uppercase tracking-wide">
        {title}
      </h3>
      <dl className="space-y-0.5">{children}</dl>
    </div>
  );
}

function Row({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="flex justify-between text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={strong ? "font-bold" : ""}>{value}</dd>
    </div>
  );
}
