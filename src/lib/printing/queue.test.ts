import { beforeEach, describe, expect, it } from "vitest";
import {
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_TENANT_ID,
  getPosDriver,
  type Order,
} from "@/lib/db";
import { resetMockOrders, resetMockPayments } from "@/lib/db/mock";
import {
  MAX_PRINT_ATTEMPTS,
  RECLAIM_MS,
  printHealth,
  publicOrigin,
  retryBackoffMs,
  retryFailed,
  rotatePrinterToken,
  scheduleAutoPrint,
  authenticatePrinter,
  autoPrintOnFire,
  claimNext,
  confirm,
  createPrinter,
  enqueueOrderTicket,
  enqueueTestTicket,
  getServable,
  isOnline,
  markSeen,
} from "./queue";
import {
  decodeJobId,
  encodeJobId,
  epsonRequest,
  starConfirm,
  starGetJob,
  starPoll,
} from "./protocols";
import { resolveTicketPrinter } from "./provider";

beforeEach(() => {
  resetMockOrders();
  resetMockPayments();
});

async function placeOrder(over: Partial<{ id: string; tenantId: string; locationId: string; status: "paid" | "draft" }> = {}): Promise<Order> {
  return getPosDriver().createOrder({
    id: over.id ?? crypto.randomUUID(),
    tenant_id: over.tenantId ?? DEMO_TENANT_ID,
    location_id: over.locationId ?? DEMO_LOCATION_DOWNTOWN_ID,
    channel: "in_store",
    currency: "USD",
    items: [],
    discount_cents: 0,
    totals: {
      subtotal_cents: 1000,
      discount_cents: 0,
      taxable_cents: 1000,
      tax_cents: 0,
      tip_cents: 0,
      total_cents: 1000,
    },
    notes: null,
    status: over.status ?? "paid",
  });
}

async function rival() {
  const driver = getPosDriver();
  const { tenant } = await driver.createTenant({
    businessName: `Rival ${Math.random().toString(36).slice(2, 7)}`,
    ownerEmail: `o-${Math.random().toString(36).slice(2, 7)}@rival.example`,
  });
  const location = await driver.createLocation({ tenant_id: tenant.id, name: "Rival Main" });
  return { tenantId: tenant.id, locationId: location.id };
}

const star = (label = "Kitchen") =>
  createPrinter({
    tenantId: DEMO_TENANT_ID,
    locationId: DEMO_LOCATION_DOWNTOWN_ID,
    label,
    protocol: "star_cloudprnt",
  });

describe("printer auth", () => {
  it("stores only a hash and authenticates the exact token", async () => {
    const { printer, token } = await star();
    expect(token.startsWith(`${printer.id}.`)).toBe(true);
    expect(printer.token_hash).toHaveLength(64);
    expect(token).not.toContain(printer.token_hash);
    expect((await authenticatePrinter(token, "star_cloudprnt"))?.id).toBe(printer.id);
  });

  it("rejects a wrong secret, a malformed token, an unknown printer and the wrong protocol", async () => {
    const { printer, token } = await star();
    expect(await authenticatePrinter(`${printer.id}.nope`, "star_cloudprnt")).toBeNull();
    expect(await authenticatePrinter("garbage", "star_cloudprnt")).toBeNull();
    expect(await authenticatePrinter(`${crypto.randomUUID()}.${token.split(".")[1]}`, "star_cloudprnt")).toBeNull();
    expect(await authenticatePrinter(token, "epson_sdp")).toBeNull();
  });

  it("a token stops working once the printer is deleted", async () => {
    const { printer, token } = await star();
    await getPosDriver().deletePrinter(DEMO_TENANT_ID, printer.id);
    expect(await authenticatePrinter(token, "star_cloudprnt")).toBeNull();
  });

  it("another tenant cannot delete a printer", async () => {
    const { printer } = await star();
    const other = await rival();
    expect(await getPosDriver().deletePrinter(other.tenantId, printer.id)).toBe(false);
    expect(await getPosDriver().getPrinter(printer.id)).not.toBeNull();
  });
});

describe("queue claim / confirm", () => {
  it("claims oldest first, once, and confirm is idempotent", async () => {
    const { printer } = await star();
    const o1 = await placeOrder();
    const o2 = await placeOrder();
    const [j1] = await enqueueOrderTicket(o1);
    await new Promise((r) => setTimeout(r, 2));
    const [j2] = await enqueueOrderTicket(o2);

    const c1 = await claimNext(printer);
    expect(c1?.id).toBe(j1!.id);
    expect(c1?.status).toBe("sent");
    expect(c1?.attempts).toBe(1);
    expect((await claimNext(printer))?.id).toBe(j2!.id);
    expect(await claimNext(printer)).toBeNull(); // both in flight

    const done = await confirm(printer, j1!.id, { ok: true });
    expect(done?.status).toBe("done");
    const again = await confirm(printer, j1!.id, { ok: true });
    expect(again?.status).toBe("done");
    expect(again?.done_at).toBe(done?.done_at);
    // A late failure report cannot flip a printed job.
    expect((await confirm(printer, j1!.id, { ok: false, error: "x" }))?.status).toBe("done");
  });

  it("re-serves an unconfirmed job after the reclaim window", async () => {
    const { printer } = await star();
    await enqueueOrderTicket(await placeOrder());
    const t0 = new Date();
    const first = await claimNext(printer, t0);
    expect(await claimNext(printer, new Date(t0.getTime() + RECLAIM_MS - 1000))).toBeNull();
    const retry = await claimNext(printer, new Date(t0.getTime() + RECLAIM_MS + 1000));
    expect(retry?.id).toBe(first?.id);
    expect(retry?.attempts).toBe(2);
  });

  it("expired jobs are never served", async () => {
    const { printer } = await star();
    const [job] = await enqueueOrderTicket(await placeOrder());
    const later = new Date(Date.parse(job!.expires_at) + 1000);
    expect(await claimNext(printer, later)).toBeNull();
    expect(await getServable(printer, job!.id, later)).toBeNull();
    await markSeen(printer, later);
    expect((await getPosDriver().getPrintJobForPrinter(printer.id, job!.id))?.status).toBe("expired");
    expect((await confirm(printer, job!.id, { ok: true }))?.status).toBe("expired");
  });

  it("a failed print is retried with backoff, then final, then Retry requeues it", async () => {
    const { printer } = await star();
    const [j] = await enqueueOrderTicket(await placeOrder());
    let now = new Date();
    for (let attempt = 1; attempt <= MAX_PRINT_ATTEMPTS; attempt++) {
      expect((await claimNext(printer, now))?.id).toBe(j!.id);
      const r = await confirm(printer, j!.id, { ok: false, error: "52 Paper empty" }, now);
      if (attempt < MAX_PRINT_ATTEMPTS) {
        expect(r?.status).toBe("queued");
        expect(r?.retry_after).toBe(new Date(now.getTime() + retryBackoffMs(attempt)).toISOString());
        // Not claimable during the backoff, claimable right after.
        expect(await claimNext(printer, new Date(now.getTime() + retryBackoffMs(attempt) - 1000))).toBeNull();
        now = new Date(now.getTime() + retryBackoffMs(attempt) + 1000);
      } else {
        expect(r?.status).toBe("failed");
        expect(r?.error).toBe("52 Paper empty");
      }
    }
    expect(await claimNext(printer, now)).toBeNull();
    const health = await printHealth(DEMO_TENANT_ID, DEMO_LOCATION_DOWNTOWN_ID);
    expect(health.failedCount).toBe(1);
    expect(health.lastError).toBe("52 Paper empty");
    expect(await retryFailed(DEMO_TENANT_ID, DEMO_LOCATION_DOWNTOWN_ID)).toBe(1);
    expect((await claimNext(printer))?.id).toBe(j!.id);
    expect((await printHealth(DEMO_TENANT_ID, DEMO_LOCATION_DOWNTOWN_ID)).failedCount).toBe(0);
  });

  it("retry never crosses tenants and skips expired jobs", async () => {
    const { printer } = await star();
    const other = await rival();
    const [j] = await enqueueOrderTicket(await placeOrder());
    for (let i = 0; i < MAX_PRINT_ATTEMPTS; i++) {
      await claimNext(printer, new Date(Date.now() + i * 1e6));
      await confirm(printer, j!.id, { ok: false, error: "x" }, new Date(Date.now() + i * 1e6));
    }
    expect(await retryFailed(other.tenantId, other.locationId)).toBe(0);
    expect(await getPosDriver().retryFailedPrintJobs(DEMO_TENANT_ID, DEMO_LOCATION_DOWNTOWN_ID, new Date(Date.parse(j!.expires_at) + 1).toISOString())).toBe(0);
  });

  it("reprint queues a fresh REPRINT-flagged job; a repeated manual send does not", async () => {
    const { printer } = await star();
    const order = await placeOrder();
    const [first] = await enqueueOrderTicket(order, { dedupeKey: `manual:${order.id}` });
    expect(first!.document.lines[0]!.text).not.toBe("*** REPRINT ***");
    const [again] = await enqueueOrderTicket(order, { dedupeKey: `manual:${order.id}` });
    expect(again!.id).toBe(first!.id); // refresh / second screen: no duplicate
    const [re] = await enqueueOrderTicket(order, { reprint: true });
    expect(re!.id).not.toBe(first!.id);
    expect(re!.document.lines[0]!.text).toBe("*** REPRINT ***");
    const jobs = await getPosDriver().listPrintJobs(DEMO_TENANT_ID, DEMO_LOCATION_DOWNTOWN_ID, 50);
    expect(jobs.filter((j) => j.printer_id === printer.id)).toHaveLength(2);
  });

  it("a manual send after the auto-print ticket is flagged REPRINT", async () => {
    await star();
    await getPosDriver().setPrintAutoPrint(DEMO_TENANT_ID, DEMO_LOCATION_DOWNTOWN_ID, true);
    const order = await placeOrder();
    await autoPrintOnFire(order);
    const [manual] = await enqueueOrderTicket(order, { dedupeKey: `manual:${order.id}` });
    expect(manual!.document.lines[0]!.text).toBe("*** REPRINT ***");
  });

  it("rotating a token revokes the old one; only the owning tenant can rotate", async () => {
    const { printer, token } = await star();
    const other = await rival();
    expect(await rotatePrinterToken(other.tenantId, printer.id)).toBeNull();
    expect(await authenticatePrinter(token, "star_cloudprnt")).not.toBeNull();
    const rotated = await rotatePrinterToken(DEMO_TENANT_ID, printer.id);
    expect(await authenticatePrinter(token, "star_cloudprnt")).toBeNull();
    expect(await authenticatePrinter(rotated!.token, "star_cloudprnt")).not.toBeNull();
  });

  it("prunes finished jobs older than the cutoff, keeps pending ones", async () => {
    const { printer } = await star();
    const [done] = await enqueueOrderTicket(await placeOrder());
    await enqueueOrderTicket(await placeOrder());
    await claimNext(printer);
    await confirm(printer, done!.id, { ok: true });
    const future = new Date(Date.now() + 5 * 864e5).toISOString();
    expect(await getPosDriver().pruneFinishedPrintJobs(future)).toBe(1);
    expect((await getPosDriver().listPrintJobs(DEMO_TENANT_ID, DEMO_LOCATION_DOWNTOWN_ID, 10))).toHaveLength(1);
  });

  it("scheduleAutoPrint prints outside a request scope and never throws", async () => {
    await star();
    await getPosDriver().setPrintAutoPrint(DEMO_TENANT_ID, DEMO_LOCATION_DOWNTOWN_ID, true);
    const order = await placeOrder();
    expect(() => scheduleAutoPrint(order)).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));
    expect(await getPosDriver().listPrintJobs(DEMO_TENANT_ID, DEMO_LOCATION_DOWNTOWN_ID, 10)).toHaveLength(1);
  });

  it("setup URLs prefer the configured app origin", () => {
    const old = process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://pos.example.com/x";
    expect(publicOrigin("http://internal:3000/api")).toBe("https://pos.example.com");
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(publicOrigin("http://internal:3000/api")).toBe("http://internal:3000");
    if (old) process.env.NEXT_PUBLIC_APP_URL = old;
  });

  it("dedupe key makes enqueue idempotent per printer", async () => {
    const { printer } = await star();
    const order = await placeOrder();
    const a = await enqueueOrderTicket(order, { dedupeKey: "fire:x" });
    const b = await enqueueOrderTicket(order, { dedupeKey: "fire:x" });
    expect(b[0]!.id).toBe(a[0]!.id);
    expect((await getPosDriver().listPrintJobs(DEMO_TENANT_ID, DEMO_LOCATION_DOWNTOWN_ID, 50)).filter((j) => j.printer_id === printer.id)).toHaveLength(1);
  });

  it("renders per printer column width", async () => {
    const p42 = (await star("a")).printer;
    const p48 = (
      await createPrinter({ tenantId: DEMO_TENANT_ID, locationId: DEMO_LOCATION_DOWNTOWN_ID, label: "b", protocol: "epson_sdp", columns: 48 })
    ).printer;
    const jobs = await enqueueOrderTicket(await placeOrder());
    expect(jobs).toHaveLength(2);
    expect(p42.columns).toBe(42);
    expect(p48.columns).toBe(48);
  });
});

describe("tenant / printer isolation", () => {
  it("a printer never sees another printer's or tenant's jobs", async () => {
    const a = await star("A");
    const other = await rival();
    const b = await createPrinter({
      tenantId: other.tenantId,
      locationId: other.locationId,
      label: "B",
      protocol: "star_cloudprnt",
    });
    const sibling = await star("A2");
    const rivalOrder = await placeOrder({ tenantId: other.tenantId, locationId: other.locationId });
    const [jb] = await enqueueOrderTicket(rivalOrder);
    expect(jb!.printer_id).toBe(b.printer.id);

    // A cannot claim, read, or confirm B's job.
    expect(await claimNext(a.printer)).toBeNull();
    expect(await getServable(a.printer, jb!.id)).toBeNull();
    expect(await confirm(a.printer, jb!.id, { ok: true })).toBeNull();
    expect((await getPosDriver().getPrintJobForPrinter(b.printer.id, jb!.id))?.status).toBe("queued");

    // Same-location sibling jobs are per-printer too.
    const [ja] = await enqueueOrderTicket(await placeOrder());
    expect(ja).toBeDefined();
    const jobs = await getPosDriver().listPrintJobs(DEMO_TENANT_ID, DEMO_LOCATION_DOWNTOWN_ID, 50);
    expect(jobs.every((j) => j.tenant_id === DEMO_TENANT_ID)).toBe(true);
    expect(sibling.printer.id).not.toBe(a.printer.id);

    // Over HTTP: A's token cannot fetch B's job token.
    const r = await starGetJob(a.token, jb!.id);
    expect(r.status).toBe(404);
    expect((await starConfirm(a.token, jb!.id, "200 OK")).status).toBe(200);
    expect((await getPosDriver().getPrintJobForPrinter(b.printer.id, jb!.id))?.status).toBe("queued");
  });

  it("enqueue only targets the order's own location printers", async () => {
    await star();
    const other = await rival();
    const o = await placeOrder({ tenantId: other.tenantId, locationId: other.locationId });
    expect(await enqueueOrderTicket(o)).toEqual([]);
  });
});

describe("Star CloudPRNT protocol (simulated poller)", () => {
  it("poll -> GET job -> DELETE confirm, then idle", async () => {
    const { printer, token } = await star();
    expect((await starPoll(token)).body).toBe('{"jobReady":false}');
    expect(isOnline((await getPosDriver().getPrinter(printer.id))!)).toBe(true);

    await enqueueOrderTicket(await placeOrder());
    const poll = await starPoll(token);
    const body = JSON.parse(poll.body!) as { jobReady: boolean; mediaTypes: string[]; jobToken: string };
    expect(body.jobReady).toBe(true);
    expect(body.mediaTypes).toEqual(["text/vnd.star.markup"]);

    const get = await starGetJob(token, body.jobToken);
    expect(get.status).toBe(200);
    expect(get.contentType).toContain("text/vnd.star.markup");
    expect(get.body).toContain("[magnify: width 3; height 3]");

    expect((await starConfirm(token, body.jobToken, "200 OK")).status).toBe(200);
    expect((await starConfirm(token, body.jobToken, "200 OK")).status).toBe(200); // idempotent
    expect(JSON.parse((await starPoll(token)).body!).jobReady).toBe(false);
    expect((await starGetJob(token, body.jobToken)).status).toBe(404); // done: not served again
  });

  it("text-format printers advertise and receive text/plain", async () => {
    const { token } = await createPrinter({
      tenantId: DEMO_TENANT_ID,
      locationId: DEMO_LOCATION_DOWNTOWN_ID,
      label: "old",
      protocol: "star_cloudprnt",
      format: "text",
    });
    await enqueueOrderTicket(await placeOrder());
    const body = JSON.parse((await starPoll(token)).body!);
    expect(body.mediaTypes).toEqual(["text/plain"]);
    expect((await starGetJob(token, body.jobToken)).contentType).toContain("text/plain");
  });

  it("a non-2xx confirm code fails the job; bad tokens are 401", async () => {
    const { printer, token } = await star();
    const [j] = await enqueueOrderTicket(await placeOrder());
    await starPoll(token);
    await starConfirm(token, j!.id, "52 Paper empty");
    const row = await getPosDriver().getPrintJobForPrinter(printer.id, j!.id);
    expect(row?.status).toBe("queued"); // retried with backoff
    expect(row?.error).toBe("52 Paper empty");
    expect(row?.retry_after).not.toBeNull();
    // Junk tokens are 401/404, never a 500.
    expect((await starPoll("not-a-uuid.secret")).status).toBe(401);
    expect((await starGetJob(token, "junk")).status).toBe(404);
    expect((await starConfirm(token, "junk", "200 OK")).status).toBe(200);
    expect((await starPoll("bad.token")).status).toBe(401);
    expect((await starGetJob(`${printer.id}.x`, j!.id)).status).toBe(401);
    expect((await starConfirm(`${printer.id}.x`, j!.id, "200 OK")).status).toBe(401);
  });

  it("test ticket flows through like an order ticket", async () => {
    const { printer, token } = await star();
    await enqueueTestTicket(printer);
    const body = JSON.parse((await starPoll(token)).body!);
    expect((await starGetJob(token, body.jobToken)).body).toContain("TEST TICKET");
  });
});

describe("Epson Server Direct Print protocol (simulated poller)", () => {
  const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

  it("GetRequest -> PrintRequestInfo -> SetResponse confirms", async () => {
    const { printer, token } = await createPrinter({
      tenantId: DEMO_TENANT_ID,
      locationId: DEMO_LOCATION_DOWNTOWN_ID,
      label: "epson",
      protocol: "epson_sdp",
    });
    const idle = await epsonRequest(token, form({ ConnectionType: "GetRequest", ID: "x" }));
    expect(idle).toMatchObject({ status: 200, body: "" });

    const [job] = await enqueueOrderTicket(await placeOrder());
    const get = await epsonRequest(token, form({ ConnectionType: "GetRequest", ID: "x" }));
    expect(get.body).toContain("<PrintRequestInfo>");
    const pj = /<printjobid>([^<]+)<\/printjobid>/.exec(get.body!)![1]!;
    expect(pj.length).toBeLessThanOrEqual(30);
    expect(decodeJobId(pj)).toBe(job!.id);

    const resp = `<PrintResponseInfo><ePOSPrint><Parameter><printjobid>${pj}</printjobid></Parameter><PrintResponse><response success="true" code="" status="251658262" battery="0"/></PrintResponse></ePOSPrint></PrintResponseInfo>`;
    await epsonRequest(token, form({ ConnectionType: "SetResponse", ResponseFile: resp }));
    await epsonRequest(token, form({ ConnectionType: "SetResponse", ResponseFile: resp }));
    expect((await getPosDriver().getPrintJobForPrinter(printer.id, job!.id))?.status).toBe("done");
  });

  it("failure response marks failed; a Star token is not accepted here", async () => {
    const e = await createPrinter({ tenantId: DEMO_TENANT_ID, locationId: DEMO_LOCATION_DOWNTOWN_ID, label: "e", protocol: "epson_sdp" });
    const s = await star();
    const [job] = await enqueueOrderTicket(await placeOrder(), { printerId: e.printer.id });
    await epsonRequest(e.token, form({ ConnectionType: "GetRequest" }));
    const bad = `<response success="false" code="EPTR_COVER_OPEN"/><printjobid>${encodeJobId(job!.id)}</printjobid>`;
    await epsonRequest(e.token, form({ ConnectionType: "SetResponse", ResponseFile: bad }));
    const row = await getPosDriver().getPrintJobForPrinter(e.printer.id, job!.id);
    expect(row?.status).toBe("queued");
    expect(row?.error).toBe("epson:EPTR_COVER_OPEN");
    expect((await epsonRequest(s.token, form({ ConnectionType: "GetRequest" }))).status).toBe(401);
  });
});

describe("auto-print on fire + printer selection", () => {
  it("is off by default, on per location, idempotent, live orders only", async () => {
    await star();
    const order = await placeOrder();
    expect(await autoPrintOnFire(order)).toBe(0); // default off
    await getPosDriver().setPrintAutoPrint(DEMO_TENANT_ID, DEMO_LOCATION_DOWNTOWN_ID, true);
    expect(await autoPrintOnFire(order)).toBe(1);
    await autoPrintOnFire(order); // retried fire: same dedupe key
    const jobs = await getPosDriver().listPrintJobs(DEMO_TENANT_ID, DEMO_LOCATION_DOWNTOWN_ID, 50);
    expect(jobs).toHaveLength(1);
    const draft = await placeOrder({ status: "draft" });
    expect(await autoPrintOnFire(draft)).toBe(0);
  });

  it("auto-print on another location does not leak", async () => {
    await star();
    const other = await rival();
    await getPosDriver().setPrintAutoPrint(other.tenantId, other.locationId, true);
    expect(await autoPrintOnFire(await placeOrder())).toBe(0);
  });

  it("uses the network printer when one is configured, else the browser", async () => {
    expect((await resolveTicketPrinter(DEMO_TENANT_ID, DEMO_LOCATION_DOWNTOWN_ID)).name).toBe("browser");
    await star();
    const p = await resolveTicketPrinter(DEMO_TENANT_ID, DEMO_LOCATION_DOWNTOWN_ID);
    expect(p.name).toBe("network");
    const res = await p.print(await placeOrder());
    expect(res).toMatchObject({ ok: true, via: "network", queued: 1 });
  });
});
