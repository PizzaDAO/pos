import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { DEMO_LOCATION_DOWNTOWN_ID, DEMO_TENANT_ID, getPosDriver } from "@/lib/db";
import { resetMockPayments } from "@/lib/db/mock";
import { authenticatePrinter } from "@/lib/printing/queue";

const requireTenantRole = vi.fn();
vi.mock("@/lib/auth/api", () => ({
  requireTenantRole: (...a: unknown[]) => requireTenantRole(...a),
}));

import { DELETE, GET, PATCH, POST } from "./route";
import { POST as TEST } from "./test/route";

const json = (method: string, body: unknown) =>
  new Request("http://localhost/api/admin/printers", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const base = { tenantId: DEMO_TENANT_ID, locationId: DEMO_LOCATION_DOWNTOWN_ID };

beforeEach(() => {
  resetMockPayments();
  requireTenantRole.mockReset();
  requireTenantRole.mockResolvedValue({ ok: true, user: {} });
});

describe("/api/admin/printers", () => {
  it("adds a printer, returns the token + setup URL once, and never lists it again", async () => {
    const res = await POST(json("POST", { ...base, label: "Kitchen", protocol: "star_cloudprnt" }));
    expect(res.status).toBe(201);
    const b = await res.json();
    expect(b.setupUrl).toBe(`http://localhost/api/print/star/${b.token}`);
    expect(b.printer.token_hash).toBeUndefined();
    expect(await authenticatePrinter(b.token, "star_cloudprnt")).not.toBeNull();

    const list = await (await GET(new Request(`http://localhost/api/admin/printers?tenantId=${DEMO_TENANT_ID}&locationId=${DEMO_LOCATION_DOWNTOWN_ID}`))).json();
    expect(list.printers).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(b.token.split(".")[1]);
    expect(list.printers[0].lastSeenAt).toBeNull();
    expect(list.autoPrint).toBe(false);
  });

  it("validates input and enforces roles", async () => {
    expect((await POST(json("POST", { ...base, label: "x", protocol: "lpr" }))).status).toBe(422);
    expect((await POST(json("POST", { ...base, label: "", protocol: "epson_sdp" }))).status).toBe(422);
    expect((await POST(json("POST", { ...base, label: "x", protocol: "epson_sdp", columns: 40 }))).status).toBe(422);
    requireTenantRole.mockResolvedValue({ ok: false, res: NextResponse.json({ error: "no" }, { status: 403 }) });
    expect((await POST(json("POST", { ...base, label: "x", protocol: "epson_sdp" }))).status).toBe(403);
    expect(requireTenantRole).toHaveBeenLastCalledWith(DEMO_TENANT_ID, ["owner", "manager"]);
  });

  it("rejects a location from another tenant", async () => {
    const res = await POST(json("POST", { tenantId: DEMO_TENANT_ID, locationId: crypto.randomUUID(), label: "x", protocol: "epson_sdp" }));
    expect(res.status).toBe(404);
  });

  it("toggles auto-print, queues a test ticket, and removes the printer", async () => {
    const { printer } = await (await POST(json("POST", { ...base, label: "K", protocol: "epson_sdp" }))).json();
    const patched = await (await PATCH(json("PATCH", { ...base, autoPrint: true }))).json();
    expect(patched.autoPrint).toBe(true);
    expect((await PATCH(json("PATCH", { ...base, autoPrint: "yes" }))).status).toBe(422);

    expect((await TEST(json("POST", { ...base, printerId: printer.id }))).status).toBe(201);
    expect((await TEST(json("POST", { ...base, printerId: crypto.randomUUID() }))).status).toBe(404);
    const jobs = await getPosDriver().listPrintJobs(DEMO_TENANT_ID, DEMO_LOCATION_DOWNTOWN_ID, 5);
    expect(jobs[0]).toMatchObject({ kind: "test", status: "queued", printer_id: printer.id });

    const del = await DELETE(new Request(`http://localhost/api/admin/printers?tenantId=${DEMO_TENANT_ID}&locationId=${DEMO_LOCATION_DOWNTOWN_ID}&printerId=${printer.id}`, { method: "DELETE" }));
    expect((await del.json()).printers).toHaveLength(0);
  });

  it("caps printers per location", async () => {
    for (let i = 0; i < 5; i++) await POST(json("POST", { ...base, label: `p${i}`, protocol: "epson_sdp" }));
    expect((await POST(json("POST", { ...base, label: "p6", protocol: "epson_sdp" }))).status).toBe(409);
  });
});
