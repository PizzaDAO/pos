/**
 * Marketplace orders are paid by the marketplace. Every path that takes money
 * (till tenders, card reader, hosted payment sessions, /v1 external tenders,
 * online checkout) refuses them, so a cashier or anonymous caller can never
 * double-charge one or flip a pending order to `paid` behind the acceptance step.
 */
import type { Order } from "@/lib/db";

export const MARKETPLACE_NOT_PAYABLE_MESSAGE =
  "This order was paid on the marketplace; it cannot take a payment here.";

export function isMarketplaceChannel(order: Pick<Order, "channel">): boolean {
  return order.channel === "marketplace";
}

export class MarketplaceNotPayableError extends Error {
  constructor() {
    super(MARKETPLACE_NOT_PAYABLE_MESSAGE);
    this.name = "MarketplaceNotPayableError";
  }
}

export function assertTakesPayment(order: Pick<Order, "channel">): void {
  if (isMarketplaceChannel(order)) throw new MarketplaceNotPayableError();
}

/** Another location already holds this provider store id. */
export class MarketplaceStoreTakenError extends Error {
  constructor() {
    super("That store id is already assigned to another location.");
    this.name = "MarketplaceStoreTakenError";
  }
}
