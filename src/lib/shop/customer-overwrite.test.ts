import { afterEach, describe, expect, it, vi } from "vitest";
import { DEMO_TENANT_ID, getPosDriver, type Order } from "@/lib/db";
import { ensureCustomer } from "./auth";
import { POST as shopOrdersPOST } from "@/app/api/shop/orders/route";

/**
 * Guest checkout is keyed on email, which anyone can type. An existing
 * customer's stored name/phone must never be overwritten by a guest order —
 * only blanks are filled — and the per-order contact lives on the order.
 */
afterEach(() => {
  vi.useRealTimers();
});

describe("guest checkout never overwrites customer details", () => {
  it("keeps the existing row untouched (no name, no phone planted)", async () => {
    const email = `victim-${Date.now()}@example.com`;
    const first = await ensureCustomer({
      tenantId: DEMO_TENANT_ID,
      email,
      name: "Real Name",
      phone: null,
    });
    const second = await ensureCustomer({
      tenantId: DEMO_TENANT_ID,
      email,
      name: "Attacker",
      phone: "555-0100",
    });
    expect(second.id).toBe(first.id);
    expect(second.name).toBe("Real Name"); // not overwritten
    // An anonymous email match writes NOTHING: a stranger's phone is not planted
    // on the victim's row (it would reach guests via customer.updated).
    expect(second.phone).toBeNull();
    const third = await ensureCustomer({
      tenantId: DEMO_TENANT_ID,
      email,
      phone: "555-9999",
    });
    expect(third.phone).toBeNull();

    const stored = await getPosDriver().getCustomer(first.id);
    expect(stored).toMatchObject({ name: "Real Name", phone: null });
    expect(stored!.updated_at).toBe(first.updated_at);
  });

  it("stores per-order contact on the order and doesn't echo the stored record", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-03T18:00:00.000Z"));
    const email = `regular-${Date.now()}@example.com`;
    await ensureCustomer({
      tenantId: DEMO_TENANT_ID,
      email,
      name: "Stored Name",
      phone: "555-1111",
    });

    const res = await shopOrdersPOST(
      new Request("http://localhost/api/shop/orders", {
        method: "POST",
        body: JSON.stringify({
          id: crypto.randomUUID(),
          tenantSlug: "tonys-pizza",
          locationSlug: "tonys-uptown",
          items: [
            {
              id: "l1",
              item_id: "30000000-0000-0000-0000-000000000010",
              size_id: "40000000-0000-0000-0000-000000000021",
              quantity: 1,
              modifiers: [],
            },
          ],
          fulfillmentType: "pickup",
          scheduledFor: "asap",
          customer: { email, name: "Someone Else", phone: "555-2222" },
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      order: Order;
      customer: Record<string, unknown>;
    };
    expect(body.order.fulfillment?.contact).toEqual({
      name: "Someone Else",
      phone: "555-2222",
    });
    expect(Object.keys(body.customer)).toEqual(["id"]);

    const stored = await getPosDriver().getCustomerByEmail(
      DEMO_TENANT_ID,
      email,
    );
    expect(stored).toMatchObject({ name: "Stored Name", phone: "555-1111" });
  });
});
