/**
 * PaymentRail — pluggable payment interface contract.
 *
 * Every payment method (card via Stripe Terminal/online, onchain USDC, Coinbase
 * Commerce) implements this interface. Core order logic depends ONLY on this
 * contract and the registry — never on Stripe/Coinbase/chain specifics. New
 * rails = new implementation, no core changes.
 *
 * Phase 2: real provider code paths (Stripe Terminal/online, onchain USDC,
 * Coinbase Commerce) + a fully-real `cash` rail are implemented and registered.
 * Each external rail is guarded by its env keys and falls back to a simulated
 * settlement when no keys are present (the default, incl. the Vercel preview).
 */

/**
 * Stable identifiers for the payment rails the platform supports. `cash` is a
 * first-class rail (no external dependency) so the terminal can treat every
 * tender uniformly through this interface.
 */
export type PaymentRailKey =
  | "stripe_terminal"
  | "stripe_online"
  | "crypto_onchain_usdc"
  | "crypto_coinbase"
  | "cash";

/**
 * Money as an integer minor-unit amount plus an ISO-4217 currency code.
 * Using integers avoids floating-point rounding errors. e.g. { amount: 1299,
 * currency: "USD" } === $12.99. Crypto rails settle in USDC but quote/charge in
 * the order's fiat currency.
 */
export interface Money {
  /** Integer amount in the currency's minor unit (cents for USD). */
  amount: number;
  /** ISO-4217 currency code, uppercase (e.g. "USD"). */
  currency: string;
}

export type ChargeStatus =
  | "requires_action"
  | "pending"
  | "authorized"
  | "captured"
  | "failed"
  | "canceled"
  | "refunded";

/** Tenant + connected-account context every rail call is scoped to. */
export interface PaymentContext {
  tenantId: string;
  locationId: string;
  /** Stripe Connect connected-account id (card rails) or null for crypto. */
  connectAccountId?: string | null;
  /** Idempotency key — client UUID propagated end-to-end to prevent double charges. */
  idempotencyKey: string;
}

export interface QuoteRequest {
  context: PaymentContext;
  amount: Money;
  /** Optional gratuity included in the quote. */
  tip?: Money;
}

export interface Quote {
  rail: PaymentRailKey;
  total: Money;
  /** Platform fee (Connect application_fee) if applicable to this rail. */
  applicationFee?: Money;
  /** Rail-specific quote details (e.g. crypto address, exchange rate, expiry). */
  details?: Record<string, unknown>;
  /** ISO timestamp after which the quote is no longer valid (crypto). */
  expiresAt?: string;
}

export interface CreateChargeRequest {
  context: PaymentContext;
  amount: Money;
  tip?: Money;
  /** Capture immediately (true) or authorize-then-capture (false). */
  capture?: boolean;
  metadata?: Record<string, string>;
}

export interface ChargeResult {
  rail: PaymentRailKey;
  /** Rail-native charge/intent identifier (payment_intent id, tx hash, etc.). */
  chargeId: string;
  status: ChargeStatus;
  amount: Money;
  /** Crypto tx hash / chain when applicable. */
  cryptoTxHash?: string;
  cryptoChain?: string;
  /** Free-form rail data persisted alongside the payment row. */
  raw?: Record<string, unknown>;
}

export interface CaptureRequest {
  context: PaymentContext;
  chargeId: string;
  /** Optional partial capture amount; defaults to the authorized amount. */
  amount?: Money;
}

export interface RefundRequest {
  context: PaymentContext;
  chargeId: string;
  /** Optional partial refund amount; defaults to a full refund. */
  amount?: Money;
  reason?: string;
}

export interface RefundResult {
  refundId: string;
  status: ChargeStatus;
  amount: Money;
}

/**
 * The contract each payment rail implements. Methods are async and must be
 * idempotent with respect to `context.idempotencyKey`.
 */
export interface PaymentRail {
  readonly key: PaymentRailKey;

  /** Price the transaction, including any platform fee and (for crypto) rate/expiry. */
  quote(req: QuoteRequest): Promise<Quote>;

  /** Create a charge (authorize or capture depending on `capture`). */
  createCharge(req: CreateChargeRequest): Promise<ChargeResult>;

  /** Capture a previously authorized charge. */
  capture(req: CaptureRequest): Promise<ChargeResult>;

  /** Refund a captured charge, fully or partially. */
  refund(req: RefundRequest): Promise<RefundResult>;

  /** Fetch the current status of a charge (used by watchers/reconciliation). */
  status(context: PaymentContext, chargeId: string): Promise<ChargeStatus>;
}
