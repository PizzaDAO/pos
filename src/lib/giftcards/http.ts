/**
 * Route glue shared by the /api/gift-cards (till) and /api/shop/gift-cards
 * (storefront) handlers: the feature gate, the staff guard, the brute-force
 * guard, the storefront device cookie and error mapping.
 */
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { effectiveTerminalRole, readCookie } from "@/lib/auth/active-staff";
import { requireTenantAccess } from "@/lib/auth/tenant-guard";
import type { MembershipRole, Staff } from "@/lib/db";
import type { SessionUser } from "@/lib/auth/session";
import { captureError } from "@/lib/observability";
import { clientIp } from "@/lib/security/http";
import { GiftCardsUnavailableError } from "./codes";
import { giftCardsEnabled } from "./limits";
import { LOOKUP_RULES, identityKeys, lookupGuard, type LookupIdentity } from "./lockout";
import { getStoredValueStore } from "./store";
import { rateLimitEnabled } from "@/lib/security/rate-limit";
import { StoredValueError } from "./service";

export const DEVICE_COOKIE = "gc_device";
/**
 * Signed one-time reveal token for an online purchase (see codes.signRevealToken).
 * One cookie PER ORDER, so a buyer with several purchases in flight keeps each.
 */
export function revealCookieName(orderId: string): string {
  return `gc_reveal_${orderId.replace(/[^0-9a-fA-F]/g, "").toLowerCase()}`;
}

export function featureOff(): NextResponse | null {
  if (giftCardsEnabled()) return null;
  return NextResponse.json({ error: "Gift cards are not available." }, { status: 404 });
}

export interface StaffGrant {
  user: SessionUser;
  tenantId: string;
  locationId: string | null;
  /** Role of the active PIN-switched staff member (else the device login). */
  role: MembershipRole | null;
  staff: Staff | null;
  actor: { id: string; label: string };
}

/** Owner/manager/cashier of `tenantId` (+ location), with the effective till role. */
export async function requireTillStaff(
  request: Request,
  tenantId: string | null | undefined,
  locationId?: string | null,
): Promise<{ ok: true; grant: StaffGrant } | { ok: false; res: NextResponse }> {
  const auth = await requireTenantAccess(tenantId, ["owner", "manager", "cashier"], {
    locationId: locationId ?? null,
  });
  if (!auth.ok) return auth;
  const active = await effectiveTerminalRole(request, {
    tenantId: auth.tenantId,
    role: auth.role ?? "cashier",
    user: auth.user,
  });
  return {
    ok: true,
    grant: {
      user: auth.user,
      tenantId: auth.tenantId,
      locationId: auth.locationId,
      role: active.role,
      staff: active.staff,
      actor: { id: auth.user.id, label: active.staff?.name ?? auth.user.email },
    },
  };
}

/** Money-moving staff action: needs an effective owner/manager role. */
export function requireManagerRole(grant: StaffGrant): NextResponse | null {
  if (grant.role === "owner" || grant.role === "manager") return null;
  return NextResponse.json(
    { error: "Only an owner or manager can do this.", code: "manager_required" },
    { status: 403 },
  );
}

/** The storefront device id (cookie), minted when absent. */
export function shopDevice(request: Request): { id: string; fresh: boolean } {
  const v = readCookie(request, DEVICE_COOKIE);
  if (v && /^[0-9a-f-]{36}$/.test(v)) return { id: v, fresh: false };
  return { id: randomUUID(), fresh: true };
}

export function withDeviceCookie(res: NextResponse, device: { id: string; fresh: boolean }) {
  if (device.fresh) {
    res.cookies.set(DEVICE_COOKIE, device.id, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  return res;
}

export function lookupIdentity(
  request: Request,
  surface: LookupIdentity["surface"],
  device: string | null,
  staff: string | null = null,
): LookupIdentity {
  return { ip: clientIp(request.headers), device, staff, surface };
}

/** Limiter keys: per IP AND per device, each scoped to the tenant. */
export function lookupKeys(id: LookupIdentity, tenantId: string): string[] {
  return identityKeys(id).map((k) => `${k}:${tenantId}`);
}

function tooMany(wait: number): NextResponse {
  const res = NextResponse.json(
    { error: "Too many gift card attempts. Try again later.", code: "too_many_attempts" },
    { status: 429 },
  );
  res.headers.set("Retry-After", String(wait));
  return res;
}

/**
 * 429 when the caller is over the lookup limits, else null. Two layers: a
 * process-local burst cap, and the failure lockout kept in the DATABASE (shared
 * by every app instance), keyed on IP + tenant and device + tenant.
 */
export async function admitLookup(id: LookupIdentity, tenantId: string): Promise<NextResponse | null> {
  const burst = lookupGuard.admit(id);
  if (burst > 0) return tooMany(burst);
  if (!rateLimitEnabled()) return null;
  try {
    const store = await getStoredValueStore();
    const wait = await store.guardCheck(lookupKeys(id, tenantId));
    return wait > 0 ? tooMany(wait) : null;
  } catch (err) {
    // Fail CLOSED (never an unguarded lookup), but as a clean 503, not a raw 500.
    captureError(err, { scope: "giftcard-guard-check" });
    return NextResponse.json(
      { error: "Gift cards are temporarily unavailable. Try again shortly.", code: "unavailable" },
      { status: 503 },
    );
  }
}

/** The uniform "unknown code" answer (counts toward the shared lockout). */
export async function unknownCode(id: LookupIdentity, tenantId: string): Promise<NextResponse> {
  if (rateLimitEnabled()) {
    const store = await getStoredValueStore();
    await store
      .guardFail(lookupKeys(id, tenantId), LOOKUP_RULES.failures.limit, LOOKUP_RULES.failures.windowMs / 1000)
      .catch((err) => captureError(err, { scope: "giftcard-guard" }));
  }
  return NextResponse.json(
    { error: "That code was not found.", code: "not_found" },
    { status: 404 },
  );
}

export function errorResponse(err: unknown, scope: string): NextResponse {
  if (err instanceof StoredValueError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }
  if (err instanceof GiftCardsUnavailableError) {
    return NextResponse.json({ error: err.message }, { status: 404 });
  }
  captureError(err, { scope });
  return NextResponse.json({ error: "Gift card request failed." }, { status: 502 });
}

export function cleanText(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
}
