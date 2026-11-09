/**
 * Network kitchen printing: shared types.
 *
 * A `PrintTicketDoc` is protocol-neutral (a list of styled lines). It is stored
 * on the job and rendered to Star markup / plain text / ePOS-Print XML only when
 * the printer fetches it, so one queue serves every protocol and column width.
 */

export type PrinterProtocol = "star_cloudprnt" | "epson_sdp";
/** Star only. Epson always receives ePOS-Print XML. */
export type PrinterFormat = "markup" | "text";
export type PrinterColumns = 42 | 48;

export type PrintJobStatus = "queued" | "sent" | "done" | "failed" | "expired";
export type PrintJobKind = "ticket" | "test";

export interface PrintLine {
  text: string;
  /** Character magnification: 1 normal, 2 double width+height, 3 triple. */
  size?: 1 | 2 | 3;
  bold?: boolean;
  align?: "left" | "center";
  /** Draw a full-width rule instead of text. */
  rule?: boolean;
}

export interface PrintTicketDoc {
  lines: PrintLine[];
}

/** A registered printer. `token_hash` is sha256(secret): never sent to clients. */
export interface Printer {
  id: string;
  tenant_id: string;
  location_id: string;
  label: string;
  protocol: PrinterProtocol;
  format: PrinterFormat;
  columns: PrinterColumns;
  token_hash: string;
  last_seen_at: string | null;
  created_at: string;
}

export interface PrintJob {
  id: string;
  tenant_id: string;
  location_id: string;
  printer_id: string;
  order_id: string | null;
  kind: PrintJobKind;
  document: PrintTicketDoc;
  status: PrintJobStatus;
  attempts: number;
  error: string | null;
  dedupe_key: string | null;
  created_at: string;
  expires_at: string;
  claimed_at: string | null;
  done_at: string | null;
  /** Failed attempts are retried (status back to queued) but not before this. */
  retry_after: string | null;
}

export interface PrintLocationSettings {
  location_id: string;
  tenant_id: string;
  /** Print a ticket on every printer at the location when an order fires. Off by default. */
  auto_print: boolean;
  updated_at: string;
}
