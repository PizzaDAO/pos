/**
 * Supabase stored-value writer: thin RPC glue over the SECURITY DEFINER
 * functions in supabase/migrations/20261113000410_stored_value.sql (all of the
 * checking, locking and arithmetic happens there, in one transaction). Uses the
 * service-role client; every query names the tenant.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { SupabaseDriverConfig } from "@/lib/db/supabase";
import type { StoredValueStore } from "./store";
import type {
  LedgerEntry,
  MutationFailure,
  MutationResult,
  RedeemFailure,
  StoredValueAccount,
} from "./types";

type Row = Record<string, unknown>;

const ACCOUNT_COLUMNS =
  "id, tenant_id, kind, status, currency, balance_cents, code_last4, physical, customer_id, recipient_name, recipient_email, sale_order_id, source, created_by, created_at, updated_at, activated_at, voided_at";

function mapAccount(r: Row): StoredValueAccount {
  return {
    id: r.id as string,
    tenant_id: r.tenant_id as string,
    kind: r.kind as StoredValueAccount["kind"],
    status: r.status as StoredValueAccount["status"],
    currency: (r.currency as string) ?? "USD",
    balance_cents: Number(r.balance_cents ?? 0),
    code_last4: r.code_last4 as string,
    physical: r.physical === true,
    customer_id: (r.customer_id as string | null) ?? null,
    recipient_name: (r.recipient_name as string | null) ?? null,
    recipient_email: (r.recipient_email as string | null) ?? null,
    sale_order_id: (r.sale_order_id as string | null) ?? null,
    source: r.source as StoredValueAccount["source"],
    created_by: (r.created_by as string | null) ?? null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
    activated_at: (r.activated_at as string | null) ?? null,
    voided_at: (r.voided_at as string | null) ?? null,
  };
}

function mapEntry(r: Row): LedgerEntry {
  return {
    id: r.id as string,
    account_id: r.account_id as string,
    tenant_id: r.tenant_id as string,
    location_id: (r.location_id as string | null) ?? null,
    kind: r.kind as LedgerEntry["kind"],
    amount_cents: Number(r.amount_cents),
    balance_after_cents: Number(r.balance_after_cents),
    order_id: (r.order_id as string | null) ?? null,
    payment_id: (r.payment_id as string | null) ?? null,
    idempotency_key: r.idempotency_key as string,
    reason: (r.reason as string | null) ?? null,
    actor_id: (r.actor_id as string | null) ?? null,
    approved_by: (r.approved_by as string | null) ?? null,
    created_at: r.created_at as string,
  };
}

function unwrap<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(`stored value: ${res.error.message}`);
  return res.data;
}

interface RpcOut {
  outcome: string;
  replayed?: boolean;
  account?: Row;
  entry?: Row | null;
  payment_id?: string;
}

function mutation(out: RpcOut): MutationResult {
  const account = out.account ? mapAccount(out.account) : null;
  if (out.outcome === "ok" && account) {
    return {
      ok: true,
      account,
      entry: out.entry ? mapEntry(out.entry) : null,
      replayed: out.replayed === true,
    };
  }
  return { ok: false, reason: out.outcome as MutationFailure, account };
}

export function createSupabaseStoredValueStore(config: SupabaseDriverConfig): StoredValueStore {
  const sb: SupabaseClient = createClient(config.url, config.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return {
    name: "supabase",

    async createAccount(row) {
      const res = await sb.from("stored_value_accounts").insert(row).select(ACCOUNT_COLUMNS).single();
      if (res.error?.message.includes("stored_value_accounts_code_uq")) {
        return { ok: false, reason: "code_taken" };
      }
      return { ok: true, account: mapAccount(unwrap(res) as Row) };
    },

    async getAccount(tenantId, id) {
      const r = unwrap(
        await sb
          .from("stored_value_accounts")
          .select(ACCOUNT_COLUMNS)
          .eq("tenant_id", tenantId)
          .eq("id", id)
          .maybeSingle(),
      ) as Row | null;
      return r ? mapAccount(r) : null;
    },

    async findByCodeHash(tenantId, codeHash) {
      const r = unwrap(
        await sb
          .from("stored_value_accounts")
          .select(ACCOUNT_COLUMNS)
          .eq("tenant_id", tenantId)
          .eq("code_hash", codeHash)
          .maybeSingle(),
      ) as Row | null;
      return r ? mapAccount(r) : null;
    },

    async listAccounts(tenantId, opts = {}) {
      let q = sb
        .from("stored_value_accounts")
        .select(ACCOUNT_COLUMNS)
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false })
        .limit(Math.min(Math.max(opts.limit ?? 200, 1), 500));
      if (opts.kind) q = q.eq("kind", opts.kind);
      if (opts.customerId) q = q.eq("customer_id", opts.customerId);
      return ((unwrap(await q) as Row[] | null) ?? []).map(mapAccount);
    },

    async listLedger(tenantId, accountId) {
      const rows = unwrap(
        await sb
          .from("stored_value_ledger")
          .select("*")
          .eq("tenant_id", tenantId)
          .eq("account_id", accountId)
          .order("created_at", { ascending: true })
          .limit(5000),
      ) as Row[] | null;
      return (rows ?? []).map(mapEntry);
    },

    async listLedgerBetween(tenantId, fromIso, toIso) {
      const rows = unwrap(
        await sb
          .from("stored_value_ledger")
          .select("*")
          .eq("tenant_id", tenantId)
          .gte("created_at", fromIso)
          .lt("created_at", toIso)
          .order("created_at", { ascending: true })
          .limit(10000),
      ) as Row[] | null;
      return (rows ?? []).map(mapEntry);
    },

    async getLedgerEntry(id) {
      const r = unwrap(
        await sb.from("stored_value_ledger").select("*").eq("id", id).maybeSingle(),
      ) as Row | null;
      return r ? mapEntry(r) : null;
    },

    async credit(input) {
      const out = unwrap(
        await sb.rpc("sv_credit", {
          p_tenant_id: input.tenantId,
          p_account_id: input.accountId,
          p_location_id: input.locationId,
          p_kind: input.kind,
          p_amount: input.amountCents,
          p_key: input.key,
          p_order_id: input.orderId ?? null,
          p_payment_id: input.paymentId ?? null,
          p_reason: input.reason ?? null,
          p_actor_id: input.actorId ?? null,
          p_approved_by: input.approvedBy ?? null,
          p_activate: input.activate === true,
          p_require_settled_order: input.requireSettledOrderId ?? null,
          p_max_balance: input.maxBalanceCents ?? null,
        }),
      ) as RpcOut;
      return mutation(out);
    },

    async debit(input) {
      const out = unwrap(
        await sb.rpc("sv_debit", {
          p_tenant_id: input.tenantId,
          p_account_id: input.accountId,
          p_location_id: input.locationId,
          p_kind: input.kind,
          p_amount: input.amountCents,
          p_key: input.key,
          p_order_id: input.orderId ?? null,
          p_reason: input.reason ?? null,
          p_actor_id: input.actorId ?? null,
        }),
      ) as RpcOut;
      return mutation(out);
    },

    async voidAccount(input) {
      const out = unwrap(
        await sb.rpc("sv_void", {
          p_tenant_id: input.tenantId,
          p_account_id: input.accountId,
          p_location_id: input.locationId,
          p_key: input.key,
          p_reason: input.reason,
          p_actor_id: input.actorId,
        }),
      ) as RpcOut;
      return mutation(out);
    },

    async redeem(input) {
      const out = unwrap(
        await sb.rpc("sv_redeem", {
          p_tenant_id: input.tenantId,
          p_account_id: input.accountId,
          p_order_id: input.orderId,
          p_payment_id: input.paymentId,
          p_amount: input.amountCents,
          p_actor_id: input.actorId,
          p_staff_id: input.staffId,
        }),
      ) as RpcOut;
      if (out.outcome === "ok" && out.account && out.entry && out.payment_id) {
        return {
          ok: true,
          account: mapAccount(out.account),
          entry: mapEntry(out.entry),
          paymentId: out.payment_id,
          replayed: out.replayed === true,
        };
      }
      return {
        ok: false,
        reason: out.outcome as RedeemFailure,
        account: out.account ? mapAccount(out.account) : null,
      };
    },
  };
}
