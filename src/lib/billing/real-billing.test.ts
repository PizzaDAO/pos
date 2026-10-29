import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/lib/auth/session";

/**
 * REAL billing mode: a tier change must go through Stripe and only be applied
 * locally by the verified billing webhook. Stripe is stubbed via fetch.
 */
const session = vi.hoisted(() => ({ user: null as SessionUser | null }));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: vi.fn(async () => session.user),
}));

import { getPosDriver, type Subscription } from "@/lib/db";
import { POST as billingPOST } from "@/app/api/billing/route";
import { applyBillingEvent } from "./webhook";

const ENV = {
  STRIPE_SECRET_KEY: "sk_test_x",
  STRIPE_PRICE_STARTER: "price_starter",
  STRIPE_PRICE_PRO: "price_pro",
  STRIPE_PRICE_MULTI: "price_multi",
};

function ownerOf(tenantId: string): SessionUser {
  return {
    id: "billing-owner",
    email: "billing@example.com",
    memberships: [
      {
        id: "m1",
        user_id: "billing-owner",
        tenant_id: tenantId,
        role: "owner",
        created_at: "2025-01-01T00:00:00.000Z",
      },
    ],
    isPlatformAdmin: false,
    real: true,
  };
}

const calls: { url: string; method: string; body: string }[] = [];

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) process.env[k] = v;
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: String(init?.body ?? ""),
      });
      const u = String(url);
      const json = u.includes("/checkout/sessions")
        ? { id: "cs_1", url: "https://checkout.stripe.test/cs_1" }
        : u.includes("/customers")
          ? { id: "cus_1" }
          : { id: "sub_real_1", items: { data: [{ id: "si_1" }] } };
      return new Response(JSON.stringify(json), { status: 200 });
    }),
  );
});

afterEach(() => {
  for (const k of Object.keys(ENV)) delete process.env[k];
  vi.unstubAllGlobals();
});

async function tenantWithRealSub(tier: Subscription["tier"]) {
  const driver = getPosDriver();
  const { tenant } = await driver.createTenant({
    businessName: `Real Billing ${Date.now()}-${Math.random()}`,
    ownerEmail: "real-billing@example.com",
  });
  const now = new Date().toISOString();
  await driver.upsertSubscription({
    id: `sub_${tenant.id}`,
    tenant_id: tenant.id,
    tier,
    status: "active",
    current_period_end: now,
    trial_end: null,
    cancel_at_period_end: false,
    simulated: false,
    stripe_customer_id: "cus_1",
    stripe_subscription_id: "sub_real_1",
    created_at: now,
    updated_at: now,
  });
  return tenant.id;
}

const subscribe = (tenantId: string, tier: string) =>
  billingPOST(
    new Request("http://localhost/api/billing", {
      method: "POST",
      body: JSON.stringify({ action: "subscribe", tenantId, tier }),
    }),
  );

describe("real billing: tier changes go through Stripe", () => {
  it("requests a Stripe subscription update and leaves the local tier unchanged", async () => {
    const tenantId = await tenantWithRealSub("starter");
    session.user = ownerOf(tenantId);

    const res = await subscribe(tenantId, "pro");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pending?: boolean;
      subscription: Subscription;
    };
    expect(body.pending).toBe(true);
    expect(body.subscription.tier).toBe("starter");
    expect((await getPosDriver().getSubscription(tenantId))?.tier).toBe(
      "starter",
    );

    const update = calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/subscriptions/sub_real_1"),
    );
    expect(update?.body).toContain("price_pro");

    // Only the verified webhook applies the new tier — from Stripe's CURRENT
    // state (re-fetched), not the event payload.
    await applyBillingEvent(
      {
        type: "customer.subscription.updated",
        data: { object: { id: "sub_real_1", metadata: { tenant_id: tenantId } } },
      },
      liveSub({ tenantId, price: "price_pro", status: "active" }),
    );
    expect((await getPosDriver().getSubscription(tenantId))?.tier).toBe("pro");
  });

  it("a new real subscription persists nothing until checkout completes", async () => {
    const { tenant } = await getPosDriver().createTenant({
      businessName: `Checkout ${Date.now()}`,
      ownerEmail: "checkout@example.com",
    });
    session.user = ownerOf(tenant.id);
    const res = await subscribe(tenant.id, "pro");
    const body = (await res.json()) as { checkoutUrl: string | null };
    expect(body.checkoutUrl).toBe("https://checkout.stripe.test/cs_1");
    expect(await getPosDriver().getSubscription(tenant.id)).toBeNull();

    await applyBillingEvent(
      {
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_1",
            subscription: "sub_new_1",
            customer: "cus_1",
            payment_status: "paid",
            metadata: { tenant_id: tenant.id, tier: "pro" },
          },
        },
      },
      liveSub({ tenantId: tenant.id, price: "price_pro", status: "trialing", id: "sub_new_1" }),
    );
    const sub = await getPosDriver().getSubscription(tenant.id);
    expect(sub?.tier).toBe("pro");
    expect(sub?.status).toBe("trialing");
    expect(sub?.stripe_subscription_id).toBe("sub_new_1");
    expect(sub?.simulated).toBe(false);
  });

  it("applies Stripe's current state, so stale / out-of-order events can't roll back", async () => {
    const tenantId = await tenantWithRealSub("starter");
    // Stripe's truth is now: multi, active.
    const fetcher = liveSub({ tenantId, price: "price_multi", status: "active" });
    // A LATE, older event whose payload still says starter / past_due …
    await applyBillingEvent(
      {
        type: "customer.subscription.updated",
        created: 1000,
        data: {
          object: {
            id: "sub_real_1",
            status: "past_due",
            metadata: { tenant_id: tenantId },
            items: { data: [{ price: { id: "price_starter" } }] },
          },
        },
      },
      fetcher,
    );
    // … still yields Stripe's current state.
    let sub = await getPosDriver().getSubscription(tenantId);
    expect(sub?.tier).toBe("multi");
    expect(sub?.status).toBe("active");
    // An invoice event (any type) also re-fetches instead of guessing.
    await applyBillingEvent(
      {
        type: "invoice.payment_failed",
        data: { object: { subscription: "sub_real_1" } },
      },
      fetcher,
    );
    sub = await getPosDriver().getSubscription(tenantId);
    expect(sub?.status).toBe("active");
    await applyBillingEvent(
      {
        type: "invoice.payment_failed",
        data: { object: { subscription: "sub_real_1" } },
      },
      liveSub({ tenantId, price: "price_multi", status: "past_due" }),
    );
    expect((await getPosDriver().getSubscription(tenantId))?.status).toBe("past_due");
  });

  it("does not activate a checkout whose payment is still processing", async () => {
    const { tenant } = await getPosDriver().createTenant({
      businessName: `Unpaid ${Date.now()}`,
      ownerEmail: "unpaid@example.com",
    });
    const fetcher = liveSub({ tenantId: tenant.id, price: "price_pro", status: "active", id: "sub_x" });
    const sessionEvent = (payment_status: string, type = "checkout.session.completed") =>
      applyBillingEvent(
        {
          type,
          data: {
            object: {
              subscription: "sub_x",
              customer: "cus_x",
              payment_status,
              metadata: { tenant_id: tenant.id, tier: "pro" },
            },
          },
        },
        fetcher,
      );
    await sessionEvent("unpaid");
    expect(await getPosDriver().getSubscription(tenant.id)).toBeNull();
    await sessionEvent("paid", "checkout.session.async_payment_succeeded");
    expect((await getPosDriver().getSubscription(tenant.id))?.tier).toBe("pro");
  });

  it("does not grant an active plan for an incomplete subscription", async () => {
    const tenantId = await tenantWithRealSub("starter");
    await applyBillingEvent(
      {
        type: "customer.subscription.updated",
        data: { object: { id: "sub_real_1", metadata: { tenant_id: tenantId } } },
      },
      liveSub({ tenantId, price: "price_multi", status: "incomplete" }),
    );
    const sub = await getPosDriver().getSubscription(tenantId);
    expect(sub?.status).toBe("past_due");
  });

  it("propagates a Stripe fetch failure (webhook answers 5xx → retry)", async () => {
    const tenantId = await tenantWithRealSub("starter");
    await expect(
      applyBillingEvent(
        {
          type: "customer.subscription.updated",
          data: { object: { id: "sub_real_1", metadata: { tenant_id: tenantId } } },
        },
        async () => {
          throw new Error("stripe down");
        },
      ),
    ).rejects.toThrow("stripe down");
    expect((await getPosDriver().getSubscription(tenantId))?.tier).toBe("starter");
  });
});

/** A fake Stripe subscription fetcher returning a fixed current state. */
function liveSub(input: {
  tenantId: string;
  price: string;
  status: string;
  id?: string;
}) {
  return async (id: string) => ({
    id: input.id ?? id,
    status: input.status,
    customer: "cus_1",
    metadata: { tenant_id: input.tenantId },
    items: { data: [{ id: "si_1", price: { id: input.price } }] },
    current_period_end: 1_900_000_000,
  });
}
