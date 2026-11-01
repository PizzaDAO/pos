/**
 * `/v1` payment sessions: hosted pay links (Stripe Checkout on the tenant's
 * CONNECTED account, direct charge) for held orders.
 *
 *   POST /orders/{id}/payment-sessions   createPaymentSession
 *   GET  /payment-sessions/{id}          getPaymentSession
 *   GET  /payments/account               getPaymentsAccount
 *
 * Money model: every session has exactly one `stripe_online` tender, created
 * WITH the session (status `requires_action`, `charge_id` null). Stripe creates
 * the PaymentIntent only when the payer confirms, so capture arrives through the
 * existing `payment_intent.succeeded` webhook, matched by the tender id carried
 * in `payment_intent_data.metadata.payment_id`; the webhook then also records the
 * PaymentIntent id as `charge_id` (refunds need it). `getPaymentSession` and the
 * sweeper re-read the Checkout Session as the reconcile path.
 *
 * ---------------------------------------------------------------------------
 * SAFETY GATE (the reason this file exists in this shape)
 * ---------------------------------------------------------------------------
 * `assertSessionChargeAllowed` runs BEFORE any tender row is written and before
 * any Stripe call. It is a POSITIVE match, never "not live":
 *
 *   simulated   `cardRailsSimulated()` (no key, TRAINING_MODE, or mock driver)
 *               -> a local simulated session, no Stripe call, ever.
 *   test        key starts `sk_test_` / `rk_test_`        -> real Stripe test mode.
 *   live        key starts `sk_live_` / `rk_live_`        -> 501, unless the tenant
 *               is on `V1_LIVE_SESSION_TENANTS` (comma list, EMPTY by default; the
 *               demo tenant is refused even if listed).
 *   unknown     any other key shape                       -> 501, always.
 *
 * It deliberately does NOT use `deploymentCheckoutMode()`, which answers "test"
 * for any non-live key, including an unrecognised one. As a second check, a
 * test-mode session whose Stripe id is not `cs_test_…` (or is livemode) is
 * expired immediately and the call fails.
 *
 * Nothing here sets or reads TRAINING_MODE beyond `cardRailsSimulated()`.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  ProblemError,
  checkTenderAmounts,
  holdCapSeconds,
  type PaymentSession,
  type PaymentSessionCreateInput,
  type PaymentsAccount,
} from "@openpizza/core";
import {
  DEMO_TENANT_ID,
  type Order,
  type Payment,
  type PosDriver,
} from "@/lib/db";
import {
  PaymentSessionConflictError,
  type PaymentSessionRow,
} from "@/lib/db/payment-types";
import { captureError } from "@/lib/observability";
import {
  assertLiveKeyAllowed,
  cardRailsSimulated,
  getDefaultPlatformFee,
  isStripeLiveKey,
  isStripeTestKey,
  usingMockDriver,
} from "@/lib/payments/env";
import {
  CardPaymentsNotReadyError,
  resolveCardConnectAccountId,
} from "@/lib/payments/connect";
import { effectiveConnectAccount } from "@/lib/payments/connect-status";
import {
  applyRailStatus,
  cancelOpenOnlineIntents,
  cancelPendingTender,
  orderDueCents,
  refreshPaymentStatus,
  syncPaymentSession,
} from "@/lib/payments/service";
import { LiveTenderConflictError } from "@/lib/db/payment-types";
import {
  createCheckoutSession,
  expireCheckoutSession,
  feeForTender,
} from "@/lib/payments/rails/stripe-online";
import { deriveTenderId } from "@/lib/payments/ids";
import { netSettledBaseCents } from "./money";

// ---------------------------------------------------------------------------
// Safety gate
// ---------------------------------------------------------------------------

export type SessionMode = "simulated" | "test" | "live";

/**
 * Tenants allowed to create LIVE-key sessions (`V1_LIVE_SESSION_TENANTS`, comma
 * list). Empty by default. Setting it is a go-live switch: do not set it without
 * the owner's explicit OK. Read lazily; never at module load.
 */
export function liveSessionTenants(): Set<string> {
  return new Set(
    (process.env.V1_LIVE_SESSION_TENANTS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * A simulated session is a public one-click "paid" link, so it must never exist
 * where real orders are cooked. Allowed only on the in-memory mock driver (zero-env
 * dev/CI/preview), or on a NON-production deployment for the demo tenant. A real
 * database with no Stripe key (or TRAINING_MODE) must answer 501 instead.
 */
export function simulatedSessionsAllowed(tenantId: string): boolean {
  if (usingMockDriver()) return true;
  return process.env.VERCEL_ENV !== "production" && tenantId === DEMO_TENANT_ID;
}

function sessionsUnsupported(detail: string): ProblemError {
  return ProblemError.of("CAPABILITY_UNSUPPORTED", { detail });
}

/**
 * The server-side gate for creating a payment session. Throws 501
 * `CAPABILITY_UNSUPPORTED` unless the deployment is simulated, on a positively
 * identified Stripe TEST key, or on a LIVE key for an explicitly allow-listed
 * (non-demo) tenant. Returns the mode that was allowed.
 */
export function assertSessionChargeAllowed(tenantId: string): SessionMode {
  if (cardRailsSimulated()) {
    if (!simulatedSessionsAllowed(tenantId)) {
      throw sessionsUnsupported(
        "Payment sessions are not enabled: simulated sessions are only available on a mock deployment.",
      );
    }
    return "simulated";
  }
  if (isStripeTestKey()) return "test";
  if (isStripeLiveKey()) {
    if (
      tenantId === DEMO_TENANT_ID ||
      !liveSessionTenants().has(tenantId.toLowerCase())
    ) {
      throw sessionsUnsupported(
        "Payment sessions are not enabled for this tenant on live Stripe keys.",
      );
    }
    try {
      assertLiveKeyAllowed();
    } catch {
      throw sessionsUnsupported(
        "Payment sessions are not enabled on this deployment.",
      );
    }
    return "live";
  }
  // A key we cannot positively identify as test or live: never charge.
  throw sessionsUnsupported(
    "Payment sessions are not enabled: the Stripe key is not recognised.",
  );
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

export function toContractSession(row: PaymentSessionRow): PaymentSession {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    order_id: row.order_id,
    status: row.status,
    url: row.url,
    currency: row.currency,
    amount_cents: row.amount_cents,
    tip_cents: row.tip_cents,
    processor: "stripe",
    payment_id: row.payment_id,
    expires_at: row.expires_at,
    created_at: row.created_at,
    simulated: row.simulated,
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/** Stripe refuses Checkout sessions that expire in under 30 minutes. */
const STRIPE_MIN_EXPIRY_MS = 31 * 60_000;
const STRIPE_MAX_EXPIRY_MS = 23 * 3_600_000;
/** The hold outlives the pay link by this much, so a last-second pay still lands. */
const HOLD_GRACE_MS = 2 * 60_000;

function requestHash(orderId: string, input: PaymentSessionCreateInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        orderId,
        input.amount_cents ?? null,
        input.tip_cents ?? null,
        input.success_url,
        input.cancel_url ?? null,
        input.expires_in_seconds ?? null,
        input.customer_email ?? null,
      ]),
    )
    .digest("hex");
}

function conflict(reason: string, detail: string): ProblemError {
  return ProblemError.of("CONFLICT", { detail, details: { reason } });
}

export interface CreateSessionArgs {
  driver: PosDriver;
  tenantId: string;
  order: Order;
  input: PaymentSessionCreateInput;
  idempotencyKey: string;
  now: Date;
  /** Origin used for the simulated pay page URL. */
  baseUrl: string;
}

export async function createPaymentSession(
  a: CreateSessionArgs,
): Promise<{ row: PaymentSessionRow; replayed: boolean }> {
  const { driver, tenantId, order, input, now } = a;
  const hash = requestHash(order.id, input);

  // 2. Replay: same key + same body returns the stored session.
  const prior = await driver.getPaymentSessionByKey(tenantId, a.idempotencyKey);
  if (prior) {
    if (prior.order_id !== order.id || prior.request_hash !== hash) {
      throw ProblemError.of("IDEMPOTENCY_CONFLICT", {
        detail: "Idempotency-Key was used with a different request.",
      });
    }
    return { row: prior, replayed: true };
  }

  // 3. THE GATE. Before any tender row, any Stripe call.
  const mode = assertSessionChargeAllowed(tenantId);
  const simulated = mode === "simulated";

  // 4. The order must be payable.
  assertPayable(order, now);
  const payments = await driver.listPaymentsForOrder(order.id);

  // 5. What is owed. The server decides; the caller may only ask for LESS.
  const due = orderDueCents(order) - netSettledBaseCents(payments, order.currency);
  if (due <= 0) throw conflict("settled", "The order is already paid in full.");
  const amount = input.amount_cents ?? due;
  if (amount <= 0 || amount > due) {
    throw ProblemError.of("VALIDATION_FAILED", {
      detail: `amount_cents must be between 1 and the amount due (${due}).`,
      path: "amount_cents",
    });
  }
  const tip = input.tip_cents ?? (amount === due ? uncoveredTipCents(order, payments) : 0);
  const violation = checkTenderAmounts(
    {
      amount_due_cents: due,
      tenders: payments.map((p) => ({
        status: p.status,
        amount_cents: p.amount_cents,
        tip_cents: p.tip_cents,
      })),
    },
    { amount_cents: amount, tip_cents: tip },
  );
  if (violation) {
    throw ProblemError.of("VALIDATION_FAILED", {
      detail: violation.detail,
      path: violation.path,
    });
  }

  // Expiry: Stripe's 30-minute minimum, honoured; the hold must cover it.
  const requestedMs = (input.expires_in_seconds ?? 0) * 1000;
  const expiryMs =
    now.getTime() +
    Math.min(STRIPE_MAX_EXPIRY_MS, Math.max(STRIPE_MIN_EXPIRY_MS, requestedMs));
  const holdPlan = planHoldExtension(order, expiryMs);

  // 6. The connected account (real mode: must be charges-enabled; never sim).
  let connectAccountId: string | null = null;
  try {
    connectAccountId = await resolveCardConnectAccountId(tenantId);
  } catch (err) {
    if (err instanceof CardPaymentsNotReadyError) {
      throw conflict("card_not_ready", "Card payments are not ready for this tenant.");
    }
    throw err;
  }
  if (!simulated && (!connectAccountId || connectAccountId.startsWith("acct_sim_"))) {
    throw conflict("card_not_ready", "Card payments are not ready for this tenant.");
  }

  // 7. One live session per order: close the old one STRICTLY (Stripe is asked
  //    first; if the payer just paid, that is recorded and we stop below).
  try {
    await cancelOpenOnlineIntents(order.id);
  } catch (err) {
    captureError(err, { scope: "v1.paymentSession.close", orderId: order.id });
    throw ProblemError.of("UPSTREAM_UNAVAILABLE", {
      status: 503,
      detail: "Could not close the order's earlier card payment; try again.",
    });
  }
  const afterClose = await driver.getOrder(order.id);
  if (!afterClose) throw ProblemError.of("NOT_FOUND", { detail: "Order not found." });
  assertPayable(afterClose, now);
  const stillOwed =
    orderDueCents(afterClose) -
    netSettledBaseCents(await driver.listPaymentsForOrder(order.id), afterClose.currency);
  if (stillOwed < amount) {
    throw conflict("settled", "The order was paid while the session was being created.");
  }

  // 8. The tender, with the platform fee on the BASE amount only.
  const tenderId = await nextSessionTenderId(driver, order.id);
  const fee = feeForTender(amount, tip);
  const stamp = now.toISOString();
  const tender: Payment = {
    id: tenderId,
    order_id: order.id,
    tenant_id: tenantId,
    location_id: order.location_id,
    rail: "stripe_online",
    status: "requires_action",
    amount_cents: amount,
    tip_cents: tip,
    application_fee_cents: fee,
    currency: order.currency,
    charge_id: null,
    // A simulated tender never carries a (possibly real) account id: nothing
    // downstream can then mistake it for something to send to Stripe.
    connect_account_id: simulated ? null : connectAccountId,
    crypto_tx_hash: null,
    crypto_chain: null,
    cash_tendered_cents: null,
    cash_change_cents: null,
    refunded_cents: 0,
    simulated,
    raw: {
      via: "payment_session",
      applicationFeeCents: fee,
      tipCents: tip,
      livemode: isStripeLiveKey() && !simulated,
    },
    created_at: stamp,
    updated_at: stamp,
  };
  try {
    await driver.upsertPayment(tender);
  } catch (err) {
    if (err instanceof LiveTenderConflictError) {
      throw conflict("tender_in_progress", "A payment on this order is already in progress.");
    }
    throw err;
  }

  // 9. The Checkout Session (or the local simulated one).
  const rowId = `ps_${randomBytes(18).toString("base64url")}`;
  let stripeSessionId: string;
  let url: string;
  let expiresAtMs = expiryMs;
  if (simulated) {
    stripeSessionId = `cs_sim_${randomBytes(12).toString("hex")}`;
    url = `${a.baseUrl.replace(/\/$/, "")}/pay/sim/${rowId}`;
  } else {
    let created;
    try {
      created = await createCheckoutSession({
        paymentId: tenderId,
        orderId: order.id,
        tenantId,
        connectAccountId: connectAccountId!,
        currency: order.currency,
        amountCents: amount,
        tipCents: tip,
        applicationFeeCents: fee,
        successUrl: input.success_url,
        cancelUrl: input.cancel_url ?? input.success_url,
        expiresAt: Math.floor(expiryMs / 1000),
        customerEmail: input.customer_email ?? null,
        description: `Order ${order.order_number}`,
      });
    } catch (err) {
      captureError(err, { scope: "v1.paymentSession.create", orderId: order.id });
      await applyRailStatus(tenderId, "failed").catch(() => undefined);
      throw ProblemError.of("UPSTREAM_UNAVAILABLE", {
        status: 503,
        detail: "The card processor could not create the payment session; try again.",
      });
    }
    // Second check (test mode): a session that is not provably a TEST session is
    // expired at once and the call fails. (Live mode only reaches here for an
    // allow-listed tenant.)
    if (
      mode === "test" &&
      (!created.id.startsWith("cs_test_") || created.livemode === true)
    ) {
      await expireCheckoutSession(created.id, connectAccountId).catch((err) =>
        captureError(err, { scope: "v1.paymentSession.expire-nontest", orderId: order.id }),
      );
      await applyRailStatus(tenderId, "failed").catch(() => undefined);
      throw sessionsUnsupported(
        "Payment sessions are not enabled: Stripe returned a session that is not in test mode.",
      );
    }
    if (!created.url) {
      await expireCheckoutSession(created.id, connectAccountId).catch(() => undefined);
      await applyRailStatus(tenderId, "failed").catch(() => undefined);
      throw ProblemError.of("UPSTREAM_UNAVAILABLE", {
        status: 503,
        detail: "The card processor returned no payment link; try again.",
      });
    }
    stripeSessionId = created.id;
    url = created.url;
    expiresAtMs = created.expires_at * 1000;
  }

  // Link the tender to its session. RE-READ it first: it may have been closed
  // while we talked to Stripe (cash settled the order and closed the siblings, a
  // cancel, a supersede). Writing our stale copy back would resurrect a closed
  // tender next to a live payable URL (double charge). If it is not still open,
  // expire the session and fail.
  const failSession = async (problem: ProblemError): Promise<never> => {
    if (!simulated) {
      await expireCheckoutSession(stripeSessionId, connectAccountId).catch((err) =>
        captureError(err, { scope: "v1.paymentSession.expire-orphan", orderId: order.id }),
      );
    }
    const cur = await driver.getPayment(tenderId);
    if (cur && (cur.status === "requires_action" || cur.status === "pending")) {
      await applyRailStatus(tenderId, "canceled").catch(() => undefined);
    }
    throw problem;
  };
  const current = await driver.getPayment(tenderId);
  if (!current || current.status !== "requires_action") {
    return failSession(
      conflict("settled", "The order changed while the payment session was being created."),
    );
  }
  try {
    await driver.upsertPayment({
      ...current,
      raw: { ...current.raw, checkout_session_id: stripeSessionId },
    });
  } catch (err) {
    // E.g. the one-live-tender index refusing the write: never a 500 with a payable
    // session left open.
    if (err instanceof LiveTenderConflictError) {
      return failSession(
        conflict("tender_in_progress", "A payment on this order is already in progress."),
      );
    }
    await failSession(ProblemError.of("INTERNAL")).catch(() => undefined);
    throw err;
  }

  // 10. Re-check the ORDER now that the link exists: voided meanwhile, settled by
  //     another tender, or no longer owing this amount -> close the tender and the
  //     session (cancelPendingTender expires it at Stripe) and fail.
  const fresh = await driver.getOrder(order.id);
  let recheck: ProblemError | null = null;
  if (!fresh || fresh.status === "voided" || fresh.status === "abandoned") {
    recheck = ProblemError.of("INVALID_TRANSITION", { detail: "The order was canceled." });
  } else {
    try {
      assertPayable(fresh, now);
      const owed =
        orderDueCents(fresh) -
        netSettledBaseCents(await driver.listPaymentsForOrder(order.id), fresh.currency);
      if (owed < amount) {
        recheck = conflict("settled", "The order was paid while the session was being created.");
      }
    } catch (err) {
      if (!(err instanceof ProblemError)) throw err;
      recheck = err;
    }
  }
  if (recheck) {
    const linked = await driver.getPayment(tenderId);
    if (linked) await cancelPendingTender(linked);
    throw recheck;
  }

  // The session row. A concurrent request for the same key/order loses cleanly.
  let row: PaymentSessionRow;
  try {
    row = await driver.insertPaymentSession({
      id: rowId,
      tenant_id: tenantId,
      order_id: order.id,
      payment_id: null,
      status: "open",
      url,
      stripe_session_id: stripeSessionId,
      currency: order.currency,
      amount_cents: amount,
      tip_cents: tip,
      application_fee_cents: fee,
      idempotency_key: a.idempotencyKey,
      request_hash: hash,
      success_url: input.success_url,
      cancel_url: input.cancel_url ?? null,
      expires_at: new Date(expiresAtMs).toISOString(),
      simulated,
      created_at: stamp,
      updated_at: stamp,
    });
  } catch (err) {
    const linked = await driver.getPayment(tenderId);
    if (linked) await cancelPendingTender(linked);
    if (err instanceof PaymentSessionConflictError) {
      if (err.kind === "key") {
        const winner = await driver.getPaymentSessionByKey(tenantId, a.idempotencyKey);
        if (winner && winner.request_hash === hash && winner.order_id === order.id) {
          return { row: winner, replayed: true };
        }
        throw ProblemError.of("IDEMPOTENCY_CONFLICT", {
          detail: "Idempotency-Key was used with a different request.",
        });
      }
      throw conflict("tender_in_progress", "A payment session on this order is already open.");
    }
    throw err;
  }

  // 11. Keep the hold alive past the pay link.
  if (holdPlan) {
    await applyHoldExtension(driver, tenantId, order.id, holdPlan.expiresAtMs);
  }
  return { row, replayed: false };
}

/**
 * The tender id for this session: the first derived `stripe_online` id with no row.
 * Settled, refunded, canceled and failed tenders are history (a second session
 * after a PARTIAL capture must work); only a tender still open means a payment is
 * in progress (409 tender_in_progress; step 7 normally closed those already).
 */
async function nextSessionTenderId(driver: PosDriver, orderId: string): Promise<string> {
  for (let seq = 0; seq < 50; seq += 1) {
    const id = deriveTenderId(orderId, "stripe_online", seq);
    const ex = await driver.getPayment(id);
    if (!ex) return id;
    if (ex.status === "requires_action" || ex.status === "pending") {
      throw conflict("tender_in_progress", "A payment on this order is already in progress.");
    }
  }
  throw conflict("tender_in_progress", "Too many payment attempts for this order.");
}

/** Order statuses a session may be created for: a live hold, or `placed` with a balance. */
function assertPayable(order: Order, now: Date): void {
  switch (order.status) {
    case "draft": {
      if (!order.hold) {
        throw ProblemError.of("INVALID_TRANSITION", { detail: "The order is not held." });
      }
      const exp = order.hold.expires_at ? Date.parse(order.hold.expires_at) : null;
      if (exp !== null && exp <= now.getTime()) {
        throw conflict("expired", "The hold already expired.");
      }
      return;
    }
    case "placed":
      return;
    case "paid":
    case "in_kitchen":
    case "ready":
    case "recall":
    case "out_for_delivery":
    case "completed":
      throw conflict("settled", "The order is already paid.");
    default:
      throw ProblemError.of("INVALID_TRANSITION", {
        detail: `The order is ${order.status} and cannot be paid.`,
      });
  }
}

/** The order's tip not already carried by a covering (pending/authorized/captured) tender. */
function uncoveredTipCents(order: Order, payments: Payment[]): number {
  const cur = order.currency.toUpperCase();
  const covered = payments
    .filter(
      (p) =>
        p.currency.toUpperCase() === cur &&
        (p.status === "pending" || p.status === "authorized" || p.status === "captured"),
    )
    .reduce((n, p) => n + p.tip_cents, 0);
  return Math.max(0, (order.totals.tip_cents ?? 0) - covered);
}

/**
 * Plan the hold extension that keeps a held order alive for the pay link plus a
 * grace. Returns null when the hold already outlives it (or the order is not
 * held). Throws 409 `at_cap` when the lifetime cap would cut the hold off before
 * the pay link expires.
 */
function planHoldExtension(
  order: Order,
  linkExpiresMs: number,
): { expiresAtMs: number } | null {
  const hold = order.status === "draft" ? order.hold : null;
  if (!hold) return null;
  const cap = Date.parse(order.created_at) + holdCapSeconds(hold.reason) * 1000;
  const wanted = Math.min(linkExpiresMs + HOLD_GRACE_MS, cap);
  if (wanted < linkExpiresMs) {
    throw conflict("at_cap", "The hold is too close to its maximum lifetime for a payment link.");
  }
  const cur = hold.expires_at ? Date.parse(hold.expires_at) : null;
  if (cur !== null && cur >= wanted) return null;
  return { expiresAtMs: wanted };
}

async function applyHoldExtension(
  driver: PosDriver,
  tenantId: string,
  orderId: string,
  wantedMs: number,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const order = await driver.getOrder(orderId);
    const hold = order?.status === "draft" ? order.hold : null;
    if (!order || !hold) return; // released / paid / canceled meanwhile: nothing to extend
    const cur = hold.expires_at ? Date.parse(hold.expires_at) : null;
    if (cur !== null && cur >= wantedMs) return;
    const res = await driver.extendOrderHold(
      orderId,
      tenantId,
      { expires_at: hold.expires_at },
      { ...hold, expires_at: new Date(wantedMs).toISOString() },
    );
    if (res.ok || res.reason === "not_found") return;
  }
  captureError(new Error("could not extend the hold for a payment session"), {
    scope: "v1.paymentSession.extend",
    orderId,
  });
}

// ---------------------------------------------------------------------------
// Get
// ---------------------------------------------------------------------------

/**
 * `GET /payment-sessions/{id}`. The caller has already checked tenant and
 * location scope through `order`. An open REAL session is re-read from Stripe
 * (the reconcile path); an open session past its expiry is closed. `payment_id`
 * stays null until the tender is captured.
 */
export async function loadPaymentSession(
  driver: PosDriver,
  row: PaymentSessionRow,
  now: Date,
): Promise<PaymentSessionRow> {
  if (row.status !== "open") return row;
  const tenders = await driver.listPaymentsForOrder(row.order_id);
  const tender = tenders.find(
    (p) => p.rail === "stripe_online" && p.raw?.checkout_session_id === row.stripe_session_id,
  );
  if (tender && !row.simulated) {
    // May capture (payer paid, webhook late) or cancel (Stripe expired it).
    await refreshPaymentStatus(tender.id).catch((err) =>
      captureError(err, { scope: "v1.paymentSession.sync", paymentId: tender.id }),
    );
  } else if (tender && Date.parse(row.expires_at) <= now.getTime()) {
    // A simulated link past its expiry: close it locally.
    await applyRailStatus(tender.id, "canceled", { sessionStatus: "expired" });
  }
  // Repair a row left open after its tender settled or closed (a missed sync).
  const settled = (await driver.listPaymentsForOrder(row.order_id)).find(
    (p) => p.rail === "stripe_online" && p.raw?.checkout_session_id === row.stripe_session_id,
  );
  if (settled) {
    await syncPaymentSession(settled).catch((err) =>
      captureError(err, { scope: "v1.paymentSession.repair", paymentId: settled.id }),
    );
  }
  return (await driver.getPaymentSession(row.id)) ?? row;
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

/** `GET /payments/account`: the tenant's processor account, no secrets. */
export async function getPaymentsAccount(
  driver: PosDriver,
  tenantId: string,
  defaultCurrency: string,
): Promise<PaymentsAccount> {
  const simulated = cardRailsSimulated();
  const acct = effectiveConnectAccount(await driver.getConnectAccount(tenantId));
  // Real mode never reports a simulated `acct_sim_` id as a connect account.
  const real = acct && (simulated || !acct.account_id.startsWith("acct_sim_")) ? acct : null;
  const fee = getDefaultPlatformFee();
  return {
    tenant_id: tenantId,
    processor: "stripe",
    connect_account_id: real?.account_id ?? null,
    charges_enabled: real?.charges_enabled ?? false,
    payouts_enabled: real?.payouts_enabled ?? false,
    default_currency: defaultCurrency,
    platform_fee: { bps: fee.bps, fixed_cents: fee.flatCents, max_cents: null },
    simulated,
  };
}
