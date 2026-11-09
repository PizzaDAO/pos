/**
 * Renderers: `PrintTicketDoc` -> what each protocol accepts.
 *
 *  - Star CloudPRNT `text/vnd.star.markup`: Star Document Markup, the simplest
 *    format CloudPRNT firmware takes that still gives big/bold text (no byte
 *    encoding, no StarPRNT command mapping). `text/plain` is the fallback for
 *    printers whose firmware lacks markup (per-printer `format: "text"`).
 *  - Epson Server Direct Print: ePOS-Print XML (`<epos-print>`).
 */
import type { PrintLine, PrintTicketDoc, PrinterColumns } from "./types";

export interface Rendered {
  contentType: string;
  body: string;
}

export const STAR_MARKUP_TYPE = "text/vnd.star.markup";
export const STAR_TEXT_TYPE = "text/plain";

function ruleText(cols: number): string {
  return "-".repeat(cols);
}

export function renderStarMarkup(doc: PrintTicketDoc, cols: PrinterColumns): Rendered {
  const out: string[] = [];
  for (const l of doc.lines) {
    const size = l.size ?? 1;
    const align = l.align === "center" ? "centre" : "left";
    out.push(
      `[align: ${align}][magnify: width ${size}; height ${size}][bold: ${l.bold ? "on" : "off"}]${
        l.rule ? ruleText(cols) : l.text
      }`,
    );
  }
  out.push("[magnify: width 1; height 1][bold: off][align: left][cut: feed; partial]");
  return { contentType: STAR_MARKUP_TYPE, body: out.join("\n") + "\n" };
}

function pad(l: PrintLine, cols: PrinterColumns): string {
  if (l.rule) return ruleText(cols);
  const width = Math.floor(cols / (l.size ?? 1));
  const text = l.size && l.size > 1 ? l.text.toUpperCase() : l.text;
  if (l.align !== "center") return text;
  // Magnified characters take `size` cells, so centre against the real width.
  const spaces = Math.max(0, Math.floor((width - text.length) / 2)) * (l.size ?? 1);
  return " ".repeat(spaces) + text;
}

export function renderPlainText(doc: PrintTicketDoc, cols: PrinterColumns): Rendered {
  return {
    contentType: STAR_TEXT_TYPE,
    body: doc.lines.map((l) => pad(l, cols)).join("\n") + "\n\n\n",
  };
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The `<epos-print>` document (no SDP envelope). */
export function renderEposPrint(doc: PrintTicketDoc, cols: PrinterColumns): string {
  const parts: string[] = [];
  for (const l of doc.lines) {
    const size = l.size ?? 1;
    parts.push(
      `<text align="${l.align === "center" ? "center" : "left"}"/>`,
      `<text width="${size}" height="${size}"/>`,
      `<text em="${l.bold ? "true" : "false"}"/>`,
      `<text>${xmlEscape(l.rule ? ruleText(cols) : l.text)}&#10;</text>`,
    );
  }
  parts.push(
    '<text width="1" height="1"/>',
    '<text em="false"/>',
    '<text align="left"/>',
    '<feed line="2"/>',
    '<cut type="feed"/>',
  );
  return `<epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print">${parts.join("")}</epos-print>`;
}

/**
 * Server Direct Print response to a `GetRequest` poll: the job wrapped in
 * `PrintRequestInfo`. `printjobid` comes back in the printer's `SetResponse`.
 */
export function renderEpsonSdp(
  doc: PrintTicketDoc,
  cols: PrinterColumns,
  printJobId: string,
): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<PrintRequestInfo><ePOSPrint><Parameter><devid>local_printer</devid>` +
    `<timeout>10000</timeout><printjobid>${xmlEscape(printJobId)}</printjobid></Parameter>` +
    `<PrintData>${renderEposPrint(doc, cols)}</PrintData></ePOSPrint></PrintRequestInfo>`
  );
}
