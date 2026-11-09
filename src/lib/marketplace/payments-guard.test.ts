/**
 * A marketplace order is paid by the marketplace: no payment path may take a
 * tender against it (double charge, or flipping a pending order to `paid` behind
 * the acceptance step).
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Principal } from "@openpizza/core";
import {
  DEMO_LOCATION_DOWNTOWN_ID as L,
  DEMO_TENANT_ID as T,
  getPosDriver,
} from "@/lib/db";
import {
  resetMockOnline,
  resetMockOrders,
  resetMockPayments,
} from "@/lib/db/mock";
import { handleV1 } from "@/lib/core/v1";
import { DEV_TOKEN } from "@/lib/core/auth";
import { POST as payRoute } from "@/app/api/payments/route";
import {
  TerminalFlowError,
  startCardTender,
} from "@/lib/payments/terminal/flow";
import { takePayment } from "@/lib/payments/service";
import { MarketplaceNotPayableError } from "./guard";
import {
  buildSimulatedOrder,
  signSimulatedWebhook,
} from "./adapters/simulator";
import { SIMULATOR_DEV_SECRET } from "./env";
import { ingestMarketplaceWebhook, respondToMarketplaceOrder } from "./service";

const PID = (n: number) =>
  `a1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function marketplaceOrder(accept: boolean, id = "SIM-PAY") {
  await getPosDriver().setMarketplaceSettings(T, L, {
    enabled: true,
    auto_accept: false,
    providers: { simulator: { enabled: true, store_id: null } },
  });
  const s = signSimulatedWebhook(
    buildSimulatedOrder(1, { externalId: id }),
    SIMULATOR_DEV_SECRET,
  );
  const r = await ingestMarketplaceWebhook({
    provider: "simulator",
    location: { tenantId: T, locationId: L },
    rawBody: s.rawBody,
    headers: s.headers,
  });
  if (accept) await respondToMarketplaceOrder(r.orderId!, "accept");
  return (await getPosDriver().getOrder(r.orderId!))!;
}

beforeEach(() => {
  resetMockOrders();
  resetMockPayments();
  resetMockOnline();
});

describe("no tender against a marketplace order", () => {
  for (const rail of [
    "cash",
    "stripe_online",
    "crypto_coinbase",
    "stripe_terminal",
  ]) {
    it(`POST /api/payments refuses ${rail} (pending order stays pending)`, async () => {
      const order = await marketplaceOrder(false);
      const res = await payRoute(
        new Request("http://x/api/payments", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            paymentId: PID(1),
            orderId: order.id,
            tenantId: T,
            locationId: L,
            rail,
            amountCents: 100,
            currency: order.currency,
          }),
        }),
      );
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("marketplace_order");
      const after = (await getPosDriver().getOrder(order.id))!;
      expect(after.status).toBe("placed");
      expect(after.fulfillment?.marketplace?.acceptance).toBe("pending");
      expect(await getPosDriver().listPaymentsForOrder(order.id)).toHaveLength(
        0,
      );
    });
  }

  it("the payment service refuses it too (defense in depth)", async () => {
    const order = await marketplaceOrder(true, "SIM-PAY2");
    await expect(
      takePayment({
        paymentId: PID(2),
        orderId: order.id,
        tenantId: T,
        locationId: L,
        rail: "cash",
        amountCents: 100,
        tipCents: 0,
        currency: order.currency,
      }),
    ).rejects.toBeInstanceOf(MarketplaceNotPayableError);
  });

  it("the card reader refuses it", async () => {
    const order = await marketplaceOrder(true, "SIM-PAY3");
    await expect(
      startCardTender({
        paymentId: PID(3),
        orderId: order.id,
        readerId: "r",
        amountCents: 100,
      }),
    ).rejects.toBeInstanceOf(TerminalFlowError);
  });

  it("/v1 external tenders are refused", async () => {
    const order = await marketplaceOrder(true, "SIM-PAY4");
    const p: Principal = {
      kind: "service",
      id: "t",
      tenant_id: T,
      location_ids: null,
      scopes: ["orders:read", "payments:read", "payments:write"],
      module: "kiosk",
    };
    const res = await handleV1(
      new Request(`https://pos.test/api/v1/orders/${order.id}/payments`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "k1",
        },
        body: JSON.stringify({
          method: "card",
          processor: "x",
          processor_ref: "r1",
          amount_cents: 100,
          status: "captured",
        }),
      }),
      ["orders", order.id, "payments"],
      { principal: p },
    );
    expect(res.status).toBe(409);
    expect(await getPosDriver().listPaymentsForOrder(order.id)).toHaveLength(0);
  });

  it("/v1 order creation reserves source.type marketplace", async () => {
    const call = (path: string, init?: RequestInit) =>
      handleV1(
        new Request(`https://pos.test/api/v1${path}`, {
          ...init,
          headers: {
            ...(init?.headers ?? {}),
            authorization: `Bearer ${DEV_TOKEN}`,
            "content-type": "application/json",
          },
        }),
        path.split("/").filter(Boolean),
        { now: () => new Date("2026-06-04T22:00:00.000Z") },
      );
    const menu = await (await call(`/locations/${L}/menu`)).json();
    const item = menu.categories.flatMap(
      (c: { items: unknown[] }) => c.items,
    )[0] as {
      id: string;
      sizes: { id: string }[];
    };
    const res = await call("/orders", {
      method: "POST",
      body: JSON.stringify({
        location_id: L,
        lines: [{ item_id: item.id, size_id: item.sizes[0]!.id, quantity: 1 }],
        channel: "agent",
        source: { type: "marketplace" },
        payment_intent: "prepaid",
      }),
    });
    expect(res.status).toBe(422);
  });
});
