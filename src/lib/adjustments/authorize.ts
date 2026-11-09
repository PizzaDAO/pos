/**
 * Who is acting at the till, and manager PIN approval (server-only).
 *
 * The ACTOR of a refund / void / comp is the active (PIN-switched) staff member
 * (see `effectiveTerminalRole`), else the device login's role when the tenant
 * has no staff PINs. Above the location threshold a non-manager needs an
 * owner/manager to approve: the request carries `approval: { staffId, pin }`,
 * verified here with the same per-staff lockout as the PIN switch (each attempt
 * counted atomically BEFORE the PIN is checked). The approval is per request:
 * it opens no session and changes nobody's active staff.
 */
import { NextResponse } from "next/server";
import { getPosDriver, type MembershipRole, type Staff } from "@/lib/db";
import type { SessionUser } from "@/lib/auth/session";
import { requireTenantRole } from "@/lib/auth/api";
import { effectiveTerminalRole } from "@/lib/auth/active-staff";
import { sessionRoleIn } from "@/lib/auth/tenant-guard";
import { isValidPinFormat, verifyPin } from "@/lib/auth/pin";
import type { AdjustmentKind, AdjustmentPolicy } from "@/lib/db/adjustment-types";
import { isManagerRole, needsApproval, resolvePolicy, thresholdFor } from "./policy";

export interface TillActor {
  user: SessionUser;
  role: MembershipRole;
  /** The PIN-switched staff member, when there is one. */
  staff: Staff | null;
}

/** Resolve the acting till user (owner | manager | cashier) for a tenant. */
export async function resolveTillActor(
  request: Request,
  tenantId: string,
): Promise<{ ok: true; actor: TillActor } | { ok: false; res: NextResponse }> {
  const auth = await requireTenantRole(tenantId, ["owner", "manager", "cashier"]);
  if (!auth.ok) return auth;
  const active = await effectiveTerminalRole(request, {
    tenantId,
    role: sessionRoleIn(auth.user, tenantId) ?? "cashier",
    user: auth.user,
  });
  if (!active.role || active.role === "kitchen") {
    return {
      ok: false,
      res: NextResponse.json(
        { error: "Switch in with your staff PIN first.", code: "staff_required" },
        { status: 403 },
      ),
    };
  }
  return { ok: true, actor: { user: auth.user, role: active.role, staff: active.staff } };
}

/** `approval` as sent by the till (validated here). */
export interface ApprovalInput {
  staffId: string;
  pin: string;
}

export function parseApproval(raw: unknown): ApprovalInput | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.staffId !== "string" || !r.staffId || r.staffId.length > 64) return null;
  if (!isValidPinFormat(r.pin)) return null;
  return { staffId: r.staffId, pin: r.pin as string };
}

export async function loadPolicy(tenantId: string, locationId: string): Promise<AdjustmentPolicy> {
  const settings = await getPosDriver().getStoreSettings(tenantId, locationId);
  return resolvePolicy(settings.adjustment_policy);
}

export type ApprovalOutcome =
  | { ok: true; approver: Staff | null }
  | { ok: false; res: NextResponse };

/**
 * Enforce the policy for one action. Returns the approving manager (null when
 * none was needed), or the response to send: 403 `approval_required` (the till
 * asks for a manager PIN and resends), 401 `approval_pin_incorrect`, 423 locked.
 */
export async function authorizeAdjustment(input: {
  tenantId: string;
  /** The order's location: the approving manager must work there. */
  locationId: string;
  actor: TillActor;
  policy: AdjustmentPolicy;
  kind: AdjustmentKind;
  amountCents: number;
  fired?: boolean;
  approval: ApprovalInput | null;
}): Promise<ApprovalOutcome> {
  const required = needsApproval({
    policy: input.policy,
    kind: input.kind,
    amountCents: input.amountCents,
    role: input.actor.role,
    fired: input.fired,
  });
  if (!required) return { ok: true, approver: null };
  const threshold = thresholdFor(input.policy, input.kind);
  if (!input.approval) {
    return {
      ok: false,
      res: NextResponse.json(
        {
          error: "A manager must approve this.",
          code: "approval_required",
          amountCents: input.amountCents,
          thresholdCents: threshold,
        },
        { status: 403 },
      ),
    };
  }
  const incorrect = () =>
    NextResponse.json(
      { error: "Manager PIN incorrect.", code: "approval_pin_incorrect" },
      { status: 401 },
    );
  const driver = getPosDriver();
  const staff = await driver.getStaffById(input.tenantId, input.approval.staffId);
  if (!staff || !staff.active || !isManagerRole(staff.role)) return { ok: false, res: incorrect() };
  // A manager scoped to other locations cannot approve here (empty = all).
  if (staff.location_ids?.length && !staff.location_ids.includes(input.locationId)) {
    return { ok: false, res: incorrect() };
  }
  const attempt = await driver.beginPinAttempt(input.tenantId, staff.id);
  if (!attempt.allowed) {
    return {
      ok: false,
      res: NextResponse.json(
        {
          error: "Too many incorrect PINs. Try again later.",
          code: "approval_locked",
          lockedUntil: attempt.lockedUntil,
        },
        { status: 423 },
      ),
    };
  }
  if (!verifyPin(input.approval.pin, staff.pin_hash)) return { ok: false, res: incorrect() };
  await driver.clearPinAttempts(input.tenantId, staff.id);
  return { ok: true, approver: { ...staff, pin_hash: undefined } };
}
