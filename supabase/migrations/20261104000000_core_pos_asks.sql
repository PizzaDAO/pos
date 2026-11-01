-- ============================================================================
-- Migration: core_pos_asks  (Open Pizza core 0.3.x "POS asks")
--
--   1. order_items.fired_at / voided_at / status_at_void, stamped by triggers on
--      every path that fires or voids a line (terminal, shop, /v1, KDS status
--      moves, any later line insert into a live order). Exposed as
--      OrderLine.fired_at / voided_at / status_at_void.
--   2. payments.refunds jsonb: one entry per refund with a stable server-minted
--      id (+ amount, at, processor_ref, reason), appended in the SAME atomic
--      UPDATE that reserves the refund. Exposed as Payment.refunds[] and the
--      `refund` on payment.refunded events.
--   3. Defense in depth for staff identity: a manager cannot change the email of
--      an owner (or anyone ranked above them), and cannot change the login or
--      role of an owner's / higher-ranked staff row (nor promote their own).
--
-- All additive and live-safe: nullable / defaulted column adds are metadata-only
-- (no table rewrite, no long lock); triggers and functions are replaced
-- idempotently; no data is rewritten. Legacy rows keep NULL stamps and no
-- refunds entries (the API synthesizes one stable `<payment>:legacy` refund for
-- money refunded before per-refund records existed).
-- ============================================================================

-- One explicit transaction (psql -f / apply.sh would otherwise autocommit each
-- statement, splitting the DROP + CREATE of reserve_payment_refund). Fail fast
-- instead of queueing behind a long lock on a live database.
begin;
set local lock_timeout = '3s';

-- ---- 1. per-line fire / void stamps -------------------------------------------
alter table public.order_items
  add column if not exists fired_at timestamptz,
  add column if not exists voided_at timestamptz,
  add column if not exists status_at_void text;

-- "Live" = the same list as src/lib/db/menu-types.ts NOT_LIVE_ORDER_STATUSES and
-- orders.core_announced: draft, awaiting_payment, voided, abandoned, refunded
-- are NOT live (not on the KDS).

-- A line written into an order. Voided on arrival (terminal cart void, kept for
-- audit) = voided before it was ever sent: voided_at + the order's status, no
-- fired_at. Otherwise, into a live order = fired now (a line added to an
-- already-fired ticket); into a held / unpaid order = fired later, when the
-- order goes live (trigger below).
create or replace function public.order_items_stamp_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  select o.status::text into v_status from public.orders o
   where o.id = new.order_id
     for share; -- wait out a concurrent status change (see orders_fire_lines)
  if new.voided then
    new.voided_at := now();
    new.status_at_void := v_status;
    new.fired_at := null;
  elsif v_status is not null
        and v_status not in ('draft', 'awaiting_payment', 'voided', 'abandoned', 'refunded') then
    new.fired_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists order_items_stamp_insert on public.order_items;
create trigger order_items_stamp_insert
  before insert on public.order_items
  for each row execute function public.order_items_stamp_insert();

-- A later void (voided false -> true) records when and at which order status.
create or replace function public.order_items_stamp_void()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.voided and not old.voided then
    new.voided_at := now();
    select o.status::text into new.status_at_void
      from public.orders o where o.id = new.order_id;
  elsif not new.voided and old.voided then
    new.voided_at := null;
    new.status_at_void := null;
  end if;
  return new;
end;
$$;

drop trigger if exists order_items_stamp_void on public.order_items;
create trigger order_items_stamp_void
  before update of voided on public.order_items
  for each row execute function public.order_items_stamp_void();

-- An order going live (released from a hold, paid, ...) fires its unfired,
-- unvoided lines. One UPDATE; a no-op once they are fired. A concurrent line
-- insert takes FOR SHARE on the order row first (order_items_stamp_insert), so
-- it either waits for this status UPDATE to commit and then sees the live
-- status, or commits before it and is fired here; it cannot be missed.
create or replace function public.orders_fire_lines()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status::text in ('draft', 'awaiting_payment', 'voided', 'abandoned', 'refunded') then
    return new;
  end if;
  if old.status::text not in ('draft', 'awaiting_payment', 'voided', 'abandoned', 'refunded') then
    return new; -- was already live
  end if;
  update public.order_items
     set fired_at = now()
   where order_id = new.id and fired_at is null and not voided;
  return new;
end;
$$;

drop trigger if exists orders_fire_lines on public.orders;
create trigger orders_fire_lines
  after update of status on public.orders
  for each row
  when (old.status is distinct from new.status)
  execute function public.orders_fire_lines();

-- ---- 2. per-refund records on payments ----------------------------------------
alter table public.payments
  add column if not exists refunds jsonb not null default '[]'::jsonb;

-- Replaces the 3-arg function with a 5-arg one (the extra args default to NULL,
-- so a caller that still sends 3 named args keeps working). Dropping the old
-- overload in the same transaction avoids an ambiguous named-argument call.
drop function if exists public.reserve_payment_refund(uuid, integer, text);

create or replace function public.reserve_payment_refund(
  p_payment_id uuid,
  p_amount integer,
  p_refund_id text,
  p_processor_ref text default null,
  p_reason text default null
) returns jsonb
language plpgsql
as $$
declare
  r public.payments;
  v_entry text := gen_random_uuid()::text;
begin
  update public.payments p
     set refunded_cents = p.refunded_cents + p_amount,
         refund_ids = case
           when p_refund_id is null then p.refund_ids
           else p.refund_ids || p_refund_id
         end,
         refunds = p.refunds || jsonb_build_array(jsonb_build_object(
           'id', v_entry,
           'amount_cents', p_amount,
           'at', to_jsonb(now()),
           'processor_ref', p_processor_ref,
           'reason', p_reason,
           'request_id', p_refund_id
         )),
         status = case
           when p.refunded_cents + p_amount >= p.amount_cents + p.tip_cents
             then 'refunded'::public.payment_status
           else p.status
         end,
         updated_at = now()
   where p.id = p_payment_id
     and p_amount > 0
     and p.status in ('captured', 'authorized')
     and p.refunded_cents + p_amount <= p.amount_cents + p.tip_cents
     and (p_refund_id is null or not (p_refund_id = any (p.refund_ids)))
  returning * into r;

  if found then
    return jsonb_build_object('outcome', 'ok', 'payment', to_jsonb(r),
                              'refund_entry_id', v_entry);
  end if;

  select * into r from public.payments where id = p_payment_id;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if p_refund_id is not null and p_refund_id = any (r.refund_ids) then
    return jsonb_build_object('outcome', 'duplicate', 'payment', to_jsonb(r));
  end if;
  return jsonb_build_object('outcome', 'exceeds', 'payment', to_jsonb(r));
end;
$$;

-- Undo a reservation whose rail call failed: also drops its refunds[] entry
-- (the one reserved under p_refund_id, else the latest of that amount).
create or replace function public.release_payment_refund(
  p_payment_id uuid,
  p_amount integer,
  p_refund_id text
) returns void
language plpgsql
as $$
declare
  v_idx bigint;
begin
  -- Lock the row first so concurrent releases serialize and each computes its
  -- index against the other's result.
  perform 1 from public.payments where id = p_payment_id for update;

  select t.o into v_idx
    from public.payments p,
         jsonb_array_elements(p.refunds) with ordinality as t(e, o)
   where p.id = p_payment_id
     and ((p_refund_id is not null and t.e ->> 'request_id' = p_refund_id)
          or (p_refund_id is null and (t.e ->> 'amount_cents')::integer = p_amount))
   order by t.o desc
   limit 1;

  update public.payments p
     set refunded_cents = greatest(0, p.refunded_cents - p_amount),
         refund_ids = case
           when p_refund_id is null then p.refund_ids
           else array_remove(p.refund_ids, p_refund_id)
         end,
         refunds = case
           when v_idx is null then p.refunds
           else coalesce((
             select jsonb_agg(t.e order by t.o)
               from jsonb_array_elements(p.refunds) with ordinality as t(e, o)
              where t.o <> v_idx
           ), '[]'::jsonb)
         end,
         status = case
           when p.status = 'refunded' then 'captured'::public.payment_status
           else p.status
         end,
         updated_at = now()
   where p.id = p_payment_id;
end;
$$;

revoke all on function public.reserve_payment_refund(uuid, integer, text, text, text)
  from public, anon, authenticated;
revoke all on function public.release_payment_refund(uuid, integer, text)
  from public, anon, authenticated;
grant execute on function public.reserve_payment_refund(uuid, integer, text, text, text)
  to service_role;
grant execute on function public.release_payment_refund(uuid, integer, text)
  to service_role;

-- ---- 3. staff identity guards (defense in depth) -------------------------------
-- Rank of a membership role: higher = more powerful.
create or replace function public.membership_rank(p_role public.membership_role)
returns integer
language sql
immutable
as $$
  select case p_role
    when 'owner' then 4
    when 'manager' then 3
    when 'cashier' then 2
    else 1
  end;
$$;

-- The hub staff login trusts POS staff emails (identity bound to the first
-- email that signs in), so a manager must never change the email of an owner or
-- anyone ranked above them. RLS already limits users UPDATE to self / platform
-- admin; this holds even if a policy or a server path later widens it.
-- Trusted without checks: no JWT user (service role, the auth.users bridge,
-- migrations), the user themself, and platform admins.
create or replace function public.guard_user_email_edit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
begin
  if new.email is not distinct from old.email then
    return new;
  end if;
  if v_actor is null or v_actor = old.id or public.is_platform_admin() then
    return new;
  end if;
  -- Someone else's email: only by a member who outranks-or-equals the target in
  -- EVERY tenant the target belongs to, and shares at least one with them.
  if not exists (
       select 1 from public.memberships t
         join public.memberships a
           on a.tenant_id = t.tenant_id and a.user_id = v_actor
        where t.user_id = old.id)
     or exists (
       select 1 from public.memberships t
        where t.user_id = old.id
          and public.membership_rank(t.role) > coalesce((
                select public.membership_rank(a.role)
                  from public.memberships a
                 where a.tenant_id = t.tenant_id and a.user_id = v_actor), 0))
  then
    raise exception 'not allowed to change this staff member''s email'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists users_guard_email_edit on public.users;
create trigger users_guard_email_edit
  before update of email on public.users
  for each row execute function public.guard_user_email_edit();

-- A staff row decides whose email the hub trusts for a role, so changing its
-- login OR its role is rank-gated: the actor must rank at least as high as the
-- row's old AND new role (also on insert), and as any login it is linked from /
-- to. This closes the demote -> relink -> promote bypass and self-promotion
-- (a manager setting role = 'owner' on their own row).
create or replace function public.guard_staff_user_link()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_rank integer;
  v_top integer;
begin
  if tg_op = 'UPDATE'
     and new.user_id is not distinct from old.user_id
     and new.role is not distinct from old.role then
    return new;
  end if;
  if v_actor is null or public.is_platform_admin() then
    return new;
  end if;
  select public.membership_rank(m.role) into v_actor_rank
    from public.memberships m
   where m.tenant_id = new.tenant_id and m.user_id = v_actor;
  v_actor_rank := coalesce(v_actor_rank, 0);

  v_top := public.membership_rank(new.role);
  if tg_op = 'UPDATE' then
    v_top := greatest(v_top, public.membership_rank(old.role));
  end if;
  select greatest(v_top, coalesce(max(public.membership_rank(m.role)), 0)) into v_top
    from public.memberships m
   where m.tenant_id = new.tenant_id
     and m.user_id in (new.user_id, case when tg_op = 'UPDATE' then old.user_id end);

  if v_top > v_actor_rank then
    raise exception 'not allowed to change the role or login of a higher-ranked staff member'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists staff_guard_user_link on public.staff;
create trigger staff_guard_user_link
  before insert or update of user_id, role on public.staff
  for each row execute function public.guard_staff_user_link();

-- PostgREST caches the RPC signatures: pick up the new reserve_payment_refund.
notify pgrst, 'reload schema';

commit;
