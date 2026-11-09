-- ============================================================================
-- Migration: stored_value  (gift cards + store credit, part 2 of 2)
--
-- Storage and the atomic writers behind src/lib/giftcards (store-supabase.ts).
--
--   * stored_value_accounts: one row per gift card / store-credit account. The
--     code is NEVER stored: `code_hash` is HMAC-SHA256(server pepper, tenant +
--     normalized code), unique per tenant, plus `code_last4` for display.
--     `balance_cents` is a CACHE of the ledger (always = the last ledger row's
--     balance_after_cents), maintained only by the writers below.
--   * stored_value_ledger: APPEND-ONLY. Signed amounts (credits issue/load/refund
--     > 0, debits redeem/reverse/void < 0), the balance each row produced, and a
--     per-account idempotency key (a replay writes nothing). A trigger refuses
--     every UPDATE and DELETE.
--   * Writers (SECURITY DEFINER, service_role only), each ONE transaction:
--       sv_credit   issue / load (activating a paid sale) / refund-to-card
--       sv_debit    reverse a refunded reload
--       sv_void     close an UNREDEEMED card (its sale is then refunded)
--       sv_redeem   debit the card AND insert the gift_card / store_credit tender
--     Each locks the account row FOR UPDATE, so two tills redeeming one card
--     serialize and can never overspend it. sv_redeem locks the ORDER first and
--     then the account (no writer locks them in the other order: no deadlock),
--     and re-checks what the order still owes under that lock, so stored value
--     can never overpay an order either.
--
-- No client access: RLS on with no policies, and every grant revoked from anon
-- and authenticated. The app reads and writes with the service role only.
--
-- Additive and live-safe: two new tables, five new functions. Needs
-- 20261113000400 (the enum values) applied first.
-- ============================================================================

begin;
set local lock_timeout = '3s';

create table if not exists public.stored_value_accounts (
  id uuid primary key,
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  kind text not null check (kind in ('gift_card', 'store_credit')),
  status text not null check (status in ('pending', 'active', 'voided')),
  currency text not null default 'USD',
  balance_cents integer not null default 0 check (balance_cents >= 0),
  code_hash text not null,
  code_last4 text not null,
  physical boolean not null default false,
  customer_id uuid references public.customers (id) on delete set null,
  recipient_name text,
  recipient_email text,
  sale_order_id uuid references public.orders (id) on delete set null,
  source text not null check (source in ('till', 'online', 'issued')),
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  activated_at timestamptz,
  voided_at timestamptz,
  constraint stored_value_accounts_code_uq unique (tenant_id, code_hash)
);
create index if not exists stored_value_accounts_tenant_idx
  on public.stored_value_accounts (tenant_id, created_at desc);
create index if not exists stored_value_accounts_customer_idx
  on public.stored_value_accounts (customer_id) where customer_id is not null;

create table if not exists public.stored_value_ledger (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.stored_value_accounts (id) on delete restrict,
  tenant_id uuid not null references public.tenants (id) on delete restrict,
  location_id uuid,
  kind text not null check (kind in ('issue', 'load', 'refund', 'redeem', 'reverse', 'void')),
  amount_cents integer not null,
  balance_after_cents integer not null check (balance_after_cents >= 0),
  order_id uuid,
  payment_id uuid,
  idempotency_key text not null,
  reason text,
  actor_id text,
  approved_by text,
  created_at timestamptz not null default now(),
  constraint stored_value_ledger_sign_ck check (
    (kind in ('issue', 'load', 'refund') and amount_cents > 0)
    or (kind in ('redeem', 'reverse', 'void') and amount_cents < 0)
  ),
  constraint stored_value_ledger_key_uq unique (account_id, idempotency_key)
);
create index if not exists stored_value_ledger_account_idx
  on public.stored_value_ledger (account_id, created_at);
create index if not exists stored_value_ledger_tenant_idx
  on public.stored_value_ledger (tenant_id, created_at);
create index if not exists stored_value_ledger_payment_idx
  on public.stored_value_ledger (payment_id) where payment_id is not null;

-- ---- append-only ------------------------------------------------------------
create or replace function public.sv_ledger_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'stored_value_ledger is append-only (% refused)', tg_op;
end;
$$;

drop trigger if exists stored_value_ledger_append_only on public.stored_value_ledger;
create trigger stored_value_ledger_append_only
  before update or delete on public.stored_value_ledger
  for each row execute function public.sv_ledger_append_only();

-- ---- no client access ---------------------------------------------------------
alter table public.stored_value_accounts enable row level security;
alter table public.stored_value_ledger enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table public.stored_value_accounts, public.stored_value_ledger from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table public.stored_value_accounts, public.stored_value_ledger from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert on table public.stored_value_accounts, public.stored_value_ledger to service_role;
  end if;
end
$$;

-- ---- helpers ------------------------------------------------------------------

-- What the order still owes / whether settled money covers it. Same rules as
-- src/lib/giftcards/order-math.ts (and orderDueCents in the payment service):
-- due = total - order-level tip; covering = pending/authorized/captured base
-- amounts, settled = captured/authorized, both in the order's currency.
create or replace function public.sv_order_due(p_order public.orders)
returns bigint
language sql
immutable
as $$
  select greatest(
    0,
    coalesce((p_order.totals ->> 'total_cents')::bigint, 0)
      - coalesce((p_order.totals ->> 'tip_cents')::bigint, 0)
  );
$$;

create or replace function public.sv_order_sum(p_order public.orders, p_statuses text[])
returns bigint
language sql
stable
set search_path = public
as $$
  select coalesce(sum(p.amount_cents), 0)::bigint
    from public.payments p
   where p.order_id = p_order.id
     and upper(p.currency) = upper(p_order.currency)
     and p.status::text = any (p_statuses);
$$;

-- ---- sv_credit ----------------------------------------------------------------
-- Outcomes: ok (replayed true|false) | not_found | inactive | not_settled |
--           bad_amount | exceeds_max
create or replace function public.sv_credit(
  p_tenant_id uuid,
  p_account_id uuid,
  p_location_id uuid,
  p_kind text,
  p_amount integer,
  p_key text,
  p_order_id uuid default null,
  p_payment_id uuid default null,
  p_reason text default null,
  p_actor_id text default null,
  p_approved_by text default null,
  p_activate boolean default false,
  p_require_settled_order uuid default null,
  p_max_balance integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_acct public.stored_value_accounts;
  v_prior public.stored_value_ledger;
  v_order public.orders;
  v_entry public.stored_value_ledger;
  v_after bigint;
begin
  if p_kind not in ('issue', 'load', 'refund') then
    raise exception 'sv_credit: bad kind %', p_kind;
  end if;

  select * into v_acct from public.stored_value_accounts
   where id = p_account_id and tenant_id = p_tenant_id
   for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  select * into v_prior from public.stored_value_ledger
   where account_id = p_account_id and idempotency_key = p_key;
  if found then
    return jsonb_build_object('outcome', 'ok', 'replayed', true,
      'account', to_jsonb(v_acct), 'entry', to_jsonb(v_prior));
  end if;

  if v_acct.status = 'voided' or (v_acct.status = 'pending' and not p_activate) then
    return jsonb_build_object('outcome', 'inactive', 'account', to_jsonb(v_acct));
  end if;

  if p_require_settled_order is not null then
    select * into v_order from public.orders
     where id = p_require_settled_order and tenant_id = p_tenant_id;
    if not found
       or v_order.status::text in ('voided', 'abandoned', 'refunded')
       or public.sv_order_sum(v_order, array['captured', 'authorized'])
          < public.sv_order_due(v_order) then
      return jsonb_build_object('outcome', 'not_settled', 'account', to_jsonb(v_acct));
    end if;
  end if;

  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('outcome', 'bad_amount', 'account', to_jsonb(v_acct));
  end if;
  v_after := v_acct.balance_cents::bigint + p_amount;
  if p_max_balance is not null and v_after > p_max_balance then
    return jsonb_build_object('outcome', 'exceeds_max', 'account', to_jsonb(v_acct));
  end if;

  update public.stored_value_accounts
     set balance_cents = v_after,
         status = case when p_activate and status = 'pending' then 'active' else status end,
         activated_at = case when p_activate and status = 'pending' then now() else activated_at end,
         updated_at = now()
   where id = p_account_id
  returning * into v_acct;

  insert into public.stored_value_ledger (
    account_id, tenant_id, location_id, kind, amount_cents, balance_after_cents,
    order_id, payment_id, idempotency_key, reason, actor_id, approved_by
  ) values (
    p_account_id, p_tenant_id, p_location_id, p_kind, p_amount, v_after,
    p_order_id, p_payment_id, p_key, p_reason, p_actor_id, p_approved_by
  ) returning * into v_entry;

  return jsonb_build_object('outcome', 'ok', 'replayed', false,
    'account', to_jsonb(v_acct), 'entry', to_jsonb(v_entry));
end;
$$;

-- ---- sv_debit (reverse a refunded reload) --------------------------------------
-- Outcomes: ok | not_found | inactive | bad_amount | insufficient
create or replace function public.sv_debit(
  p_tenant_id uuid,
  p_account_id uuid,
  p_location_id uuid,
  p_kind text,
  p_amount integer,
  p_key text,
  p_order_id uuid default null,
  p_reason text default null,
  p_actor_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_acct public.stored_value_accounts;
  v_prior public.stored_value_ledger;
  v_entry public.stored_value_ledger;
begin
  if p_kind <> 'reverse' then
    raise exception 'sv_debit: bad kind %', p_kind;
  end if;

  select * into v_acct from public.stored_value_accounts
   where id = p_account_id and tenant_id = p_tenant_id
   for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  select * into v_prior from public.stored_value_ledger
   where account_id = p_account_id and idempotency_key = p_key;
  if found then
    return jsonb_build_object('outcome', 'ok', 'replayed', true,
      'account', to_jsonb(v_acct), 'entry', to_jsonb(v_prior));
  end if;

  if v_acct.status <> 'active' then
    return jsonb_build_object('outcome', 'inactive', 'account', to_jsonb(v_acct));
  end if;
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('outcome', 'bad_amount', 'account', to_jsonb(v_acct));
  end if;
  if v_acct.balance_cents < p_amount then
    return jsonb_build_object('outcome', 'insufficient', 'account', to_jsonb(v_acct));
  end if;

  update public.stored_value_accounts
     set balance_cents = balance_cents - p_amount, updated_at = now()
   where id = p_account_id
  returning * into v_acct;

  insert into public.stored_value_ledger (
    account_id, tenant_id, location_id, kind, amount_cents, balance_after_cents,
    order_id, idempotency_key, reason, actor_id
  ) values (
    p_account_id, p_tenant_id, p_location_id, p_kind, -p_amount, v_acct.balance_cents,
    p_order_id, p_key, p_reason, p_actor_id
  ) returning * into v_entry;

  return jsonb_build_object('outcome', 'ok', 'replayed', false,
    'account', to_jsonb(v_acct), 'entry', to_jsonb(v_entry));
end;
$$;

-- ---- sv_void (only an UNREDEEMED card) -------------------------------------------
-- Outcomes: ok (replayed) | not_found | has_activity
create or replace function public.sv_void(
  p_tenant_id uuid,
  p_account_id uuid,
  p_location_id uuid,
  p_key text,
  p_reason text default null,
  p_actor_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_acct public.stored_value_accounts;
  v_entry public.stored_value_ledger;
begin
  select * into v_acct from public.stored_value_accounts
   where id = p_account_id and tenant_id = p_tenant_id
   for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_acct.status = 'voided' then
    select * into v_entry from public.stored_value_ledger
     where account_id = p_account_id and idempotency_key = p_key;
    return jsonb_build_object('outcome', 'ok', 'replayed', true,
      'account', to_jsonb(v_acct),
      'entry', case when v_entry.id is null then null else to_jsonb(v_entry) end);
  end if;

  -- Unredeemed: nothing but issue/load credits ever touched it.
  if exists (
    select 1 from public.stored_value_ledger
     where account_id = p_account_id and kind not in ('issue', 'load')
  ) then
    return jsonb_build_object('outcome', 'has_activity', 'account', to_jsonb(v_acct));
  end if;

  if v_acct.balance_cents > 0 then
    insert into public.stored_value_ledger (
      account_id, tenant_id, location_id, kind, amount_cents, balance_after_cents,
      idempotency_key, reason, actor_id
    ) values (
      p_account_id, p_tenant_id, p_location_id, 'void', -v_acct.balance_cents, 0,
      p_key, p_reason, p_actor_id
    ) returning * into v_entry;
  end if;

  update public.stored_value_accounts
     set balance_cents = 0, status = 'voided', voided_at = now(), updated_at = now()
   where id = p_account_id
  returning * into v_acct;

  return jsonb_build_object('outcome', 'ok', 'replayed', false,
    'account', to_jsonb(v_acct),
    'entry', case when v_entry.id is null then null else to_jsonb(v_entry) end);
end;
$$;

-- ---- sv_redeem (debit + tender, one transaction) ---------------------------------
-- Outcomes: ok (replayed) | bad_amount | order_not_found | conflict | not_found |
--           inactive | order_not_payable | currency | exceeds_due | insufficient
create or replace function public.sv_redeem(
  p_tenant_id uuid,
  p_account_id uuid,
  p_order_id uuid,
  p_payment_id uuid,
  p_amount integer,
  p_actor_id text default null,
  p_staff_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders;
  v_acct public.stored_value_accounts;
  v_pay public.payments;
  v_entry public.stored_value_ledger;
  v_remaining bigint;
begin
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('outcome', 'bad_amount');
  end if;

  -- Lock order: ORDER first, then the account (every writer agrees).
  select * into v_order from public.orders
   where id = p_order_id and tenant_id = p_tenant_id
   for update;
  if not found then
    return jsonb_build_object('outcome', 'order_not_found');
  end if;

  -- Replay on the tender id.
  select * into v_pay from public.payments where id = p_payment_id;
  if found then
    select * into v_entry from public.stored_value_ledger
     where payment_id = p_payment_id and kind = 'redeem'
     limit 1;
    if v_entry.id is not null and v_entry.account_id = p_account_id
       and v_pay.order_id = p_order_id then
      select * into v_acct from public.stored_value_accounts where id = p_account_id;
      return jsonb_build_object('outcome', 'ok', 'replayed', true,
        'account', to_jsonb(v_acct), 'entry', to_jsonb(v_entry),
        'payment_id', p_payment_id);
    end if;
    return jsonb_build_object('outcome', 'conflict');
  end if;

  select * into v_acct from public.stored_value_accounts
   where id = p_account_id and tenant_id = p_tenant_id
   for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if v_acct.status <> 'active' then
    return jsonb_build_object('outcome', 'inactive', 'account', to_jsonb(v_acct));
  end if;
  if v_order.status::text in ('voided', 'abandoned', 'refunded')
     or (v_order.core_ext ? 'stored_value') then
    return jsonb_build_object('outcome', 'order_not_payable');
  end if;
  if upper(v_order.currency) <> upper(v_acct.currency) then
    return jsonb_build_object('outcome', 'currency');
  end if;

  v_remaining := public.sv_order_due(v_order)
    - public.sv_order_sum(v_order, array['pending', 'authorized', 'captured']);
  if p_amount > v_remaining then
    return jsonb_build_object('outcome', 'exceeds_due');
  end if;
  if v_acct.balance_cents < p_amount then
    return jsonb_build_object('outcome', 'insufficient', 'account', to_jsonb(v_acct));
  end if;

  update public.stored_value_accounts
     set balance_cents = balance_cents - p_amount, updated_at = now()
   where id = p_account_id
  returning * into v_acct;

  insert into public.stored_value_ledger (
    account_id, tenant_id, location_id, kind, amount_cents, balance_after_cents,
    order_id, payment_id, idempotency_key, actor_id
  ) values (
    p_account_id, p_tenant_id, v_order.location_id, 'redeem', -p_amount,
    v_acct.balance_cents, p_order_id, p_payment_id, 'redeem:' || p_payment_id::text,
    p_actor_id
  ) returning * into v_entry;

  insert into public.payments (
    id, order_id, tenant_id, location_id, rail, status, amount_cents, tip_cents,
    application_fee_cents, currency, charge_id, simulated, raw, staff_id
  ) values (
    p_payment_id, p_order_id, p_tenant_id, v_order.location_id,
    v_acct.kind::public.payment_rail, 'captured', p_amount, 0,
    0, v_order.currency, v_entry.id::text, false,
    jsonb_build_object('stored_value_account_id', v_acct.id,
                       'code_last4', v_acct.code_last4,
                       'kind', v_acct.kind),
    p_staff_id
  );

  return jsonb_build_object('outcome', 'ok', 'replayed', false,
    'account', to_jsonb(v_acct), 'entry', to_jsonb(v_entry),
    'payment_id', p_payment_id);
end;
$$;

-- ---- grants: service_role only ---------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.sv_credit(uuid, uuid, uuid, text, integer, text, uuid, uuid, text, text, text, boolean, uuid, integer)',
    'public.sv_debit(uuid, uuid, uuid, text, integer, text, uuid, text, text)',
    'public.sv_void(uuid, uuid, uuid, text, text, text)',
    'public.sv_redeem(uuid, uuid, uuid, uuid, integer, text, uuid)',
    'public.sv_order_due(public.orders)',
    'public.sv_order_sum(public.orders, text[])'
  ] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function %s from anon', f);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on function %s from authenticated', f);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', f);
    end if;
  end loop;
end
$$;

commit;

notify pgrst, 'reload schema';
