/**
 * Inventory management — /api/admin/inventory (Phase 5).
 *
 * GET  ?tenantId=&locationId=  → location inventory (with derived `low` flag) +
 *      the recent movement ledger.
 * POST { action: "upsertItem", item }       → create/edit an inventory item.
 *      { action: "movement", inventoryItemId, reason, delta, note } → apply a
 *      manual restock/adjustment/waste movement and return the new level.
 *
 * Sale-driven depletion happens automatically in `createOrder`; this endpoint
 * covers manual stock changes. No env vars; in-memory mock driver.
 *
 * Auth: owner|manager of the tenant. Items/locations referenced by id are
 * verified to belong to that tenant before any write.
 */
import { NextResponse } from "next/server";
import {
  getPosDriver,
  type InventoryItem,
  type MovementReason,
} from "@/lib/db";
import { requireTenantAccess } from "@/lib/auth/tenant-guard";

const MOVEMENT_REASONS: MovementReason[] = [
  "restock",
  "adjustment",
  "waste",
  "depletion",
];

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
  const [items, movements] = await Promise.all([
    driver.listInventory(tenantId, locationId),
    driver.listInventoryMovements(tenantId, locationId),
  ]);
  return NextResponse.json({ items, movements });
}

interface InventoryBody {
  action: "upsertItem" | "movement";
  /** Active tenant for session authorization (sent by the client). */
  tenantId?: string;
  item?: InventoryItem;
  inventoryItemId?: string;
  reason?: MovementReason;
  delta?: number;
  note?: string | null;
}

export async function POST(request: Request) {
  let body: InventoryBody;
  try {
    body = (await request.json()) as InventoryBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  // Owner|manager of the active tenant only.
  const tenantId = body.tenantId ?? body.item?.tenant_id;
  if (!tenantId) {
    return NextResponse.json({ error: "tenantId is required." }, { status: 422 });
  }
  const auth = await requireTenantAccess(tenantId, "admin");
  if (!auth.ok) return auth.res;

  const driver = getPosDriver();
  const locations = await driver.listLocations(auth.tenantId);

  try {
    if (body.action === "upsertItem") {
      if (!body.item) {
        return NextResponse.json(
          { error: "item is required." },
          { status: 422 },
        );
      }
      // The row must live at one of THIS tenant's locations, and an existing
      // id must not belong to another tenant.
      if (!locations.some((l) => l.id === body.item?.location_id)) {
        return NextResponse.json(
          { error: "location_id does not belong to this tenant." },
          { status: 403 },
        );
      }
      if (body.item.id) {
        const current = await driver.getInventoryItem(body.item.id);
        if (current && current.tenant_id !== auth.tenantId) {
          return NextResponse.json(
            { error: "Inventory item not found." },
            { status: 404 },
          );
        }
      }
      const item = await driver.upsertInventoryItem({
        ...body.item,
        tenant_id: auth.tenantId,
      });
      return NextResponse.json({ item }, { status: 201 });
    }
    if (body.action === "movement") {
      if (
        !body.inventoryItemId ||
        !body.reason ||
        typeof body.delta !== "number"
      ) {
        return NextResponse.json(
          { error: "inventoryItemId, reason, delta are required." },
          { status: 422 },
        );
      }
      if (
        !MOVEMENT_REASONS.includes(body.reason) ||
        !Number.isFinite(body.delta) ||
        !Number.isInteger(body.delta) ||
        Math.abs(body.delta) > 1_000_000
      ) {
        return NextResponse.json(
          { error: "Invalid movement." },
          { status: 422 },
        );
      }
      const target = await driver.getInventoryItem(body.inventoryItemId);
      if (!target || target.tenant_id !== auth.tenantId) {
        return NextResponse.json(
          { error: "Inventory item not found." },
          { status: 404 },
        );
      }
      const result = await driver.applyInventoryMovement({
        inventoryItemId: body.inventoryItemId,
        reason: body.reason,
        delta: body.delta,
        note: body.note ?? null,
      });
      return NextResponse.json(result, { status: 201 });
    }
    return NextResponse.json({ error: "Unknown action." }, { status: 422 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Inventory update failed." },
      { status: 500 },
    );
  }
}
