/**
 * Stored value (gift cards + store credit) domain types.
 *
 * MONEY MODEL. A card is an account; its money lives in an APPEND-ONLY ledger.
 * Every ledger row carries a signed `amount_cents` (credit +, debit -) and the
 * `balance_after_cents` it produced, so the account's cached `balance_cents` is
 * always the last row's `balance_after_cents` (and the sum of every amount).
 * Writes go through ONE atomic writer per operation (a SECURITY DEFINER function
 * under a row lock on the account in Postgres; a mutex in the mock), so two
 * tills redeeming the same card at once can never overspend it.
 *
 * Codes are never stored: only a peppered HMAC of the normalized code plus its
 * last 4 characters (for staff to tell cards apart).
 *
 * ACCOUNTING. Selling a gift card is a LIABILITY, not revenue: the sale order
 * carries no menu lines and no tax, and reports keep it out of gross/net/tax.
 * Revenue (and tax) is recognised when the card is REDEEMED against a normal,
 * taxed order. Store credit has no sale: it is issued (with a reason) instead of
 * a refund, and is redeemed the same way.
 *
 * All money is integer minor units (cents).
 */

export type StoredValueKind = "gift_card" | "store_credit";

/**
 * `pending`: created with an unpaid sale order (no money on it yet); becomes
 * `active` when that order settles. `voided`: closed (balance 0), never usable.
 */
export type StoredValueStatus = "pending" | "active" | "voided";

/**
 * Ledger row kinds.
 *  credits: `issue` (first money: a paid sale, or store credit issued),
 *           `load` (a paid reload), `refund` (an order paid with the card was
 *           refunded: the value goes back to the card).
 *  debits:  `redeem` (a tender on an order), `reverse` (a reload refunded),
 *           `void` (the card was voided: the whole balance leaves).
 */
export type LedgerKind = "issue" | "load" | "refund" | "redeem" | "reverse" | "void";

export const CREDIT_KINDS: readonly LedgerKind[] = ["issue", "load", "refund"];
export const DEBIT_KINDS: readonly LedgerKind[] = ["redeem", "reverse", "void"];

export interface StoredValueAccount {
  id: string;
  tenant_id: string;
  kind: StoredValueKind;
  status: StoredValueStatus;
  currency: string;
  /** Cached balance: always equals the last ledger row's balance_after_cents. */
  balance_cents: number;
  /** Last 4 characters of the normalized code (display only). */
  code_last4: string;
  /** True when the code is a pre-printed physical card number entered by staff. */
  physical: boolean;
  customer_id: string | null;
  recipient_name: string | null;
  recipient_email: string | null;
  /** The order that sold the card (gift cards); null for store credit. */
  sale_order_id: string | null;
  /** Where it was created: the till, the storefront, or issued by staff. */
  source: "till" | "online" | "issued";
  created_by: string | null;
  created_at: string;
  updated_at: string;
  activated_at: string | null;
  voided_at: string | null;
}

export interface LedgerEntry {
  id: string;
  account_id: string;
  tenant_id: string;
  location_id: string | null;
  kind: LedgerKind;
  /** Signed: credits positive, debits negative. Never 0. */
  amount_cents: number;
  balance_after_cents: number;
  order_id: string | null;
  payment_id: string | null;
  /** Unique per account: a replay of the same operation writes nothing. */
  idempotency_key: string;
  reason: string | null;
  actor_id: string | null;
  /** Owner/manager who approved it (store credit above the threshold). */
  approved_by: string | null;
  created_at: string;
}

/** What a stored-value SALE order carries (`orders.core_ext.stored_value`). */
export type { StoredValueOrderExt } from "@/lib/db/menu-types";

/** Fields the writer needs to create an account. */
export interface NewAccount {
  id: string;
  tenant_id: string;
  kind: StoredValueKind;
  status: "pending" | "active";
  currency: string;
  code_hash: string;
  code_last4: string;
  physical: boolean;
  customer_id: string | null;
  recipient_name: string | null;
  recipient_email: string | null;
  sale_order_id: string | null;
  source: StoredValueAccount["source"];
  created_by: string | null;
}

export type MutationFailure =
  | "not_found"
  | "inactive"
  | "insufficient"
  | "exceeds_max"
  | "not_settled"
  | "has_activity"
  | "bad_amount";

export type MutationResult =
  | { ok: true; account: StoredValueAccount; entry: LedgerEntry | null; replayed: boolean }
  | { ok: false; reason: MutationFailure; account?: StoredValueAccount | null };

export interface CreditInput {
  tenantId: string;
  accountId: string;
  locationId: string | null;
  kind: "issue" | "load" | "refund";
  amountCents: number;
  key: string;
  orderId?: string | null;
  paymentId?: string | null;
  reason?: string | null;
  actorId?: string | null;
  approvedBy?: string | null;
  /** Move a `pending` account to `active` in the same write. */
  activate?: boolean;
  /** Refuse unless this order's settled tenders cover its amount due. */
  requireSettledOrderId?: string | null;
  /** Cap the resulting balance (sales/reloads); refunds are never capped. */
  maxBalanceCents?: number | null;
}

export interface DebitInput {
  tenantId: string;
  accountId: string;
  locationId: string | null;
  kind: "reverse";
  amountCents: number;
  key: string;
  orderId?: string | null;
  reason?: string | null;
  actorId?: string | null;
}

export interface VoidInput {
  tenantId: string;
  accountId: string;
  locationId: string | null;
  key: string;
  reason: string | null;
  actorId: string | null;
}

export interface RedeemInput {
  tenantId: string;
  accountId: string;
  orderId: string;
  /** Becomes the payments.id of the tender (idempotency key). */
  paymentId: string;
  amountCents: number;
  actorId: string | null;
  staffId: string | null;
}

export type RedeemFailure =
  | "not_found"
  | "order_not_found"
  | "inactive"
  | "insufficient"
  | "exceeds_due"
  | "order_not_payable"
  | "currency"
  | "bad_amount"
  | "conflict";

export type RedeemResult =
  | {
      ok: true;
      account: StoredValueAccount;
      entry: LedgerEntry;
      paymentId: string;
      replayed: boolean;
    }
  | { ok: false; reason: RedeemFailure; account?: StoredValueAccount | null };
