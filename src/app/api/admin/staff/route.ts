/**
 * Staff & cash drawer — /api/admin/staff (Phase 5 + staff management).
 *
 * GET  ?tenantId=&locationId=  → staff list (+ contact details), who has a PIN,
 *      each member's last PIN sign-in, the acting admin, each member's open
 *      shift (if any) + recent shifts for the location.
 * POST { action, ... }:
 *   - "create"     { name, role, email?, phone?, moduleRoles?, locationIds?,
 *                    issuePin? } → add a staff member (201; `pin` once if asked).
 *   - "update"     { staffId, name?, role?, email?, phone?, moduleRoles?,
 *                    locationIds? } → edit.
 *   - "deactivate" / "reactivate" { staffId } → never a hard delete (orders,
 *                    shifts and payments reference staff).
 *   - "resetPin"   { staffId } → issue a new server-generated PIN, unique in the
 *                    tenant, returned ONCE (see src/lib/staff/manage.ts).
 *   - "clockIn"  { staffId, openingFloatCents } → open a shift (idempotent).
 *   - "cashEvent"{ shiftId, type, amountCents, note } → record a drawer event.
 *   - "clockOut" { shiftId, countedCents, note } → close + reconcile (over/short).
 * PATCH { tenantId, staffId, moduleRoles: ("driver"|"dispatcher")[] } → set the
 *      member's roles for other Open Pizza modules. Grants nothing inside POS;
 *      the driver module reads them from the contract staff.
 *
 * Rules (src/lib/staff/manage.ts#checkStaffChange): owner|manager only;
 * managers can't create, promote to, or change an owner; nobody can demote or
 * deactivate the last active owner (also a DB trigger). Every roster change and
 * PIN reset is audited; a role change, deactivation or PIN reset ends that
 * member's live till/admin sessions.
 *
 * Drawer reconciliation = float + cash sales + paid-in − payouts vs counted.
 * Auth: every method → owner|manager device session AND the back-office PIN
 * gate (src/lib/auth/admin-gate.ts). The acting role for the rules is the PIN
 * staff member's. Staff and shifts referenced by id are verified to belong to
 * the authorized tenant; cash events use the SHIFT's own tenant/location, never
 * client-supplied ones. No env vars; mock driver.
 */
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  getPosDriver,
  type CashEventType,
  type MembershipRole,
  type Shift,
  type ShiftCashEvent,
  type Staff,
  type StaffProfilePatch,
} from "@/lib/db";
import {
  recentlySignedIn,
  requireAdminAccess,
  type AdminActor,
} from "@/lib/auth/admin-gate";
import { isMoneyCents, recordAudit } from "@/lib/security";
import { STAFF_MODULE_ROLES, normalizeModuleRoles } from "@/lib/db";
import {
  checkStaffChange,
  cleanEmail,
  cleanName,
  cleanPhone,
  isStaffRole,
  issueStaffPin,
  checkPinIssue,
  ownerHasPin,
  type StaffChange,
} from "@/lib/staff/manage";

const CASH_EVENT_TYPES: CashEventType[] = ["sale", "payout", "paid_in", "drop"];

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const auth = await requireAdminAccess(request, searchParams.get("tenantId"), {
    locationId: searchParams.get("locationId"),
    requireLocation: true,
  });
  if (!auth.ok) return auth.res;
  const tenantId = auth.tenantId;
  const locationId = auth.locationId as string;
  const driver = getPosDriver();
  const [staff, shifts, withPin, signIns] = await Promise.all([
    driver.listStaff(tenantId),
    driver.listShifts(tenantId, locationId),
    driver.listStaffWithPin(tenantId),
    driver.lastStaffSignIns(tenantId),
  ]);

  // Resolve each staff member's currently-open shift (if any) for the UI.
  const openShifts: Record<string, Shift | null> = {};
  await Promise.all(
    staff.map(async (s) => {
      openShifts[s.id] = await driver.getOpenShift(
        tenantId,
        locationId,
        s.id,
      );
    }),
  );

  // Reconciliation summaries for the listed shifts (so the UI can show drawer).
  const reconciliations = await Promise.all(
    shifts.map(async (s) => ({
      shiftId: s.id,
      reconciliation: await driver.getDrawerReconciliation(s.id),
    })),
  );

  return NextResponse.json(
    {
      staff,
      shifts,
      openShifts,
      reconciliations,
      hasPin: Object.fromEntries(staff.map((s) => [s.id, withPin.has(s.id)])),
      lastSignInAt: Object.fromEntries(signIns),
      actor: actorView(auth.actor),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** What the UI needs to know about the acting admin (no secrets). */
function actorView(actor: AdminActor) {
  return {
    role: actor.role,
    staffId: actor.staff?.id ?? null,
    name: actor.staff?.name ?? null,
    gated: actor.gated,
    expiresAt: actor.expiresAt,
  };
}

const deny = (status: number, error: string) =>
  NextResponse.json({ error }, { status });

async function activeOwnerCount(tenantId: string): Promise<number> {
  return (await getPosDriver().listStaff(tenantId)).filter(
    (s) => s.active && s.role === "owner",
  ).length;
}

/** The rules check for `change`; a 403 response when refused, else null. */
async function refuse(
  actor: AdminActor,
  tenantId: string,
  change: StaffChange,
): Promise<NextResponse | null> {
  const why = checkStaffChange(actor.role, change, await activeOwnerCount(tenantId));
  return why ? deny(403, why) : null;
}

/** Who did it, for the audit trail: the device login + the PIN staff member. */
function auditActor(auth: { user: { id: string; email: string }; actor: AdminActor }) {
  return {
    id: auth.user.id,
    label: auth.actor.staff
      ? `${auth.user.email} (PIN: ${auth.actor.staff.name})`
      : auth.user.email,
  };
}

/** Validated location ids (each must belong to the tenant); false when invalid. */
async function cleanLocationIds(
  tenantId: string,
  v: unknown,
): Promise<string[] | false> {
  if (!Array.isArray(v)) return false;
  const known = new Set((await getPosDriver().listLocations(tenantId)).map((l) => l.id));
  const ids = [...new Set(v)];
  return ids.every((id) => typeof id === "string" && known.has(id))
    ? (ids as string[])
    : false;
}

/** A staff row without any PIN material, for a response. */
function publicStaff(s: Staff): Staff {
  return {
    ...s,
    pin_hash: undefined,
    pin_previous_hash: undefined,
    pin_previous_until: undefined,
  };
}

/** Will this change leave `target` an ACTIVE owner/manager holding a PIN? */
function holdsGatePin(
  target: Staff,
  next: { role?: MembershipRole; active?: boolean },
): MembershipRole | null {
  const role = next.role ?? target.role;
  const active = next.active ?? target.active;
  return target.pin_hash && active && (role === "owner" || role === "manager")
    ? role
    : null;
}

/** A deadlock / serialization failure (Postgres 40P01 / 40001): retryable → 409. */
function isRetryableDbError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return (
    code === "40P01" ||
    code === "40001" ||
    /deadlock detected|could not serialize access/i.test(err.message)
  );
}

/** The bootstrap rules for issuing a PIN to a member with `role` (manage.ts). */
async function pinIssueRefusal(
  auth: ManageAuth,
  role: MembershipRole,
): Promise<NextResponse | null> {
  const why = checkPinIssue({
    role,
    ownerHasPin: await ownerHasPin(auth.tenantId),
    gateOn: auth.actor.gated,
    recentSignIn: recentlySignedIn(auth.user),
  });
  return why
    ? NextResponse.json(
        { error: why.error, ...(why.code ? { code: why.code } : {}) },
        { status: why.status },
      )
    : null;
}

/** Owner-safe failure of the DB "keep an owner" trigger → 409. */
function isLastOwnerError(err: unknown): boolean {
  return err instanceof Error && /last active owner/i.test(err.message);
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(request: Request) {
  let body: { tenantId?: string; staffId?: string; moduleRoles?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (
    !body.tenantId ||
    typeof body.staffId !== "string" ||
    !UUID_RE.test(body.staffId) ||
    !Array.isArray(body.moduleRoles)
  ) {
    return NextResponse.json(
      { error: "tenantId, staffId and moduleRoles[] are required." },
      { status: 422 },
    );
  }
  if (
    !body.moduleRoles.every((r) =>
      (STAFF_MODULE_ROLES as readonly unknown[]).includes(r),
    )
  ) {
    return NextResponse.json(
      { error: `moduleRoles must be among: ${STAFF_MODULE_ROLES.join(", ")}.` },
      { status: 422 },
    );
  }
  const auth = await requireAdminAccess(request, body.tenantId);
  if (!auth.ok) return auth.res;
  const driver = getPosDriver();
  // Resolved inside the authorized tenant: another tenant's staff id is a 404.
  const staff = await driver.getStaffById(auth.tenantId, body.staffId);
  if (!staff) {
    return NextResponse.json({ error: "Staff not found." }, { status: 404 });
  }
  const refused = await refuse(auth.actor, auth.tenantId, {
    kind: "update",
    target: staff,
    next: {},
  });
  if (refused) return refused;
  const next = normalizeModuleRoles(body.moduleRoles);
  // Targeted write of module_roles only (tenant + id scoped); nothing else moves.
  const saved = await driver.setStaffModuleRoles(auth.tenantId, staff.id, next);
  if (!saved) {
    return NextResponse.json({ error: "Staff not found." }, { status: 404 });
  }
  const fmt = (r: readonly string[] | undefined) => `[${(r ?? []).join(", ")}]`;
  await recordAudit({
    actor: auditActor(auth),
    action: "membership_change",
    tenantId: auth.tenantId,
    detail: `Staff ${staff.id} module_roles ${fmt(staff.module_roles)} -> ${fmt(next)}`,
  });
  return NextResponse.json({ staff: saved });
}

type ManageAction = "create" | "update" | "deactivate" | "reactivate" | "resetPin";
const MANAGE_ACTIONS: readonly string[] = [
  "create",
  "update",
  "deactivate",
  "reactivate",
  "resetPin",
];

interface StaffBody {
  action: "clockIn" | "cashEvent" | "clockOut" | ManageAction;
  tenantId?: string;
  locationId?: string;
  staffId?: string;
  openingFloatCents?: number;
  shiftId?: string;
  type?: CashEventType;
  amountCents?: number;
  countedCents?: number;
  note?: string | null;
  // create / update
  name?: unknown;
  role?: unknown;
  email?: unknown;
  phone?: unknown;
  moduleRoles?: unknown;
  locationIds?: unknown;
  issuePin?: unknown;
}

export async function POST(request: Request) {
  let body: StaffBody;
  try {
    body = (await request.json()) as StaffBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || !body.tenantId) {
    return NextResponse.json({ error: "tenantId is required." }, { status: 422 });
  }
  // Drawer actions and staff management are back-office actions: owner|manager
  // device session + the PIN gate.
  const auth = await requireAdminAccess(request, body.tenantId, {
    locationId: body.locationId ?? null,
  });
  if (!auth.ok) return auth.res;
  const tenantId = auth.tenantId;
  const driver = getPosDriver();

  if (MANAGE_ACTIONS.includes(body.action)) {
    try {
      return await manage(body, { ...auth, tenantId });
    } catch (err) {
      if (isRetryableDbError(err)) {
        return deny(409, "Someone else changed staff at the same time. Try again.");
      }
      if (isLastOwnerError(err)) {
        return deny(409, "This is the last owner. Make someone else an owner first.");
      }
      return deny(500, err instanceof Error ? err.message : "Staff change failed.");
    }
  }

  /** A shift by id, only if it belongs to the authorized tenant. */
  const ownShift = async (shiftId: string) => {
    const shift = await driver.getShift(shiftId);
    return shift && shift.tenant_id === tenantId ? shift : null;
  };

  try {
    if (body.action === "clockIn") {
      if (!body.tenantId || !body.locationId || !body.staffId) {
        return NextResponse.json(
          { error: "tenantId, locationId, staffId are required." },
          { status: 422 },
        );
      }
      if (
        body.openingFloatCents !== undefined &&
        !isMoneyCents(body.openingFloatCents)
      ) {
        return NextResponse.json(
          { error: "openingFloatCents must be a non-negative integer." },
          { status: 422 },
        );
      }
      const member = await driver.getStaffById(tenantId, body.staffId);
      if (!member) {
        return NextResponse.json({ error: "Staff not found." }, { status: 404 });
      }
      if (!member.active) {
        return deny(409, "This staff member is deactivated.");
      }
      const shift = await driver.openShift({
        tenantId,
        locationId: body.locationId,
        staffId: body.staffId,
        openingFloatCents: body.openingFloatCents ?? 0,
      });
      return NextResponse.json({ shift }, { status: 201 });
    }

    if (body.action === "cashEvent") {
      if (
        !body.shiftId ||
        !body.tenantId ||
        !body.locationId ||
        !body.type ||
        typeof body.amountCents !== "number"
      ) {
        return NextResponse.json(
          { error: "shiftId, tenantId, locationId, type, amountCents required." },
          { status: 422 },
        );
      }
      if (
        !CASH_EVENT_TYPES.includes(body.type) ||
        !isMoneyCents(Math.abs(body.amountCents))
      ) {
        return NextResponse.json(
          { error: "Invalid cash event." },
          { status: 422 },
        );
      }
      const shift = await ownShift(body.shiftId);
      if (!shift) {
        return NextResponse.json({ error: "Shift not found." }, { status: 404 });
      }
      const event: ShiftCashEvent = {
        id: "",
        shift_id: shift.id,
        tenant_id: shift.tenant_id,
        location_id: shift.location_id,
        type: body.type,
        amount_cents: body.amountCents,
        order_id: null,
        note: body.note ?? null,
        created_at: "",
      };
      const saved = await driver.addShiftCashEvent(event);
      const reconciliation = await driver.getDrawerReconciliation(body.shiftId);
      return NextResponse.json(
        { event: saved, reconciliation },
        { status: 201 },
      );
    }

    if (body.action === "clockOut") {
      if (!body.shiftId || !isMoneyCents(body.countedCents)) {
        return NextResponse.json(
          { error: "shiftId and countedCents are required." },
          { status: 422 },
        );
      }
      if (!(await ownShift(body.shiftId))) {
        return NextResponse.json({ error: "Shift not found." }, { status: 404 });
      }
      const shift = await driver.closeShift({
        shiftId: body.shiftId,
        countedCents: body.countedCents,
        note: body.note ?? null,
      });
      if (!shift) {
        return NextResponse.json(
          { error: "Shift not found." },
          { status: 404 },
        );
      }
      const reconciliation = await driver.getDrawerReconciliation(shift.id);
      return NextResponse.json({ shift, reconciliation });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 422 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Staff action failed." },
      { status: 500 },
    );
  }
}

type ManageAuth = {
  tenantId: string;
  user: { id: string; email: string; authAt?: number | null };
  actor: AdminActor;
};

/** Staff management actions (create / update / deactivate / reactivate / resetPin). */
async function manage(body: StaffBody, auth: ManageAuth): Promise<NextResponse> {
  const { tenantId } = auth;
  const driver = getPosDriver();
  const actor = auditActor(auth);

  if (body.action === "create") {
    const name = cleanName(body.name);
    if (!name) return deny(422, "Name is required (up to 80 characters).");
    if (!isStaffRole(body.role)) {
      return deny(422, "Role must be owner, manager, cashier or kitchen.");
    }
    const role: MembershipRole = body.role;
    const email = cleanEmail(body.email);
    if (email === false) return deny(422, "That email doesn't look right.");
    const phone = cleanPhone(body.phone);
    if (phone === false) return deny(422, "That phone number doesn't look right.");
    const moduleRoles = body.moduleRoles === undefined ? [] : body.moduleRoles;
    if (
      !Array.isArray(moduleRoles) ||
      !moduleRoles.every((r) => (STAFF_MODULE_ROLES as readonly unknown[]).includes(r))
    ) {
      return deny(422, `moduleRoles must be among: ${STAFF_MODULE_ROLES.join(", ")}.`);
    }
    const locationIds =
      body.locationIds === undefined ? [] : await cleanLocationIds(tenantId, body.locationIds);
    if (locationIds === false) return deny(422, "Unknown location.");
    const refused = await refuse(auth.actor, tenantId, { kind: "create", role });
    if (refused) return refused;
    if (body.issuePin === true) {
      const pinRefused = await pinIssueRefusal(auth, role);
      if (pinRefused) return pinRefused;
    }

    const created = await driver.upsertStaff({
      id: randomUUID(),
      tenant_id: tenantId,
      name,
      role,
      active: true,
      pin_hash: null,
      user_id: null,
      location_ids: locationIds,
      module_roles: normalizeModuleRoles(moduleRoles),
      contact_email: email,
      contact_phone: phone,
      created_at: new Date().toISOString(),
    });
    await recordAudit({
      actor,
      action: "staff_create",
      tenantId,
      detail: `Added staff ${created.id} "${created.name}" as ${created.role}.`,
    });
    let pin: string | null = null;
    if (body.issuePin === true) {
      pin = await issueStaffPin(tenantId, created.id);
      if (pin) {
        await recordAudit({
          actor,
          action: "staff_pin_reset",
          tenantId,
          detail: `Issued a PIN for staff ${created.id} "${created.name}".`,
        });
      }
    }
    return NextResponse.json(
      { staff: created, ...(pin ? { pin } : {}) },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Every other action names an existing staff member of THIS tenant.
  if (typeof body.staffId !== "string" || !UUID_RE.test(body.staffId)) {
    return deny(422, "staffId is required.");
  }
  const target = await driver.getStaffById(tenantId, body.staffId);
  if (!target) return deny(404, "Staff not found.");
  const label = `staff ${target.id} "${target.name}"`;

  if (body.action === "resetPin") {
    const refused = await refuse(auth.actor, tenantId, { kind: "resetPin", target });
    if (refused) return refused;
    const pinRefused = await pinIssueRefusal(auth, target.role);
    if (pinRefused) return pinRefused;
    const pin = await issueStaffPin(tenantId, target.id);
    if (!pin) return deny(404, "Staff not found.");
    // Whoever was signed in on the old PIN is signed out.
    await driver.revokeStaffSessionsForStaff(tenantId, target.id);
    await recordAudit({
      actor,
      action: "staff_pin_reset",
      tenantId,
      detail: `Reset the PIN for ${label}.`,
    });
    return NextResponse.json(
      { pin, staffId: target.id },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  if (body.action === "deactivate" || body.action === "reactivate") {
    const active = body.action === "reactivate";
    if (target.active === active) {
      return NextResponse.json({ staff: publicStaff(target) });
    }
    const refused = await refuse(auth.actor, tenantId, {
      kind: "update",
      target,
      next: { active },
    });
    if (refused) return refused;
    // Reactivating an owner/manager who has a PIN hands out a gate PIN again:
    // the same bootstrap rules as issuing one.
    const gateRole = active ? holdsGatePin(target, { active }) : null;
    if (gateRole) {
      const pinRefused = await pinIssueRefusal(auth, gateRole);
      if (pinRefused) return pinRefused;
    }
    const saved = await driver.updateStaffProfile(tenantId, target.id, { active });
    if (!saved) return deny(404, "Staff not found.");
    if (!active) await driver.revokeStaffSessionsForStaff(tenantId, target.id);
    await recordAudit({
      actor,
      action: active ? "staff_reactivate" : "staff_deactivate",
      tenantId,
      detail: `${active ? "Reactivated" : "Deactivated"} ${label}.`,
    });
    return NextResponse.json({ staff: saved });
  }

  // update
  const patch: StaffProfilePatch = {};
  const changes: string[] = [];
  if (body.name !== undefined) {
    const name = cleanName(body.name);
    if (!name) return deny(422, "Name is required (up to 80 characters).");
    if (name !== target.name) {
      patch.name = name;
      changes.push(`name "${target.name}" -> "${name}"`);
    }
  }
  if (body.role !== undefined) {
    if (!isStaffRole(body.role)) {
      return deny(422, "Role must be owner, manager, cashier or kitchen.");
    }
    if (body.role !== target.role) {
      patch.role = body.role;
      changes.push(`role ${target.role} -> ${body.role}`);
    }
  }
  if (body.email !== undefined) {
    const email = cleanEmail(body.email);
    if (email === false) return deny(422, "That email doesn't look right.");
    if (email !== (target.contact_email ?? null)) {
      patch.contact_email = email;
      changes.push("email changed");
    }
  }
  if (body.phone !== undefined) {
    const phone = cleanPhone(body.phone);
    if (phone === false) return deny(422, "That phone number doesn't look right.");
    if (phone !== (target.contact_phone ?? null)) {
      patch.contact_phone = phone;
      changes.push("phone changed");
    }
  }
  if (body.moduleRoles !== undefined) {
    if (
      !Array.isArray(body.moduleRoles) ||
      !body.moduleRoles.every((r) => (STAFF_MODULE_ROLES as readonly unknown[]).includes(r))
    ) {
      return deny(422, `moduleRoles must be among: ${STAFF_MODULE_ROLES.join(", ")}.`);
    }
    const next = normalizeModuleRoles(body.moduleRoles);
    const cur = target.module_roles ?? [];
    if (next.join() !== cur.join()) {
      patch.module_roles = next;
      changes.push(`module_roles [${cur.join(", ")}] -> [${next.join(", ")}]`);
    }
  }
  if (body.locationIds !== undefined) {
    const ids = await cleanLocationIds(tenantId, body.locationIds);
    if (ids === false) return deny(422, "Unknown location.");
    const cur = target.location_ids ?? [];
    if ([...ids].sort().join() !== [...cur].sort().join()) {
      patch.location_ids = ids;
      changes.push("locations changed");
    }
  }
  const refused = await refuse(auth.actor, tenantId, {
    kind: "update",
    target,
    next: { role: patch.role },
  });
  if (refused) return refused;
  // Promoting someone who already has a PIN to owner/manager makes that PIN a
  // back-office PIN: the same bootstrap rules as issuing one (else a cashier at
  // a till signed in as the owner could promote themselves, gate off, and hold
  // a gate PIN without any re-auth).
  if (patch.role && patch.role !== target.role) {
    const gateRole = holdsGatePin(target, { role: patch.role });
    if (gateRole) {
      const pinRefused = await pinIssueRefusal(auth, gateRole);
      if (pinRefused) return pinRefused;
    }
  }
  if (changes.length === 0) {
    return NextResponse.json({ staff: publicStaff(target) });
  }
  const saved: Staff | null = await driver.updateStaffProfile(tenantId, target.id, patch);
  if (!saved) return deny(404, "Staff not found.");
  // A changed role takes effect now: end their live till/admin sessions.
  if (patch.role) await driver.revokeStaffSessionsForStaff(tenantId, target.id);
  await recordAudit({
    actor,
    action: "staff_update",
    tenantId,
    detail: `Updated ${label}: ${changes.join("; ")}.`,
  });
  return NextResponse.json({ staff: saved });
}
