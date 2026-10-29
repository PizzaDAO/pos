/**
 * Staff & cash drawer — /api/admin/staff (Phase 5).
 *
 * GET  ?tenantId=&locationId=  → staff list + each member's open shift (if any)
 *      + recent shifts for the location.
 * POST { action, ... }:
 *   - "clockIn"  { staffId, openingFloatCents } → open a shift (idempotent).
 *   - "cashEvent"{ shiftId, type, amountCents, note } → record a drawer event.
 *   - "clockOut" { shiftId, countedCents, note } → close + reconcile (over/short).
 *
 * Drawer reconciliation = float + cash sales + paid-in − payouts vs counted.
 * Auth: GET → owner|manager (admin surface). POST → any operational role of
 * the tenant (terminal surface). Staff and shifts referenced by id are verified
 * to belong to the authorized tenant; cash events use the SHIFT's own
 * tenant/location, never client-supplied ones. No env vars; mock driver.
 */
import { NextResponse } from "next/server";
import {
  getPosDriver,
  type CashEventType,
  type Shift,
  type ShiftCashEvent,
} from "@/lib/db";
import { requireTenantAccess } from "@/lib/auth/tenant-guard";
import { isMoneyCents } from "@/lib/security";

const CASH_EVENT_TYPES: CashEventType[] = ["sale", "payout", "paid_in", "drop"];

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const auth = await requireTenantAccess(searchParams.get("tenantId"), "admin", {
    locationId: searchParams.get("locationId"),
    requireLocation: true,
  });
  if (!auth.ok) return auth.res;
  const tenantId = auth.tenantId;
  const locationId = auth.locationId as string;
  const driver = getPosDriver();
  const [staff, shifts] = await Promise.all([
    driver.listStaff(tenantId),
    driver.listShifts(tenantId, locationId),
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

  return NextResponse.json({ staff, shifts, openShifts, reconciliations });
}

interface StaffBody {
  action: "clockIn" | "cashEvent" | "clockOut";
  tenantId?: string;
  locationId?: string;
  staffId?: string;
  openingFloatCents?: number;
  shiftId?: string;
  type?: CashEventType;
  amountCents?: number;
  countedCents?: number;
  note?: string | null;
}

export async function POST(request: Request) {
  let body: StaffBody;
  try {
    body = (await request.json()) as StaffBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  // Any operational member of the tenant may open/close a drawer + record drawer events.
  if (!body.tenantId) {
    return NextResponse.json({ error: "tenantId is required." }, { status: 422 });
  }
  const auth = await requireTenantAccess(body.tenantId, "terminal", {
    locationId: body.locationId ?? null,
  });
  if (!auth.ok) return auth.res;
  const tenantId = auth.tenantId;
  const driver = getPosDriver();

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
      if (!(await driver.getStaffById(tenantId, body.staffId))) {
        return NextResponse.json({ error: "Staff not found." }, { status: 404 });
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
