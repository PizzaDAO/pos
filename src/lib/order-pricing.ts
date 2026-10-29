/**
 * Server-side order pricing (I/O wrapper around the pure `reprice` module).
 *
 * Loads the location's CUSTOMER menu (86'd items/modifiers excluded, price
 * overrides folded in), its size-availability overrides and its store settings,
 * then re-prices client lines and recomputes totals — so order money is always
 * derived from the server's menu, never from the browser.
 */
import {
  getPosDriver,
  type OrderItem,
  type OrderTotals,
  type StoreSettings,
} from "@/lib/db";
import { computeOrderTotals } from "@/lib/pricing";
import { repriceOrderItems, type RepriceOptions } from "@/lib/reprice";

export interface PricedOrder {
  items: OrderItem[];
  totals: OrderTotals;
  settings: StoreSettings;
}

export async function priceOrder(input: {
  tenantId: string;
  locationId: string;
  items: unknown;
  /** Explicit, already-authorized order-level discount (clamped to subtotal). */
  discountCents?: number;
  /** Explicit, already-bounded order-level tip. */
  tipCents?: number;
  voided?: RepriceOptions["voided"];
  /** Pre-loaded settings (avoids a second read when the caller has them). */
  settings?: StoreSettings;
}): Promise<PricedOrder> {
  const driver = getPosDriver();
  const [menu, overrides, settings] = await Promise.all([
    driver.getMenu(input.tenantId, input.locationId),
    driver.listOverrides(input.tenantId, input.locationId),
    input.settings
      ? Promise.resolve(input.settings)
      : driver.getStoreSettings(input.tenantId, input.locationId),
  ]);
  const unavailableSizeIds = new Set(
    overrides
      .filter((o) => o.target_type === "size" && o.available === false)
      .map((o) => o.target_id),
  );
  const items = repriceOrderItems(menu, input.items, {
    unavailableSizeIds,
    voided: input.voided,
  });
  const totals = computeOrderTotals({
    items,
    discountCents: input.discountCents ?? 0,
    taxRateBps: settings.tax_rate_bps,
    tipCents: input.tipCents ?? 0,
  });
  return { items, totals, settings };
}
