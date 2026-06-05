/**
 * App-layer tenant isolation (the complement to DB RLS).
 *
 * Even though the mock driver holds all tenants' data in shared maps, every
 * read method is scoped by tenant_id (+ location_id). This proves a tenant can
 * never see another tenant's orders, menu, reports, or inventory THROUGH THE
 * DRIVER — the same access pattern the app uses. The Postgres RLS layer
 * (supabase/tests/rls_isolation.sql) enforces this again at the database.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  getPosDriver,
  DEMO_TENANT_ID,
  DEMO_LOCATION_DOWNTOWN_ID,
  type CreateOrderInput,
} from "@/lib/db";
import { resetMockOrders, resetMockPayments } from "@/lib/db/mock";

beforeEach(() => {
  resetMockOrders();
  resetMockPayments();
});

function orderFor(
  id: string,
  tenantId: string,
  locationId: string,
): CreateOrderInput {
  return {
    id,
    tenant_id: tenantId,
    location_id: locationId,
    channel: "in_store",
    currency: "USD",
    items: [],
    discount_cents: 0,
    totals: {
      subtotal_cents: 1000,
      discount_cents: 0,
      taxable_cents: 1000,
      tax_cents: 0,
      tip_cents: 0,
      total_cents: 1000,
    },
    notes: null,
    status: "paid",
  };
}

async function makeOtherTenant() {
  const driver = getPosDriver();
  const { tenant } = await driver.createTenant({
    businessName: `Rival Pizza ${Math.random().toString(36).slice(2, 7)}`,
    ownerEmail: `owner-${Math.random().toString(36).slice(2, 7)}@rival.example`,
  });
  const location = await driver.createLocation({
    tenant_id: tenant.id,
    name: "Rival Main",
  });
  await driver.importStarterMenu(tenant.id);
  return { tenantId: tenant.id, locationId: location.id };
}

describe("app-layer tenant isolation", () => {
  it("listOrders never returns another tenant's orders", async () => {
    const driver = getPosDriver();
    const other = await makeOtherTenant();

    await driver.createOrder(
      orderFor("demo-order", DEMO_TENANT_ID, DEMO_LOCATION_DOWNTOWN_ID),
    );
    await driver.createOrder(
      orderFor("rival-order", other.tenantId, other.locationId),
    );

    const demoOrders = await driver.listOrders(
      DEMO_TENANT_ID,
      DEMO_LOCATION_DOWNTOWN_ID,
    );
    const rivalOrders = await driver.listOrders(
      other.tenantId,
      other.locationId,
    );

    expect(demoOrders.some((o) => o.id === "rival-order")).toBe(false);
    expect(rivalOrders.some((o) => o.id === "demo-order")).toBe(false);
    expect(rivalOrders.map((o) => o.id)).toContain("rival-order");
    // The rival tenant's orders all carry the rival tenant_id.
    expect(rivalOrders.every((o) => o.tenant_id === other.tenantId)).toBe(true);
  });

  it("getSalesReport scopes gross to the requesting tenant", async () => {
    const driver = getPosDriver();
    const other = await makeOtherTenant();
    await driver.createOrder(
      orderFor("demo-rep", DEMO_TENANT_ID, DEMO_LOCATION_DOWNTOWN_ID),
    );
    await driver.createOrder(
      orderFor("rival-rep", other.tenantId, other.locationId),
    );

    const rivalReport = await driver.getSalesReport(other.tenantId, null, {
      from: null,
      to: null,
    });
    // The rival rollup contains only the rival location, never the demo location.
    expect(
      rivalReport.byLocation.some((b) => b.key === DEMO_LOCATION_DOWNTOWN_ID),
    ).toBe(false);
    expect(rivalReport.byLocation.some((b) => b.key === other.locationId)).toBe(
      true,
    );
  });

  it("getMenu returns only the requesting tenant's categories", async () => {
    const driver = getPosDriver();
    const other = await makeOtherTenant();

    const otherMenu = await driver.getMenu(other.tenantId, other.locationId);
    // The starter menu has categories, and none belong to the demo tenant.
    expect(otherMenu.categories.length).toBeGreaterThan(0);
    // Demo-tenant menu must not leak the rival's categories and vice-versa.
    const demoMenu = await driver.getMenu(
      DEMO_TENANT_ID,
      DEMO_LOCATION_DOWNTOWN_ID,
    );
    const demoCatIds = new Set(demoMenu.categories.map((c) => c.id));
    expect(otherMenu.categories.every((c) => !demoCatIds.has(c.id))).toBe(true);
  });

  it("listInventory never returns another tenant's stock rows", async () => {
    const driver = getPosDriver();
    const other = await makeOtherTenant();
    const demoInv = await driver.listInventory(
      DEMO_TENANT_ID,
      DEMO_LOCATION_DOWNTOWN_ID,
    );
    // Demo inventory rows are all demo-tenant scoped.
    expect(demoInv.every((i) => i.tenant_id === DEMO_TENANT_ID)).toBe(true);
    // The rival tenant has no demo inventory.
    const rivalInv = await driver.listInventory(
      other.tenantId,
      other.locationId,
    );
    expect(rivalInv.every((i) => i.tenant_id === other.tenantId)).toBe(true);
  });

  it("listLocations is tenant-scoped", async () => {
    const driver = getPosDriver();
    const other = await makeOtherTenant();
    const rivalLocs = await driver.listLocations(other.tenantId);
    expect(rivalLocs.every((l) => l.tenant_id === other.tenantId)).toBe(true);
    expect(rivalLocs.some((l) => l.id === DEMO_LOCATION_DOWNTOWN_ID)).toBe(
      false,
    );
  });
});
