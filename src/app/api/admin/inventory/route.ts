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
 */
import { NextResponse } from "next/server";
import {
  getPosDriver,
  type InventoryItem,
  type MovementReason,
} from "@/lib/db";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const tenantId = searchParams.get("tenantId");
  const locationId = searchParams.get("locationId");
  if (!tenantId || !locationId) {
    return NextResponse.json(
      { error: "tenantId and locationId are required." },
      { status: 400 },
    );
  }
  const driver = getPosDriver();
  const [items, movements] = await Promise.all([
    driver.listInventory(tenantId, locationId),
    driver.listInventoryMovements(tenantId, locationId),
  ]);
  return NextResponse.json({ items, movements });
}

interface InventoryBody {
  action: "upsertItem" | "movement";
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
  const driver = getPosDriver();

  try {
    if (body.action === "upsertItem") {
      if (!body.item) {
        return NextResponse.json(
          { error: "item is required." },
          { status: 422 },
        );
      }
      const item = await driver.upsertInventoryItem(body.item);
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
