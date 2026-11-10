/** Marketplace orders in the owner reports: own channel, no tenders, no phantom fees. */
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEMO_LOCATION_DOWNTOWN_ID as L,
  DEMO_TENANT_ID as T,
  getPosDriver,
} from "@/lib/db";
import { resetMockOrders } from "@/lib/db/mock";
import {
  buildOwnerBundle,
  reportChannel,
  summarize,
} from "@/lib/owner-reports";
import {
  buildSimulatedOrder,
  signSimulatedWebhook,
} from "./adapters/simulator";
import { SIMULATOR_DEV_SECRET } from "./env";
import { locationBusinessDate } from "@/lib/reports";
import { ingestMarketplaceWebhook, respondToMarketplaceOrder } from "./service";

beforeEach(() => resetMockOrders());

describe("owner reports", () => {
  it("shows marketplace orders under their own channel with zero fees and no refunds", async () => {
    const d = getPosDriver();
    await d.setMarketplaceSettings(T, L, {
      enabled: true,
      auto_accept: false,
      providers: { simulator: { enabled: true, store_id: null } },
    });
    const s = signSimulatedWebhook(
      buildSimulatedOrder(9, { externalId: "SIM-OWN" }),
      SIMULATOR_DEV_SECRET,
    );
    const r = await ingestMarketplaceWebhook({
      provider: "simulator",
      location: { tenantId: T, locationId: L },
      rawBody: s.rawBody,
      headers: s.headers,
    });
    await respondToMarketplaceOrder(r.orderId!, "accept");
    const order = (await d.getOrder(r.orderId!))!;
    expect(order.totals.tax_cents).toBeGreaterThan(0);
    expect(order.totals.tip_cents).toBeGreaterThan(0);
    expect(reportChannel(order)).toBe("marketplace");

    const location = (await d.listLocations(T)).find((l) => l.id === L)!;
    // The location's business date (its time zone + cutoff), not the UTC date:
    // they differ in the evening, US time.
    const day = locationBusinessDate(order.created_at, location);
    const bundle = buildOwnerBundle({
      tenantId: T,
      locationId: L,
      from: day,
      to: day,
      orders: [order],
      payments: [],
      locations: [location],
      staff: [],
      categoryOf: () => null,
    });
    const sum = summarize(bundle.daily);
    const gross = order.items.reduce((n, i) => n + i.line_total_cents, 0);
    expect(sum.orders).toBe(1);
    expect(sum.gross_cents).toBe(gross);
    expect(sum.fees_cents).toBe(0);
    expect(sum.refund_cents).toBe(0);
    expect(bundle.channels).toHaveLength(1);
    expect(bundle.channels[0]).toMatchObject({
      channel: "marketplace",
      orders: 1,
      gross_cents: gross,
      fees_cents: 0,
    });
  });
});
