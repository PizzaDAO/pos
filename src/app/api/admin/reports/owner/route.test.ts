/** Owner reports route: auth, range validation, CSV, comparison (mock driver). */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { DEMO_TENANT_ID } from "@/lib/db";
import { resetMockOrders, resetMockPayments } from "@/lib/db/mock";

let allowed = true;
vi.mock("@/lib/auth/tenant-guard", () => ({
  requireTenantAccess: async (tenantId: string | null) =>
    allowed
      ? { ok: true, tenantId: tenantId ?? DEMO_TENANT_ID, locationId: null }
      : { ok: false, res: NextResponse.json({ error: "Not authorized." }, { status: 403 }) },
}));

import { GET } from "./route";

const get = (qs: string) => GET(new Request(`https://pos.test/api/admin/reports/owner?${qs}`));

describe("GET /api/admin/reports/owner", () => {
  beforeEach(() => {
    allowed = true;
    resetMockOrders();
    resetMockPayments();
  });

  it("is owner/manager only", async () => {
    allowed = false;
    expect((await get("from=2026-03-01&to=2026-03-07")).status).toBe(403);
  });

  it("rejects missing, invalid and oversize ranges", async () => {
    expect((await get("")).status).toBe(422);
    expect((await get("from=2026-03-09&to=2026-03-01")).status).toBe(422);
    expect((await get("from=2020-01-01&to=2026-03-01")).status).toBe(422);
  });

  it("returns the bundle with the previous period when asked", async () => {
    const res = await get("from=2026-03-08&to=2026-03-14&compare=1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.previous).toEqual({ from: "2026-03-01", to: "2026-03-07" });
    expect(body.deltas).toBeTruthy();
    expect(Array.isArray(body.bundle.daily)).toBe(true);
  });

  it("exports CSV per report and rejects unknown kinds", async () => {
    const res = await get("from=2026-03-08&to=2026-03-14&report=accountant&format=csv");
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("accountant-2026-03-08_2026-03-14.csv");
    expect((await res.text()).startsWith("business_date,location,")).toBe(true);
    expect((await get("from=2026-03-08&to=2026-03-14&report=nope&format=csv")).status).toBe(422);
  });
});
