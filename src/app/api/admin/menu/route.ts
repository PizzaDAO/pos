/**
 * Back-office menu management — /api/admin/menu (Phase 5).
 *
 * GET  ?tenantId=&locationId=  → tenant categories + modifier groups + the
 *      assembled (override-aware) menu graph for the location, so the admin
 *      editor can render the full tree and preview how it reads at the location.
 *
 * POST { entity, action, ... } → CRUD on a single menu entity through the DB
 *      abstraction (mock driver today). `entity` ∈ category|item|size|
 *      modifierGroup|modifier; `action` ∈ upsert|delete. Edits reflect in
 *      terminal/shop reads immediately because `getMenu` folds overrides.
 *
 * No env vars are read; everything runs against the in-memory mock driver.
 */
import { NextResponse } from "next/server";
import {
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_TENANT_ID,
  getPosDriver,
  type CategoryInput,
  type ItemInput,
  type ModifierGroupInput,
  type ModifierInput,
  type SizeInput,
} from "@/lib/db";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const tenantId = searchParams.get("tenantId") ?? DEMO_TENANT_ID;
  const locationId =
    searchParams.get("locationId") ?? DEMO_LOCATION_DOWNTOWN_ID;

  const driver = getPosDriver();
  const [categories, modifierGroups, menu] = await Promise.all([
    driver.listCategories(tenantId),
    driver.listModifierGroups(tenantId),
    driver.getMenu(tenantId, locationId),
  ]);
  return NextResponse.json({ categories, modifierGroups, menu });
}

interface MenuMutation {
  entity: "category" | "item" | "size" | "modifierGroup" | "modifier";
  action: "upsert" | "delete";
  id?: string;
  payload?: unknown;
}

export async function POST(request: Request) {
  let body: MenuMutation;
  try {
    body = (await request.json()) as MenuMutation;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const driver = getPosDriver();

  try {
    if (body.action === "delete") {
      if (!body.id) {
        return NextResponse.json(
          { error: "id is required for delete." },
          { status: 422 },
        );
      }
      switch (body.entity) {
        case "category":
          await driver.deleteCategory(body.id);
          break;
        case "item":
          await driver.deleteItem(body.id);
          break;
        case "size":
          await driver.deleteSize(body.id);
          break;
        case "modifierGroup":
          await driver.deleteModifierGroup(body.id);
          break;
        case "modifier":
          await driver.deleteModifier(body.id);
          break;
        default:
          return NextResponse.json(
            { error: "Unknown entity." },
            { status: 422 },
          );
      }
      return NextResponse.json({ ok: true });
    }

    // upsert
    let result: unknown;
    switch (body.entity) {
      case "category":
        result = await driver.upsertCategory(body.payload as CategoryInput);
        break;
      case "item":
        result = await driver.upsertItem(body.payload as ItemInput);
        break;
      case "size":
        result = await driver.upsertSize(body.payload as SizeInput);
        break;
      case "modifierGroup":
        result = await driver.upsertModifierGroup(
          body.payload as ModifierGroupInput,
        );
        break;
      case "modifier":
        result = await driver.upsertModifier(body.payload as ModifierInput);
        break;
      default:
        return NextResponse.json({ error: "Unknown entity." }, { status: 422 });
    }
    return NextResponse.json({ result }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Menu mutation failed." },
      { status: 500 },
    );
  }
}
