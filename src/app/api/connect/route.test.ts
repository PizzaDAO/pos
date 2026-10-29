import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import type { ConnectAccount } from "@/lib/db/payment-types";

const requireTenantRole = vi.fn();
vi.mock("@/lib/auth/api", () => ({
  requireTenantRole: (...args: unknown[]) => requireTenantRole(...args),
}));

const createConnectAccount = vi.fn();
const createAccountLink = vi.fn();
const fetchConnectStatus = vi.fn();
vi.mock("@/lib/payments/connect", async (orig) => {
  const actual = await orig<typeof import("@/lib/payments/connect")>();
  return {
    ...actual,
    createConnectAccount: (...a: unknown[]) => createConnectAccount(...a),
    createAccountLink: (...a: unknown[]) => createAccountLink(...a),
    fetchConnectStatus: (...a: unknown[]) => fetchConnectStatus(...a),
  };
});

import { GET, POST } from "./route";

const TENANT = "00000000-0000-4000-8000-0000000000c1";

function acct(overrides: Partial<ConnectAccount>): ConnectAccount {
  return {
    tenant_id: TENANT,
    account_id: "acct_real_1",
    status: "connected",
    charges_enabled: true,
    payouts_enabled: true,
    details_submitted: true,
    simulated: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function getReq(tenantId?: string) {
  const q = tenantId ? `?tenantId=${tenantId}` : "";
  return new Request(`http://localhost/api/connect${q}`);
}
function postReq(body: unknown) {
  return new Request("http://localhost/api/connect", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("STRIPE_SECRET_KEY", "");
  requireTenantRole.mockResolvedValue({
    ok: true,
    user: { id: "u1", email: "owner@example.com" },
  });
  createAccountLink.mockResolvedValue("https://connect.stripe.test/onboard");
  // Reset stored state for the test tenant.
  const driver = getPosDriver();
  await driver.upsertConnectAccount(acct({ account_id: "acct_reset" }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/connect auth", () => {
  it("rejects a missing tenantId before auth", async () => {
    const res = await GET(getReq());
    expect(res.status).toBe(400);
    expect(requireTenantRole).not.toHaveBeenCalled();
  });

  it("returns the auth failure (401/403) and leaks nothing", async () => {
    requireTenantRole.mockResolvedValue({
      ok: false,
      res: NextResponse.json({ error: "Not signed in." }, { status: 401 }),
    });
    const res = await GET(getReq(TENANT));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Not signed in." });
    expect(fetchConnectStatus).not.toHaveBeenCalled();
  });

  it("requires owner|manager for the tenant", async () => {
    await GET(getReq(TENANT));
    expect(requireTenantRole).toHaveBeenCalledWith(TENANT, [
      "owner",
      "manager",
    ]);
  });
});

describe("simulated account in real mode", () => {
  it("GET treats a stored simulated account as not connected (no Stripe call)", async () => {
    await getPosDriver().upsertConnectAccount(
      acct({ account_id: "acct_sim_abc", simulated: true }),
    );
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    const res = await GET(getReq(TENANT));
    const json = await res.json();
    expect(json.account).toBeNull();
    expect(json.simulated).toBe(false);
    expect(fetchConnectStatus).not.toHaveBeenCalled();
  });

  it("GET still returns the simulated account in simulated mode", async () => {
    await getPosDriver().upsertConnectAccount(
      acct({ account_id: "acct_sim_abc", simulated: true }),
    );
    const res = await GET(getReq(TENANT));
    expect((await res.json()).account.account_id).toBe("acct_sim_abc");
  });

  it("POST replaces a simulated account with a real one", async () => {
    await getPosDriver().upsertConnectAccount(
      acct({ account_id: "acct_sim_abc", simulated: true }),
    );
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    createConnectAccount.mockResolvedValue(
      acct({ account_id: "acct_real_new", status: "not_started", charges_enabled: false }),
    );
    const res = await POST(postReq({ tenantId: TENANT }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(createConnectAccount).toHaveBeenCalledWith(TENANT);
    expect(createAccountLink).toHaveBeenCalledWith(
      "acct_real_new",
      expect.any(String),
      expect.any(String),
    );
    expect(json.account.account_id).toBe("acct_real_new");
    const stored = await getPosDriver().getConnectAccount(TENANT);
    expect(stored?.account_id).toBe("acct_real_new");
    expect(stored?.simulated).toBe(false);
  });

  it("POST replaces an acct_sim_ id even if the simulated flag is false", async () => {
    await getPosDriver().upsertConnectAccount(
      acct({ account_id: "acct_sim_zzz", simulated: false }),
    );
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    createConnectAccount.mockResolvedValue(acct({ account_id: "acct_real_2" }));
    await POST(postReq({ tenantId: TENANT }));
    expect(createConnectAccount).toHaveBeenCalledTimes(1);
  });

  it("POST reuses an existing real account in real mode", async () => {
    await getPosDriver().upsertConnectAccount(acct({ account_id: "acct_real_1" }));
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    await POST(postReq({ tenantId: TENANT }));
    expect(createConnectAccount).not.toHaveBeenCalled();
    expect(createAccountLink).toHaveBeenCalledWith(
      "acct_real_1",
      expect.any(String),
      expect.any(String),
    );
  });
});
