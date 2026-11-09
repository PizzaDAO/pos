/**
 * Back-office PIN gate (security audit M1): a till signed in with the owner's
 * account must not open /admin or call any /api/admin/* route without a fresh
 * owner/manager PIN.
 *
 * The ENUMERATION test walks src/app/api/admin on disk and calls every exported
 * handler of every route, so a new admin route that forgets the gate fails CI.
 * Admin-only routes outside /api/admin are listed in ADMIN_GATED_OUTSIDE, and
 * the only deliberate exception is in UNGATED (with the reason). A static scan
 * also refuses any route that authorizes the "admin" surface without the gate.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "./session";

const session = vi.hoisted(() => ({ user: null as SessionUser | null }));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: vi.fn(async () => session.user),
}));
const mode = vi.hoisted(() => ({ real: true }));
vi.mock("@/lib/auth/signing-secret", async (orig) => ({
  ...(await orig<typeof import("./signing-secret")>()),
  isRealMode: () => mode.real,
  signingSecret: () => "admin-gate-test-secret-0123456789abcdef",
}));

import {
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_TENANT_ID,
  getPosDriver,
  type CreateOrderInput,
} from "@/lib/db";
import { resetMockPinState } from "@/lib/db/mock";
import {
  POST as unlockPOST,
  DELETE as unlockDELETE,
  GET as unlockGET,
} from "@/app/api/admin/unlock/route";
import { POST as tillPinPOST } from "@/app/api/terminal/pin/route";
import {
  ADMIN_PIN_REQUIRED,
  ADMIN_UNLOCK_COOKIE,
  ADMIN_UNLOCK_TTL_MS,
  adminGateRequired,
} from "./admin-gate";
import { ACTIVE_STAFF_COOKIE, effectiveTerminalRole } from "./active-staff";
import { hashPin, verifyPin } from "./pin";
import { DELETE as tillPinDELETE } from "@/app/api/terminal/pin/route";
import { POST as signOutPOST } from "@/app/auth/signout/route";

const T = DEMO_TENANT_ID;
const L = DEMO_LOCATION_DOWNTOWN_ID;
// Seed staff (src/lib/db/seed-data.ts): Tony owner 1111, Carmela manager 2222,
// Christopher cashier 3333, Furio kitchen 4444.
const TONY = "80000000-0000-0000-0000-000000000001";
const CARMELA = "80000000-0000-0000-0000-000000000002";
const CHRIS = "80000000-0000-0000-0000-000000000003";
// 6-digit PINs (a shorter owner/manager PIN is replaced at unlock; see below).
const TONY_PIN = "739204";
const CARMELA_PIN = "482915";

const ROOT = resolve(__dirname, "../../app/api");
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** Every /api/admin route is gated except these (path relative to src/app/api). */
const UNGATED: Record<string, string> = {
  "admin/owner-pin":
    "An owner with no PIN must be able to get one, so the gate can never lock an owner out. It requires an OWNER device session, a sign-in within the last 10 minutes, and only gives a FIRST PIN to an active owner row that has none.",
  "admin/unlock":
    "It is the PIN entry that passes the gate. It still requires an owner|manager device session, and its POST runs the device/location/staff PIN budgets.",
};
/** Admin-only routes outside /api/admin that are gated too. */
const ADMIN_GATED_OUTSIDE = [
  "billing",
  "connect",
  "entitlements",
  "delivery/dispatch",
  "signup",
];

function owner(id = "gate-device"): SessionUser {
  return {
    id,
    email: `${id}@example.com`,
    memberships: [
      {
        id: `m-${id}`,
        user_id: id,
        tenant_id: T,
        role: "owner",
        created_at: "2025-01-01T00:00:00.000Z",
      },
    ],
    isPlatformAdmin: false,
    real: true,
  };
}

function routeDirs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...routeDirs(p));
    else if (name === "route.ts") out.push(relative(ROOT, dir));
  }
  return out.sort();
}

const ORDER_ID = "6a7e0000-0000-4000-8000-000000000001";
const DELIVERY_ID = "6a7e0000-0000-4000-8000-0000000000d1";

/** A request that gets past every route's input checks to its auth. */
function requestFor(rel: string, method: string, cookie?: string): Request {
  const path = rel.replace("[id]", "tmr_gate");
  const url = `http://localhost/api/${path}?tenantId=${T}&locationId=${L}&date=2026-11-09&targetType=item&targetId=gate-item`;
  const action: Record<string, string> = {
    "admin/late-payments": "accept",
    "admin/staff": "create",
    signup: "go_live",
  };
  const body =
    method === "GET"
      ? undefined
      : JSON.stringify({
          tenantId: T,
          tenant_id: T,
          locationId: L,
          location_id: L,
          orderId: ORDER_ID,
          deliveryId: DELIVERY_ID,
          driverName: "Gate Test",
          staffId: CHRIS,
          moduleRoles: [],
          action: action[rel] ?? "noop",
          // Enough for the routes that validate their body before auth.
          name: "Gate Test",
          country: "US",
          entity: "category",
          target_type: "item",
          target_id: "gate-item",
          simulate: true,
          ...(rel === "admin/menu"
            ? { action: "delete", payload: { id: "gate-cat" } }
            : {}),
        });
  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...(cookie
        ? { cookie: `${ADMIN_UNLOCK_COOKIE}=${encodeURIComponent(cookie)}` }
        : {}),
    },
    body,
  });
}

async function call(rel: string, method: string, cookie?: string) {
  const mod = (await import(resolve(ROOT, rel, "route.ts"))) as Record<
    string,
    (req: Request, ctx?: unknown) => Promise<Response>
  >;
  const handler = mod[method]!;
  const res = await handler(requestFor(rel, method, cookie), {
    params: Promise.resolve({ id: "tmr_gate" }),
  });
  const json = (await res
    .clone()
    .json()
    .catch(() => ({}))) as { code?: string };
  return { status: res.status, code: json.code };
}

/** Unlock as `staffId` with `pin`; returns the cookie value (or the response). */
async function unlock(staffId: string, pin: string, user = session.user) {
  session.user = user;
  const res = await unlockPOST(
    new Request("http://localhost/api/admin/unlock", {
      method: "POST",
      body: JSON.stringify({ tenantId: T, staffId, pin }),
    }),
  );
  const set = res.headers.get("set-cookie") ?? "";
  const m = new RegExp(`${ADMIN_UNLOCK_COOKIE}=([^;]+)`).exec(set);
  return { res, cookie: m ? decodeURIComponent(m[1]!) : null };
}

const gateReq = (cookie?: string | null, name = ADMIN_UNLOCK_COOKIE) =>
  new Request(`http://localhost/api/admin/reports?tenantId=${T}`, {
    headers: cookie ? { cookie: `${name}=${encodeURIComponent(cookie)}` } : {},
  });

async function reports(cookie?: string | null, name?: string) {
  const { GET } = await import("@/app/api/admin/reports/route");
  const res = await GET(gateReq(cookie, name));
  const json = (await res
    .clone()
    .json()
    .catch(() => ({}))) as { code?: string };
  return { status: res.status, code: json.code };
}

beforeAll(async () => {
  await getPosDriver().setStaffPinHash(T, TONY, hashPin(TONY_PIN));
  await getPosDriver().setStaffPinHash(T, CARMELA, hashPin(CARMELA_PIN));
  const order: CreateOrderInput = {
    id: ORDER_ID,
    tenant_id: T,
    location_id: L,
    channel: "online_delivery",
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
    status: "placed",
  };
  await getPosDriver().createOrder(order);
  await getPosDriver().upsertDelivery({
    id: DELIVERY_ID,
    order_id: ORDER_ID,
    tenant_id: T,
    location_id: L,
    provider: "in_house_manual",
    status: "pending_assignment",
    zone_id: null,
    fee_cents: 0,
    currency: "USD",
    eta_minutes: null,
    provider_delivery_id: null,
    tracking_ref: null,
    dropoff: {
      line1: "1 Main",
      city: "X",
      region: "NY",
      postal_code: "10001",
      country: "US",
    },
    driver_name: null,
    driver_phone: null,
    simulated: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as never);
});

beforeEach(() => {
  mode.real = true;
  session.user = owner();
  resetMockPinState();
});

describe("every admin route is behind the PIN gate", () => {
  const adminRoutes = routeDirs(join(ROOT, "admin")).map((d) =>
    d.replace(/\\/g, "/"),
  );
  const gated = [
    ...adminRoutes.filter((r) => !UNGATED[r]),
    ...ADMIN_GATED_OUTSIDE,
  ];

  it("finds the admin routes on disk (sanity)", () => {
    expect(adminRoutes).toContain("admin/staff");
    expect(adminRoutes).toContain("admin/terminal/readers/[id]");
    expect(adminRoutes).toContain("admin/unlock");
    expect(gated.length).toBeGreaterThanOrEqual(15);
  });

  it("the gate is in force for the demo tenant (owner/manager PINs are seeded)", async () => {
    expect(await adminGateRequired(T)).toBe(true);
  });

  for (const rel of gated) {
    it(`${rel}: every method refuses an owner device session without a PIN unlock`, async () => {
      const mod = (await import(resolve(ROOT, rel, "route.ts"))) as Record<
        string,
        unknown
      >;
      const methods = METHODS.filter((m) => typeof mod[m] === "function");
      expect(methods.length).toBeGreaterThan(0);
      for (const m of methods) {
        const r = await call(rel, m);
        expect({ m, status: r.status, code: r.code }).toEqual({
          m,
          status: 403,
          code: ADMIN_PIN_REQUIRED,
        });
      }
    });

    it(`${rel}: a manager PIN unlock lets every method through the gate`, async () => {
      const { cookie } = await unlock(CARMELA, CARMELA_PIN);
      expect(cookie).toBeTruthy();
      const mod = (await import(resolve(ROOT, rel, "route.ts"))) as Record<
        string,
        unknown
      >;
      for (const m of METHODS.filter((x) => typeof mod[x] === "function")) {
        const r = await call(rel, m, cookie!);
        expect({ m, code: r.code }).not.toEqual({
          m,
          code: ADMIN_PIN_REQUIRED,
        });
      }
    });
  }

  it("no route authorizes the admin surface without the gate (static scan)", () => {
    const offenders: string[] = [];
    const all = routeDirs(ROOT).map((d) => d.replace(/\\/g, "/"));
    for (const rel of all) {
      if (UNGATED[rel]) continue;
      const src = readFileSync(resolve(ROOT, rel, "route.ts"), "utf8");
      // The admin surface / owner+manager roles must come through the gate
      // (requireAdminAccess / requireAdminRole / authorizeAdminLocation /
      // requireTenantAdminOrOnboarding), never the bare guards.
      if (/requireTenantAccess\([^)]*"admin"/s.test(src))
        offenders.push(`${rel}: requireTenantAccess("admin")`);
      if (/authorizeLocation\([^)]*ADMIN_ROLES/s.test(src))
        offenders.push(`${rel}: authorizeLocation(ADMIN_ROLES)`);
      if (
        rel.startsWith("admin/") &&
        /requireTenant(Role|Member)\(/.test(src)
      ) {
        offenders.push(`${rel}: requireTenantRole/Member`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("unlock", () => {
  it("a cashier's or kitchen PIN can't unlock; a wrong PIN is 401", async () => {
    expect((await unlock(CHRIS, "3333")).res.status).toBe(403);
    expect((await unlock(CARMELA, "9999")).res.status).toBe(401);
    expect((await reports()).code).toBe(ADMIN_PIN_REQUIRED);
  });

  it("owner and manager PINs unlock; it lasts 10 minutes then re-prompts", async () => {
    const { res, cookie } = await unlock(TONY, TONY_PIN);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect((await reports(cookie)).status).toBe(200);
    const spy = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + ADMIN_UNLOCK_TTL_MS + 1000);
    try {
      expect((await reports(cookie)).code).toBe(ADMIN_PIN_REQUIRED);
    } finally {
      spy.mockRestore();
    }
  });

  it("GET reports who unlocked; DELETE (Lock now) ends it", async () => {
    const { cookie } = await unlock(CARMELA, CARMELA_PIN);
    const status = (await (
      await unlockGET(
        new Request(`http://localhost/api/admin/unlock?tenantId=${T}`, {
          headers: {
            cookie: `${ADMIN_UNLOCK_COOKIE}=${encodeURIComponent(cookie!)}`,
          },
        }),
      )
    ).json()) as {
      required: boolean;
      unlocked: boolean;
      staff: { name: string };
    };
    expect(status).toMatchObject({
      required: true,
      unlocked: true,
      staff: { name: "Carmela M." },
    });
    await unlockDELETE(
      new Request("http://localhost/api/admin/unlock", {
        method: "DELETE",
        headers: {
          cookie: `${ADMIN_UNLOCK_COOKIE}=${encodeURIComponent(cookie!)}`,
        },
      }),
    );
    expect((await reports(cookie)).code).toBe(ADMIN_PIN_REQUIRED);
  });

  it("the unlock is bound to the device login that opened it", async () => {
    const { cookie } = await unlock(CARMELA, CARMELA_PIN);
    session.user = owner("other-device");
    expect((await reports(cookie)).code).toBe(ADMIN_PIN_REQUIRED);
  });

  it("demoting or deactivating the unlocking manager ends the unlock at once", async () => {
    const driver = getPosDriver();
    const { cookie } = await unlock(CARMELA, CARMELA_PIN);
    expect((await reports(cookie)).status).toBe(200);
    await driver.updateStaffProfile(T, CARMELA, { role: "cashier" });
    try {
      expect((await reports(cookie)).code).toBe(ADMIN_PIN_REQUIRED);
    } finally {
      await driver.updateStaffProfile(T, CARMELA, { role: "manager" });
    }
    expect((await reports(cookie)).status).toBe(200);
    await driver.updateStaffProfile(T, CARMELA, { active: false });
    try {
      expect((await reports(cookie)).code).toBe(ADMIN_PIN_REQUIRED);
    } finally {
      await driver.updateStaffProfile(T, CARMELA, { active: true });
    }
  });

  it("a till PIN cookie can't open admin, and an admin session can't be replayed at the till", async () => {
    // Manager switches in at the till: that cookie is not an admin unlock.
    const till = await tillPinPOST(
      new Request("http://localhost/api/terminal/pin", {
        method: "POST",
        body: JSON.stringify({ staffId: CARMELA, pin: CARMELA_PIN }),
      }),
    );
    const tillCookie = /pos_active_staff=([^;]+)/.exec(
      till.headers.get("set-cookie") ?? "",
    )?.[1];
    expect(tillCookie).toBeTruthy();
    expect((await reports(decodeURIComponent(tillCookie!))).code).toBe(
      ADMIN_PIN_REQUIRED,
    );

    // An admin unlock's session id, named as an offline order's session, gives
    // the till no manager authority.
    const { cookie } = await unlock(CARMELA, CARMELA_PIN);
    const sessionId = cookie!.split(".")[3]!;
    const role = await effectiveTerminalRole(
      new Request("http://localhost/api/orders", {
        headers: {
          cookie: `${ACTIVE_STAFF_COOKIE}=${encodeURIComponent(cookie!)}`,
        },
      }),
      { tenantId: T, role: "owner", user: { id: session.user!.id } },
      { queuedSessionId: sessionId, queuedStaffId: CARMELA },
    );
    expect(role.role).toBeNull();
  });

  it("a forged or tampered cookie is refused", async () => {
    const { cookie } = await unlock(CARMELA, CARMELA_PIN);
    const parts = cookie!.split(".");
    parts[1] = TONY; // claim to be the owner
    expect((await reports(parts.join("."))).code).toBe(ADMIN_PIN_REQUIRED);
    expect((await reports("garbage")).code).toBe(ADMIN_PIN_REQUIRED);
  });
});

describe("when the gate is not in force", () => {
  it("the zero-env demo uses the device role as before", async () => {
    mode.real = false;
    expect(await adminGateRequired(T)).toBe(false);
    expect((await reports()).status).toBe(200);
  });

  it("a tenant with no owner/manager PIN uses the device role (so the owner can set one up)", async () => {
    const driver = getPosDriver();
    const tony = await driver.getStaffById(T, TONY);
    const carmela = await driver.getStaffById(T, CARMELA);
    await driver.setStaffPinHash(T, TONY, null);
    await driver.setStaffPinHash(T, CARMELA, null);
    try {
      // Cashier/kitchen PINs alone don't turn it on.
      expect(await adminGateRequired(T)).toBe(false);
      expect((await reports()).status).toBe(200);
    } finally {
      await driver.setStaffPinHash(T, TONY, tony!.pin_hash ?? null);
      await driver.setStaffPinHash(T, CARMELA, carmela!.pin_hash ?? null);
    }
    expect(await adminGateRequired(T)).toBe(true);
  });

  it("an inactive manager's PIN doesn't count", async () => {
    const driver = getPosDriver();
    const tony = await driver.getStaffById(T, TONY);
    await driver.setStaffPinHash(T, TONY, null);
    await driver.updateStaffProfile(T, CARMELA, { active: false });
    try {
      expect(await adminGateRequired(T)).toBe(false);
    } finally {
      await driver.updateStaffProfile(T, CARMELA, { active: true });
      await driver.setStaffPinHash(T, TONY, tony!.pin_hash ?? null);
    }
  });
});

describe("what ends an unlock", () => {
  const withCookie = (
    url: string,
    cookie: string,
    method = "POST",
    body?: unknown,
  ) =>
    new Request(url, {
      method,
      headers: {
        cookie: `${ADMIN_UNLOCK_COOKIE}=${encodeURIComponent(cookie)}`,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  it("till switch-out / lock (DELETE /api/terminal/pin) revokes it and clears the cookie", async () => {
    const { cookie } = await unlock(CARMELA, CARMELA_PIN);
    const res = await tillPinDELETE(
      withCookie("http://localhost/api/terminal/pin", cookie!, "DELETE"),
    );
    expect(res.headers.get("set-cookie")).toMatch(
      new RegExp(`${ADMIN_UNLOCK_COOKIE}=;`),
    );
    expect((await reports(cookie)).code).toBe(ADMIN_PIN_REQUIRED);
  });

  it("a till switch-in on this browser revokes it", async () => {
    const { cookie } = await unlock(CARMELA, CARMELA_PIN);
    const res = await tillPinPOST(
      withCookie("http://localhost/api/terminal/pin", cookie!, "POST", {
        staffId: CHRIS,
        pin: "3333",
      }),
    );
    expect(res.status).toBe(200);
    expect((await reports(cookie)).code).toBe(ADMIN_PIN_REQUIRED);
  });

  it("account sign-out revokes it", async () => {
    const { cookie } = await unlock(CARMELA, CARMELA_PIN);
    const res = await signOutPOST(
      withCookie("http://localhost/auth/signout", cookie!),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toMatch(
      new RegExp(`${ADMIN_UNLOCK_COOKIE}=;`),
    );
    expect((await reports(cookie)).code).toBe(ADMIN_PIN_REQUIRED);
  });
});

describe("short owner/manager PINs", () => {
  it("are replaced by a server-issued 6-digit PIN at unlock (shown once)", async () => {
    const driver = getPosDriver();
    await driver.setStaffPinHash(T, CARMELA, hashPin("2468"));
    try {
      const { res, cookie } = await unlock(CARMELA, "2468");
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = (await res.json()) as { newPin?: string };
      expect(body.newPin).toMatch(/^\d{6}$/);
      const stored = await driver.getStaffById(T, CARMELA);
      expect(verifyPin("2468", stored?.pin_hash)).toBe(false);
      expect(verifyPin(body.newPin!, stored?.pin_hash)).toBe(true);
      expect((await reports(cookie)).status).toBe(200);
      const log = await driver.listAuditLog(T);
      expect(
        log.some(
          (e) => e.action === "staff_pin_reset" && e.detail?.includes(CARMELA),
        ),
      ).toBe(true);
      expect(log.some((e) => e.detail?.includes(body.newPin!))).toBe(false);
    } finally {
      await driver.setStaffPinHash(T, CARMELA, hashPin(CARMELA_PIN));
    }
  });

  it("a 6-digit PIN is left alone", async () => {
    const { res } = await unlock(CARMELA, CARMELA_PIN);
    expect(((await res.json()) as { newPin?: string }).newPin).toBeUndefined();
  });
});
