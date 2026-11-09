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
import { after } from "next/server";
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
/**
 * Served-but-unconfirmed jobs become claimable again after this. Long enough for
 * a slow printer to print and confirm (a premature reclaim risks a duplicate
 * ticket), short enough that a dropped confirm is retried within the shift rush.
 */
export const RECLAIM_MS = 120_000;
/** A failed print (paper out, cover open) is retried this many times in total... */
export const MAX_PRINT_ATTEMPTS = 4;
/** ...waiting 30 s, 60 s, 120 s between attempts (still bounded by the job's expiry). */
export function retryBackoffMs(attempts: number): number {
  return 30_000 * 2 ** Math.max(0, attempts - 1);
}
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

/**
 * Printer's verdict. Idempotent: repeats and unknown/foreign ids are harmless
 * no-ops. A failure is retried with backoff until `MAX_PRINT_ATTEMPTS` or expiry,
 * then it is final (`failed`) and shows in the "not printed" banner with a Retry.
 */
export async function confirm(
  printer: Printer,
  jobId: string,
  outcome: { ok: true } | { ok: false; error: string },
  now = new Date(),
): Promise<PrintJob | null> {
  const driver = getPosDriver();
  if (outcome.ok) return driver.completePrintJob(printer.id, jobId, outcome, now.toISOString());
  const job = await driver.getPrintJobForPrinter(printer.id, jobId);
  if (!job) return null;
  const retryAt = new Date(now.getTime() + retryBackoffMs(job.attempts));
  const retryable = job.attempts < MAX_PRINT_ATTEMPTS && retryAt.toISOString() < job.expires_at;
  return driver.completePrintJob(
    printer.id,
    jobId,
    { ...outcome, retryAt: retryable ? retryAt.toISOString() : null },
    now.toISOString(),
  );
}

/** Rotate: new secret, old token stops working immediately. Returns the new token. */
export async function rotatePrinterToken(
  tenantId: string,
  printerId: string,
): Promise<{ printer: Printer; token: string } | null> {
  const { secret, hash } = generatePrinterSecret();
  const printer = await getPosDriver().setPrinterTokenHash(tenantId, printerId, hash);
  return printer ? { printer, token: formatToken(printer.id, secret) } : null;
}

/** Canonical public origin for setup URLs: configured app URL, else the request's. */
export function publicOrigin(requestUrl: string): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      /* fall through */
    }
  }
  return new URL(requestUrl).origin;
}

export interface PrintHealth {
  /** Final-failed, still-printable tickets (not yet expired). */
  failedCount: number;
  lastError: string | null;
  offlinePrinters: string[];
}

/** What the KDS / admin banner shows for a location. */
export async function printHealth(
  tenantId: string,
  locationId: string,
  now = new Date(),
): Promise<PrintHealth> {
  const driver = getPosDriver();
  const [printers, jobs] = await Promise.all([
    driver.listPrinters(tenantId, locationId),
    driver.listPrintJobs(tenantId, locationId, 50),
  ]);
  const failed = jobs.filter((j) => j.status === "failed" && j.expires_at > now.toISOString());
  return {
    failedCount: failed.length,
    lastError: failed[0]?.error ?? null,
    offlinePrinters: printers.filter((p) => !isOnline(p, now.getTime())).map((p) => p.label),
  };
}

export async function retryFailed(tenantId: string, locationId: string, now = new Date()): Promise<number> {
  return getPosDriver().retryFailedPrintJobs(tenantId, locationId, now.toISOString());
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
    // A second ticket for the same order on the same printer is flagged REPRINT so
    // the line never mistakes a duplicate for a new order.
    const prior = opts.reprint || (await driver.hasPrintJobForOrder(p.id, order.id));
    jobs.push(
      await driver.enqueuePrintJob({
        tenant_id: order.tenant_id,
        location_id: order.location_id,
        printer_id: p.id,
        order_id: order.id,
        kind: "ticket",
        document: buildTicketDoc(order, { columns: p.columns, timezone, reprint: prior }),
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

/**
 * Run `autoPrintOnFire` after the response is sent (Next `after()`), so printer
 * lookups never add latency to the money path. Outside a request scope (tests,
 * scripts) it falls back to fire-and-forget. Never throws.
 */
export function scheduleAutoPrint(order: Order): void {
  const run = () => autoPrintOnFire(order).then(() => undefined);
  try {
    after(run);
  } catch {
    void run();
  }
}

/** Whether the printer polled recently. */
export function isOnline(printer: Printer, now = Date.now()): boolean {
  return !!printer.last_seen_at && now - Date.parse(printer.last_seen_at) < ONLINE_WINDOW_MS;
}
