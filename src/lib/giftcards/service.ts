/**
 * Stored-value service (server-only): selling, reloading, checking, redeeming,
 * voiding gift cards, and issuing store credit. Persistence + every money check
 * is in the atomic writers (`getStoredValueStore()`); this layer validates
 * input, builds the sale orders and wires the outcomes into the payment flow.
 *
 * SALES. A sale (or reload) is an ORDER with no menu lines, total = the amount,
 * tax 0, marked `core_ext.stored_value`. It is paid like any other order
 * (cash/card at the till, the online card rail on the storefront). When it
 * settles, `settleStoredValueOrder` (called by the payment service once the
 * order is paid) credits the card, idempotently, and closes the order as
 * `completed`. The card stays `pending` (unusable) until then.
 *
 * REDEMPTION. `redeemStoredValue` debits the card and writes a `gift_card` /
 * `store_credit` tender in ONE transaction, never more than the card holds or
 * the order still owes, then settles the order like any tender. Refunding that
 * tender (POST /api/payments/refund) credits the card back through the rail.
 *
 * VOIDS. A sold card may be voided (and its sale refunded) only while
 * UNREDEEMED. A sale order's tenders cannot be refunded any other way
 * (`assertStoredValueRefundAllowed`), so the card and the money can never both
 * survive a refund.
 */
import { getPosDriver, type Order, type OrderFulfillment, type Payment } from "@/lib/db";
import { locationBusinessDate, type LocationClock } from "@/lib/reports";
import { captureError } from "@/lib/observability";
import { deploymentCheckoutMode } from "@/lib/payments/env";
import {
  RefundExceedsError,
  refundPayment,
  settleOrderAfterExternalTender,
} from "@/lib/payments/service";
import { recordAudit } from "@/lib/security/audit";
import {
  codeLast4,
  deriveCode,
  formatCode,
  generateCode,
  hashCode,
  normalizeCode,
} from "./codes";
import { deliverGiftCard } from "./deliver";
import { redeemableCents } from "./ledger";
import {
  GIFT_CARD_MAX_BALANCE_CENTS,
  storeCreditApprovalThresholdCents,
  storeCreditDailyCapCents,
  validLoadAmount,
  validStoreCreditAmount,
} from "./limits";
import { isSettled, remainingCents } from "./order-math";
import { getStoredValueStore, type IssueStoreCreditOutcome } from "./store";
import type {
  LedgerEntry,
  MutationFailure,
  RedeemFailure,
  StoredValueAccount,
  StoredValueOrderExt,
} from "./types";

/** A refused stored-value operation, with a staff/customer-safe message. */
export class StoredValueError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = "StoredValueError";
  }
}

/**
 * Refunding a tender of a gift-card SALE whose card is still live. Subclasses
 * RefundExceedsError so the refund endpoint answers 409 (not 502) unchanged.
 */
export class StoredValueRefundBlockedError extends RefundExceedsError {
  constructor() {
    super();
    this.message =
      "This payment bought a gift card. Void the gift card first (only an unredeemed card can be refunded).";
    this.name = "StoredValueRefundBlockedError";
  }
}

const FAILURE_COPY: Record<MutationFailure | RedeemFailure, string> = {
  not_found: "Gift card not found.",
  order_not_found: "Order not found.",
  inactive: "This card is not active.",
  insufficient: "Not enough balance on this card.",
  exceeds_max: "That would take the card over its maximum balance.",
  exceeds_due: "That is more than the order still owes.",
  not_settled: "The sale has not been paid yet.",
  has_activity: "This card has been used, so it can no longer be voided.",
  bad_amount: "Enter an amount greater than zero.",
  order_not_payable: "This order cannot be paid with a gift card.",
  currency: "This card is in a different currency.",
  conflict: "That payment id was already used.",
};

function fail(reason: MutationFailure | RedeemFailure): StoredValueError {
  return new StoredValueError(reason, FAILURE_COPY[reason]);
}

function nowIso(): string {
  return new Date().toISOString();
}

export function storedValueExt(order: Pick<Order, "core_ext"> | null | undefined): StoredValueOrderExt | null {
  return order?.core_ext?.stored_value ?? null;
}

/** Staff/customer-safe view of an account (no hashes; there are no codes). */
export interface AccountView {
  id: string;
  kind: StoredValueAccount["kind"];
  status: StoredValueAccount["status"];
  currency: string;
  balance_cents: number;
  code_last4: string;
}

export function accountView(a: StoredValueAccount): AccountView {
  return {
    id: a.id,
    kind: a.kind,
    status: a.status,
    currency: a.currency,
    balance_cents: a.balance_cents,
    code_last4: a.code_last4,
  };
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * The account a code names in `tenantId`, or null (unknown or malformed). A
 * `pending` card whose sale has settled is activated on the way (recovery for a
 * crashed settlement hook).
 */
export async function findAccountByCode(
  tenantId: string,
  rawCode: unknown,
  opts: { anonymous?: boolean } = {},
): Promise<StoredValueAccount | null> {
  const code = normalizeCode(rawCode);
  if (!code) return null;
  const store = await getStoredValueStore();
  const account = await store.findByCodeHash(tenantId, hashCode(tenantId, code));
  if (!account) return null;
  // Pre-printed card numbers are low entropy: usable at the till only, never
  // from an anonymous storefront lookup (reported as unknown, like a guess).
  if (opts.anonymous && account.physical) return null;
  if (account.status === "pending" && account.sale_order_id) {
    await settleStoredValueOrder(account.sale_order_id).catch((err) =>
      captureError(err, { scope: "giftcard-lazy-activate", accountId: account.id }),
    );
    return (await store.getAccount(tenantId, account.id)) ?? account;
  }
  return account;
}

// ---------------------------------------------------------------------------
// Sell / reload
// ---------------------------------------------------------------------------

export interface SaleInput {
  tenantId: string;
  locationId: string;
  /** Client UUID: the sale order id (a retry returns the same sale). */
  orderId: string;
  amountCents: number;
  channel: "in_store" | "online";
  /** A pre-printed physical card number (till only); else a code is generated. */
  physicalCode?: string | null;
  recipientName?: string | null;
  recipientEmail?: string | null;
  customerId?: string | null;
  staffId?: string | null;
  actorId?: string | null;
  currency: string;
}

export interface SaleResult {
  order: Order;
  account: AccountView;
  /**
   * The code to hand over, formatted, shown ONCE. Null for a physical card (the
   * customer holds it) and for a replayed till sale (a generated code is never
   * stored, so it cannot be shown again).
   */
  code: string | null;
  replayed: boolean;
}

function saleTotals(amountCents: number): Order["totals"] {
  // No menu lines and NO TAX: a gift card sale is a liability, not a sale.
  return {
    subtotal_cents: 0,
    discount_cents: 0,
    taxable_cents: 0,
    tax_cents: 0,
    tip_cents: 0,
    total_cents: amountCents,
  };
}

function onlineFulfillment(): OrderFulfillment {
  // Online orders settle through finalizeOnlinePayment, which needs a
  // fulfillment. A gift card has nothing to cook or deliver: a pickup "now".
  const now = nowIso();
  return {
    type: "pickup",
    scheduled_for: now,
    promised_at: now,
    checkout_mode: deploymentCheckoutMode(),
  };
}

async function replaySale(
  existing: Order,
  input: Pick<SaleInput, "tenantId" | "channel">,
): Promise<SaleResult> {
  const ext = storedValueExt(existing);
  if (!ext || existing.tenant_id !== input.tenantId) {
    throw new StoredValueError("conflict", "That order id is already used.");
  }
  const store = await getStoredValueStore();
  const account = await store.getAccount(input.tenantId, ext.account_id);
  if (!account) throw fail("not_found");
  // A replay NEVER returns the code: it is shown once at creation, and online
  // buyers get it once more through the signed one-time reveal (revealOnlineCode).
  return { order: existing, account: accountView(account), code: null, replayed: true };
}

/**
 * The buyer's one-time reveal of an ONLINE card's code after paying. The caller
 * must already have verified the buyer's signed reveal token for this order.
 * Returns null when the card is not active yet (keep waiting) and throws
 * `already_revealed` the second time.
 */
export async function revealOnlineCode(
  tenantId: string,
  orderId: string,
): Promise<{ code: string; account: AccountView } | null> {
  const order = await getPosDriver().getOrder(orderId);
  const ext = storedValueExt(order);
  if (!order || order.tenant_id !== tenantId || !ext || ext.op !== "sell") {
    throw new StoredValueError("not_found", "Gift card not found.", 404);
  }
  const store = await getStoredValueStore();
  let account = await store.getAccount(tenantId, ext.account_id);
  if (account?.status === "pending") {
    await settleStoredValueOrder(order.id);
    account = await store.getAccount(tenantId, ext.account_id);
  }
  if (!account || account.source !== "online" || account.physical) {
    throw new StoredValueError("not_found", "Gift card not found.", 404);
  }
  if (account.status !== "active") return null;
  if (!(await store.markCodeRevealed(tenantId, account.id))) {
    throw new StoredValueError("already_revealed", "This code was already shown.", 410);
  }
  return { code: formatCode(deriveCode(account.id)), account: accountView(account) };
}

/** Create a gift card SALE: a pending card plus its unpaid, untaxed order. */
export async function createGiftCardSale(input: SaleInput): Promise<SaleResult> {
  if (!validLoadAmount(input.amountCents)) {
    throw new StoredValueError("bad_amount", "Gift card amount is outside the allowed range.", 422);
  }
  const driver = getPosDriver();
  const existing = await driver.getOrder(input.orderId);
  if (existing) return replaySale(existing, input);

  let physical = false;
  let code: string;
  const accountId = globalThis.crypto.randomUUID();
  if (input.physicalCode) {
    if (input.channel !== "in_store") {
      throw new StoredValueError("bad_code", "Card numbers are entered at the till.", 422);
    }
    const n = normalizeCode(input.physicalCode);
    if (!n) throw new StoredValueError("bad_code", "Enter a 12 to 32 character card number.", 422);
    code = n;
    physical = true;
  } else {
    code = input.channel === "online" ? deriveCode(accountId) : generateCode();
  }

  const store = await getStoredValueStore();
  const hash = hashCode(input.tenantId, code);
  if (await store.findByCodeHash(input.tenantId, hash)) {
    // A physical number already registered (a generated 80-bit code never collides).
    throw new StoredValueError("code_taken", "That card number is already registered.");
  }

  const last4 = codeLast4(code);
  const ext: StoredValueOrderExt = {
    op: "sell",
    account_id: accountId,
    amount_cents: input.amountCents,
    code_last4: last4,
  };
  const order = await driver.createOrder({
    id: input.orderId,
    tenant_id: input.tenantId,
    location_id: input.locationId,
    channel: input.channel === "online" ? "online_pickup" : "in_store",
    currency: input.currency,
    items: [],
    discount_cents: 0,
    totals: saleTotals(input.amountCents),
    notes: `Gift card ••••${last4}`,
    status: input.channel === "online" ? "awaiting_payment" : "draft",
    customer_id: input.customerId ?? null,
    staff_id: input.staffId ?? null,
    ...(input.channel === "online" ? { fulfillment: onlineFulfillment() } : {}),
    core_ext: { stored_value: ext },
  });

  const created = await store.createAccount({
    id: accountId,
    tenant_id: input.tenantId,
    kind: "gift_card",
    status: "pending",
    currency: input.currency,
    code_hash: hash,
    code_last4: last4,
    physical,
    customer_id: input.customerId ?? null,
    recipient_name: input.recipientName ?? null,
    recipient_email: input.recipientEmail ?? null,
    sale_order_id: order.id,
    source: input.channel === "online" ? "online" : "till",
    created_by: input.actorId ?? null,
  });
  if (!created.ok) {
    // Lost a race on a physical card number: give the unpaid sale up.
    await driver.transitionOrderStatus(order.id, ["draft", "awaiting_payment"], "voided");
    throw new StoredValueError("code_taken", "That card number is already registered.");
  }
  return {
    order,
    account: accountView(created.account),
    code: physical ? null : formatCode(code),
    replayed: false,
  };
}

export interface ReloadInput {
  tenantId: string;
  locationId: string;
  orderId: string;
  code: string;
  amountCents: number;
  staffId?: string | null;
  currency: string;
}

/** Create a RELOAD: an unpaid, untaxed order that loads an active gift card. */
export async function createGiftCardReload(
  input: ReloadInput,
): Promise<{ order: Order; account: AccountView; replayed: boolean }> {
  if (!validLoadAmount(input.amountCents)) {
    throw new StoredValueError("bad_amount", "Reload amount is outside the allowed range.", 422);
  }
  const driver = getPosDriver();
  const existing = await driver.getOrder(input.orderId);
  if (existing) {
    const r = await replaySale(existing, { tenantId: input.tenantId, channel: "in_store" });
    return { order: r.order, account: r.account, replayed: true };
  }
  const account = await findAccountByCode(input.tenantId, input.code);
  if (!account) throw fail("not_found");
  if (account.kind !== "gift_card") {
    throw new StoredValueError("not_reloadable", "Store credit cannot be reloaded.");
  }
  if (account.status !== "active") throw fail("inactive");
  if (account.currency.toUpperCase() !== input.currency.toUpperCase()) throw fail("currency");
  if (account.balance_cents + input.amountCents > GIFT_CARD_MAX_BALANCE_CENTS) throw fail("exceeds_max");

  const order = await driver.createOrder({
    id: input.orderId,
    tenant_id: input.tenantId,
    location_id: input.locationId,
    channel: "in_store",
    currency: input.currency,
    items: [],
    discount_cents: 0,
    totals: saleTotals(input.amountCents),
    notes: `Gift card reload ••••${account.code_last4}`,
    status: "draft",
    staff_id: input.staffId ?? null,
    core_ext: {
      stored_value: {
        op: "reload",
        account_id: account.id,
        amount_cents: input.amountCents,
        code_last4: account.code_last4,
      },
    },
  });
  return { order, account: accountView(account), replayed: false };
}

/**
 * The settlement hook: a stored-value sale/reload order is paid, so credit the
 * card (idempotent on the order) and close the order. Safe to call any number
 * of times, for any order (a non stored-value order is ignored). The writer
 * re-checks under its lock that the order's settled money covers it.
 */
export async function settleStoredValueOrder(orderId: string): Promise<void> {
  const driver = getPosDriver();
  const order = await driver.getOrder(orderId);
  const ext = storedValueExt(order);
  if (!order || !ext) return;
  if (!isSettled(order, await driver.listPaymentsForOrder(order.id))) return;

  const store = await getStoredValueStore();
  const result = await store.credit({
    tenantId: order.tenant_id,
    accountId: ext.account_id,
    locationId: order.location_id,
    kind: ext.op === "sell" ? "issue" : "load",
    amountCents: ext.amount_cents,
    key: `sale:${order.id}`,
    orderId: order.id,
    activate: ext.op === "sell",
    requireSettledOrderId: order.id,
    maxBalanceCents: GIFT_CARD_MAX_BALANCE_CENTS,
    actorId: order.staff_id ?? null,
  });
  if (!result.ok) {
    if (result.reason === "not_settled") return;
    // Paid, but the card refused the money (voided meanwhile, over the cap):
    // the customer is owed a refund. Alert; the sale's tenders may be refunded
    // (the card holds none of it).
    captureError(new Error(`stored value sale paid but not credited: ${result.reason}`), {
      scope: "giftcard-settle",
      orderId: order.id,
      accountId: ext.account_id,
    });
    return;
  }
  await driver.transitionOrderStatus(order.id, ["paid"], "completed");
  if (!result.replayed && ext.op === "sell" && result.account.source === "online") {
    await deliverGiftCard({
      account: result.account,
      code: formatCode(deriveCode(result.account.id)),
      amountCents: ext.amount_cents,
      currency: result.account.currency,
    }).catch((err) => captureError(err, { scope: "giftcard-deliver", accountId: result.account.id }));
  }
}

// ---------------------------------------------------------------------------
// Redeem
// ---------------------------------------------------------------------------

export interface RedeemRequest {
  order: Order;
  account: StoredValueAccount;
  paymentId: string;
  /** Requested amount; omitted = as much as the card covers. */
  amountCents?: number | null;
  actorId: string | null;
  staffId: string | null;
}

/** Debit the card + write the tender (atomic), then settle the order. */
export async function redeemStoredValue(
  req: RedeemRequest,
): Promise<{ payment: Payment; account: AccountView; replayed: boolean }> {
  const driver = getPosDriver();
  const store = await getStoredValueStore();

  // A retry of a tender that already landed: return it unchanged.
  const prior = await driver.getPayment(req.paymentId);
  if (!prior) {
    if (req.account.status !== "active") throw fail("inactive");
    const remaining = remainingCents(req.order, await driver.listPaymentsForOrder(req.order.id));
    const amount = redeemableCents(req.account.balance_cents, remaining, req.amountCents);
    if (req.amountCents != null && req.amountCents > req.account.balance_cents) throw fail("insufficient");
    if (req.amountCents != null && req.amountCents > remaining) throw fail("exceeds_due");
    if (amount <= 0) {
      throw remaining <= 0
        ? new StoredValueError("nothing_due", "This order has nothing left to pay.")
        : fail(req.account.balance_cents <= 0 ? "insufficient" : "bad_amount");
    }
    req = { ...req, amountCents: amount };
  }

  const result = await store.redeem({
    tenantId: req.order.tenant_id,
    accountId: req.account.id,
    orderId: req.order.id,
    paymentId: req.paymentId,
    amountCents: req.amountCents ?? prior?.amount_cents ?? 0,
    actorId: req.actorId,
    staffId: req.staffId,
  });
  if (!result.ok) throw fail(result.reason);
  const payment = await driver.getPayment(result.paymentId);
  if (!payment) throw new Error("stored value tender missing after redeem");
  if (!result.replayed) await settleOrderAfterExternalTender(payment);
  return { payment, account: accountView(result.account), replayed: result.replayed };
}

/** Give one stored-value tender back to its card (idempotent: fixed refund id). */
export async function releaseStoredValueTender(paymentId: string): Promise<void> {
  await refundPayment({
    paymentId,
    refundId: `release_${paymentId}`,
    reason: "Not used: returned to card",
  }).catch((err) => captureError(err, { scope: "giftcard-release", paymentId }));
}

/**
 * Online checkout gives up an order (cancel / expiry): every stored-value
 * tender on it goes back to its card. Idempotent (the refund id is fixed per
 * tender, and a refunded tender is skipped).
 */
export async function releaseStoredValueTenders(orderId: string): Promise<void> {
  const payments = await getPosDriver().listPaymentsForOrder(orderId);
  for (const p of payments) {
    if (p.rail !== "gift_card" && p.rail !== "store_credit") continue;
    if (p.status !== "captured" || p.refunded_cents >= p.amount_cents + p.tip_cents) continue;
    await refundPayment({
      paymentId: p.id,
      refundId: `release_${p.id}`,
      reason: "Checkout canceled: returned to card",
    }).catch((err) =>
      captureError(err, { scope: "giftcard-release", orderId, paymentId: p.id }),
    );
  }
}

/** Release sweep batch size and the per-run page cap (the next run continues). */
const RELEASE_PAGE = 100;
const RELEASE_MAX_PAGES = 20;

/**
 * Sweep: an abandoned online checkout that STILL holds a captured stored-value
 * tender (a release that failed or never ran) gets it released again. The
 * target set is queried directly (newest first, keyset-batched); the refund id
 * is fixed per tender (`release_<id>`), so this is idempotent with the release
 * that ran at abandonment. Returns how many orders it released.
 */
export async function sweepUnreleasedStoredValue(): Promise<number> {
  const store = await getStoredValueStore();
  let released = 0;
  let before: { created_at: string; id: string } | null = null;
  for (let page = 0; page < RELEASE_MAX_PAGES; page += 1) {
    const batch = await store.listUnreleasedOrders(RELEASE_PAGE, before);
    for (const o of batch) {
      await releaseStoredValueTenders(o.id);
      released += 1;
    }
    if (batch.length < RELEASE_PAGE) break;
    before = batch[batch.length - 1]!;
  }
  return released;
}

// ---------------------------------------------------------------------------
// Refund guard (called by refundPayment)
// ---------------------------------------------------------------------------

/**
 * refundPayment's policy for a tender, decided BEFORE any money moves:
 *  - null: not a gift-card sale/reload tender (normal rules);
 *  - "released": the value it bought already left the card (voided, reload
 *    reversed, never credited): refund normally (card rails Stripe-first with
 *    the fixed idempotency key, then record), no crash window;
 *  - "excess": the order would still hold the card's value without it (a
 *    duplicate tender): reserve first, re-check (assertStoredValueRefundAllowed)
 *    after the atomic reservation, then call the rail.
 * Throws StoredValueRefundBlockedError while the card still holds the value.
 */
export async function storedValueSaleRefundMode(
  payment: Payment,
  refundCents: number,
): Promise<"released" | "excess" | null> {
  const driver = getPosDriver();
  const order = await driver.getOrder(payment.order_id);
  const ext = storedValueExt(order);
  if (!order || !ext) return null;
  if (await valueLeftCard(order, ext)) return "released";
  const held = heldCents(await driver.listPaymentsForOrder(order.id));
  if (held - refundCents >= ext.amount_cents) return "excess";
  throw new StoredValueRefundBlockedError();
}

function heldCents(payments: Payment[]): number {
  // Pending (card / stored value) refund reservations already hold their room:
  // they count as gone, so two racing "excess" refunds can never both pass.
  return payments
    .filter((p) => p.status === "captured" || p.status === "authorized" || p.status === "refunded")
    .reduce(
      (n, p) =>
        n +
        Math.max(0, p.amount_cents + p.tip_cents - p.refunded_cents - (p.refund_reserved_cents ?? 0)),
      0,
    );
}

/** The value a sale/reload order bought is no longer on the card (or never was). */
async function valueLeftCard(order: Order, ext: StoredValueOrderExt): Promise<boolean> {
  const store = await getStoredValueStore();
  const ledger = await store.listLedger(order.tenant_id, ext.account_id);
  if (!ledger.some((e) => e.idempotency_key === `sale:${order.id}`)) return true;
  if (ext.op === "sell") {
    const account = await store.getAccount(order.tenant_id, ext.account_id);
    return !account || account.status === "voided";
  }
  return ledger.some((e) => e.idempotency_key === `reverse:${order.id}`);
}

/**
 * A tender of a stored-value SALE/RELOAD order may be refunded only once the
 * value it bought has left the card (the card voided / the reload reversed /
 * never credited), or when it is EXCESS money (the order still holds the card's
 * value without it).
 *
 * Called by refundPayment AFTER the refund was reserved (atomically) and
 * before any money moves, so the order's tenders already show this refund and
 * every concurrent one reserved before it: of two racing "excess" refunds the
 * later check sees both, so they can never both pass. On a throw the caller
 * releases its reservation.
 */
export async function assertStoredValueRefundAllowed(payment: Payment): Promise<void> {
  const driver = getPosDriver();
  const order = await driver.getOrder(payment.order_id);
  const ext = storedValueExt(order);
  if (!order || !ext) return;
  if (heldCents(await driver.listPaymentsForOrder(order.id)) >= ext.amount_cents) return; // excess
  if (await valueLeftCard(order, ext)) return;
  throw new StoredValueRefundBlockedError();
}

// ---------------------------------------------------------------------------
// Void / reverse
// ---------------------------------------------------------------------------

export interface Actor {
  id: string;
  label: string;
}

async function refundOrderTenders(order: Order, refundId: string, reason: string) {
  const payments = await getPosDriver().listPaymentsForOrder(order.id);
  const out: { paymentId: string; refundedCents: number; manual: boolean }[] = [];
  for (const p of payments) {
    if (p.status !== "captured" && p.status !== "authorized") continue;
    if (p.refunded_cents >= p.amount_cents + p.tip_cents) continue;
    const r = await refundPayment({ paymentId: p.id, refundId, reason });
    if (r) {
      out.push({
        paymentId: p.id,
        refundedCents: r.refundedNowCents ?? 0,
        manual: r.manualRefund === true,
      });
    }
  }
  return out;
}

/**
 * Void a card. Gift card: only while UNREDEEMED; its sale's tenders are then
 * refunded (cash back from the drawer, card back through Stripe). An unpaid
 * (pending) card is simply closed with its sale order. Store credit: only while
 * unredeemed; there is no money to return.
 */
export async function voidStoredValue(input: {
  tenantId: string;
  accountId: string;
  locationId: string | null;
  reason: string;
  actor: Actor;
}): Promise<{
  account: AccountView;
  refunds: { paymentId: string; refundedCents: number; manual: boolean }[];
}> {
  const driver = getPosDriver();
  const store = await getStoredValueStore();
  const account = await store.getAccount(input.tenantId, input.accountId);
  if (!account) throw fail("not_found");
  const sale = account.sale_order_id ? await driver.getOrder(account.sale_order_id) : null;

  if (account.status === "pending" && sale) {
    const live = (await driver.listPaymentsForOrder(sale.id)).some(
      (p) => p.status === "pending" || p.status === "authorized" || p.status === "captured",
    );
    if (live) {
      throw new StoredValueError("payment_in_progress", "A payment for this card is in progress. Refresh and try again.");
    }
  }

  const voided = await store.voidAccount({
    tenantId: input.tenantId,
    accountId: input.accountId,
    locationId: input.locationId,
    key: `void:${input.accountId}`,
    reason: input.reason,
    actorId: input.actor.id,
  });
  if (!voided.ok) throw fail(voided.reason);

  let refunds: Awaited<ReturnType<typeof refundOrderTenders>> = [];
  if (sale) {
    // Decided by the MONEY, not the order status: any settled tender is refunded.
    const settled = (await driver.listPaymentsForOrder(sale.id)).some(
      (p) => p.status === "captured" || p.status === "authorized",
    );
    if (settled) {
      refunds = await refundOrderTenders(sale, `gcvoid_${account.id}`, `Gift card voided: ${input.reason}`);
    } else if (sale.status === "draft" || sale.status === "awaiting_payment") {
      await driver.transitionOrderStatus(sale.id, ["draft", "awaiting_payment"], "voided");
    }
  }
  if (!voided.replayed) {
    await recordAudit({
      actor: input.actor,
      action: "gift_card_void",
      tenantId: input.tenantId,
      detail: `Voided ${account.kind === "gift_card" ? "gift card" : "store credit"} ••••${account.code_last4} (${voided.entry ? -voided.entry.amount_cents : 0}c removed${refunds.length ? `, ${refunds.reduce((n, r) => n + r.refundedCents, 0)}c refunded` : ""}): ${input.reason}`,
    });
  }
  return { account: accountView(voided.account), refunds };
}

/** Refund a paid RELOAD: take its amount back off the card, then refund it. */
export async function reverseReload(input: {
  tenantId: string;
  orderId: string;
  reason: string;
  actor: Actor;
}): Promise<{ account: AccountView; refunds: { paymentId: string; refundedCents: number; manual: boolean }[] }> {
  const driver = getPosDriver();
  const order = await driver.getOrder(input.orderId);
  const ext = storedValueExt(order);
  if (!order || order.tenant_id !== input.tenantId || !ext || ext.op !== "reload") {
    throw new StoredValueError("not_found", "Reload not found.", 404);
  }
  const store = await getStoredValueStore();
  const ledger = await store.listLedger(input.tenantId, ext.account_id);
  if (!ledger.some((e) => e.idempotency_key === `sale:${order.id}`)) {
    throw new StoredValueError("not_settled", "This reload was never added to the card.");
  }
  const debited = await store.debit({
    tenantId: input.tenantId,
    accountId: ext.account_id,
    locationId: order.location_id,
    kind: "reverse",
    amountCents: ext.amount_cents,
    key: `reverse:${order.id}`,
    orderId: order.id,
    reason: input.reason,
    actorId: input.actor.id,
  });
  if (!debited.ok) throw fail(debited.reason);
  const refunds = await refundOrderTenders(order, `gcreverse_${order.id}`, `Gift card reload refunded: ${input.reason}`);
  if (!debited.replayed) {
    await recordAudit({
      actor: input.actor,
      action: "gift_card_void",
      tenantId: input.tenantId,
      detail: `Refunded a ${ext.amount_cents}c reload on gift card ••••${ext.code_last4}: ${input.reason}`,
    });
  }
  return { account: accountView(debited.account), refunds };
}

// ---------------------------------------------------------------------------
// Store credit
// ---------------------------------------------------------------------------

/**
 * The instant the location's current business day began (its time zone and
 * business-day cutoff, same rule as the reports): the earliest instant with
 * today's business date, found by a minute-precision search over the last 48 h.
 */
export function businessDayStartIso(
  loc: LocationClock | null | undefined,
  now: Date = new Date(),
): string {
  const today = locationBusinessDate(now.toISOString(), loc);
  let lo = now.getTime() - 48 * 60 * 60_000; // a different business date
  let hi = now.getTime(); // today
  while (hi - lo > 60_000) {
    const mid = Math.floor((lo + hi) / 2);
    if (locationBusinessDate(new Date(mid).toISOString(), loc) === today) hi = mid;
    else lo = mid;
  }
  return new Date(hi - (hi % 60_000)).toISOString();
}

export interface IssueStoreCreditInput {
  tenantId: string;
  locationId: string | null;
  /** Client UUID: the new account id (a retry returns the same credit). */
  accountId: string;
  amountCents: number;
  reason: string;
  customerId?: string | null;
  /** The role that authorizes it (the active PIN staff, else the device login). */
  role: string;
  /**
   * Whose daily cap it counts against: the PIN-switched staff member, else the
   * device login. Recorded as the ledger actor. Defaults to `actor.id`.
   */
  capActorId?: string;
  /** Start of the location's business day (default: the UTC day). */
  dayStartIso?: string;
  actor: Actor;
  currency: string;
}

/**
 * Issue store credit (e.g. instead of a refund). Above the approval threshold
 * an owner/manager must be the one issuing it (`approved_by` records them).
 */
export async function issueStoreCredit(
  input: IssueStoreCreditInput,
): Promise<{ account: AccountView; code: string | null; replayed: boolean; entry: LedgerEntry | null }> {
  if (!validStoreCreditAmount(input.amountCents)) {
    throw new StoredValueError("bad_amount", "Store credit amount is outside the allowed range.", 422);
  }
  const reason = input.reason.trim();
  if (!reason) throw new StoredValueError("reason_required", "A reason is required.", 422);
  const manager = input.role === "owner" || input.role === "manager";
  if (input.amountCents > storeCreditApprovalThresholdCents() && !manager) {
    throw new StoredValueError(
      "approval_required",
      "Store credit above the limit needs a manager. Switch to a manager to issue it.",
      403,
    );
  }

  const store = await getStoredValueStore();
  // Create + credit in ONE atomic write (sv_issue_store_credit), which also
  // enforces the per-staff daily cap for non-managers.
  let code = "";
  let out: IssueStoreCreditOutcome = { outcome: "code_taken" };
  for (let attempt = 0; attempt < 2 && out.outcome === "code_taken"; attempt += 1) {
    code = generateCode(); // an 80-bit collision is not a real event: one retry
    out = await store.issueStoreCredit({
      tenantId: input.tenantId,
      accountId: input.accountId,
      locationId: input.locationId,
      currency: input.currency,
      codeHash: hashCode(input.tenantId, code),
      codeLast4: codeLast4(code),
      customerId: input.customerId ?? null,
      amountCents: input.amountCents,
      reason,
      actorId: input.capActorId ?? input.actor.id,
      isManager: manager,
      dailyCapCents: storeCreditDailyCapCents(),
      dayStartIso: input.dayStartIso ?? `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`,
    });
  }
  if (out.outcome === "replayed") {
    return { account: accountView(out.account), code: null, replayed: true, entry: null };
  }
  if (out.outcome === "approval_required") {
    throw new StoredValueError(
      "approval_required",
      "That is over your store credit limit for today. Switch to a manager to issue it.",
      403,
    );
  }
  if (out.outcome !== "ok") throw fail(out.outcome === "bad_amount" ? "bad_amount" : "conflict");
  const credited = out;
  await recordAudit({
    actor: input.actor,
    action: "store_credit_issue",
    tenantId: input.tenantId,
    detail: `Issued ${input.amountCents}c store credit ••••${credited.account.code_last4}${input.customerId ? ` to customer ${input.customerId}` : ""}: ${reason}`,
  });
  return {
    account: accountView(credited.account),
    code: formatCode(code),
    replayed: false,
    entry: credited.entry,
  };
}
