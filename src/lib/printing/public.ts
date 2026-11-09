/** Client-safe views of printers/jobs: never include `token_hash`. */
import { isOnline } from "./queue";
import type { Printer, PrintJob } from "./types";

export function publicPrinter(p: Printer) {
  return {
    id: p.id,
    label: p.label,
    protocol: p.protocol,
    format: p.format,
    columns: p.columns,
    lastSeenAt: p.last_seen_at,
    online: isOnline(p),
  };
}

export function publicJob(j: PrintJob) {
  return {
    id: j.id,
    printerId: j.printer_id,
    orderId: j.order_id,
    kind: j.kind,
    status: j.status,
    attempts: j.attempts,
    error: j.error,
    createdAt: j.created_at,
  };
}

/** The URL to paste into the printer, for a freshly created token. */
export function setupUrl(origin: string, protocol: Printer["protocol"], token: string): string {
  const seg = protocol === "star_cloudprnt" ? "star" : "epson";
  return `${origin}/api/print/${seg}/${token}`;
}
