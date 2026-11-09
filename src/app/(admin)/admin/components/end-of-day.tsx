/**
 * End-of-day Z-report (Phase 5, /admin → End of day).
 *
 * Per-location business-day close: gross/net, tax, tips, fees, payment mix,
 * voids/refunds, order counts by channel, and a drawer summary. CLOSE is
 * idempotent (re-closing the same day returns the frozen snapshot). Close day
 * asks first: a confirm dialog with the day's orders, expected cash vs the cash
 * counted now (over/short live) and a warning for drawers still open. The
 * default business date is TODAY AT THE LOCATION (its time zone and cutoff,
 * `locationBusinessDate`), not UTC, and the report buckets by the same rule. Includes a print-friendly layout (browser print CSS
 * hides the chrome). Talks to /api/admin/eod. No env vars.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Lock, Printer, Receipt } from "lucide-react";
import type { BusinessDayClose, SalesReport } from "@/lib/db";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { formatMoney } from "@/lib/pricing";
import { locationBusinessDate, railFamily } from "@/lib/reports";

interface Props {
  tenantId: string;
  locationId: string;
  /** Display name for the active location (Phase 6 — locations are dynamic). */
  locationName?: string;
  /** Tenant (business) name for the report title. */
  tenantName?: string;
  /** IANA time zone of the location (the business date is local to it). */
  timezone?: string;
  /** Minutes after local midnight the business day starts (default 0). */
  cutoffMinutes?: number;
}

/**
 * Today's business date at the location: local date in its zone, less its
 * cutoff (the same rule the Z-report and owner reports bucket by).
 */
export function todayInZone(
  timezone: string | undefined,
  now = new Date(),
  cutoffMinutes = 0,
): string {
  return locationBusinessDate(now.toISOString(), {
    timezone,
    business_day_cutoff_minutes: cutoffMinutes,
  });
}

/** "Mon, Nov 9" for a yyyy-mm-dd business date. */
function prettyDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

interface EodData {
  close: BusinessDayClose | null;
  closed: boolean;
  report?: SalesReport;
  /** Live drawer preview (not yet closed). */
  drawer?: BusinessDayClose["drawer"];
}

export function EndOfDay({
  tenantId,
  locationId,
  locationName: locName,
  tenantName,
  timezone,
  cutoffMinutes = 0,
}: Props) {
  const [date, setDate] = useState(() =>
    todayInZone(timezone, new Date(), cutoffMinutes),
  );
  // Until the manager picks a date, follow the location's (late-loading) zone.
  const [dateTouched, setDateTouched] = useState(false);
  useEffect(() => {
    if (!dateTouched) setDate(todayInZone(timezone, new Date(), cutoffMinutes));
  }, [timezone, cutoffMinutes, dateTouched]);
  const [data, setData] = useState<EodData | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [counted, setCounted] = useState("");

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

  const countedCents = (() => {
    const v = parseFloat(counted);
    return counted.trim() !== "" && Number.isFinite(v) && v >= 0
      ? Math.round(v * 100)
      : null;
  })();

  async function close() {
    setConfirming(false);
    setBusy(true);
    try {
      await fetch("/api/admin/eod", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId,
          locationId,
          date,
          ...(countedCents !== null ? { countedCents } : {}),
        }),
      });
      setCounted("");
      await load();
    } finally {
      setBusy(false);
    }
  }

  const report = data?.close?.report ?? data?.report ?? null;
  const drawer = data?.close?.drawer ?? data?.drawer ?? null;
  const closed = data?.closed ?? false;
  const locationName = locName ?? locationId;
  const businessName = tenantName?.trim() || locationName;
  const expectedCents = drawer?.expected_cents ?? 0;
  const overShort = countedCents !== null ? countedCents - expectedCents : null;
  const openDrawers = drawer?.open_drawer_count ?? 0;

  const family = { cash: 0, card: 0, crypto: 0, other: 0 };
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
              onChange={(e) => {
                setDateTouched(true);
                setDate(e.target.value);
              }}
            />
          </label>
          {!closed && (
            <Button
              size="sm"
              disabled={busy || !report}
              onClick={() => setConfirming(true)}
            >
              <Lock className="h-4 w-4" /> Close day
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => window.print()}>
            <Printer className="h-4 w-4" /> Print
          </Button>
        </div>
      </div>

      {confirming && report && (
        <ConfirmDialog
          title={`Close ${prettyDate(date)}?`}
          destructive={false}
          confirmLabel="Close day"
          onCancel={() => setConfirming(false)}
          onConfirm={() => void close()}
          description={
            <span className="block space-y-3 text-foreground">
              <span className="block">
                {report.order_count} order{report.order_count === 1 ? "" : "s"} ·
                net {formatMoney(report.net_cents)}. This freezes the Z-report
                for {locationName}; it can&apos;t be reopened.
              </span>
              {openDrawers > 0 && (
                <span
                  role="alert"
                  className="block rounded-md bg-amber-500/15 p-2 font-medium text-amber-800 dark:text-amber-300"
                >
                  {openDrawers} drawer{openDrawers === 1 ? " is" : "s are"} still
                  open: close {openDrawers === 1 ? "it" : "them"} in Staff &amp;
                  drawer first, or {openDrawers === 1 ? "its" : "their"} cash is
                  not in Expected.
                </span>
              )}
              <span className="flex justify-between">
                <span className="text-muted-foreground">
                  Expected cash
                  {drawer?.expected_source === "sales" ? " (cash sales)" : ""}
                </span>
                <span className="font-semibold tabular-nums">
                  {formatMoney(expectedCents)}
                </span>
              </span>
              <label className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Counted cash</span>
                <span className="flex items-center gap-1">
                  $
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    aria-label="Counted cash"
                    value={counted}
                    onChange={(e) => setCounted(e.target.value)}
                    placeholder={(expectedCents / 100).toFixed(2)}
                    className="h-11 w-28 rounded-md border bg-background px-2 text-right"
                  />
                </span>
              </label>
              <span className="flex justify-between">
                <span className="text-muted-foreground">Over / short</span>
                <span
                  data-testid="eod-over-short"
                  className={
                    overShort === null
                      ? "text-muted-foreground"
                      : overShort < 0
                        ? "font-bold text-destructive"
                        : "font-bold"
                  }
                >
                  {overShort === null
                    ? "Count the drawer"
                    : `${overShort > 0 ? "+" : ""}${formatMoney(overShort)}`}
                </span>
              </span>
            </span>
          }
        />
      )}

      {!report ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="rounded-xl border p-6 print:border-0 print:p-0">
          <div className="mb-4 text-center">
            <h1 className="text-xl font-bold">{businessName} — Z-Report</h1>
            <p className="text-sm text-muted-foreground">
              {locationName} · {prettyDate(date)} ({date})
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
            {(report.order_fees_cents ?? 0) > 0 && (
              <Row label="Order fees" value={formatMoney(report.order_fees_cents ?? 0)} />
            )}
            <Row label="Tips" value={formatMoney(report.tip_cents)} />
            <Row label="Platform fees" value={formatMoney(report.fees_cents)} />
          </Section>

          <Section title="Payment mix">
            <Row label="Cash" value={formatMoney(family.cash)} />
            <Row label="Card" value={formatMoney(family.card)} />
            <Row label="Crypto" value={formatMoney(family.crypto)} />
            {family.other > 0 && <Row label="Other" value={formatMoney(family.other)} />}
          </Section>

          {report.stored_value &&
            (report.stored_value.sold_cents > 0 || report.stored_value.redeemed_count > 0) && (
              <Section title="Gift cards (liability, not sales)">
                <Row
                  label="Sold"
                  value={`${report.stored_value.sold_count} · ${formatMoney(report.stored_value.sold_cents)}`}
                />
                <Row label="  paid in cash" value={formatMoney(report.stored_value.sold_by_family.cash)} />
                <Row label="  paid by card" value={formatMoney(report.stored_value.sold_by_family.card)} />
                {report.stored_value.sold_refunded_cents > 0 && (
                  <Row label="Sales refunded (voided)" value={formatMoney(report.stored_value.sold_refunded_cents)} />
                )}
                <Row
                  label="Redeemed (gift card / store credit)"
                  value={`${formatMoney(report.stored_value.redeemed_gift_card_cents)} / ${formatMoney(report.stored_value.redeemed_store_credit_cents)}`}
                />
                {report.stored_value.returned_to_card_cents > 0 && (
                  <Row label="Returned to cards" value={formatMoney(report.stored_value.returned_to_card_cents)} />
                )}
              </Section>
            )}

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
              label="Refunds (incl. partial)"
              value={`${report.refund_count} · ${formatMoney(report.refund_cents)}`}
            />
            {(report.tip_refund_cents ?? 0) > 0 && (
              <Row
                label="  of which tip refunds (flagged)"
                value={formatMoney(report.tip_refund_cents ?? 0)}
              />
            )}
            {(report.comp_count ?? 0) > 0 && (
              <Row
                label="Comps (in discounts)"
                value={`${report.comp_count} · ${formatMoney(report.comp_cents ?? 0)}`}
              />
            )}
            {(report.line_void_count ?? 0) > 0 && (
              <Row
                label="Items voided"
                value={`${report.line_void_count} · ${formatMoney(report.line_void_cents ?? 0)}`}
              />
            )}
          </Section>

          {drawer && (
            <Section title="Drawer summary">
              <Row label="Shifts closed" value={String(drawer.shift_count)} />
              {(drawer.open_drawer_count ?? 0) > 0 && (
                <Row
                  label="Drawers still open"
                  value={String(drawer.open_drawer_count)}
                />
              )}
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
              <Row
                label={drawer.counted_at_close ? "Counted at close" : "Counted"}
                value={formatMoney(drawer.counted_cents)}
              />
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
            Generated by {businessName} POS — back office
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
