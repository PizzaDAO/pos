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
import type { DeliveryRecord, DeliveryRecordStatus } from "./customer-types";

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

/** One refund against a tender (`payments.refunds`, oldest first). */
export interface PaymentRefund {
  /** Stable, unique per refund (server-minted). */
  id: string;
  amount_cents: number;
  at: string;
  /** Provider-native refund id (Stripe `re_…`), when the rail returns one. */
  processor_ref: string | null;
  reason: string | null;
  /** Internal: the client refund-request id this entry was reserved under. */
  request_id?: string | null;
  /**
   * The GRATUITY part of `amount_cents` (the rest is base). Recorded on every
   * refund since tip refunds are tracked separately; absent on older entries,
   * which came off the tip first (see `tipRefundedCents`).
   */
  tip_cents?: number | null;
}

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
  rail: PaymentRailKey | "cash" | "external";
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
  /** Amount refunded so far against this tender, in cents (base + tip). */
  refunded_cents: number;
  /**
   * The gratuity part of `refunded_cents`. Written ONLY by the refund
   * reservation (never `upsertPayment`). Absent on rows read from a database
   * that predates it: then refunds came off the tip first (`tipRefundedCents`).
   */
  tip_refunded_cents?: number;
  /** Whether this payment was taken on a simulated rail (no live keys). */
  simulated: boolean;
  /**
   * `external` rail only (`payments.recordExternal`): how the money was taken,
   * by whom, and the processor's own reference. `processor_ref` is deliberately
   * NOT `charge_id`: that is the Stripe/Coinbase webhook correlation key.
   */
  method?: string | null;
  processor?: string | null;
  processor_ref?: string | null;
  collection?: string | null;
  staff_id?: string | null;
  /** Free-form rail data persisted alongside the payment row. */
  raw: Record<string, unknown> | null;
  /**
   * Client refund-request ids already applied to this tender (idempotency).
   * Written ONLY by `reservePaymentRefund`, never by `upsertPayment`.
   */
  refund_ids?: string[];
  /**
   * Every refund with a stable id (Σ amount_cents = refunded_cents). Written
   * ONLY by `reservePaymentRefund` / `releasePaymentRefund`, never by
   * `upsertPayment`. Absent on tenders refunded before it existed.
   */
  refunds?: PaymentRefund[];
  created_at: string;
  updated_at: string;
}

/** Result of an atomic refund reservation (see `PosDriver.reservePaymentRefund`). */
export type RefundReservation =
  | {
      ok: true;
      payment: Payment;
      /** Id of the refund entry this reservation appended to `payment.refunds`. */
      refundEntryId?: string;
    }
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
// External tenders (`payments.recordExternal`)
// ---------------------------------------------------------------------------

/** What `PosDriver.recordExternalTender` is asked to store. */
export interface ExternalTenderWrite {
  tenantId: string;
  orderId: string;
  paymentId: string;
  method: string;
  processor: string;
  processorRef: string | null;
  amountCents: number;
  tipCents: number;
  /** Stored status. `authorized` is stored as `pending`: it never counts. */
  status: "captured" | "pending";
  /** What the caller asked for (kept in `raw.requested_status`). */
  requestedStatus: "captured" | "authorized" | "pending";
  collection: string | null;
  staffId: string | null;
  /**
   * What the caller summed over the order's live tenders (pending, authorized,
   * captured, refunded) when it validated the amounts. If the order changed
   * since, nothing is written (`stale`) and the caller re-validates.
   */
  expect: { n: number; amount: number; tip: number; refunded: number };
  /** Server-derived from the verified token (never caller-supplied); stored in raw. */
  recordedBy: { principal_id: string; module: string | null };
}

/** Outcome of the atomic external-tender write (one transaction, order row locked). */
export type ExternalTenderResult =
  | { outcome: "ok"; payment: Payment; superseded: string[] }
  /** This payment id already exists (any tenant / order: the caller decides replay vs conflict). */
  | { outcome: "exists"; payment: Payment }
  /** Another CAPTURED external tender already carries this processor + ref. */
  | { outcome: "duplicate_ref"; payment: Payment }
  | { outcome: "not_found" }
  | { outcome: "invalid_state"; status: string }
  | { outcome: "stale" };

/** Statuses that count as "live" for the tender fingerprint and the tip caps. */
export const FINGERPRINT_STATUSES: readonly string[] = [
  "pending",
  "authorized",
  "captured",
  "refunded",
];

/** The fingerprint `ExternalTenderWrite.expect` carries, from an order's tenders. */
export function tenderFingerprint(
  tenders: readonly Pick<
    Payment,
    "status" | "amount_cents" | "tip_cents" | "refunded_cents"
  >[],
): ExternalTenderWrite["expect"] {
  const live = tenders.filter((p) => FINGERPRINT_STATUSES.includes(p.status));
  return {
    n: live.length,
    amount: live.reduce((n, p) => n + p.amount_cents, 0),
    tip: live.reduce((n, p) => n + p.tip_cents, 0),
    refunded: live.reduce((n, p) => n + p.refunded_cents, 0),
  };
}

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

// ---------------------------------------------------------------------------
// /v1 payment sessions + stored quotes (pos-v1-gaps phase 1)
// ---------------------------------------------------------------------------

export type PaymentSessionStatus = "open" | "completed" | "expired" | "canceled";

/**
 * A hosted pay link (`payment_sessions`). One `stripe_online` tender backs each
 * session; the session itself never carries money, it is only the link.
 */
export interface PaymentSessionRow {
  /** Random, unguessable. */
  id: string;
  tenant_id: string;
  order_id: string;
  /** The tender (payments.id) once captured; null before. */
  payment_id: string | null;
  status: PaymentSessionStatus;
  url: string;
  /** Stripe Checkout Session id (`cs_test_…`), or a `cs_sim_…` id when simulated. */
  stripe_session_id: string | null;
  currency: string;
  amount_cents: number;
  tip_cents: number;
  application_fee_cents: number;
  idempotency_key: string;
  request_hash: string;
  success_url: string;
  cancel_url: string | null;
  expires_at: string;
  simulated: boolean;
  created_at: string;
  updated_at: string;
}

/** The idempotency key or the one-open-session slot is already taken. */
export class PaymentSessionConflictError extends Error {
  readonly kind: "key" | "open";
  constructor(kind: "key" | "open") {
    super(
      kind === "key"
        ? "Idempotency key already used for a payment session."
        : "This order already has an open payment session.",
    );
    this.name = "PaymentSessionConflictError";
    this.kind = kind;
  }
}

/** A stored `/v1` quote (`core_quotes`): the validated request, re-priced on use. */
export interface StoredQuote {
  id: string;
  tenant_id: string;
  location_id: string;
  /** The parsed QuoteRequest (zod defaults applied). */
  request: Record<string, unknown>;
  quote_hash: string;
  expires_at: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// pos-v1-gaps phase 4
// ---------------------------------------------------------------------------

/** Result of {@link PosDriver.linkTenderSession} (a compare-and-set). */
export type TenderLinkResult =
  | { ok: true; payment: Payment }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_open"; status: string };

/** One row of a published allergen matrix. */
export interface AllergenRow {
  target_type: "item" | "size" | "modifier";
  target_id: string;
  contains: string[];
  may_contain: string[];
  tags: string[];
}

/** A stored allergen publication (`menu_allergen_publications`). */
export interface AllergenPublicationRecord {
  id: string;
  tenant_id: string;
  version: string;
  payload_hash: string;
  location_ids: string[] | null;
  row_count: number;
  published_by: string | null;
  published_at: string;
}

export type AllergenPublishResult =
  | { outcome: "ok" | "replay"; publication: AllergenPublicationRecord }
  | { outcome: "conflict" }
  | { outcome: "unknown_target" | "unknown_location" | "duplicate"; ids: string[] };

/** Fields a delivery status update may change. */
export interface DeliveryPatch {
  status: DeliveryRecordStatus;
  driver_name?: string | null;
  driver_phone?: string | null;
  eta_minutes?: number | null;
  tracking_ref?: string | null;
  provider_delivery_id?: string | null;
}

export type DeliveryTransitionResult =
  | { ok: true; delivery: DeliveryRecord }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "terminal"; delivery: DeliveryRecord };
