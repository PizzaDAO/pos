/**
 * Kitchen ticket -> protocol-neutral `PrintTicketDoc` (fixed 42/48-column layout).
 *
 * Content: order number (large), channel, fulfilment type, time, every live line
 * with quantity/size, modifiers (half-and-half split LEFT/RIGHT) and line notes,
 * then the order note. Voided lines are skipped. All wrapping happens here, at
 * the printer's column width (a magnified line fits `columns / size` characters),
 * so the renderers never re-flow text.
 */
import type { Order, OrderItem } from "@/lib/db";
import { channelLabel, groupModifiersByPlacement } from "@/lib/kds/format";
import type { PrintLine, PrintTicketDoc, PrinterColumns } from "./types";

export interface BuildTicketOptions {
  columns: PrinterColumns;
  /** IANA zone used for the printed time; falls back to UTC. */
  timezone?: string | null;
  /** Prints a "REPRINT" banner. */
  reprint?: boolean;
}

/** Greedy word wrap to `width`, hard-splitting words longer than the line. */
export function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r/g, "").split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      let w = word;
      while (w.length > width) {
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(w.slice(0, width));
        w = w.slice(width);
      }
      if (!line) line = w;
      else if (line.length + 1 + w.length <= width) line += ` ${w}`;
      else {
        out.push(line);
        line = w;
      }
    }
    out.push(line);
  }
  return out;
}

/** Printer-safe text: single-byte-ish, no control chars or markup brackets. */
export function cleanText(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/×/g, "x")
    // Backslash may be an escape in Star markup (unverified) and is a yen sign in
    // some code pages; a slash is always safe on a kitchen ticket.
    .replace(/\\/g, "/")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[\[\]]/g, (c) => (c === "[" ? "(" : ")"))
    .replace(/[^\x20-\x7e\n]/gu, "?");
}

function fulfilmentLabel(order: Order): string {
  const f = order.fulfillment;
  if (f?.type === "delivery") return "DELIVERY";
  if (f?.type === "pickup") return "PICKUP";
  return order.channel === "in_store" ? "COUNTER / DINE-IN" : channelLabel(order.channel).toUpperCase();
}

function formatTime(iso: string, timezone?: string | null): string {
  const d = new Date(iso);
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || "UTC",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 16).replace("T", " ");
  }
}

/** Left text + right text on one `width` line (right truncates the gap, never the left). */
function leftRight(left: string, right: string, width: number): string {
  const gap = width - left.length - right.length;
  return gap >= 1 ? left + " ".repeat(gap) + right : `${left} ${right}`;
}

export function buildTicketDoc(order: Order, opts: BuildTicketOptions): PrintTicketDoc {
  const cols = opts.columns;
  const lines: PrintLine[] = [];
  const push = (text: string, extra: Partial<PrintLine> = {}) => {
    const size = extra.size ?? 1;
    for (const t of wrapText(cleanText(text), Math.floor(cols / size))) {
      lines.push({ text: t, ...extra });
    }
  };
  const rule = () => lines.push({ text: "", rule: true });

  if (opts.reprint) push("*** REPRINT ***", { bold: true, align: "center" });

  const num = cleanText(order.order_number);
  push(num, { size: num.length * 3 <= cols ? 3 : 2, bold: true, align: "center" });
  push(fulfilmentLabel(order), { size: 2, bold: true, align: "center" });
  const callout = order.core_ext?.callout_name;
  if (callout) push(callout, { bold: true, align: "center" });
  push(
    `${channelLabel(order.channel)}  ${formatTime(order.created_at, opts.timezone)}`,
    { align: "center" },
  );
  const sched = order.fulfillment?.scheduled_for;
  if (sched && sched !== "asap") {
    push(`FOR ${formatTime(sched, opts.timezone)}`, { bold: true, align: "center" });
  }
  rule();

  const live = order.items.filter((i) => !i.voided);
  for (const item of live) pushItem(item, push);
  if (live.length === 0) push("(no items)", { align: "center" });

  if (order.notes) {
    rule();
    push(`NOTE: ${order.notes}`, { bold: true });
  }
  rule();
  const count = live.reduce((n, i) => n + i.quantity, 0);
  push(leftRight(`${count} item${count === 1 ? "" : "s"}`, order.order_number, cols));
  return { lines };
}

function pushItem(
  item: OrderItem,
  push: (text: string, extra?: Partial<PrintLine>) => void,
): void {
  const size = item.size_name ? ` (${item.size_name})` : "";
  push(`${item.quantity}x ${item.item_name}${size}`, { bold: true });
  const g = groupModifiersByPlacement(item.modifiers);
  const names = (ms: typeof g.whole) => ms.map((m) => m.modifier_name).join(", ");
  if (g.whole.length) push(`   + ${names(g.whole)}`);
  if (g.left.length) push(`   LEFT: ${names(g.left)}`);
  if (g.right.length) push(`   RIGHT: ${names(g.right)}`);
  if (item.notes) push(`   ** ${item.notes}`, { bold: true });
}

/** A short ticket to prove a printer is wired up (admin "Print test ticket"). */
export function buildTestDoc(
  opts: { columns: PrinterColumns; label: string; locationName?: string },
): PrintTicketDoc {
  const cols = opts.columns;
  const lines: PrintLine[] = [];
  const add = (text: string, extra: Partial<PrintLine> = {}) => {
    for (const t of wrapText(cleanText(text), Math.floor(cols / (extra.size ?? 1)))) {
      lines.push({ text: t, ...extra });
    }
  };
  add("TEST TICKET", { size: 2, bold: true, align: "center" });
  if (opts.locationName) add(opts.locationName, { align: "center" });
  add(opts.label || "Kitchen printer", { align: "center" });
  lines.push({ text: "", rule: true });
  add("Printer is connected.", { align: "center" });
  add(`${cols}-column layout`, { align: "center" });
  add("1234567890".repeat(5).slice(0, cols));
  return { lines };
}

/**
 * A VOID ticket: food that was already sent to the kitchen and has just been
 * voided (some lines, or the whole order). Big STOP banner, the order number
 * and what to stop making, so a line working from paper tickets stops too.
 */
export function buildVoidTicketDoc(
  order: Order,
  items: OrderItem[],
  opts: BuildTicketOptions & { scope: "order" | "lines"; reason?: string | null; at?: string },
): PrintTicketDoc {
  const cols = opts.columns;
  const lines: PrintLine[] = [];
  const push = (text: string, extra: Partial<PrintLine> = {}) => {
    const size = extra.size ?? 1;
    for (const t of wrapText(cleanText(text), Math.floor(cols / size))) {
      lines.push({ text: t, ...extra });
    }
  };
  const rule = () => lines.push({ text: "", rule: true });
  push("*** VOID ***", { size: 2, bold: true, align: "center" });
  const num = cleanText(order.order_number);
  push(num, { size: num.length * 3 <= cols ? 3 : 2, bold: true, align: "center" });
  push(opts.scope === "order" ? "WHOLE ORDER - STOP" : "STOP MAKING:", {
    size: 2,
    bold: true,
    align: "center",
  });
  push(formatTime(opts.at ?? new Date().toISOString(), opts.timezone), { align: "center" });
  rule();
  for (const item of items) pushItem(item, push);
  if (items.length === 0) push("(no items)", { align: "center" });
  if (opts.reason) {
    rule();
    push(`REASON: ${opts.reason}`);
  }
  return { lines };
}
