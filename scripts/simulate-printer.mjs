#!/usr/bin/env node
/**
 * Simulated network printer (no hardware needed). Behaves like a Star CloudPRNT
 * or Epson Server Direct Print device: polls the setup URL, fetches a job,
 * "prints" it to stdout and confirms.
 *
 *   node scripts/simulate-printer.mjs <setup-url> [--once] [--fail] [--interval=2000]
 *
 * <setup-url> is the URL shown once in Admin > Printers
 * (http://localhost:3401/api/print/star/<token> or .../epson/<token>).
 * --once  exit after the first printed job   --fail  report a print failure
 */
const [url, ...flags] = process.argv.slice(2);
if (!url) {
  console.error("usage: node scripts/simulate-printer.mjs <setup-url> [--once] [--fail] [--interval=ms]");
  process.exit(2);
}
const once = flags.includes("--once");
const fail = flags.includes("--fail");
const interval = Number(flags.find((f) => f.startsWith("--interval="))?.split("=")[1] ?? 2000);
const epson = url.includes("/api/print/epson/");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tickStar() {
  const poll = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ printerMAC: "00:11:62:00:00:01", statusCode: "200 OK", status: "OK" }) });
  if (poll.status === 401) throw new Error("401: bad token");
  const p = await poll.json();
  if (!p.jobReady) return false;
  const sep = url.includes("?") ? "&" : "?";
  const job = await fetch(`${url}${sep}type=${encodeURIComponent(p.mediaTypes[0])}&token=${p.jobToken}`);
  console.log(`--- job ${p.jobToken} (${job.headers.get("content-type")}) ---\n${await job.text()}--- end ---`);
  const code = fail ? "52 Paper empty" : "200 OK";
  await fetch(`${url}${sep}token=${p.jobToken}&code=${encodeURIComponent(code)}`, { method: "DELETE" });
  console.log(`confirmed: ${code}`);
  return true;
}

async function tickEpson() {
  const form = (o) => new URLSearchParams(o).toString();
  const h = { "Content-Type": "application/x-www-form-urlencoded" };
  const res = await fetch(url, { method: "POST", headers: h, body: form({ ConnectionType: "GetRequest", ID: "sim", Name: "sim-epson" }) });
  if (res.status === 401) throw new Error("401: bad token");
  const xml = await res.text();
  const id = /<printjobid>([^<]+)<\/printjobid>/.exec(xml)?.[1];
  if (!id) return false;
  console.log(`--- job ${id} ---\n${xml}\n--- end ---`);
  const response = `<PrintResponseInfo><ePOSPrint><Parameter><printjobid>${id}</printjobid></Parameter><PrintResponse><response success="${!fail}" code="${fail ? "EPTR_COVER_OPEN" : ""}" status="251658262" battery="0"/></PrintResponse></ePOSPrint></PrintResponseInfo>`;
  await fetch(url, { method: "POST", headers: h, body: form({ ConnectionType: "SetResponse", ID: "sim", ResponseFile: response }) });
  console.log(`confirmed: success=${!fail}`);
  return true;
}

console.log(`simulated ${epson ? "Epson SDP" : "Star CloudPRNT"} printer polling ${url.replace(/\/[^/]+$/, "/<token>")}`);
for (;;) {
  const printed = await (epson ? tickEpson() : tickStar());
  if (printed && once) break;
  await sleep(interval);
}
