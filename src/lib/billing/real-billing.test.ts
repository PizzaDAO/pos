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
import { POST as billingWebhookPOST } from "@/app/api/billing/webhook/route";
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
    await recordPending(tenant.id, "cs_x", "pro");
    const fetcher = liveSub({ tenantId: tenant.id, price: "price_pro", status: "active", id: "sub_x" });
    const sessionEvent = (payment_status: string, type = "checkout.session.completed") =>
      applyBillingEvent(
        {
          type,
          data: {
            object: {
              id: "cs_x",
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

/** Record `sessionId` as the tenant's open billing checkout (as subscribe does). */
async function recordPending(tenantId: string, sessionId: string, tier: Subscription["tier"]) {
  await getPosDriver().claimPendingBillingCheckout({
    tenant_id: tenantId,
    session_id: sessionId,
    tier,
    url: `https://checkout.stripe.test/${sessionId}`,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    created_at: new Date().toISOString(),
  });
}

async function newTenant(name: string) {
  const { tenant } = await getPosDriver().createTenant({
    businessName: `${name} ${Date.now()}-${Math.random()}`,
    ownerEmail: "dbl@example.com",
  });
  session.user = ownerOf(tenant.id);
  return tenant.id;
}

const sessionsCreated = () =>
  calls.filter((c) => c.method === "POST" && c.url.endsWith("/checkout/sessions"));

describe("real billing: no double subscribe", () => {
  it("a second subscribe for the same tier reuses the open Checkout Session", async () => {
    const tenantId = await newTenant("Double");
    const first = (await (await subscribe(tenantId, "pro")).json()) as { checkoutUrl: string };
    const second = (await (await subscribe(tenantId, "pro")).json()) as {
      checkoutUrl: string;
      reused?: boolean;
    };
    expect(second.checkoutUrl).toBe(first.checkoutUrl);
    expect(second.reused).toBe(true);
    expect(sessionsCreated()).toHaveLength(1);
  });

  it("concurrent subscribes open at most one recorded session", async () => {
    const tenantId = await newTenant("Concurrent");
    const results = await Promise.all([subscribe(tenantId, "pro"), subscribe(tenantId, "pro")]);
    const urls = await Promise.all(results.map(async (r) => ((await r.json()) as { checkoutUrl: string }).checkoutUrl));
    expect(new Set(urls).size).toBe(1);
    expect((await getPosDriver().getPendingBillingCheckout(tenantId))?.url).toBe(urls[0]);
  });

  it("another tier expires the open session at Stripe first, then opens a new one", async () => {
    const tenantId = await newTenant("Switch");
    await recordPending(tenantId, "cs_old", "starter");
    const res = await subscribe(tenantId, "pro");
    expect(res.status).toBe(200);
    expect(
      calls.some((c) => c.method === "POST" && c.url.endsWith("/checkout/sessions/cs_old/expire")),
    ).toBe(true);
    const pending = await getPosDriver().getPendingBillingCheckout(tenantId);
    expect(pending?.tier).toBe("pro");
    expect(pending?.session_id).not.toBe("cs_old");
  });

  it("refuses (409) when the open session for another tier can't be expired", async () => {
    const tenantId = await newTenant("Refuse");
    await recordPending(tenantId, "cs_paid", "starter");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), method: init?.method ?? "GET", body: String(init?.body ?? "") });
        if (String(url).endsWith("/expire")) {
          return new Response(JSON.stringify({ error: { message: "already complete" } }), {
            status: 400,
          });
        }
        return new Response(JSON.stringify({ id: "cs_new", url: "https://x" }), { status: 200 });
      }),
    );
    expect((await subscribe(tenantId, "pro")).status).toBe(409);
    expect(sessionsCreated()).toHaveLength(0);
    expect((await getPosDriver().getPendingBillingCheckout(tenantId))?.session_id).toBe("cs_paid");
  });

  it("an expired recorded session doesn't block a new checkout", async () => {
    const tenantId = await newTenant("Expired");
    await getPosDriver().claimPendingBillingCheckout({
      tenant_id: tenantId,
      session_id: "cs_stale",
      tier: "pro",
      url: "https://stale",
      expires_at: new Date(Date.now() - 1000).toISOString(),
      created_at: new Date().toISOString(),
    });
    const body = (await (await subscribe(tenantId, "pro")).json()) as { checkoutUrl: string };
    expect(body.checkoutUrl).toBe("https://checkout.stripe.test/cs_1");
    expect(sessionsCreated()).toHaveLength(1);
  });
});

describe("billing webhook: checkout.session.* only for the recorded session", () => {
  const completed = (tenantId: string, id: string) => ({
    type: "checkout.session.completed",
    data: {
      object: {
        id,
        subscription: "sub_w",
        customer: "cus_w",
        payment_status: "paid",
        metadata: { tenant_id: tenantId, tier: "pro" },
      },
    },
  });

  it("ignores a completed session that isn't the recorded one", async () => {
    const tenantId = await newTenant("Webhook");
    const fetcher = liveSub({ tenantId, price: "price_pro", status: "active", id: "sub_w" });
    expect(await applyBillingEvent(completed(tenantId, "cs_unknown"), fetcher)).toBeNull();
    expect(await getPosDriver().getSubscription(tenantId)).toBeNull();

    await recordPending(tenantId, "cs_real", "pro");
    expect(await applyBillingEvent(completed(tenantId, "cs_other"), fetcher)).toBeNull();
    expect(await getPosDriver().getSubscription(tenantId)).toBeNull();

    // The recorded one activates — and is then cleared.
    await applyBillingEvent(completed(tenantId, "cs_real"), fetcher);
    expect((await getPosDriver().getSubscription(tenantId))?.tier).toBe("pro");
    expect(await getPosDriver().getPendingBillingCheckout(tenantId)).toBeNull();
  });

  it("a recorded session can't activate another tenant's subscription", async () => {
    const tenantId = await newTenant("Cross");
    const victim = await newTenant("Victim");
    await recordPending(tenantId, "cs_mine", "pro");
    // Stripe says the subscription belongs to `victim`.
    const fetcher = liveSub({ tenantId: victim, price: "price_pro", status: "active", id: "sub_w" });
    expect(await applyBillingEvent(completed(tenantId, "cs_mine"), fetcher)).toBeNull();
    expect(await getPosDriver().getSubscription(victim)).toBeNull();
  });

  it("checkout.session.expired clears the recorded session", async () => {
    const tenantId = await newTenant("Expire");
    await recordPending(tenantId, "cs_exp", "pro");
    await applyBillingEvent({
      type: "checkout.session.expired",
      data: { object: { id: "cs_exp", metadata: { tenant_id: tenantId } } },
    });
    expect(await getPosDriver().getPendingBillingCheckout(tenantId)).toBeNull();
  });
});

describe("billing webhook route: missing secret", () => {
  const post = () =>
    billingWebhookPOST(
      new Request("http://localhost/api/billing/webhook", {
        method: "POST",
        body: JSON.stringify({ type: "checkout.session.completed" }),
      }),
    );

  it("answers 5xx (and logs) when real billing is configured", async () => {
    delete process.env.STRIPE_BILLING_WEBHOOK_SECRET;
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await post();
    expect(res.status).toBe(503);
    expect(err.mock.calls.some((c) => String(c[0]).includes("billing_webhook_secret_missing"))).toBe(
      true,
    );
    err.mockRestore();
  });

  it("stays a 200 simulated no-op when billing isn't configured", async () => {
    for (const k of Object.keys(ENV)) delete process.env[k];
    const res = await post();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { simulated?: boolean }).simulated).toBe(true);
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
