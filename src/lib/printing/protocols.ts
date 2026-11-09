/**
 * Device-facing protocol handlers, kept free of Next types so they are unit
 * testable. The routes under `src/app/api/print/` are thin wrappers.
 *
 * Star CloudPRNT (HTTP, printer-initiated, https://starmicronics.com/cloudprnt):
 *   POST   <url>                      poll. JSON status in, `{jobReady, mediaTypes, jobToken}` out
 *   GET    <url>?type=..&token=<job>  fetch the job body
 *   DELETE <url>?code=200%20OK&token=<job>   confirm (non-2xx code = print failed)
 *
 * Epson Server Direct Print (printer polls with form-encoded POSTs):
 *   ConnectionType=GetRequest  -> a `PrintRequestInfo` XML (or empty 200 = nothing to print)
 *   ConnectionType=SetResponse -> ResponseFile `<response success="true|false" .../>`
 *
 * Auth for both: the device token in the URL path (see `tokens.ts`). A bad token
 * is always 401 with no detail, whether the printer id or the secret was wrong.
 */
import { authenticatePrinter, claimNext, confirm, getServable, markSeen } from "./queue";
import {
  renderEpsonSdp,
  renderPlainText,
  renderStarMarkup,
  STAR_MARKUP_TYPE,
  STAR_TEXT_TYPE,
  type Rendered,
} from "./render";
import type { PrintJob, Printer } from "./types";

export interface DeviceResponse {
  status: number;
  contentType?: string;
  body?: string;
}

const unauthorized: DeviceResponse = {
  status: 401,
  contentType: "application/json",
  body: JSON.stringify({ error: "Unauthorized" }),
};
const json = (status: number, v: unknown): DeviceResponse => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(v),
});

function renderStar(printer: Printer, job: PrintJob): Rendered {
  return printer.format === "text"
    ? renderPlainText(job.document, printer.columns)
    : renderStarMarkup(job.document, printer.columns);
}

export async function starPoll(token: string): Promise<DeviceResponse> {
  const printer = await authenticatePrinter(token, "star_cloudprnt");
  if (!printer) return unauthorized;
  await markSeen(printer);
  const job = await claimNext(printer);
  if (!job) return json(200, { jobReady: false });
  return json(200, {
    jobReady: true,
    mediaTypes: [printer.format === "text" ? STAR_TEXT_TYPE : STAR_MARKUP_TYPE],
    jobToken: job.id,
  });
}

export async function starGetJob(token: string, jobToken: string | null): Promise<DeviceResponse> {
  const printer = await authenticatePrinter(token, "star_cloudprnt");
  if (!printer) return unauthorized;
  await markSeen(printer);
  // No job token (a printer that ignored ours): serve the next claimable job.
  const job = jobToken ? await getServable(printer, jobToken) : await claimNext(printer);
  if (!job) return { status: 404 };
  const r = renderStar(printer, job);
  return { status: 200, contentType: `${r.contentType}; charset=utf-8`, body: r.body };
}

export async function starConfirm(
  token: string,
  jobToken: string | null,
  code: string | null,
): Promise<DeviceResponse> {
  const printer = await authenticatePrinter(token, "star_cloudprnt");
  if (!printer) return unauthorized;
  if (jobToken) {
    const ok = !code || /^2/.test(code.trim());
    await confirm(printer, jobToken, ok ? { ok: true } : { ok: false, error: (code ?? "").slice(0, 200) });
  }
  // Idempotent: unknown/duplicate/foreign job tokens still acknowledge.
  return { status: 200 };
}

/** Epson printjobid <= 30 chars: the job uuid as 22-char base64url. */
export function encodeJobId(uuid: string): string {
  return Buffer.from(uuid.replace(/-/g, ""), "hex").toString("base64url");
}
export function decodeJobId(id: string): string | null {
  const hex = Buffer.from(id, "base64url").toString("hex");
  if (hex.length !== 32) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function epsonRequest(token: string, rawBody: string): Promise<DeviceResponse> {
  const printer = await authenticatePrinter(token, "epson_sdp");
  if (!printer) return unauthorized;
  await markSeen(printer);
  const form = new URLSearchParams(rawBody);
  const type = form.get("ConnectionType");

  if (type === "GetRequest") {
    const job = await claimNext(printer);
    if (!job) return { status: 200, contentType: "text/xml; charset=utf-8", body: "" };
    return {
      status: 200,
      contentType: "text/xml; charset=utf-8",
      body: renderEpsonSdp(job.document, printer.columns, encodeJobId(job.id)),
    };
  }

  if (type === "SetResponse") {
    const xml = form.get("ResponseFile") ?? "";
    const idRaw = /printjobid="?([A-Za-z0-9_-]+)"?|<printjobid>([A-Za-z0-9_-]+)<\/printjobid>/i.exec(xml);
    const jobId = idRaw ? decodeJobId(idRaw[1] ?? idRaw[2] ?? "") : null;
    const printJobId = form.get("PrintJobId") ?? form.get("printjobid");
    const id = jobId ?? (printJobId ? decodeJobId(printJobId) : null);
    if (id) {
      const ok = /success="true"/i.test(xml);
      const code = /code="([^"]*)"/.exec(xml)?.[1] ?? "";
      await confirm(printer, id, ok ? { ok: true } : { ok: false, error: `epson:${code}`.slice(0, 200) });
    }
    return { status: 200, contentType: "text/xml; charset=utf-8", body: "" };
  }

  return { status: 200, contentType: "text/xml; charset=utf-8", body: "" };
}
