/**
 * Back-office menu management — /api/admin/menu (Phase 5).
 *
 * GET  ?tenantId=&locationId=  → tenant categories + modifier groups + the
 *      assembled (override-aware) menu graph for the location, so the admin
 *      editor can render the full tree and preview how it reads at the location.
 *
 * POST { entity, action, tenantId, ... } → CRUD on a single menu entity through
 *      the DB abstraction. `entity` ∈ category|item|size|modifierGroup|modifier;
 *      `action` ∈ upsert|delete. Edits reflect in terminal/shop reads
 *      immediately because `getMenu` folds overrides.
 *
 * Auth: owner|manager of the tenant (session-derived). Because the server
 * driver bypasses RLS, every client-supplied id is checked to belong to the
 * authorized tenant before it is mutated: the entity itself (update/delete) and
 * its parent (item → category, size → item, modifier → group). The payload's
 * tenant_id is forced to the authorized tenant.
 *
 * No env vars are read; everything runs against the in-memory mock driver.
 */
import { NextResponse } from "next/server";
import { requireTenantAccess } from "@/lib/auth/tenant-guard";
import {
  getPosDriver,
  type CategoryInput,
  type ItemInput,
  type MenuEntityKind,
  type ModifierGroupInput,
  type ModifierInput,
  type SizeInput,
} from "@/lib/db";
import { isMoneyCents } from "@/lib/security";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const auth = await requireTenantAccess(searchParams.get("tenantId"), "admin", {
    locationId: searchParams.get("locationId"),
  });
  if (!auth.ok) return auth.res;
  const tenantId = auth.tenantId;

  const driver = getPosDriver();
  const locationId =
    auth.locationId ?? (await driver.listLocations(tenantId))[0]?.id ?? null;
  const [categories, modifierGroups, menu] = await Promise.all([
    driver.listCategories(tenantId),
    driver.listModifierGroups(tenantId),
    // Back-office editor: include 86'd items/modifiers so they can be SEEN and
    // un-86'd. (Customer reads at /api/menu + /api/shop/* exclude them.)
    locationId
      ? driver.getMenu(tenantId, locationId, { includeUnavailable: true })
      : Promise.resolve({ tenantId, locationId: "", categories: [] }),
  ]);
  return NextResponse.json({ categories, modifierGroups, menu });
}

interface MenuMutation {
  entity: MenuEntityKind;
  action: "upsert" | "delete";
  id?: string;
  payload?: unknown;
  /** Active tenant for session authorization (sent by the client). */
  tenantId?: string;
}

const ENTITIES: MenuEntityKind[] = [
  "category",
  "item",
  "size",
  "modifierGroup",
  "modifier",
];

function bad(error: string, status = 422) {
  return NextResponse.json({ error }, { status });
}

export async function POST(request: Request) {
  let body: MenuMutation;
  try {
    body = (await request.json()) as MenuMutation;
  } catch {
    return bad("Invalid JSON body.", 400);
  }
  if (!body || !ENTITIES.includes(body.entity)) return bad("Unknown entity.");
  if (body.action !== "upsert" && body.action !== "delete") {
    return bad("Unknown action.");
  }

  // Authorize against the session: owner|manager of the active tenant. The
  // client always sends a top-level tenantId; fall back to the payload's.
  const payload = (body.payload ?? {}) as Record<string, unknown>;
  const requestedTenant =
    body.tenantId ??
    (typeof payload.tenant_id === "string" ? payload.tenant_id : undefined);
  if (!requestedTenant) return bad("tenant_id is required.");
  const auth = await requireTenantAccess(requestedTenant, "admin");
  if (!auth.ok) return auth.res;
  const tenantId = auth.tenantId;

  const driver = getPosDriver();

  /** True iff `id` names an existing `entity` owned by the authorized tenant. */
  const owned = async (entity: MenuEntityKind, id: unknown) =>
    typeof id === "string" &&
    (await driver.getMenuEntityTenant(entity, id)) === tenantId;
  /** An id that exists but belongs to ANOTHER tenant (never mutate it). */
  const foreign = async (entity: MenuEntityKind, id: unknown) => {
    if (typeof id !== "string" || !id) return false;
    const owner = await driver.getMenuEntityTenant(entity, id);
    return owner !== null && owner !== tenantId;
  };

  try {
    if (body.action === "delete") {
      if (!body.id) return bad("id is required for delete.");
      if (!(await owned(body.entity, body.id))) {
        return bad("Not found.", 404);
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
      }
      return NextResponse.json({ ok: true });
    }

    // upsert — never touch an id that belongs to another tenant.
    if (await foreign(body.entity, payload.id)) return bad("Not found.", 404);

    let result: unknown;
    switch (body.entity) {
      case "category":
        result = await driver.upsertCategory({
          ...(payload as unknown as CategoryInput),
          tenant_id: tenantId,
        });
        break;
      case "item":
        if (!(await owned("category", payload.category_id))) {
          return bad("category_id does not belong to this tenant.");
        }
        result = await driver.upsertItem({
          ...(payload as unknown as ItemInput),
          tenant_id: tenantId,
        });
        break;
      case "size":
        if (!(await owned("item", payload.item_id))) {
          return bad("item_id does not belong to this tenant.");
        }
        if (!isMoneyCents(payload.price_cents)) {
          return bad("price_cents must be a non-negative integer.");
        }
        result = await driver.upsertSize(payload as unknown as SizeInput);
        break;
      case "modifierGroup":
        result = await driver.upsertModifierGroup({
          ...(payload as unknown as ModifierGroupInput),
          tenant_id: tenantId,
        });
        break;
      case "modifier":
        if (!(await owned("modifierGroup", payload.group_id))) {
          return bad("group_id does not belong to this tenant.");
        }
        if (!isMoneyCents(payload.price_cents)) {
          return bad("price_cents must be a non-negative integer.");
        }
        result = await driver.upsertModifier(payload as unknown as ModifierInput);
        break;
    }
    return NextResponse.json({ result }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Menu mutation failed." },
      { status: 500 },
    );
  }
}
