import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "./session";

/**
 * The API tenant guard derives the tenants a caller may act on from the
 * SESSION's memberships. We mock the session resolver (it reads cookies via
 * next/headers) and drive the guard + real route handlers against the mock
 * driver: no session → 401, wrong tenant/role → 403, right tenant → ok.
 */
const session = vi.hoisted(() => ({ user: null as SessionUser | null }));
vi.mock("./session", () => ({
  getCurrentUser: vi.fn(async () => session.user),
}));

import {
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_TENANT_ID,
  getPosDriver,
  type MembershipRole,
} from "@/lib/db";
import {
  decideTenantAccess,
  requireOrderAccess,
  requireTenantAccess,
} from "./tenant-guard";

const RIVAL_TENANT_ID = "rival-tenant-guard-test";

function userWith(
  memberships: { tenant_id: string; role: MembershipRole }[],
  extra: Partial<SessionUser> = {},
): SessionUser {
  return {
    id: "user-under-test",
    email: "user@example.com",
    memberships: memberships.map((m, i) => ({
      id: `m-${i}`,
      user_id: "user-under-test",
      created_at: "2025-01-01T00:00:00.000Z",
      ...m,
    })),
    isPlatformAdmin: false,
    real: true,
    ...extra,
  };
}

const demoOwner = () => userWith([{ tenant_id: DEMO_TENANT_ID, role: "owner" }]);
const rivalOwner = () =>
  userWith([{ tenant_id: RIVAL_TENANT_ID, role: "owner" }]);

beforeEach(() => {
  session.user = null;
});

describe("decideTenantAccess (pure)", () => {
  it("401s without a session", () => {
    expect(decideTenantAccess(null, DEMO_TENANT_ID, "admin")).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it("403s for a tenant the user is not a member of", () => {
    expect(
      decideTenantAccess(rivalOwner(), DEMO_TENANT_ID, "admin"),
    ).toMatchObject({ ok: false, status: 403 });
  });

  it("403s when the role is insufficient for the surface", () => {
    const cashier = userWith([{ tenant_id: DEMO_TENANT_ID, role: "cashier" }]);
    expect(decideTenantAccess(cashier, DEMO_TENANT_ID, "admin")).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(
      decideTenantAccess(cashier, DEMO_TENANT_ID, "terminal"),
    ).toMatchObject({ ok: true, tenantId: DEMO_TENANT_ID, role: "cashier" });
  });

  it("derives the sole authorized tenant when none is requested", () => {
    expect(decideTenantAccess(demoOwner(), null, "admin")).toMatchObject({
      ok: true,
      tenantId: DEMO_TENANT_ID,
    });
  });

  it("requires an explicit tenant when the user has several", () => {
    const multi = userWith([
      { tenant_id: DEMO_TENANT_ID, role: "owner" },
      { tenant_id: RIVAL_TENANT_ID, role: "manager" },
    ]);
    expect(decideTenantAccess(multi, null, "admin")).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(decideTenantAccess(multi, RIVAL_TENANT_ID, "admin")).toMatchObject({
      ok: true,
      tenantId: RIVAL_TENANT_ID,
    });
  });

  it("is not satisfied by platform-admin status alone", () => {
    const platform = userWith([], { isPlatformAdmin: true });
    expect(
      decideTenantAccess(platform, DEMO_TENANT_ID, "admin"),
    ).toMatchObject({ ok: false, status: 403 });
  });
});

describe("requireTenantAccess", () => {
  it("returns 401 / 403 / ok for no session / wrong tenant / right tenant", async () => {
    const none = await requireTenantAccess(DEMO_TENANT_ID, "admin");
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.res.status).toBe(401);

    session.user = rivalOwner();
    const wrong = await requireTenantAccess(DEMO_TENANT_ID, "admin");
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.res.status).toBe(403);

    session.user = demoOwner();
    const right = await requireTenantAccess(DEMO_TENANT_ID, "admin", {
      locationId: DEMO_LOCATION_DOWNTOWN_ID,
    });
    expect(right.ok).toBe(true);
    if (right.ok) {
      expect(right.tenantId).toBe(DEMO_TENANT_ID);
      expect(right.locationId).toBe(DEMO_LOCATION_DOWNTOWN_ID);
    }
  });

  it("403s a location that belongs to another tenant", async () => {
    const { tenant } = await getPosDriver().createTenant({
      businessName: "Guard Test Other",
      ownerEmail: "guard-other@example.com",
    });
    const foreignLoc = await getPosDriver().createLocation({
      tenant_id: tenant.id,
      name: "Elsewhere",
    });
    session.user = demoOwner();
    const res = await requireTenantAccess(DEMO_TENANT_ID, "admin", {
      locationId: foreignLoc.id,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.res.status).toBe(403);
  });

  it("authorizes an order against the order's own tenant", async () => {
    const order = await getPosDriver().createOrder({
      id: "guard-test-order-1",
      tenant_id: DEMO_TENANT_ID,
      location_id: DEMO_LOCATION_DOWNTOWN_ID,
      channel: "in_store",
      currency: "USD",
      items: [],
      discount_cents: 0,
      totals: {
        subtotal_cents: 0,
        discount_cents: 0,
        taxable_cents: 0,
        tax_cents: 0,
        tip_cents: 0,
        total_cents: 0,
      },
      notes: null,
    });

    const anon = await requireOrderAccess(order.id, "kitchen");
    expect(anon.ok).toBe(false);
    if (!anon.ok) expect(anon.res.status).toBe(401);

    session.user = rivalOwner();
    const rival = await requireOrderAccess(order.id, "kitchen");
    expect(rival.ok).toBe(false);
    if (!rival.ok) expect(rival.res.status).toBe(403);

    session.user = demoOwner();
    const own = await requireOrderAccess(order.id, "kitchen");
    expect(own.ok && own.order.id).toBe(order.id);

    const missing = await requireOrderAccess("no-such-order", "kitchen");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.res.status).toBe(404);
  });
});

describe("tenant-scoped API routes enforce the guard", () => {
  const url = (path: string) => `http://localhost${path}`;

  it("GET /api/entitlements: 401 anon, 403 other tenant, 200 own tenant", async () => {
    const { GET } = await import("@/app/api/entitlements/route");
    const req = () =>
      new Request(url(`/api/entitlements?tenantId=${DEMO_TENANT_ID}`));

    expect((await GET(req())).status).toBe(401);
    session.user = rivalOwner();
    expect((await GET(req())).status).toBe(403);
    session.user = demoOwner();
    expect((await GET(req())).status).toBe(200);
  });

  it("GET /api/admin/reports no longer defaults to the demo tenant", async () => {
    const { GET } = await import("@/app/api/admin/reports/route");
    expect((await GET(new Request(url("/api/admin/reports")))).status).toBe(
      401,
    );
    // With no tenantId, the caller's OWN tenant is used (not the demo tenant).
    session.user = rivalOwner();
    const own = await GET(new Request(url("/api/admin/reports")));
    expect(own.status).toBe(200);
    const body = (await own.json()) as { report: { tenant_id: string } };
    expect(body.report.tenant_id).toBe(RIVAL_TENANT_ID);
    expect(
      (
        await GET(
          new Request(url(`/api/admin/reports?tenantId=${DEMO_TENANT_ID}`)),
        )
      ).status,
    ).toBe(403);
  });

  it("GET /api/kitchen/orders: 401 anon, 403 cross-tenant", async () => {
    const { GET } = await import("@/app/api/kitchen/orders/route");
    const req = () =>
      new Request(
        url(
          `/api/kitchen/orders?tenantId=${DEMO_TENANT_ID}&locationId=${DEMO_LOCATION_DOWNTOWN_ID}`,
        ),
      );
    expect((await GET(req())).status).toBe(401);
    session.user = rivalOwner();
    expect((await GET(req())).status).toBe(403);
    session.user = demoOwner();
    expect((await GET(req())).status).toBe(200);
  });

  it("GET /api/delivery/dispatch rejects anon", async () => {
    const dispatch = await import("@/app/api/delivery/dispatch/route");
    const res = await dispatch.GET(
      new Request(
        url(
          `/api/delivery/dispatch?tenantId=${DEMO_TENANT_ID}&locationId=${DEMO_LOCATION_DOWNTOWN_ID}`,
        ),
      ),
    );
    expect(res.status).toBe(401);
  });

  it("POST /api/admin/menu refuses to delete another tenant's item", async () => {
    const { POST } = await import("@/app/api/admin/menu/route");
    // A rival owner authorizes as THEIR tenant but targets a demo item id.
    session.user = rivalOwner();
    const res = await POST(
      new Request(url("/api/admin/menu"), {
        method: "POST",
        body: JSON.stringify({
          entity: "item",
          action: "delete",
          id: "30000000-0000-0000-0000-000000000002",
          tenantId: RIVAL_TENANT_ID,
        }),
      }),
    );
    expect(res.status).toBe(404);
    expect(
      await getPosDriver().getMenuEntityTenant(
        "item",
        "30000000-0000-0000-0000-000000000002",
      ),
    ).toBe(DEMO_TENANT_ID);
  });

  it("POST /api/signup steps require the onboarding token or a session", async () => {
    const { POST } = await import("@/app/api/signup/route");
    const created = await POST(
      new Request(url("/api/signup"), {
        method: "POST",
        body: JSON.stringify({
          action: "create_business",
          businessName: "Token Test Pizza",
          ownerEmail: "token-test@example.com",
        }),
      }),
    );
    expect(created.status).toBe(201);
    const { tenant, onboardingToken } = (await created.json()) as {
      tenant: { id: string };
      onboardingToken: string;
    };

    const addLocation = (headers: Record<string, string>) =>
      POST(
        new Request(url("/api/signup"), {
          method: "POST",
          headers,
          body: JSON.stringify({
            action: "add_location",
            tenantId: tenant.id,
            name: "Main",
          }),
        }),
      );

    // Signed out, no token → 401. Another tenant's session → 403.
    expect((await addLocation({})).status).toBe(401);
    session.user = demoOwner();
    expect((await addLocation({})).status).toBe(403);
    // A token for a DIFFERENT tenant doesn't work either.
    const { signOnboardingToken } = await import("./onboarding-token");
    expect(
      (await addLocation({ "x-onboarding-token": signOnboardingToken(DEMO_TENANT_ID) }))
        .status,
    ).toBe(403);
    // The tenant's own token works.
    session.user = null;
    expect(
      (await addLocation({ "x-onboarding-token": onboardingToken })).status,
    ).toBe(201);
  });
});
