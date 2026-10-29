/**
 * Tenant-scoped loaders that assemble contract resources from the PosDriver.
 * Shared by the `/api/v1` handlers and the event outbox hydrator so a resource
 * is built exactly one way. Every function takes the tenant id explicitly and
 * returns null for ids outside it (cross-tenant ids look like NOT_FOUND).
 */
import type {
  Customer as CoreCustomer,
  Delivery as CoreDelivery,
  DrawerSession as CoreDrawerSession,
  Location as CoreLocation,
  Menu as CoreMenu,
  Order as CoreOrder,
  Payment as CorePayment,
  StaffMember as CoreStaffMember,
} from "@openpizza/core";
import {
  getPosDriver,
  type Location,
  type Order,
  type PosDriver,
  type StoreSettings,
} from "@/lib/db";
import {
  toContractCustomer,
  toContractDelivery,
  toContractDrawerSession,
  toContractLocation,
  toContractMenu,
  toContractOrder,
  toContractPayment,
  toContractStaff,
} from "./mappers";

export interface LocationBundle {
  location: Location;
  settings: StoreSettings;
  contract: CoreLocation;
}

export function driverOf(driver?: PosDriver): PosDriver {
  return driver ?? getPosDriver();
}

export async function loadLocations(
  tenantId: string,
  driver?: PosDriver,
): Promise<LocationBundle[]> {
  const d = driverOf(driver);
  const locations = await d.listLocations(tenantId);
  return Promise.all(
    locations.map(async (location) => {
      const settings = await d.getStoreSettings(tenantId, location.id);
      return {
        location,
        settings,
        contract: toContractLocation(location, settings),
      };
    }),
  );
}

export async function loadLocation(
  tenantId: string,
  locationId: string,
  driver?: PosDriver,
): Promise<LocationBundle | null> {
  const all = await loadLocations(tenantId, driver);
  return all.find((b) => b.location.id === locationId) ?? null;
}

export async function loadMenu(
  bundle: LocationBundle,
  driver?: PosDriver,
): Promise<CoreMenu> {
  const d = driverOf(driver);
  const tenantId = bundle.location.tenant_id;
  const [menu, overrides] = await Promise.all([
    d.getMenu(tenantId, bundle.location.id, { includeUnavailable: true }),
    d.listOverrides(tenantId, bundle.location.id),
  ]);
  return toContractMenu({ menu, overrides, currency: bundle.settings.currency });
}

export async function mapOrder(
  order: Order,
  timezone: string,
  driver?: PosDriver,
): Promise<CoreOrder> {
  const d = driverOf(driver);
  const [payments, customer] = await Promise.all([
    d.listPaymentsForOrder(order.id),
    order.customer_id ? d.getCustomer(order.customer_id) : Promise.resolve(null),
  ]);
  return toContractOrder({
    order,
    payments,
    timezone,
    customer: customer && customer.tenant_id === order.tenant_id ? customer : null,
  });
}

export async function loadOrder(
  tenantId: string,
  orderId: string,
  driver?: PosDriver,
): Promise<CoreOrder | null> {
  const d = driverOf(driver);
  const order = await d.getOrder(orderId);
  if (!order || order.tenant_id !== tenantId) return null;
  const loc = await loadLocation(tenantId, order.location_id, d);
  return mapOrder(order, loc?.location.timezone ?? "UTC", d);
}

/** Every order of a tenant (optionally one location), mapped, oldest first. */
export async function loadTenantOrders(
  tenantId: string,
  opts: { locationIds?: string[] | null; driver?: PosDriver } = {},
): Promise<CoreOrder[]> {
  const d = driverOf(opts.driver);
  const bundles = (await loadLocations(tenantId, d)).filter(
    (b) => !opts.locationIds || opts.locationIds.includes(b.location.id),
  );
  const out: CoreOrder[] = [];
  for (const b of bundles) {
    const orders = await d.listOrders(tenantId, b.location.id);
    const mapped = await Promise.all(
      orders.map((o) => mapOrder(o, b.location.timezone, d)),
    );
    out.push(...mapped);
  }
  return out.sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );
}

export async function loadPayment(
  tenantId: string,
  paymentId: string,
  driver?: PosDriver,
): Promise<CorePayment | null> {
  const p = await driverOf(driver).getPayment(paymentId);
  return p && p.tenant_id === tenantId ? toContractPayment(p) : null;
}

export async function customerStats(
  tenantId: string,
  orders?: CoreOrder[],
  driver?: PosDriver,
): Promise<
  Map<
    string,
    { order_count: number; last_order_at: string | null; lifetime_spend_cents: number }
  >
> {
  const all = orders ?? (await loadTenantOrders(tenantId, { driver }));
  const stats = new Map<
    string,
    { order_count: number; last_order_at: string | null; lifetime_spend_cents: number }
  >();
  for (const o of all) {
    if (!o.customer_id || o.fulfillment_status === "canceled" || o.fulfillment_status === "held") {
      continue;
    }
    const s = stats.get(o.customer_id) ?? {
      order_count: 0,
      last_order_at: null,
      lifetime_spend_cents: 0,
    };
    s.order_count += 1;
    s.lifetime_spend_cents += o.totals.total_cents;
    if (!s.last_order_at || o.created_at > s.last_order_at) {
      s.last_order_at = o.created_at;
    }
    stats.set(o.customer_id, s);
  }
  return stats;
}

export async function loadCustomer(
  tenantId: string,
  customerId: string,
  driver?: PosDriver,
): Promise<CoreCustomer | null> {
  const d = driverOf(driver);
  const c = await d.getCustomer(customerId);
  if (!c || c.tenant_id !== tenantId) return null;
  const stats = await customerStats(tenantId, undefined, d);
  return toContractCustomer(
    c,
    stats.get(c.id) ?? { order_count: 0, last_order_at: null, lifetime_spend_cents: 0 },
  );
}

export async function loadStaffList(
  tenantId: string,
  driver?: PosDriver,
): Promise<CoreStaffMember[]> {
  const d = driverOf(driver);
  const staff = await d.listStaff(tenantId);
  return Promise.all(
    staff.map(async (s) => {
      // listStaff strips the hash; the trusted lookup tells us whether one is set.
      const full = await d.getStaffById(tenantId, s.id);
      return toContractStaff(s, Boolean(full?.pin_hash));
    }),
  );
}

export async function loadDrawerSessions(
  bundle: LocationBundle,
  driver?: PosDriver,
): Promise<CoreDrawerSession[]> {
  const d = driverOf(driver);
  const shifts = await d.listShifts(bundle.location.tenant_id, bundle.location.id);
  return Promise.all(
    shifts.map(async (shift) =>
      toContractDrawerSession({
        shift,
        recon: await d.getDrawerReconciliation(shift.id),
        currency: bundle.settings.currency,
        timezone: bundle.location.timezone,
      }),
    ),
  );
}

export async function loadDelivery(
  tenantId: string,
  deliveryId: string,
  driver?: PosDriver,
): Promise<CoreDelivery | null> {
  const d = driverOf(driver);
  const record = await d.getDelivery(deliveryId);
  if (!record || record.tenant_id !== tenantId) return null;
  const loc = await loadLocation(tenantId, record.location_id, d);
  if (!loc) return null;
  const [order, payments] = await Promise.all([
    d.getOrder(record.order_id),
    d.listPaymentsForOrder(record.order_id),
  ]);
  return toContractDelivery({ record, order, payments, location: loc.contract });
}
