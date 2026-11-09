/**
 * Print queue service (network kitchen printing).
 *
 * Producers (`enqueueOrderTicket`, `enqueueTestTicket`, `autoPrintOnFire`) write
 * per-printer jobs; the device-facing protocol routes call `authenticatePrinter`
 * then `claimNext` / `getClaimed` / `confirm`. Rules enforced here:
 *   - a printer only ever sees its own jobs (every driver call is keyed on the
 *     authenticated printer id; the token's printer id never comes from the body)
 *   - jobs expire (`JOB_TTL_MS`); an expired job is never served
 *   - a job served but not confirmed within `RECLAIM_MS` is served again
 *     (printer retry after a dropped confirm)
 *   - confirm is idempotent; reprint = enqueue a fresh job (no dedupe key)
 */
import { getPosDriver } from "@/lib/db";
import { isLiveOrderStatus } from "@/lib/db/menu-types";
import type { Order } from "@/lib/db";
import { captureError } from "@/lib/observability";
import { buildTestDoc, buildTicketDoc } from "./ticket";
import {
  formatToken,
  generatePrinterSecret,
  parseToken,
  secretMatches,
} from "./tokens";
import type {
  Printer,
  PrinterColumns,
  PrinterFormat,
  PrinterProtocol,
  PrintJob,
} from "./types";

/** A ticket nobody collected for this long is stale: don't print it hours later. */
export const JOB_TTL_MS = 30 * 60_000;
export const TEST_JOB_TTL_MS = 10 * 60_000;
/** Served-but-unconfirmed jobs become claimable again after this. */
export const RECLAIM_MS = 60_000;
/** A printer polled within this window counts as online in the admin UI. */
export const ONLINE_WINDOW_MS = 2 * 60_000;

export interface NewPrinterInput {
  tenantId: string;
  locationId: string;
  label: string;
  protocol: PrinterProtocol;
  format?: PrinterFormat;
  columns?: PrinterColumns;
}

/** Create a printer; the returned `token` is the only time the secret exists in the clear. */
export async function createPrinter(
  input: NewPrinterInput,
): Promise<{ printer: Printer; token: string }> {
  const { secret, hash } = generatePrinterSecret();
  const printer = await getPosDriver().createPrinter({
    tenant_id: input.tenantId,
    location_id: input.locationId,
    label: input.label.trim().slice(0, 60),
    protocol: input.protocol,
    format: input.protocol === "star_cloudprnt" ? (input.format ?? "markup") : "markup",
    columns: input.columns ?? 42,
    token_hash: hash,
  });
  return { printer, token: formatToken(printer.id, secret) };
}

/** Resolve the printer a device token belongs to, or null (unknown id / wrong secret / wrong protocol). */
export async function authenticatePrinter(
  token: string,
  protocol: PrinterProtocol,
): Promise<Printer | null> {
  const parsed = parseToken(token);
  if (!parsed) return null;
  const printer = await getPosDriver().getPrinter(parsed.printerId);
  if (!printer || printer.protocol !== protocol) return null;
  return secretMatches(parsed.secret, printer.token_hash) ? printer : null;
}

/** Record that the printer checked in, sweep its overdue jobs. */
export async function markSeen(printer: Printer, now = new Date()): Promise<void> {
  const driver = getPosDriver();
  const iso = now.toISOString();
  await driver.touchPrinter(printer.id, iso);
  await driver.expirePrintJobs(printer.id, iso);
}

/** Claim the next job for this printer (served now, reclaimable after RECLAIM_MS). */
export async function claimNext(printer: Printer, now = new Date()): Promise<PrintJob | null> {
  return getPosDriver().claimPrintJob(
    printer.id,
    now.toISOString(),
    new Date(now.getTime() - RECLAIM_MS).toISOString(),
  );
}

/** The job named by the printer's token, only if it is its own and still servable. */
export async function getServable(
  printer: Printer,
  jobId: string,
  now = new Date(),
): Promise<PrintJob | null> {
  const job = await getPosDriver().getPrintJobForPrinter(printer.id, jobId);
  if (!job) return null;
  if (job.status !== "sent" && job.status !== "queued") return null;
  if (job.expires_at <= now.toISOString()) return null;
  return job;
}

/** Printer's verdict. Idempotent: repeats and unknown/foreign ids are harmless no-ops. */
export async function confirm(
  printer: Printer,
  jobId: string,
  outcome: { ok: true } | { ok: false; error: string },
  now = new Date(),
): Promise<PrintJob | null> {
  return getPosDriver().completePrintJob(printer.id, jobId, outcome, now.toISOString());
}

// ---------------------------------------------------------------------------
// Producers
// ---------------------------------------------------------------------------

async function locationTimezone(tenantId: string, locationId: string): Promise<string | null> {
  const locs = await getPosDriver().listLocations(tenantId);
  return locs.find((l) => l.id === locationId)?.timezone ?? null;
}

/**
 * Queue `order`'s ticket on every printer at its location (or just `printerId`).
 * `dedupeKey` makes it idempotent per printer (auto-print); omit it for a manual
 * print/reprint, which always queues a fresh ticket.
 */
export async function enqueueOrderTicket(
  order: Order,
  opts: { printerId?: string; reprint?: boolean; dedupeKey?: string } = {},
  now = new Date(),
): Promise<PrintJob[]> {
  const driver = getPosDriver();
  let printers = await driver.listPrinters(order.tenant_id, order.location_id);
  if (opts.printerId) printers = printers.filter((p) => p.id === opts.printerId);
  if (printers.length === 0) return [];
  const timezone = await locationTimezone(order.tenant_id, order.location_id);
  const expires = new Date(now.getTime() + JOB_TTL_MS).toISOString();
  const jobs: PrintJob[] = [];
  for (const p of printers) {
    jobs.push(
      await driver.enqueuePrintJob({
        tenant_id: order.tenant_id,
        location_id: order.location_id,
        printer_id: p.id,
        order_id: order.id,
        kind: "ticket",
        document: buildTicketDoc(order, { columns: p.columns, timezone, reprint: opts.reprint }),
        dedupe_key: opts.dedupeKey ?? null,
        expires_at: expires,
      }),
    );
  }
  return jobs;
}

export async function enqueueTestTicket(printer: Printer, now = new Date()): Promise<PrintJob> {
  const locs = await getPosDriver().listLocations(printer.tenant_id);
  const loc = locs.find((l) => l.id === printer.location_id);
  return getPosDriver().enqueuePrintJob({
    tenant_id: printer.tenant_id,
    location_id: printer.location_id,
    printer_id: printer.id,
    order_id: null,
    kind: "test",
    document: buildTestDoc({
      columns: printer.columns,
      label: printer.label,
      locationName: loc?.name,
    }),
    dedupe_key: null,
    expires_at: new Date(now.getTime() + TEST_JOB_TTL_MS).toISOString(),
  });
}

/**
 * Auto-print hook for the moment an order fires to the kitchen. No-op unless the
 * location's `auto_print` setting is on (default off) and the order is live.
 * Idempotent per order+printer, and NEVER throws: printing must not fail a sale.
 */
export async function autoPrintOnFire(order: Order): Promise<number> {
  try {
    if (!isLiveOrderStatus(order.status) || order.hold) return 0;
    const settings = await getPosDriver().getPrintSettings(order.location_id);
    if (!settings?.auto_print) return 0;
    const jobs = await enqueueOrderTicket(order, { dedupeKey: `fire:${order.id}` });
    return jobs.length;
  } catch (err) {
    captureError(err, { scope: "print.autoPrintOnFire", orderId: order.id });
    return 0;
  }
}

/** Whether the printer polled recently. */
export function isOnline(printer: Printer, now = Date.now()): boolean {
  return !!printer.last_seen_at && now - Date.parse(printer.last_seen_at) < ONLINE_WINDOW_MS;
}
