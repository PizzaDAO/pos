/**
 * Stored-value persistence contract + driver selection (server-only).
 *
 * Its own small store (not new PosDriver methods), selected exactly like
 * `getPosDriver()`: the Supabase writer when Supabase env is present, else the
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
  /** A tenant's ledger rows created in [fromIso, toIso), oldest first. */
  listLedgerBetween(tenantId: string, fromIso: string, toIso: string): Promise<LedgerEntry[]>;
  getLedgerEntry(id: string): Promise<LedgerEntry | null>;
  credit(input: CreditInput): Promise<MutationResult>;
  debit(input: DebitInput): Promise<MutationResult>;
  voidAccount(input: VoidInput): Promise<MutationResult>;
  redeem(input: RedeemInput): Promise<RedeemResult>;
}

let cached: StoredValueStore | null = null;

export async function getStoredValueStore(): Promise<StoredValueStore> {
  if (cached) return cached;
  const config = readSupabaseConfig();
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
