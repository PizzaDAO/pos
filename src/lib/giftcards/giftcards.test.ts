/**
 * Gift cards + store credit, end to end on the mock driver: sale -> activation
 * -> redemption (partial, split, races) -> refund back to the card -> void,
 * reloads, store credit approval, online checkout release, and the accounting
 * (tax + reports).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_TENANT_ID,
  getPosDriver,
  type CreateOrderInput,
  type Order,
  type OrderItem,
} from "@/lib/db";
import { resetMockOnline, resetMockOrders, resetMockPayments } from "@/lib/db/mock";
import { computeOrderTotals } from "@/lib/pricing";
import { refundPayment, takePayment, getOrderBalance } from "@/lib/payments/service";
import { cancelOnlineCheckout } from "@/lib/shop/lifecycle";
import { buildSalesReport } from "@/lib/reports";
import { buildTickets, DEFAULT_KDS_THRESHOLDS } from "@/lib/kds/board";
import { verifyLedger } from "./ledger";
import { resetMockStoredValue } from "./store-mock";
import { getStoredValueStore } from "./store";
import {
  StoredValueError,
  StoredValueRefundBlockedError,
  businessDayStartIso,
  createGiftCardReload,
  createGiftCardSale,
  findAccountByCode,
  issueStoreCredit,
  redeemStoredValue,
  revealOnlineCode,
  reverseReload,
  settleStoredValueOrder,
  sweepUnreleasedStoredValue,
  voidStoredValue,
} from "./service";
import { expireOnlineOrders } from "@/lib/shop/lifecycle";
import { vi } from "vitest";
import { requirePaymentRail } from "@/lib/payments/registry";

const TENANT = DEMO_TENANT_ID;
const LOCATION = DEMO_LOCATION_DOWNTOWN_ID;
const ACTOR = { id: "00000000-0000-0000-0000-0000000000aa", label: "mgr@test" };

function line(cents: number): OrderItem {
  return {
    id: randomUUID(),
    item_id: "30000000-0000-0000-0000-000000000001",
    item_name: "Margherita",
    size_id: "s1",
    size_name: "L",
    base_price_cents: cents,
    quantity: 1,
    modifiers: [],
    notes: null,
    voided: false,
    unit_price_cents: cents,
    line_total_cents: cents,
  };
}

/** A normal, TAXED food order (8.25%). */
async function foodOrder(
  subtotal: number,
  opts: { online?: boolean } = {},
): Promise<Order> {
  const items = [line(subtotal)];
  const input: CreateOrderInput = {
    id: randomUUID(),
    tenant_id: TENANT,
    location_id: LOCATION,
    channel: opts.online ? "online_pickup" : "in_store",
    currency: "USD",
    items,
    discount_cents: 0,
    totals: computeOrderTotals({ items, discountCents: 0, taxRateBps: 825 }),
    notes: null,
    status: opts.online ? "awaiting_payment" : "placed",
    ...(opts.online
      ? {
          fulfillment: {
            type: "pickup" as const,
            scheduled_for: "2030-01-01T18:00:00.000Z",
            promised_at: "2030-01-01T18:00:00.000Z",
          },
        }
      : {}),
  };
  return getPosDriver().createOrder(input);
}

async function payCash(orderId: string, amountCents: number) {
  return takePayment({
    paymentId: randomUUID(),
    orderId,
    tenantId: TENANT,
    locationId: LOCATION,
    rail: "cash",
    amountCents,
    tipCents: 0,
    currency: "USD",
  });
}

/** Sell + pay a gift card at the till; returns its code and account id. */
async function soldCard(amountCents = 5000, physicalCode?: string) {
  const sale = await createGiftCardSale({
    tenantId: TENANT,
    locationId: LOCATION,
    orderId: randomUUID(),
    amountCents,
    channel: "in_store",
    physicalCode,
    currency: "USD",
  });
  await payCash(sale.order.id, amountCents);
  return { code: sale.code ?? physicalCode!, accountId: sale.account.id, saleOrderId: sale.order.id };
}

async function account(id: string) {
  return (await (await getStoredValueStore()).getAccount(TENANT, id))!;
}

async function ledgerOk(id: string) {
  const store = await getStoredValueStore();
  return verifyLedger(await store.listLedger(TENANT, id), await account(id));
}

async function redeem(order: Order, code: string, amountCents?: number, paymentId = randomUUID()) {
  const acct = await findAccountByCode(TENANT, code);
  if (!acct) throw new Error("card not found");
  return redeemStoredValue({
    order: (await getPosDriver().getOrder(order.id))!,
    account: acct,
    paymentId,
    amountCents: amountCents ?? null,
    actorId: null,
    staffId: null,
  });
}

beforeEach(() => {
  resetMockOrders();
  resetMockPayments();
  resetMockOnline();
  resetMockStoredValue();
});

describe("selling a gift card", () => {
  it("creates an untaxed, line-less sale order and a pending card that activates on payment", async () => {
    const sale = await createGiftCardSale({
      tenantId: TENANT,
      locationId: LOCATION,
      orderId: randomUUID(),
      amountCents: 5000,
      channel: "in_store",
      currency: "USD",
    });
    expect(sale.order.items).toEqual([]);
    expect(sale.order.totals).toMatchObject({ tax_cents: 0, taxable_cents: 0, total_cents: 5000 });
    expect(sale.order.status).toBe("draft");
    expect(sale.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    expect(sale.account.status).toBe("pending");

    // Unpaid: unusable.
    const food = await foodOrder(1000);
    await expect(redeem(food, sale.code!)).rejects.toMatchObject({ code: "inactive" });

    await payCash(sale.order.id, 5000);
    const after = await account(sale.account.id);
    expect(after.status).toBe("active");
    expect(after.balance_cents).toBe(5000);
    expect((await getPosDriver().getOrder(sale.order.id))!.status).toBe("completed");
    expect((await ledgerOk(sale.account.id)).ok).toBe(true);
  });

  it("is idempotent on the order id (no second card) and never re-shows a till code", async () => {
    const orderId = randomUUID();
    const input = {
      tenantId: TENANT,
      locationId: LOCATION,
      orderId,
      amountCents: 2500,
      channel: "in_store" as const,
      currency: "USD",
    };
    const first = await createGiftCardSale(input);
    const again = await createGiftCardSale(input);
    expect(again.replayed).toBe(true);
    expect(again.account.id).toBe(first.account.id);
    expect(again.code).toBeNull();
    expect((await (await getStoredValueStore()).listAccounts(TENANT)).length).toBe(1);
  });

  it("accepts a physical card number once, and refuses the same number again", async () => {
    const { accountId } = await soldCard(2000, "6000 1234 5678 9012");
    expect((await account(accountId)).physical).toBe(true);
    expect((await findAccountByCode(TENANT, "6000-1234-5678-9012"))?.id).toBe(accountId);
    await expect(
      createGiftCardSale({
        tenantId: TENANT,
        locationId: LOCATION,
        orderId: randomUUID(),
        amountCents: 2000,
        channel: "in_store",
        physicalCode: "600012345678 9012",
        currency: "USD",
      }),
    ).rejects.toMatchObject({ code: "code_taken" });
  });

  it("enforces the amount limits", async () => {
    for (const amountCents of [0, 499, 50_001, 12.5]) {
      await expect(
        createGiftCardSale({
          tenantId: TENANT,
          locationId: LOCATION,
          orderId: randomUUID(),
          amountCents,
          channel: "in_store",
          currency: "USD",
        }),
      ).rejects.toBeInstanceOf(StoredValueError);
    }
  });

  it("never shows a sale on the kitchen board", async () => {
    const sale = await createGiftCardSale({
      tenantId: TENANT,
      locationId: LOCATION,
      orderId: randomUUID(),
      amountCents: 5000,
      channel: "in_store",
      currency: "USD",
    });
    const paidLike = { ...sale.order, status: "paid" as const };
    expect(buildTickets([paidLike], new Date(), DEFAULT_KDS_THRESHOLDS)).toEqual([]);
  });
});

describe("redeeming", () => {
  it("pays part of a taxed order and splits the rest with cash", async () => {
    const { code, accountId } = await soldCard(2000);
    const food = await foodOrder(2800); // + 231 tax = 3031
    expect(food.totals.tax_cents).toBe(231);
    const { payment } = await redeem(food, code);
    expect(payment).toMatchObject({ rail: "gift_card", status: "captured", amount_cents: 2000, tip_cents: 0 });
    expect(await getOrderBalance((await getPosDriver().getOrder(food.id))!)).toBe(1031);
    await payCash(food.id, 1031);
    expect((await getPosDriver().getOrder(food.id))!.status).toBe("paid");
    expect((await account(accountId)).balance_cents).toBe(0);
    expect((await ledgerOk(accountId)).ok).toBe(true);
  });

  it("takes only what the order owes, and refuses more than the card or the order", async () => {
    const { code, accountId } = await soldCard(5000);
    const food = await foodOrder(1000); // 1083
    await expect(redeem(food, code, 2000)).rejects.toMatchObject({ code: "exceeds_due" });
    const { payment } = await redeem(food, code);
    expect(payment.amount_cents).toBe(1083);
    expect((await account(accountId)).balance_cents).toBe(3917);
    const big = await foodOrder(10_000);
    await expect(redeem(big, code, 4000)).rejects.toMatchObject({ code: "insufficient" });
  });

  it("is idempotent on the payment id (one debit)", async () => {
    const { code, accountId } = await soldCard(5000);
    const food = await foodOrder(1000);
    const pid = randomUUID();
    const a = await redeem(food, code, 500, pid);
    const b = await redeem(food, code, 500, pid);
    expect(b.replayed).toBe(true);
    expect(b.payment.id).toBe(a.payment.id);
    expect((await account(accountId)).balance_cents).toBe(4500);
    expect((await getPosDriver().listPaymentsForOrder(food.id)).length).toBe(1);
  });

  it("refuses to pay a gift card sale with a gift card", async () => {
    const { code } = await soldCard(5000);
    const sale = await createGiftCardSale({
      tenantId: TENANT,
      locationId: LOCATION,
      orderId: randomUUID(),
      amountCents: 1000,
      channel: "in_store",
      currency: "USD",
    });
    await expect(redeem(sale.order, code)).rejects.toMatchObject({ code: "order_not_payable" });
  });

  it("does not find a card from another tenant", async () => {
    const { code } = await soldCard(5000);
    expect(await findAccountByCode("10000000-0000-0000-0000-00000000ffff", code)).toBeNull();
  });
});

describe("concurrency: two tills, one card", () => {
  it("two simultaneous redemptions can never overspend the card", async () => {
    const { code, accountId } = await soldCard(5000);
    const o1 = await foodOrder(4000);
    const o2 = await foodOrder(4000);
    const results = await Promise.allSettled([redeem(o1, code, 4000), redeem(o2, code, 4000)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "insufficient" });
    expect((await account(accountId)).balance_cents).toBe(1000);
    expect((await ledgerOk(accountId)).ok).toBe(true);
  });

  it("ten tills racing $10 each on a $50 card: exactly five succeed", async () => {
    const { code, accountId } = await soldCard(5000);
    const orders = await Promise.all(Array.from({ length: 10 }, () => foodOrder(2000)));
    const results = await Promise.allSettled(orders.map((o) => redeem(o, code, 1000)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect((await account(accountId)).balance_cents).toBe(0);
    const check = await ledgerOk(accountId);
    expect(check).toEqual({ ok: true, balanceCents: 0 });
  });

  it("two cards racing on one order can never overpay it", async () => {
    const a = await soldCard(5000);
    const b = await soldCard(5000);
    const food = await foodOrder(2770); // 2999
    const results = await Promise.allSettled([redeem(food, a.code, 2999), redeem(food, b.code, 2999)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const paid = (await getPosDriver().listPaymentsForOrder(food.id)).reduce((n, p) => n + p.amount_cents, 0);
    expect(paid).toBe(2999);
    expect((await account(a.accountId)).balance_cents + (await account(b.accountId)).balance_cents).toBe(7001);
  });
});

describe("refunds go back to the card", () => {
  it("full and partial refunds of a gift card tender credit the card, idempotently", async () => {
    const { code, accountId } = await soldCard(5000);
    const food = await foodOrder(2000); // 2165
    const { payment } = await redeem(food, code);
    expect((await account(accountId)).balance_cents).toBe(2835);

    await refundPayment({ paymentId: payment.id, amountCents: 500, refundId: "r1" });
    await refundPayment({ paymentId: payment.id, amountCents: 500, refundId: "r1" }); // replay
    expect((await account(accountId)).balance_cents).toBe(3335);

    await refundPayment({ paymentId: payment.id, refundId: "r2" }); // the rest
    expect((await account(accountId)).balance_cents).toBe(5000);
    await expect(refundPayment({ paymentId: payment.id, amountCents: 1, refundId: "r3" })).rejects.toThrow();
    expect((await account(accountId)).balance_cents).toBe(5000);
    expect((await ledgerOk(accountId)).ok).toBe(true);
    expect((await getPosDriver().getOrder(food.id))!.status).toBe("refunded");
  });
});

describe("voiding a sale", () => {
  it("refunds an unredeemed card's sale; the sale cannot be refunded any other way", async () => {
    const { accountId, saleOrderId } = await soldCard(5000);
    const [cash] = await getPosDriver().listPaymentsForOrder(saleOrderId);
    await expect(refundPayment({ paymentId: cash!.id, refundId: "x" })).rejects.toBeInstanceOf(
      StoredValueRefundBlockedError,
    );

    const out = await voidStoredValue({
      tenantId: TENANT,
      accountId,
      locationId: LOCATION,
      reason: "changed mind",
      actor: ACTOR,
    });
    expect(out.account.status).toBe("voided");
    expect(out.account.balance_cents).toBe(0);
    expect(out.refunds).toEqual([{ paymentId: cash!.id, refundedCents: 5000, manual: false }]);
    expect((await getPosDriver().getPayment(cash!.id))!.status).toBe("refunded");
    expect((await ledgerOk(accountId)).ok).toBe(true);
  });

  it("refuses to void a card that was ever redeemed (even if refunded back)", async () => {
    const { code, accountId } = await soldCard(5000);
    const food = await foodOrder(1000);
    const { payment } = await redeem(food, code);
    await refundPayment({ paymentId: payment.id, refundId: "back" });
    expect((await account(accountId)).balance_cents).toBe(5000);
    await expect(
      voidStoredValue({ tenantId: TENANT, accountId, locationId: LOCATION, reason: "x", actor: ACTOR }),
    ).rejects.toMatchObject({ code: "has_activity" });
  });

  it("voids an unpaid card with its sale order", async () => {
    const sale = await createGiftCardSale({
      tenantId: TENANT,
      locationId: LOCATION,
      orderId: randomUUID(),
      amountCents: 5000,
      channel: "in_store",
      currency: "USD",
    });
    const out = await voidStoredValue({
      tenantId: TENANT,
      accountId: sale.account.id,
      locationId: LOCATION,
      reason: "mistake",
      actor: ACTOR,
    });
    expect(out.account.status).toBe("voided");
    expect((await getPosDriver().getOrder(sale.order.id))!.status).toBe("voided");
  });
});

describe("reloads", () => {
  it("loads a paid reload, and reverses it (refunding the reload) only while the card holds it", async () => {
    const { code, accountId } = await soldCard(2000);
    const reload = await createGiftCardReload({
      tenantId: TENANT,
      locationId: LOCATION,
      orderId: randomUUID(),
      code,
      amountCents: 3000,
      currency: "USD",
    });
    expect(reload.order.totals.tax_cents).toBe(0);
    expect((await account(accountId)).balance_cents).toBe(2000); // unpaid
    await payCash(reload.order.id, 3000);
    expect((await account(accountId)).balance_cents).toBe(5000);

    const out = await reverseReload({ tenantId: TENANT, orderId: reload.order.id, reason: "wrong card", actor: ACTOR });
    expect(out.account.balance_cents).toBe(2000);
    expect(out.refunds[0]?.refundedCents).toBe(3000);
    expect((await ledgerOk(accountId)).ok).toBe(true);
  });

  it("refuses a reload over the maximum balance", async () => {
    const { code, accountId } = await soldCard(50_000);
    const top = await createGiftCardReload({
      tenantId: TENANT,
      locationId: LOCATION,
      orderId: randomUUID(),
      code,
      amountCents: 50_000,
      currency: "USD",
    });
    await payCash(top.order.id, 50_000);
    expect((await account(accountId)).balance_cents).toBe(100_000);
    await expect(
      createGiftCardReload({
        tenantId: TENANT,
        locationId: LOCATION,
        orderId: randomUUID(),
        code,
        amountCents: 500,
        currency: "USD",
      }),
    ).rejects.toMatchObject({ code: "exceeds_max" });
  });
});

describe("store credit", () => {
  const base = {
    tenantId: TENANT,
    locationId: LOCATION,
    reason: "Late order",
    actor: ACTOR,
    currency: "USD",
  };

  it("a cashier may issue up to the threshold; above it a manager must (and is recorded)", async () => {
    const small = await issueStoreCredit({ ...base, accountId: randomUUID(), amountCents: 2500, role: "cashier" });
    expect(small.account).toMatchObject({ kind: "store_credit", status: "active", balance_cents: 2500 });
    expect(small.entry?.approved_by).toBeNull();
    await expect(
      issueStoreCredit({ ...base, accountId: randomUUID(), amountCents: 2501, role: "cashier" }),
    ).rejects.toMatchObject({ code: "approval_required", status: 403 });
    const big = await issueStoreCredit({ ...base, accountId: randomUUID(), amountCents: 4000, role: "manager" });
    expect(big.entry?.approved_by).toBe(ACTOR.id);
    expect(big.entry?.reason).toBe("Late order");
  });

  it("requires a reason, is idempotent on the account id, and redeems as a store_credit tender", async () => {
    await expect(
      issueStoreCredit({ ...base, reason: "  ", accountId: randomUUID(), amountCents: 100, role: "manager" }),
    ).rejects.toMatchObject({ code: "reason_required" });
    const id = randomUUID();
    const first = await issueStoreCredit({ ...base, accountId: id, amountCents: 1500, role: "manager" });
    const again = await issueStoreCredit({ ...base, accountId: id, amountCents: 1500, role: "manager" });
    expect(again.replayed).toBe(true);
    expect(again.code).toBeNull();
    expect((await account(id)).balance_cents).toBe(1500);

    const food = await foodOrder(1000);
    const { payment } = await redeem(food, first.code!);
    expect(payment).toMatchObject({ rail: "store_credit", amount_cents: 1083 });
    expect((await account(id)).balance_cents).toBe(417);
  });
});

describe("online", () => {
  it("an online purchase settles through the online lifecycle; a replay never returns the code, the one-time reveal does once", async () => {
    const orderId = randomUUID();
    const input = {
      tenantId: TENANT,
      locationId: LOCATION,
      orderId,
      amountCents: 4000,
      channel: "online" as const,
      recipientEmail: "friend@example.com",
      currency: "USD",
    };
    const sale = await createGiftCardSale(input);
    expect(sale.order).toMatchObject({ channel: "online_pickup", status: "awaiting_payment" });
    expect(sale.code).toMatch(/^.{4}-.{4}-.{4}-.{4}$/);
    expect((await createGiftCardSale(input)).code).toBeNull();
    expect(await revealOnlineCode(TENANT, orderId)).toBeNull(); // not paid yet
    await payCash(orderId, 4000);
    expect((await createGiftCardSale(input)).code).toBeNull(); // not even after payment
    expect((await getPosDriver().getOrder(orderId))!.status).toBe("completed");
    expect((await findAccountByCode(TENANT, sale.code))?.balance_cents).toBe(4000);
    expect((await revealOnlineCode(TENANT, orderId))?.code).toBe(sale.code);
    await expect(revealOnlineCode(TENANT, orderId)).rejects.toMatchObject({ code: "already_revealed" });
  });

  it("a gift card applied to a checkout goes back to the card when the checkout is canceled", async () => {
    const { code, accountId } = await soldCard(1000);
    const food = await foodOrder(2000, { online: true });
    await redeem(food, code);
    expect((await account(accountId)).balance_cents).toBe(0);
    const res = await cancelOnlineCheckout(food.id);
    expect(res.ok).toBe(true);
    expect((await getPosDriver().getOrder(food.id))!.status).toBe("abandoned");
    expect((await account(accountId)).balance_cents).toBe(1000);
    expect((await ledgerOk(accountId)).ok).toBe(true);
  });

  it("a card covering the whole online order pays it", async () => {
    const { code } = await soldCard(5000);
    const food = await foodOrder(2000, { online: true });
    await redeem(food, code);
    expect((await getPosDriver().getOrder(food.id))!.status).toBe("paid");
  });
});

describe("accounting: gift card sales are a liability, redemptions are taxed sales", () => {
  it("keeps the sale out of gross/net/tax/the mix and reports it as stored value", async () => {
    const { code, saleOrderId } = await soldCard(5000);
    const food = await foodOrder(2800); // 3031 incl. 231 tax
    await redeem(food, code, 2000);
    await payCash(food.id, 1031);

    const driver = getPosDriver();
    const orders = [(await driver.getOrder(saleOrderId))!, (await driver.getOrder(food.id))!];
    const payments = [
      ...(await driver.listPaymentsForOrder(saleOrderId)),
      ...(await driver.listPaymentsForOrder(food.id)),
    ];
    const report = buildSalesReport({
      tenantId: TENANT,
      locationId: LOCATION,
      range: { from: null, to: null },
      orders,
      payments,
      categoryOf: () => null,
      locationName: () => "Downtown",
    });
    expect(report.order_count).toBe(1);
    expect(report.gross_cents).toBe(2800);
    expect(report.tax_cents).toBe(231);
    // Mix = how SALES were paid: 2000 gift card + 1031 cash (the 5000 cash that
    // bought the card is not a sale).
    const mix = Object.fromEntries(report.paymentMix.map((s) => [s.rail, s.amount_cents]));
    expect(mix).toEqual({ gift_card: 2000, cash: 1031 });
    expect(report.stored_value).toMatchObject({
      sold_count: 1,
      sold_cents: 5000,
      sold_by_family: { cash: 5000, card: 0, crypto: 0, other: 0 },
      redeemed_count: 1,
      redeemed_gift_card_cents: 2000,
      redeemed_store_credit_cents: 0,
    });
  });
});

describe("review fixes", () => {
  it("physical card numbers are invisible to anonymous (storefront) lookups", async () => {
    const { code } = await soldCard(2000, "6000 1234 5678 9012");
    expect(await findAccountByCode(TENANT, code)).not.toBeNull();
    expect(await findAccountByCode(TENANT, code, { anonymous: true })).toBeNull();
  });

  it("a refund of a gift card tender is reserved, credited, then confirmed; a crash after the credit and a retry credit once", async () => {
    const { code, accountId } = await soldCard(5000);
    const food = await foodOrder(2000); // 2165
    const { payment } = await redeem(food, code);
    const driver = getPosDriver();
    // The process dies after the card got the value, before the refund is confirmed.
    const confirm = vi.spyOn(driver, "confirmPaymentRefund").mockRejectedValueOnce(new Error("crash"));
    await expect(refundPayment({ paymentId: payment.id, amountCents: 1000, refundId: "r-crash" })).rejects.toThrow("crash");
    expect((await account(accountId)).balance_cents).toBe(2835 + 1000);
    // Held as pending (it blocks a second refund of the same room), not yet refunded.
    const held = (await driver.getPayment(payment.id))!;
    expect(held.refunded_cents).toBe(0);
    expect(held.refund_reserved_cents).toBe(1000);
    confirm.mockRestore();
    // The retry replays the same credit (same key: no second credit) and confirms it.
    await refundPayment({ paymentId: payment.id, amountCents: 1000, refundId: "r-crash" });
    expect((await account(accountId)).balance_cents).toBe(3835);
    expect((await driver.getPayment(payment.id))!.refunded_cents).toBe(1000);
    expect((await ledgerOk(accountId)).ok).toBe(true);
  });

  it("refunds without a refund id still credit the card exactly once per recorded refund", async () => {
    const { code, accountId } = await soldCard(5000);
    const food = await foodOrder(2000);
    const { payment } = await redeem(food, code);
    await refundPayment({ paymentId: payment.id, amountCents: 500 });
    await refundPayment({ paymentId: payment.id, amountCents: 500 });
    expect((await account(accountId)).balance_cents).toBe(2835 + 1000);
    expect((await getPosDriver().getPayment(payment.id))!.refunded_cents).toBe(1000);
  });

  it("two racing refunds of duplicate gift-card-sale tenders cannot both pass as excess", async () => {
    const sale = await createGiftCardSale({
      tenantId: TENANT,
      locationId: LOCATION,
      orderId: randomUUID(),
      amountCents: 2000,
      channel: "in_store",
      currency: "USD",
    });
    const p1 = await payCash(sale.order.id, 2000);
    // A second (duplicate) cash tender written straight to the driver.
    const p2 = await getPosDriver().upsertPayment({ ...p1, id: randomUUID(), created_at: new Date().toISOString() });
    const results = await Promise.allSettled([
      refundPayment({ paymentId: p1.id, refundId: "a" }),
      refundPayment({ paymentId: p2.id, refundId: "b" }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    expect(ok).toBeLessThanOrEqual(1);
    const held = (await getPosDriver().listPaymentsForOrder(sale.order.id)).reduce(
      (n, p) => n + p.amount_cents - p.refunded_cents,
      0,
    );
    expect(held).toBeGreaterThanOrEqual(2000); // the live card's value never left
  });

  it("the sweeper re-releases an abandoned checkout that still holds a gift card tender", async () => {
    const { code, accountId } = await soldCard(1000);
    const food = await foodOrder(2000, { online: true });
    await redeem(food, code);
    // Abandoned WITHOUT the release running (e.g. it failed).
    await getPosDriver().transitionOrderStatus(food.id, ["awaiting_payment"], "abandoned");
    expect((await account(accountId)).balance_cents).toBe(0);
    expect(await sweepUnreleasedStoredValue()).toBe(1);
    expect((await account(accountId)).balance_cents).toBe(1000);
    expect(await sweepUnreleasedStoredValue()).toBe(0); // idempotent
    await expireOnlineOrders(); // the cron path runs it too, harmlessly
    expect((await account(accountId)).balance_cents).toBe(1000);
  });

  it("caps a non-manager's store credit per day; a manager is exempt", async () => {
    const base = { tenantId: TENANT, locationId: LOCATION, reason: "late", currency: "USD" };
    const cashier = { id: "cashier-1", label: "c" };
    for (let i = 0; i < 4; i += 1) {
      await issueStoreCredit({ ...base, accountId: randomUUID(), amountCents: 2500, role: "cashier", actor: cashier });
    }
    await expect(
      issueStoreCredit({ ...base, accountId: randomUUID(), amountCents: 100, role: "cashier", actor: cashier }),
    ).rejects.toMatchObject({ code: "approval_required" });
    const mgr = await issueStoreCredit({ ...base, accountId: randomUUID(), amountCents: 2500, role: "manager", actor: ACTOR });
    expect(mgr.account.balance_cents).toBe(2500);
  });
});

describe("card refunds on gift card sales (no crash window)", () => {
  async function cardPaidSale(amount: number) {
    const sale = await createGiftCardSale({
      tenantId: TENANT, locationId: LOCATION, orderId: randomUUID(), amountCents: amount, channel: "in_store", currency: "USD",
    });
    const now = new Date().toISOString();
    const p = await getPosDriver().upsertPayment({
      id: randomUUID(), order_id: sale.order.id, tenant_id: TENANT, location_id: LOCATION, rail: "stripe_terminal",
      status: "captured", amount_cents: amount, tip_cents: 0, application_fee_cents: 0, currency: "USD",
      charge_id: `sim_pi_${randomUUID()}`, connect_account_id: "acct_sim_1", crypto_tx_hash: null, crypto_chain: null,
      cash_tendered_cents: null, cash_change_cents: null, refunded_cents: 0, simulated: true, raw: null,
      created_at: now, updated_at: now,
    });
    await settleStoredValueOrder(sale.order.id);
    return { sale, p };
  }

  it("a voided card's card-paid sale refund is reserved pending, then Stripe, then confirmed with the re_ id", async () => {
    const { sale, p } = await cardPaidSale(3000);
    expect((await account(sale.account.id)).status).toBe("active");
    const driver = getPosDriver();
    const order: string[] = [];
    const rail = requirePaymentRail("stripe_terminal");
    const railSpy = vi.spyOn(rail, "refund").mockImplementation(async (r) => {
      order.push("rail");
      return { refundId: "re_sim_1", status: "refunded", amount: r.amount! };
    });
    const reserveSpy = vi.spyOn(driver, "reservePaymentRefund");
    reserveSpy.mockImplementation(async (...args) => {
      order.push("reserve");
      reserveSpy.mockRestore();
      return driver.reservePaymentRefund(...args);
    });
    await voidStoredValue({ tenantId: TENANT, accountId: sale.account.id, locationId: LOCATION, reason: "x", actor: ACTOR });
    railSpy.mockRestore();
    expect(order).toEqual(["reserve", "rail"]);
    expect((await driver.getPayment(p.id))!.refunds?.[0]).toMatchObject({
      processor_ref: "re_sim_1",
      state: "succeeded",
    });
  });

  it("a replayed card refund with no provider id calls the rail again with the same key and records the id", async () => {
    const { p } = await cardPaidSale(3000);
    const driver = getPosDriver();
    // A duplicate card tender: refunding one is EXCESS money (reserve-first path).
    const dup = await driver.upsertPayment({ ...p, id: randomUUID() });
    // Simulate the crash: reserved, then the process died before the Stripe call.
    await driver.reservePaymentRefund(dup.id, 3000, "r-crash", { reason: null });
    expect((await driver.getPayment(dup.id))!.refunds?.[0]?.processor_ref).toBeNull();
    const rail = requirePaymentRail("stripe_terminal");
    const railSpy = vi.spyOn(rail, "refund").mockResolvedValue({
      refundId: "re_late", status: "refunded", amount: { amount: 3000, currency: "USD" },
    });
    const out = await refundPayment({ paymentId: dup.id, refundId: "r-crash" });
    expect(out?.replayed).toBe(true);
    expect(railSpy).toHaveBeenCalledTimes(1);
    expect(railSpy.mock.calls[0]![0].context.idempotencyKey).toBe(`refund_${dup.id}_r-crash`);
    expect((await driver.getPayment(dup.id))!.refunds?.[0]?.processor_ref).toBe("re_late");
    // A second replay does nothing more.
    await refundPayment({ paymentId: dup.id, refundId: "r-crash" });
    expect(railSpy).toHaveBeenCalledTimes(1);
    railSpy.mockRestore();
  });
});

describe("store credit daily cap: per staff member, per business day", () => {
  it("finds the location's business-day start (time zone + cutoff, DST-aware)", () => {
    const ny = { timezone: "America/New_York", business_day_cutoff_minutes: 0 };
    expect(businessDayStartIso(ny, new Date("2026-03-10T16:00:00Z"))).toBe("2026-03-10T04:00:00.000Z");
    const late = { ...ny, business_day_cutoff_minutes: 240 };
    expect(businessDayStartIso(late, new Date("2026-03-10T16:00:00Z"))).toBe("2026-03-10T08:00:00.000Z");
    expect(businessDayStartIso(late, new Date("2026-03-10T06:00:00Z"))).toBe("2026-03-09T08:00:00.000Z");
    expect(businessDayStartIso(null, new Date("2026-03-10T16:00:00Z"))).toBe("2026-03-10T00:00:00.000Z");
  });

  it("counts against the PIN-switched staff member, and resets at the business-day start", async () => {
    const base = { tenantId: TENANT, locationId: LOCATION, reason: "late", currency: "USD", role: "cashier", actor: ACTOR };
    const today = new Date(Date.now() - 60_000).toISOString();
    const issue = (capActorId: string, dayStartIso = today, amountCents = 2500) =>
      issueStoreCredit({ ...base, accountId: randomUUID(), amountCents, capActorId, dayStartIso });
    for (let i = 0; i < 4; i += 1) await issue("staff-a");
    await expect(issue("staff-a", today, 100)).rejects.toMatchObject({ code: "approval_required" });
    // The same device login, another staff member: their own cap.
    await expect(issue("staff-b")).resolves.toMatchObject({ replayed: false });
    // A new business day: staff A starts again.
    const tomorrow = new Date(Date.now() + 1000).toISOString();
    await expect(issue("staff-a", tomorrow)).resolves.toMatchObject({ replayed: false });
  });
});
