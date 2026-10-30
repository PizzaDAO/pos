/**
 * Payment + money-routing domain types (Phase 2).
 *
 * Mirrors the intended Supabase `payments`, `connect_accounts`, and
 * `payment_settings` tables described in PLAN.md. Kept DB-agnostic so the
 * in-memory mock driver and a future Supabase driver share the same shapes.
 *
 * All money is integer minor units (cents for USD) — never floats.
 */
import type { PaymentRailKey } from "@/lib/payments/PaymentRail";

/**
 * Lifecycle of a single tender (one payment attempt on one rail). An order may
 * have several tenders (split payment); the order is `paid` once the sum of
 * captured tenders covers the order total.
 */
export type PaymentStatus =
  | "requires_action"
  | "pending"
  | "authorized"
  | "captured"
  | "failed"
  | "canceled"
  | "refunded";

/**
 * A single tender against an order. One order can have many (split payment).
 * `id` is a client-generated UUID and doubles as the idempotency key end-to-end
 * so paying the same tender twice never double-charges.
 */
export interface Payment {
  /** Client UUID — also the idempotency key for the rail charge. */
  id: string;
  order_id: string;
  tenant_id: string;
  location_id: string;
  rail: PaymentRailKey | "cash";
  status: PaymentStatus;
  /** Base amount applied to the order balance, in cents (excludes tip). */
  amount_cents: number;
  /** Gratuity portion of this tender, in cents. */
  tip_cents: number;
  /** Platform fee (Connect application_fee) taken off this tender, in cents. */
  application_fee_cents: number;
  currency: string;
  /** Rail-native charge id (PaymentIntent id, tx hash, Coinbase charge id, …). */
  charge_id: string | null;
  /** Stripe connected-account id the charge ran on, when applicable. */
  connect_account_id: string | null;
  /** Crypto settlement details, when applicable. */
  crypto_tx_hash: string | null;
  crypto_chain: string | null;
  /** Cash-only: amount tendered + change due, in cents. */
  cash_tendered_cents: number | null;
  cash_change_cents: number | null;
  /** Amount refunded so far against this tender, in cents. */
  refunded_cents: number;
  /** Whether this payment was taken on a simulated rail (no live keys). */
  simulated: boolean;
  /** Free-form rail data persisted alongside the payment row. */
  raw: Record<string, unknown> | null;
  /**
   * Client refund-request ids already applied to this tender (idempotency).
   * Written ONLY by `reservePaymentRefund`, never by `upsertPayment`.
   */
  refund_ids?: string[];
  created_at: string;
  updated_at: string;
}

/** Result of an atomic refund reservation (see `PosDriver.reservePaymentRefund`). */
export type RefundReservation =
  | { ok: true; payment: Payment }
  | {
      ok: false;
      /** duplicate: refundId already applied; exceeds: over-refund / not refundable. */
      reason: "not_found" | "duplicate" | "exceeds";
      payment: Payment | null;
    };

/** Per-tenant Stripe Connect onboarding status. */
export type ConnectStatus = "not_started" | "pending" | "connected" | "rejected";

export interface ConnectAccount {
  tenant_id: string;
  /** Stripe connected-account id (acct_…) — or a simulated id with no keys. */
  account_id: string;
  status: ConnectStatus;
  /** Whether charges can be created on this account. */
  charges_enabled: boolean;
  /** Whether payouts to the tenant's bank are enabled. */
  payouts_enabled: boolean;
  /** Whether onboarding/KYC details are still required. */
  details_submitted: boolean;
  /** True when there are no live Stripe keys (simulated connection). */
  simulated: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Per-tenant/location platform-fee + tipping configuration (mock store
 * settings). The platform fee is what WE charge per card order via Connect
 * `application_fee_amount`; it is the sum of a percentage (bps) + a flat fee.
 */
export interface PaymentSettings {
  tenant_id: string;
  location_id: string;
  currency: string;
  /** Platform fee rate in basis points (e.g. 250 = 2.50%). */
  platform_fee_bps: number;
  /** Flat platform fee per card order, in cents (e.g. 30 = $0.30). */
  platform_fee_flat_cents: number;
  /** Tip preset percentages, in basis points (e.g. 1800 = 18%). */
  tip_presets_bps: number[];
}

/**
 * A second LIVE card (`stripe_online`) or Coinbase tender was written for an
 * order that already has one (the `payments_one_live_card_or_cb` partial unique
 * index; the mock driver enforces the same rule). Maps to HTTP 409.
 */
export class LiveTenderConflictError extends Error {
  constructor() {
    super("This order already has a payment in progress.");
    this.name = "LiveTenderConflictError";
  }
}

/** Rails limited to one live tender per order (mirrors the unique index). */
export const ONE_LIVE_TENDER_RAILS: readonly string[] = [
  "stripe_online",
  "crypto_coinbase",
  // Card-present: one open reader tender per order (payments_one_live_terminal).
  "stripe_terminal",
];

// ---------------------------------------------------------------------------
// Stripe Terminal (server-driven in-store card reader)
// ---------------------------------------------------------------------------

/** Who collects the tip on a card-present sale. */
export type TerminalTipMode = "reader" | "pos" | "none";

export const TERMINAL_TIP_MODES: readonly TerminalTipMode[] = [
  "reader",
  "pos",
  "none",
];

/** Structured address a Stripe Terminal Location requires. */
export interface TerminalAddress {
  line1: string;
  line2?: string;
  city: string;
  /** US state/territory code (e.g. "TX"). */
  state: string;
  postal_code: string;
  /** ISO-3166 alpha-2 (US only in v1). */
  country: string;
}

/** Our index of a Stripe Terminal Location (`tml_`) for one POS location. */
export interface TerminalLocation {
  location_id: string;
  tenant_id: string;
  /** Connected account + key mode the Stripe ids below were created under. */
  connect_account_id: string | null;
  stripe_location_id: string | null;
  /** Terminal Configuration (`tmc_`) carrying the on-reader tip presets. */
  configuration_id: string | null;
  livemode: boolean;
  address: TerminalAddress | null;
  tip_mode: TerminalTipMode;
  created_at: string;
  updated_at: string;
}

/** A registered card reader (Stripe `tmr_` id) on a tenant's connected account. */
export interface TerminalReader {
  id: string;
  tenant_id: string;
  location_id: string;
  connect_account_id: string;
  label: string;
  device_type: string | null;
  serial_number: string | null;
  livemode: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Tender statuses that HOLD the one-open-tender slot (the DB index
 * `payments_one_live_card_or_cb` covers only these). Settled tenders do not, so
 * a settlement can always be recorded.
 */
export function tenderHoldsOpenSlot(status: PaymentStatus): boolean {
  return status === "requires_action" || status === "pending";
}

/** Tender statuses that free the one-live-tender slot. */
export function tenderFreesSlot(status: PaymentStatus): boolean {
  return status === "canceled" || status === "failed";
}
