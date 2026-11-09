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
import { lookupGuard, type LookupIdentity } from "./lockout";
import { StoredValueError } from "./service";

export const DEVICE_COOKIE = "gc_device";

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
): LookupIdentity {
  return { ip: clientIp(request.headers), device, surface };
}

/** 429 when the caller is over the lookup limits, else null (and counted). */
export function admitLookup(id: LookupIdentity): NextResponse | null {
  const wait = lookupGuard.admit(id);
  if (wait <= 0) return null;
  const res = NextResponse.json(
    { error: "Too many gift card attempts. Try again later.", code: "too_many_attempts" },
    { status: 429 },
  );
  res.headers.set("Retry-After", String(wait));
  return res;
}

/** The uniform "unknown code" answer (counts toward the lockout). */
export function unknownCode(id: LookupIdentity): NextResponse {
  lookupGuard.fail(id);
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
