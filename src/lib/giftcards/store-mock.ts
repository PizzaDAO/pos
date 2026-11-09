/**
 * In-memory stored-value writer (zero-env demo + tests). Mirrors the SQL
 * writers in 20261113000910_stored_value.sql: every mutation runs inside one
 * process-wide mutex, so a check and its write can never interleave with another
 * mutation (the mock's equivalent of the Postgres row lock). Orders and tenders
 * are read and written through the mock PosDriver.
 */
import { getPosDriver, type Payment } from "@/lib/db";
import { applyMovement, isUnredeemed } from "./ledger";
import { isSettled, remainingCents, UNPAYABLE_ORDER_STATUSES } from "./order-math";
import type { StoredValueStore } from "./store";
import type {
  LedgerEntry,
  LedgerKind,
  MutationResult,
  StoredValueAccount,
} from "./types";

interface MockAccount extends StoredValueAccount {
  code_hash: string;
}

const accounts = new Map<string, MockAccount>();
const ledger: LedgerEntry[] = [];
const revealed = new Set<string>();
const guard = new Map<string, { windowStart: number; failures: number; lockedUntil: number | null }>();

let chain: Promise<unknown> = Promise.resolve();
/** Run `fn` exclusively (FIFO). A failure never poisons the queue. */
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

function nowIso(): string {
  return new Date().toISOString();
}

function publicAccount(a: MockAccount): StoredValueAccount {
  const { code_hash: _h, ...rest } = a;
  void _h;
  return { ...rest };
}

function findEntry(accountId: string, key: string): LedgerEntry | undefined {
  return ledger.find((e) => e.account_id === accountId && e.idempotency_key === key);
}

function append(
  a: MockAccount,
  kind: LedgerKind,
  signed: number,
  balanceAfter: number,
  fields: Partial<LedgerEntry> & { idempotency_key: string; location_id: string | null },
): LedgerEntry {
  const at = nowIso();
  const entry: LedgerEntry = {
    id: globalThis.crypto.randomUUID(),
    account_id: a.id,
    tenant_id: a.tenant_id,
    kind,
    amount_cents: signed,
    balance_after_cents: balanceAfter,
    order_id: null,
    payment_id: null,
    reason: null,
    actor_id: null,
    approved_by: null,
    created_at: at,
    ...fields,
  };
  ledger.push(entry);
  a.balance_cents = balanceAfter;
  a.updated_at = at;
  return { ...entry };
}

function owned(tenantId: string, id: string): MockAccount | null {
  const a = accounts.get(id);
  return a && a.tenant_id === tenantId ? a : null;
}

export const mockStoredValueStore: StoredValueStore = {
  name: "mock",

  async createAccount(row) {
    return exclusive(async () => {
      for (const a of accounts.values()) {
        if (a.tenant_id === row.tenant_id && a.code_hash === row.code_hash) {
          return { ok: false as const, reason: "code_taken" as const };
        }
      }
      const at = nowIso();
      const account: MockAccount = {
        ...row,
        balance_cents: 0,
        created_at: at,
        updated_at: at,
        activated_at: row.status === "active" ? at : null,
        voided_at: null,
      };
      accounts.set(account.id, account);
      return { ok: true as const, account: publicAccount(account) };
    });
  },

  async getAccount(tenantId, id) {
    const a = owned(tenantId, id);
    return a ? publicAccount(a) : null;
  },

  async findByCodeHash(tenantId, codeHash) {
    for (const a of accounts.values()) {
      if (a.tenant_id === tenantId && a.code_hash === codeHash) return publicAccount(a);
    }
    return null;
  },

  async listAccounts(tenantId, opts = {}) {
    return [...accounts.values()]
      .filter(
        (a) =>
          a.tenant_id === tenantId &&
          (!opts.kind || a.kind === opts.kind) &&
          (!opts.customerId || a.customer_id === opts.customerId),
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, Math.min(Math.max(opts.limit ?? 200, 1), 500))
      .map(publicAccount);
  },

  async listLedger(tenantId, accountId) {
    return ledger
      .filter((e) => e.tenant_id === tenantId && e.account_id === accountId)
      .map((e) => ({ ...e }));
  },

  async listRecentRedemptions(sinceIso, limit) {
    return ledger
      .filter((e) => e.kind === "redeem" && e.created_at >= sinceIso)
      .slice(0, limit)
      .map((e) => ({ ...e }));
  },

  async summary(tenantId, locationId, fromIso, toIso) {
    let outstanding = 0;
    const credits = new Set<string>();
    for (const a of accounts.values()) {
      if (a.tenant_id !== tenantId) continue;
      if (a.status === "active") outstanding += a.balance_cents;
      if (a.kind === "store_credit") credits.add(a.id);
    }
    let count = 0;
    let cents = 0;
    for (const e of ledger) {
      if (e.tenant_id !== tenantId || e.kind !== "issue" || !credits.has(e.account_id)) continue;
      if (e.created_at < fromIso || e.created_at >= toIso) continue;
      if (locationId && e.location_id && e.location_id !== locationId) continue;
      count += 1;
      cents += e.amount_cents;
    }
    return { outstanding_cents: outstanding, store_credit_issued_count: count, store_credit_issued_cents: cents };
  },

  async issueStoreCredit(input) {
    return exclusive(async () => {
      if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
        return { outcome: "bad_amount" as const };
      }
      const existing = owned(input.tenantId, input.accountId);
      if (existing) return { outcome: "replayed" as const, account: publicAccount(existing) };
      if (!input.isManager && input.dailyCapCents != null) {
        const day = nowIso().slice(0, 10);
        const today = ledger
          .filter(
            (e) =>
              e.tenant_id === input.tenantId &&
              e.kind === "issue" &&
              e.actor_id === input.actorId &&
              e.created_at.slice(0, 10) === day &&
              accounts.get(e.account_id)?.kind === "store_credit",
          )
          .reduce((n, e) => n + e.amount_cents, 0);
        if (today + input.amountCents > input.dailyCapCents) {
          return { outcome: "approval_required" as const };
        }
      }
      for (const a of accounts.values()) {
        if (a.tenant_id === input.tenantId && a.code_hash === input.codeHash) {
          return { outcome: "code_taken" as const };
        }
      }
      const at = nowIso();
      const a: MockAccount = {
        id: input.accountId,
        tenant_id: input.tenantId,
        kind: "store_credit",
        status: "active",
        currency: input.currency,
        balance_cents: 0,
        code_hash: input.codeHash,
        code_last4: input.codeLast4,
        physical: false,
        customer_id: input.customerId,
        recipient_name: null,
        recipient_email: null,
        sale_order_id: null,
        source: "issued",
        created_by: input.actorId,
        created_at: at,
        updated_at: at,
        activated_at: at,
        voided_at: null,
      };
      accounts.set(a.id, a);
      const entry = append(a, "issue", input.amountCents, input.amountCents, {
        idempotency_key: `issue:${a.id}`,
        location_id: input.locationId,
        reason: input.reason,
        actor_id: input.actorId,
        approved_by: input.isManager ? input.actorId : null,
      });
      return { outcome: "ok" as const, account: publicAccount(a), entry };
    });
  },

  async markCodeRevealed(tenantId, accountId) {
    return exclusive(async () => {
      const a = owned(tenantId, accountId);
      if (!a || a.source !== "online" || a.status !== "active" || revealed.has(a.id)) return false;
      revealed.add(a.id);
      return true;
    });
  },

  async guardCheck(keys) {
    const t = Date.now();
    let wait = 0;
    for (const k of keys) {
      const g = guard.get(k);
      if (g?.lockedUntil && g.lockedUntil > t) wait = Math.max(wait, Math.ceil((g.lockedUntil - t) / 1000));
    }
    return wait;
  },

  async guardFail(keys, limit, windowSeconds) {
    const t = Date.now();
    let wait = 0;
    for (const k of keys) {
      let g = guard.get(k);
      if (!g || g.windowStart + windowSeconds * 1000 <= t) g = { windowStart: t, failures: 0, lockedUntil: null };
      g.failures += 1;
      if (g.failures > limit) {
        g.lockedUntil = g.windowStart + windowSeconds * 1000;
        wait = Math.max(wait, Math.ceil((g.lockedUntil - t) / 1000));
      }
      guard.set(k, g);
    }
    return wait;
  },

  async getLedgerEntry(id) {
    const e = ledger.find((x) => x.id === id);
    return e ? { ...e } : null;
  },

  async credit(input): Promise<MutationResult> {
    return exclusive(async () => {
      const a = owned(input.tenantId, input.accountId);
      if (!a) return { ok: false, reason: "not_found" };
      const prior = findEntry(a.id, input.key);
      if (prior) return { ok: true, account: publicAccount(a), entry: { ...prior }, replayed: true };
      if (a.status === "voided") return { ok: false, reason: "inactive", account: publicAccount(a) };
      if (a.status === "pending" && !input.activate) {
        return { ok: false, reason: "inactive", account: publicAccount(a) };
      }
      if (input.requireSettledOrderId) {
        const driver = getPosDriver();
        const order = await driver.getOrder(input.requireSettledOrderId);
        if (
          !order ||
          order.tenant_id !== a.tenant_id ||
          UNPAYABLE_ORDER_STATUSES.includes(order.status) ||
          !isSettled(order, await driver.listPaymentsForOrder(order.id))
        ) {
          return { ok: false, reason: "not_settled", account: publicAccount(a) };
        }
      }
      if (input.kind === "refund") {
        // Capped at what the tender redeemed (the credit runs before the refund
        // is recorded): same rule as sv_credit.
        const of = (k: LedgerKind) =>
          ledger
            .filter((e) => e.account_id === a.id && e.payment_id === input.paymentId && e.kind === k)
            .reduce((n, e) => n + e.amount_cents, 0);
        if (!input.paymentId || -of("redeem") < of("refund") + input.amountCents) {
          return { ok: false, reason: "exceeds_max", account: publicAccount(a) };
        }
      }
      const moved = applyMovement(a.balance_cents, input.kind, input.amountCents, input.maxBalanceCents);
      if (!moved.ok) return { ok: false, reason: moved.reason, account: publicAccount(a) };
      if (input.activate && a.status === "pending") {
        a.status = "active";
        a.activated_at = nowIso();
      }
      const entry = append(a, input.kind, input.amountCents, moved.balanceAfter, {
        idempotency_key: input.key,
        location_id: input.locationId,
        order_id: input.orderId ?? null,
        payment_id: input.paymentId ?? null,
        reason: input.reason ?? null,
        actor_id: input.actorId ?? null,
        approved_by: input.approvedBy ?? null,
      });
      return { ok: true, account: publicAccount(a), entry, replayed: false };
    });
  },

  async debit(input): Promise<MutationResult> {
    return exclusive(async () => {
      const a = owned(input.tenantId, input.accountId);
      if (!a) return { ok: false, reason: "not_found" };
      const prior = findEntry(a.id, input.key);
      if (prior) return { ok: true, account: publicAccount(a), entry: { ...prior }, replayed: true };
      if (a.status !== "active") return { ok: false, reason: "inactive", account: publicAccount(a) };
      const moved = applyMovement(a.balance_cents, input.kind, input.amountCents);
      if (!moved.ok) return { ok: false, reason: moved.reason, account: publicAccount(a) };
      const entry = append(a, input.kind, -input.amountCents, moved.balanceAfter, {
        idempotency_key: input.key,
        location_id: input.locationId,
        order_id: input.orderId ?? null,
        reason: input.reason ?? null,
        actor_id: input.actorId ?? null,
      });
      return { ok: true, account: publicAccount(a), entry, replayed: false };
    });
  },

  async voidAccount(input): Promise<MutationResult> {
    return exclusive(async () => {
      const a = owned(input.tenantId, input.accountId);
      if (!a) return { ok: false, reason: "not_found" };
      if (a.status === "voided") {
        const prior = findEntry(a.id, input.key) ?? null;
        return { ok: true, account: publicAccount(a), entry: prior ? { ...prior } : null, replayed: true };
      }
      const entries = ledger.filter((e) => e.account_id === a.id);
      if (!isUnredeemed(entries)) {
        return { ok: false, reason: "has_activity", account: publicAccount(a) };
      }
      let entry: LedgerEntry | null = null;
      if (a.balance_cents > 0) {
        entry = append(a, "void", -a.balance_cents, 0, {
          idempotency_key: input.key,
          location_id: input.locationId,
          reason: input.reason,
          actor_id: input.actorId,
        });
      }
      a.status = "voided";
      a.voided_at = nowIso();
      return { ok: true, account: publicAccount(a), entry, replayed: false };
    });
  },

  async redeem(input) {
    return exclusive(async () => {
      if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
        return { ok: false as const, reason: "bad_amount" as const };
      }
      const a = owned(input.tenantId, input.accountId);
      if (!a) return { ok: false as const, reason: "not_found" as const };
      const driver = getPosDriver();

      // Replay on the tender id: same account + order = the original result.
      const existing = await driver.getPayment(input.paymentId);
      if (existing) {
        const entry = ledger.find((e) => e.payment_id === existing.id && e.kind === "redeem");
        if (entry && entry.account_id === a.id && existing.order_id === input.orderId) {
          return {
            ok: true as const,
            account: publicAccount(a),
            entry: { ...entry },
            paymentId: existing.id,
            replayed: true,
          };
        }
        return { ok: false as const, reason: "conflict" as const };
      }

      if (a.status !== "active") {
        return { ok: false as const, reason: "inactive" as const, account: publicAccount(a) };
      }
      const order = await driver.getOrder(input.orderId);
      if (!order || order.tenant_id !== a.tenant_id) {
        return { ok: false as const, reason: "order_not_found" as const };
      }
      if (UNPAYABLE_ORDER_STATUSES.includes(order.status) || order.core_ext?.stored_value) {
        return { ok: false as const, reason: "order_not_payable" as const };
      }
      if (order.currency.toUpperCase() !== a.currency.toUpperCase()) {
        return { ok: false as const, reason: "currency" as const };
      }
      const remaining = remainingCents(order, await driver.listPaymentsForOrder(order.id));
      if (input.amountCents > remaining) {
        return { ok: false as const, reason: "exceeds_due" as const };
      }
      const moved = applyMovement(a.balance_cents, "redeem", input.amountCents);
      if (!moved.ok) {
        return {
          ok: false as const,
          reason: moved.reason === "bad_amount" ? ("bad_amount" as const) : ("insufficient" as const),
          account: publicAccount(a),
        };
      }
      const entry = append(a, "redeem", -input.amountCents, moved.balanceAfter, {
        idempotency_key: `redeem:${input.paymentId}`,
        location_id: order.location_id,
        order_id: order.id,
        payment_id: input.paymentId,
        actor_id: input.actorId,
      });
      const at = nowIso();
      const payment: Payment = {
        id: input.paymentId,
        order_id: order.id,
        tenant_id: order.tenant_id,
        location_id: order.location_id,
        rail: a.kind,
        status: "captured",
        amount_cents: input.amountCents,
        tip_cents: 0,
        application_fee_cents: 0,
        currency: order.currency,
        charge_id: entry.id,
        connect_account_id: null,
        crypto_tx_hash: null,
        crypto_chain: null,
        cash_tendered_cents: null,
        cash_change_cents: null,
        refunded_cents: 0,
        simulated: false,
        staff_id: input.staffId,
        raw: { stored_value_account_id: a.id, code_last4: a.code_last4, kind: a.kind },
        created_at: at,
        updated_at: at,
      };
      try {
        await driver.upsertPayment(payment);
      } catch (err) {
        // Undo the debit: no tender, no movement (the SQL writer is one transaction).
        ledger.splice(ledger.findIndex((e) => e.id === entry.id), 1);
        a.balance_cents += input.amountCents;
        throw err;
      }
      return {
        ok: true as const,
        account: publicAccount(a),
        entry,
        paymentId: payment.id,
        replayed: false,
      };
    });
  },
};

/** Test helper: drop every account and ledger row. */
export function resetMockStoredValue(): void {
  accounts.clear();
  ledger.length = 0;
  revealed.clear();
  guard.clear();
}
