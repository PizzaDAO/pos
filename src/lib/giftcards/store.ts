/**
 * Stored-value persistence contract + driver selection (server-only).
 *
 * Its own small store (not new PosDriver methods), paired with the active
 * PosDriver: the Supabase writer when the PosDriver is Supabase, else the
 * in-memory mock. Every mutating method is ONE atomic operation:
 *
 *   - Postgres: a SECURITY DEFINER function that locks the account row (and,
 *     for a redemption, the order row) `FOR UPDATE`, checks, appends the ledger
 *     row, updates the cached balance and (redeem) inserts the tender, in one
 *     transaction. Concurrent writers on one card serialize on its row lock.
 *   - Mock: the same steps inside a process-wide mutex.
 *
 * Every mutation is idempotent on (account, idempotency key); a redemption is
 * also idempotent on its payment id.
 */
import { getPosDriver } from "@/lib/db";
import { readSupabaseConfig } from "@/lib/db/supabase";
import type {
  CreditInput,
  DebitInput,
  LedgerEntry,
  MutationResult,
  NewAccount,
  RedeemInput,
  RedeemResult,
  StoredValueAccount,
  StoredValueKind,
  VoidInput,
} from "./types";

export interface StoredValueSummary {
  outstanding_cents: number;
  store_credit_issued_count: number;
  store_credit_issued_cents: number;
}

export interface IssueStoreCreditWrite {
  tenantId: string;
  accountId: string;
  locationId: string | null;
  currency: string;
  codeHash: string;
  codeLast4: string;
  customerId: string | null;
  amountCents: number;
  reason: string;
  actorId: string;
  /** Owner/manager: recorded as approved_by and exempt from the daily cap. */
  isManager: boolean;
  /** A non-manager's store credit issued since `dayStartIso` may not exceed this. */
  dailyCapCents: number | null;
  /** Start of the location's current business day (ISO instant). */
  dayStartIso: string;
}

export type IssueStoreCreditOutcome =
  | { outcome: "ok"; account: StoredValueAccount; entry: LedgerEntry }
  | { outcome: "replayed"; account: StoredValueAccount }
  | { outcome: "approval_required" | "code_taken" | "bad_amount" };

export interface StoredValueStore {
  readonly name: "mock" | "supabase";
  createAccount(
    row: NewAccount,
  ): Promise<{ ok: true; account: StoredValueAccount } | { ok: false; reason: "code_taken" }>;
  getAccount(tenantId: string, id: string): Promise<StoredValueAccount | null>;
  findByCodeHash(tenantId: string, codeHash: string): Promise<StoredValueAccount | null>;
  listAccounts(
    tenantId: string,
    opts?: { kind?: StoredValueKind; customerId?: string; limit?: number },
  ): Promise<StoredValueAccount[]>;
  /** One account's ledger, oldest first. */
  listLedger(tenantId: string, accountId: string): Promise<LedgerEntry[]>;
  getLedgerEntry(id: string): Promise<LedgerEntry | null>;
  /**
   * The release sweep's target set, queried directly: abandoned orders (all
   * tenants) still holding a captured, not fully refunded stored-value tender.
   * Newest first, keyset-paged with `before` (the last row of the previous page).
   */
  listUnreleasedOrders(
    limit: number,
    before?: { created_at: string; id: string } | null,
  ): Promise<{ id: string; created_at: string }[]>;
  /** Aggregates for reports, computed by the store (SQL), never by paging rows. */
  summary(
    tenantId: string,
    locationId: string | null,
    fromIso: string,
    toIso: string,
  ): Promise<StoredValueSummary>;
  /** Store credit: create the account AND credit it in one atomic step. */
  issueStoreCredit(input: IssueStoreCreditWrite): Promise<IssueStoreCreditOutcome>;
  /** The buyer's one-time code reveal (online cards): true only the first time. */
  markCodeRevealed(tenantId: string, accountId: string): Promise<boolean>;
  /** Guess limiter, shared across instances: seconds any key is locked out (0 = free). */
  guardCheck(keys: string[]): Promise<number>;
  /** Count one failed lookup on every key; returns seconds locked after it. */
  guardFail(keys: string[], limit: number, windowSeconds: number): Promise<number>;
  credit(input: CreditInput): Promise<MutationResult>;
  debit(input: DebitInput): Promise<MutationResult>;
  voidAccount(input: VoidInput): Promise<MutationResult>;
  redeem(input: RedeemInput): Promise<RedeemResult>;
}

let cached: StoredValueStore | null = null;

export async function getStoredValueStore(): Promise<StoredValueStore> {
  if (cached) return cached;
  // Follow the ACTIVE PosDriver (orders + tenders live there): a mock driver
  // always pairs with the mock store, whatever env changed since.
  const config = getPosDriver().name === "mock" ? null : readSupabaseConfig();
  if (config) {
    const { createSupabaseStoredValueStore } = await import("./store-supabase");
    cached = createSupabaseStoredValueStore(config);
  } else {
    const { mockStoredValueStore } = await import("./store-mock");
    cached = mockStoredValueStore;
  }
  return cached;
}

/** Test helper. */
export function resetStoredValueStore(): void {
  cached = null;
}
