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
  type Shift,
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

export async function mapOrders(
  orders: Order[],
  timezoneOf: (locationId: string) => string,
  driver?: PosDriver,
): Promise<CoreOrder[]> {
  if (orders.length === 0) return [];
  const d = driverOf(driver);
  // Two batched reads for the whole page (no per-order queries).
  const customerIds = [
    ...new Set(orders.map((o) => o.customer_id).filter((x): x is string => !!x)),
  ];
  const [payments, customers] = await Promise.all([
    d.listPaymentsForOrders(orders.map((o) => o.id)),
    customerIds.length ? d.getCustomers(customerIds) : Promise.resolve([]),
  ]);
  const byCustomer = new Map(customers.map((c) => [c.id, c]));
  return orders.map((order) => {
    const c = order.customer_id ? byCustomer.get(order.customer_id) : undefined;
    return toContractOrder({
      order,
      payments: payments.get(order.id) ?? [],
      timezone: timezoneOf(order.location_id),
      customer: c && c.tenant_id === order.tenant_id ? c : null,
    });
  });
}

export async function mapOrder(
  order: Order,
  timezone: string,
  driver?: PosDriver,
): Promise<CoreOrder> {
  return (await mapOrders([order], () => timezone, driver))[0] as CoreOrder;
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

const SCAN_PAGE = 200;
const MAX_SCAN_PAGES = 25;

export interface OrdersPageQuery {
  locationIds?: string[] | null;
  /** Wanted page size; one extra row is returned so callers can detect more. */
  limit: number;
  after?: { created_at: string; id: string };
  createdFrom?: string;
  createdTo?: string;
  updatedSince?: string;
  /** Post-mapping filter (status/channel/...). Scanning continues until enough match. */
  filter?: (o: CoreOrder) => boolean;
  driver?: PosDriver;
}

/**
 * Oldest-first page of mapped orders across locations. Paging is keyset in SQL
 * (bounded scan: at most MAX_SCAN_PAGES pages of SCAN_PAGE rows per location),
 * never "load everything then slice".
 */
export async function loadOrdersPage(
  tenantId: string,
  q: OrdersPageQuery,
): Promise<CoreOrder[]> {
  const d = driverOf(q.driver);
  const bundles = (await loadLocations(tenantId, d)).filter(
    (b) => !q.locationIds || q.locationIds.includes(b.location.id),
  );
  const tz = new Map(bundles.map((b) => [b.location.id, b.location.timezone]));
  const want = q.limit + 1;
  const merged: CoreOrder[] = [];
  for (const b of bundles) {
    let after = q.after;
    let got = 0;
    for (let page = 0; page < MAX_SCAN_PAGES && got < want; page++) {
      const rows = await d.listOrdersPage(tenantId, b.location.id, {
        after,
        limit: SCAN_PAGE,
        createdFrom: q.createdFrom,
        createdTo: q.createdTo,
        updatedSince: q.updatedSince,
      });
      if (rows.length === 0) break;
      const mapped = await mapOrders(rows, (l) => tz.get(l) ?? "UTC", d);
      for (const m of mapped) {
        if (!q.filter || q.filter(m)) {
          merged.push(m);
          got += 1;
        }
      }
      const last = rows[rows.length - 1]!;
      after = { created_at: last.created_at, id: last.id };
      if (rows.length < SCAN_PAGE) break;
    }
  }
  merged.sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );
  return merged.slice(0, want);
}

/**
 * Every order whose creation falls in a (padded) range, for rollups. Bounded by
 * the range and a hard row cap so a runaway range cannot exhaust memory.
 */
export async function loadTenantOrders(
  tenantId: string,
  opts: {
    locationIds?: string[] | null;
    createdFrom?: string;
    createdTo?: string;
    maxRows?: number;
    driver?: PosDriver;
  } = {},
): Promise<CoreOrder[]> {
  const out: CoreOrder[] = [];
  let after: { created_at: string; id: string } | undefined;
  const max = opts.maxRows ?? 20_000;
  for (;;) {
    const page = await loadOrdersPage(tenantId, {
      locationIds: opts.locationIds,
      limit: SCAN_PAGE * 5,
      after,
      createdFrom: opts.createdFrom,
      createdTo: opts.createdTo,
      driver: opts.driver,
    });
    const take = page.slice(0, SCAN_PAGE * 5);
    out.push(...take);
    if (page.length <= SCAN_PAGE * 5 || out.length >= max) break;
    const last = take[take.length - 1]!;
    after = { created_at: last.created_at, id: last.id };
  }
  return out;
}

export async function loadPayment(
  tenantId: string,
  paymentId: string,
  driver?: PosDriver,
): Promise<CorePayment | null> {
  const p = await driverOf(driver).getPayment(paymentId);
  return p && p.tenant_id === tenantId ? toContractPayment(p) : null;
}

export async function loadCustomer(
  tenantId: string,
  customerId: string,
  driver?: PosDriver,
): Promise<CoreCustomer | null> {
  const d = driverOf(driver);
  const c = (await d.getCustomers([customerId]))[0];
  if (!c || c.tenant_id !== tenantId) return null;
  const stats = await d.customerOrderStats(tenantId, [c.id]);
  return toContractCustomer(c, stats.get(c.id) ?? NO_STATS);
}

export const NO_STATS = {
  order_count: 0,
  last_order_at: null,
  lifetime_spend_cents: 0,
};

export async function loadStaffList(
  tenantId: string,
  driver?: PosDriver,
): Promise<CoreStaffMember[]> {
  const d = driverOf(driver);
  const [staff, withPin] = await Promise.all([
    d.listStaff(tenantId),
    d.listStaffWithPin(tenantId),
  ]);
  return staff.map((s) => toContractStaff(s, withPin.has(s.id)));
}

/** Drawer sessions for a location; reconciliation is computed only for `select`ed rows. */
export async function loadDrawerSessions(
  bundle: LocationBundle,
  driver?: PosDriver,
  select: (shifts: Shift[]) => Shift[] = (x) => x,
): Promise<CoreDrawerSession[]> {
  const d = driverOf(driver);
  const shifts = select(
    await d.listShifts(bundle.location.tenant_id, bundle.location.id),
  );
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
