/**
 * Staff PIN quick-switch — POST /api/terminal/pin
 *
 * On a shared terminal, the DEVICE is logged into a location by a tenant user
 * (real Supabase session). Cashiers then switch the ACTIVE STAFF member by PIN,
 * without a full re-login, so orders/shifts attribute to whoever is at the till.
 *
 * Security:
 *   - The caller must hold an operational role (owner|manager|cashier|kitchen)
 *     on the tenant — enforced server-side from the session, NOT trusted from
 *     the body. The tenant is taken from the session context, not the client.
 *   - The PIN is verified SERVER-SIDE against `staff.pin_hash`; the hash never
 *     leaves the server, and the response returns only the resolved active-staff
 *     id/name/role on success.
 *   - A generic 401 is returned for any failure (no staff/PIN enumeration).
 *
 * Body: { staffId, pin }. No env vars required (works on the mock driver).
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth/session";
import { tenantsForSurface } from "@/lib/auth/roles";
import { isValidPinFormat, verifyPin } from "@/lib/auth/pin";

export const runtime = "nodejs";

/**
 * GET /api/terminal/pin — the active-staff PICKER for the terminal: active staff
 * of the session's terminal-authorized tenant(s), names/roles only (no PIN
 * hash; listStaff strips it). Lets the cashier pick who they are before entering
 * the PIN. Gated to the device session's operational roles.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const allowedTenants = tenantsForSurface(user.memberships, "terminal");
  if (allowedTenants.length === 0) {
    return NextResponse.json({ error: "Not authorized." }, { status: 403 });
  }
  const driver = getPosDriver();
  const lists = await Promise.all(
    allowedTenants.map((t) => driver.listStaff(t)),
  );
  const staff = lists
    .flat()
    .filter((s) => s.active)
    .map((s) => ({
      id: s.id,
      tenant_id: s.tenant_id,
      name: s.name,
      role: s.role,
    }));
  return NextResponse.json({ staff });
}

interface Body {
  staffId: string;
  pin: string;
}

function isValid(b: unknown): b is Body {
  if (!b || typeof b !== "object") return false;
  const r = b as Record<string, unknown>;
  return typeof r.staffId === "string" && typeof r.pin === "string";
}

export async function POST(request: Request) {
  // The device session authorizes WHICH tenant the PIN switch applies to.
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!isValid(body) || !isValidPinFormat(body.pin)) {
    return NextResponse.json({ error: "Invalid PIN." }, { status: 401 });
  }

  // Tenants the device user may operate a terminal for (operational roles).
  const allowedTenants = tenantsForSurface(user.memberships, "terminal");
  if (allowedTenants.length === 0) {
    return NextResponse.json({ error: "Not authorized." }, { status: 403 });
  }

  const driver = getPosDriver();
  // Find the staff member among the device user's authorized tenants, then
  // verify the PIN. getStaffById carries pin_hash; it never goes to the client.
  let matched: Awaited<ReturnType<typeof driver.getStaffById>> = null;
  for (const tenantId of allowedTenants) {
    const staff = await driver.getStaffById(tenantId, body.staffId);
    if (staff) {
      matched = staff;
      break;
    }
  }

  if (!matched || !matched.active || !verifyPin(body.pin, matched.pin_hash)) {
    // Generic 401 — don't reveal whether the staff id existed or the PIN was wrong.
    return NextResponse.json({ error: "Incorrect PIN." }, { status: 401 });
  }

  // Success: return only non-sensitive identity for attribution (no hash).
  return NextResponse.json({
    activeStaff: {
      id: matched.id,
      tenant_id: matched.tenant_id,
      name: matched.name,
      role: matched.role,
    },
  });
}
