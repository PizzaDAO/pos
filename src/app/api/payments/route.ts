/**
 * Payments endpoint.
 *
 * POST /api/payments — take one tender against an order. Idempotent on the
 * client-supplied `paymentId` (UUID): retries return the existing tender rather
 * than charging again. Resolves the tenant's Connect account for card rails,
 * computes the platform application fee, calls the rail (real when keys are
 * present, simulated otherwise), persists the payment, and marks the order
 * `paid` once the balance reaches zero.
 *
 * GET /api/payments?orderId= — list tenders + remaining balance for an order.
 *
 * MONEY IS SERVER-DERIVED: the tenant, location and currency come from the
 * STORED order (client values must match or the request is rejected), and the
 * charge amount is checked against the order's remaining balance:
 *   - `amountCents` omitted → charge the full remaining balance;
 *   - staff (terminal) may take a partial tender (split payment), 1..balance;
 *   - an anonymous storefront customer must pay exactly the balance.
 * Tips are only accepted via the explicit `tipCents` field, bounded, and not at
 * all when the order already carries an order-level tip (online orders).
 *
 * Auth: in-store orders require an operational (terminal) role of the order's
 * tenant. Online orders may be paid by the anonymous customer (the order UUID
 * is the capability) but ONLY via online rails — never cash/card-present.
 * GET requires a terminal role of the order's tenant.
 *
 * No env vars are required; with none, rails settle via the simulated path.
 */
import { NextResponse } from "next/server";
import { getPosDriver, type Order } from "@/lib/db";
import type { PaymentRailKey } from "@/lib/payments/PaymentRail";
import {
  BalanceExceededError,
  getOrderBalance,
  isDefinitiveRailFailure,
  PaymentOutcomeUnknownError,
  TenderVoidedDuringChargeError,
  takePayment,
} from "@/lib/payments/service";
import { PUBLIC_RAILS, railAvailable } from "@/lib/payments/availability";
import {
  enforceRateLimit,
  isClientId,
  isMoneyCents,
  readJsonBody,
} from "@/lib/security";
import { getCurrentUser } from "@/lib/auth/session";
import { canEnterSurface } from "@/lib/auth/roles";
import {
  requireOrderAccess,
  requireTenantAccess,
} from "@/lib/auth/tenant-guard";
import { maxTipCents } from "@/lib/reprice";

export const runtime = "nodejs";

type Rail = PaymentRailKey | "cash";

const ALL_RAILS: Rail[] = [
  "cash",
  "stripe_terminal",
  "stripe_online",
  "crypto_onchain_usdc",
  "crypto_coinbase",
];

interface TakePaymentBody {
  paymentId: string;
  orderId: string;
  /** Optional; must match the stored order when present. */
  tenantId?: string;
  locationId?: string;
  currency?: string;
  rail: Rail;
  /** Base amount applied to the balance; defaults to the full balance. */
  amountCents?: number;
  tipCents?: number;
  cashTenderedCents?: number;
  metadata?: Record<string, string>;
}

function isValid(body: unknown): body is TakePaymentBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  const optStr = (v: unknown) => v === undefined || typeof v === "string";
  return (
    isClientId(b.paymentId) &&
    typeof b.orderId === "string" &&
    optStr(b.tenantId) &&
    optStr(b.locationId) &&
    optStr(b.currency) &&
    typeof b.rail === "string" &&
    ALL_RAILS.includes(b.rail as Rail) &&
    // Amount + optional tip must be non-negative integer cents (reject NaN /
    // negative / fractional / absurd values before they reach the rail).
    (b.amountCents === undefined || isMoneyCents(b.amountCents)) &&
    (b.tipCents === undefined || isMoneyCents(b.tipCents)) &&
    (b.cashTenderedCents === undefined || isMoneyCents(b.cashTenderedCents)) &&
    (b.metadata === undefined ||
      (typeof b.metadata === "object" && b.metadata !== null))
  );
}

/** Keep only a small set of short string metadata entries. */
function cleanMetadata(
  meta: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!meta) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta).slice(0, 10)) {
    if (typeof v === "string" && k.length <= 40) out[k] = v.slice(0, 200);
  }
  return out;
}

function reject(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

export async function POST(request: Request) {
  // Rate-limit payment capture per IP to blunt charge-spam / card-testing abuse.
  const limited = enforceRateLimit(request, "payments");
  if (limited) return limited;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return reject(parsed.error, parsed.status);
  const body = parsed.body;
  if (!isValid(body)) return reject("Malformed payment payload.", 422);

  const driver = getPosDriver();

  let order: Order | null = null;
  try {
    order = await driver.getOrder(body.orderId);
  } catch {
    order = null;
  }
  if (!order) return reject("Order not found.", 404);

  // Client-supplied context must match the stored order (never trusted).
  if (
    (body.tenantId !== undefined && body.tenantId !== order.tenant_id) ||
    (body.locationId !== undefined && body.locationId !== order.location_id) ||
    (body.currency !== undefined && body.currency !== order.currency)
  ) {
    return reject("Payment does not match the order.", 422);
  }

  // ---- Authorization --------------------------------------------------------
  const user = await getCurrentUser();
  const isStaff = Boolean(
    user && canEnterSurface(user.memberships, "terminal", order.tenant_id),
  );
  if (order.channel === "in_store" || !PUBLIC_RAILS.includes(body.rail)) {
    // In-store orders, and cash / card-present tenders on any order, need a
    // signed-in operational role of the ORDER's tenant.
    const auth = await requireTenantAccess(order.tenant_id, "terminal");
    if (!auth.ok) return auth.res;
  }

  // A rail with no live keys runs SIMULATED (settles without moving money).
  // Never for anonymous online checkout outside the zero-env demo; staff may
  // use it only with an explicit ALLOW_SIMULATED_PAYMENTS=true.
  if (!railAvailable(body.rail, { staff: isStaff })) {
    return reject("This payment method is not available.", 503);
  }

  // ---- Idempotent replay ------------------------------------------------------
  const prior = await driver.getPayment(body.paymentId).catch(() => null);
  // A prior attempt whose rail outcome is unknown (pending, never reached a
  // charge id) is RESUMED by takePayment with its reserved amounts.
  const resuming = Boolean(
    prior &&
      prior.order_id === order.id &&
      prior.status === "pending" &&
      !prior.charge_id &&
      !prior.raw,
  );
  if (prior && !resuming) {
    if (prior.order_id !== order.id) {
      return reject("Payment id already used for another order.", 409);
    }
    const balance = await getOrderBalance(order);
    return NextResponse.json(
      { payment: prior, balanceCents: balance, orderStatus: order.status },
      { status: 201 },
    );
  }

  // ---- Amount: derived from the stored order balance ------------------------
  if (order.status === "voided" || order.status === "refunded") {
    return reject("This order can no longer be paid.", 409);
  }
  // A resumed attempt's amount is already reserved (it's in the balance).
  const balance =
    (await getOrderBalance(order)) + (resuming && prior ? prior.amount_cents : 0);
  if (balance <= 0) return reject("This order is already paid.", 409);
  const amountCents = resuming && prior ? prior.amount_cents : (body.amountCents ?? balance);
  if (amountCents <= 0 || amountCents > balance) {
    return reject(
      `Amount does not match the order balance (${balance}).`,
      422,
    );
  }
  if (!isStaff && !resuming && amountCents !== balance) {
    return reject(
      `Amount does not match the order balance (${balance}).`,
      422,
    );
  }

  // ---- Tip: explicit, bounded, never double-counted --------------------------
  const tipCents = resuming && prior ? prior.tip_cents : (body.tipCents ?? 0);
  if (tipCents > 0 && order.totals.tip_cents > 0) {
    return reject("This order already includes a tip.", 422);
  }
  if (tipCents > maxTipCents(order.totals.total_cents)) {
    return reject("Tip amount is too large.", 422);
  }
  if (
    body.rail === "cash" &&
    body.cashTenderedCents !== undefined &&
    body.cashTenderedCents < amountCents + tipCents
  ) {
    return reject("Cash tendered is less than the amount due.", 422);
  }

  // Resolve the connected account for card rails (simulated when no Stripe key).
  let connectAccountId: string | null = null;
  if (body.rail === "stripe_terminal" || body.rail === "stripe_online") {
    const account = await driver.getConnectAccount(order.tenant_id);
    connectAccountId = account?.account_id ?? null;
  }

  try {
    const payment = await takePayment({
      paymentId: body.paymentId,
      orderId: order.id,
      tenantId: order.tenant_id,
      locationId: order.location_id,
      rail: body.rail,
      amountCents,
      tipCents,
      currency: order.currency,
      connectAccountId,
      cashTenderedCents: body.cashTenderedCents,
      metadata: cleanMetadata(body.metadata),
    });

    const refreshed = await driver.getOrder(order.id);
    const remaining = refreshed ? await getOrderBalance(refreshed) : 0;
    return NextResponse.json(
      { payment, balanceCents: remaining, orderStatus: refreshed?.status },
      { status: 201 },
    );
  } catch (err) {
    // Lost the race for the remaining balance (atomic reservation refused).
    // Provider outcome unknown: the tender stays pending. Retry with the SAME
    // paymentId (the rail dedupes on it) — never a new id.
    if (err instanceof PaymentOutcomeUnknownError) {
      return NextResponse.json(
        { error: err.message, retry: true, paymentId: err.id },
        { status: 503 },
      );
    }
    if (err instanceof TenderVoidedDuringChargeError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof BalanceExceededError) {
      return NextResponse.json(
        { error: err.message, balanceCents: err.balanceCents },
        { status: 409 },
      );
    }
    // A definitive decline (no money moved) is a 402 — the client may start
    // over with a new id. Anything else stays ambiguous (502).
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Payment failed." },
      { status: isDefinitiveRailFailure(err) ? 402 : 502 },
    );
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const orderId = searchParams.get("orderId");
  if (!orderId) {
    return NextResponse.json(
      { error: "orderId is required." },
      { status: 400 },
    );
  }
  const auth = await requireOrderAccess(orderId, "terminal");
  if (!auth.ok) return auth.res;
  const { order } = auth;
  const driver = getPosDriver();
  const payments = await driver.listPaymentsForOrder(orderId);
  const balance = await getOrderBalance(order);
  return NextResponse.json({
    order,
    payments,
    balanceCents: balance,
    orderStatus: order.status,
  });
}
