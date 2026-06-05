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
  created_at: string;
  updated_at: string;
}

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
