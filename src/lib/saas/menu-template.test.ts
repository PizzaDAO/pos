/**
 * Starter-menu template regression tests.
 *
 * Guards the Supabase self-serve menu-import bug: the template MUST emit real
 * UUIDs for every primary-key id (categories, items, sizes, modifier groups,
 * modifiers) so they survive insertion into `uuid`-typed Supabase columns
 * instead of failing with `invalid input syntax for type uuid: "cat-…"`.
 * Also asserts referential integrity across the generated graph and exercises
 * the template → driver → insert path against the mock driver end-to-end.
 */
import { describe, it, expect } from "vitest";
import { buildStarterMenu } from "./menu-template";
import { isUuid } from "@/lib/security/validate";
import { getPosDriver } from "@/lib/db";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("buildStarterMenu — UUID ids", () => {
  const tenantId = crypto.randomUUID();
  const tpl = buildStarterMenu(tenantId);

  it("emits a valid UUID for EVERY generated id", () => {
    const ids = [
      ...tpl.categories.map((c) => c.id),
      ...tpl.items.map((i) => i.id),
      ...tpl.sizes.map((s) => s.id),
      ...tpl.modifierGroups.map((g) => g.id),
      ...tpl.modifiers.map((m) => m.id),
    ];
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(id).toMatch(UUID_RE);
      expect(isUuid(id)).toBe(true);
    }
  });

  it("generates unique ids across the whole graph", () => {
    const ids = [
      ...tpl.categories.map((c) => c.id),
      ...tpl.items.map((i) => i.id),
      ...tpl.sizes.map((s) => s.id),
      ...tpl.modifierGroups.map((g) => g.id),
      ...tpl.modifiers.map((m) => m.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("preserves referential integrity with the new ids", () => {
    const catIds = new Set(tpl.categories.map((c) => c.id));
    const itemIds = new Set(tpl.items.map((i) => i.id));
    const groupIds = new Set(tpl.modifierGroups.map((g) => g.id));

    // item → category
    for (const item of tpl.items) {
      expect(item.tenant_id).toBe(tenantId);
      expect(catIds.has(item.category_id)).toBe(true);
    }
    // size → item
    for (const size of tpl.sizes) {
      expect(itemIds.has(size.item_id)).toBe(true);
    }
    // modifier → group
    for (const mod of tpl.modifiers) {
      expect(groupIds.has(mod.group_id)).toBe(true);
    }
    // item ↔ group join rows resolve on both ends
    for (const link of tpl.itemModifierGroups) {
      expect(itemIds.has(link.item_id)).toBe(true);
      expect(groupIds.has(link.group_id)).toBe(true);
    }
  });
});

describe("template → driver → insert (mock)", () => {
  it("importStarterMenu carries UUID ids through to a readable menu", async () => {
    const driver = getPosDriver();
    const { tenant } = await driver.createTenant({
      businessName: `UUID Pizza ${crypto.randomUUID().slice(0, 8)}`,
      ownerEmail: `owner-${crypto.randomUUID().slice(0, 8)}@uuid.example`,
    });
    const location = await driver.createLocation({
      tenant_id: tenant.id,
      name: "Main",
    });
    await driver.importStarterMenu(tenant.id);

    const menu = await driver.getMenu(tenant.id, location.id);
    expect(menu.categories.length).toBeGreaterThan(0);

    // Every id that surfaced through the driver read is a real UUID and the
    // graph still resolves (items under categories, sizes/groups under items).
    for (const cat of menu.categories) {
      expect(isUuid(cat.id)).toBe(true);
      for (const item of cat.items) {
        expect(isUuid(item.id)).toBe(true);
        for (const size of item.sizes) {
          expect(isUuid(size.id)).toBe(true);
        }
        for (const group of item.modifierGroups) {
          expect(isUuid(group.id)).toBe(true);
          for (const mod of group.modifiers) {
            expect(isUuid(mod.id)).toBe(true);
          }
        }
      }
    }
  });
});
