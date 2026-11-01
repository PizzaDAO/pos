-- ============================================================================
-- Migration: customers_identity  (pos-v1-gaps, phase 2)
--
-- `customers.upsert` (POST /v1/customers): a customer can be known by phone
-- alone (SMS/OTP login, a phone order), and carries marketing consent, tags and
-- external ids.
--
--   * customers.email becomes NULLable. The existing unique (tenant_id, email)
--     already treats NULLs as distinct, so phone-only customers coexist; it still
--     enforces one row per email within a tenant. A check keeps at least one of
--     email / phone so a row is always reachable.
--   * marketing / tags / external_ids columns (constant defaults: no rewrite).
--   * core_phone_key(): the comparison key for phones. Digits only, a leading
--     NANP "1" dropped, shorter than 7 digits = no key. Indexed per tenant so a
--     phone lookup is an index probe, not a scan of every customer.
--   * core_upsert_customer(): ONE transaction. Serialized per identity by advisory
--     locks (email first, then phone: one fixed order, so no deadlock), match by
--     email, else by phone; NEVER merge two customers (a phone that belongs to
--     someone with a different email is not attached); only FILL blanks; never
--     touches `verified`; consent changes only with an `at`, and an older `at`
--     never overwrites a newer one. Writes nothing (no customer.updated event)
--     when nothing changed.
--
-- Additive and live-safe (see the lock_timeout). Service role only for the
-- function; no new tables, so no new grants beyond it.
-- ============================================================================

begin;
set local lock_timeout = '3s';

alter table public.customers alter column email drop not null;

alter table public.customers add column if not exists marketing jsonb not null default '{}'::jsonb;
alter table public.customers add column if not exists tags text[] not null default '{}'::text[];
alter table public.customers add column if not exists external_ids jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.customers'::regclass and conname = 'customers_email_or_phone'
  ) then
    alter table public.customers
      add constraint customers_email_or_phone
      check (email is not null or phone is not null) not valid;
  end if;
end
$$;
alter table public.customers validate constraint customers_email_or_phone;

create or replace function public.core_phone_key(p_phone text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select case
    when d is null or length(d) < 7 then null
    when length(d) = 11 and left(d, 1) = '1' then substr(d, 2)
    else d
  end
  from (select nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), '') as d) x
$$;

create index if not exists customers_tenant_phone_key_idx
  on public.customers (tenant_id, public.core_phone_key(phone))
  where phone is not null;

-- ---- the atomic upsert -----------------------------------------------------------
-- p_marketing is already reduced by the caller to the channels that carry an `at`.
-- Returns {customer: <row>, created: bool}.
create or replace function public.core_upsert_customer(
  p_tenant_id uuid,
  p_new_id uuid,
  p_email text,
  p_phone text,
  p_name text,
  p_marketing jsonb,
  p_tags text[],
  p_external_ids jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_pkey text := public.core_phone_key(p_phone);
  v_row public.customers;
  v_found boolean := false;
  v_phone_taken boolean := false;
  v_phone_new text;
  v_email_new text;
  v_name_new text;
  v_mk jsonb;
  v_tags text[];
  v_ext jsonb;
  ch text;
  v_created boolean := false;
  v_changed boolean := false;
begin
  if v_email is null and v_phone is null then
    raise exception 'core_upsert_customer: email or phone is required';
  end if;

  if v_email is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':e:' || v_email, 0));
  end if;
  if v_pkey is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':p:' || v_pkey, 0));
  end if;

  if v_email is not null then
    select * into v_row from public.customers
     where tenant_id = p_tenant_id and email = v_email
     for update;
    v_found := found;
  end if;

  if not v_found and v_pkey is not null then
    select * into v_row from public.customers
     where tenant_id = p_tenant_id and phone is not null
       and public.core_phone_key(phone) = v_pkey
     order by (email is null), created_at, id
     limit 1
     for update;
    if found then
      if v_email is not null and v_row.email is not null and v_row.email <> v_email then
        -- Two different people: never merge. The phone stays with its owner.
        v_phone_taken := true;
      else
        v_found := true;
      end if;
    end if;
  end if;

  if not v_found then
    -- Create. A phone already held by another customer is not attached.
    insert into public.customers (id, tenant_id, email, phone, name, marketing, tags, external_ids)
    values (
      coalesce(p_new_id, gen_random_uuid()), p_tenant_id, v_email,
      case when v_phone_taken then null else v_phone end,
      nullif(btrim(coalesce(p_name, '')), ''),
      coalesce(p_marketing, '{}'::jsonb),
      coalesce((select array_agg(distinct t order by t) from unnest(coalesce(p_tags, '{}')) t), '{}'),
      coalesce(p_external_ids, '{}'::jsonb)
    )
    returning * into v_row;
    v_created := true;
    return jsonb_build_object('customer', to_jsonb(v_row), 'created', true, 'changed', true);
  end if;

  -- Existing customer: fill blanks only.
  v_email_new := coalesce(v_row.email, v_email);
  v_name_new := coalesce(nullif(btrim(coalesce(v_row.name, '')), ''), nullif(btrim(coalesce(p_name, '')), ''));
  v_phone_new := v_row.phone;
  if v_phone_new is null and v_phone is not null then
    if not exists (
      select 1 from public.customers c
       where c.tenant_id = p_tenant_id and c.id <> v_row.id and c.phone is not null
         and public.core_phone_key(c.phone) = v_pkey
    ) then
      v_phone_new := v_phone;
    end if;
  end if;

  v_mk := coalesce(v_row.marketing, '{}'::jsonb);
  foreach ch in array array['email', 'sms'] loop
    if p_marketing ? ch and (p_marketing -> ch ->> 'at') is not null then
      if (v_mk -> ch ->> 'at') is null
         or (p_marketing -> ch ->> 'at')::timestamptz >= (v_mk -> ch ->> 'at')::timestamptz then
        v_mk := jsonb_set(v_mk, array[ch], p_marketing -> ch);
      end if;
    end if;
  end loop;

  select coalesce(array_agg(distinct t order by t), '{}') into v_tags
    from unnest(coalesce(v_row.tags, '{}') || coalesce(p_tags, '{}')) t;
  -- Existing external ids win; new keys are added.
  v_ext := coalesce(p_external_ids, '{}'::jsonb) || coalesce(v_row.external_ids, '{}'::jsonb);

  if v_email_new is distinct from v_row.email
     or v_name_new is distinct from v_row.name
     or v_phone_new is distinct from v_row.phone
     or v_mk is distinct from v_row.marketing
     or v_tags is distinct from v_row.tags
     or v_ext is distinct from v_row.external_ids then
    update public.customers
       set email = v_email_new, name = v_name_new, phone = v_phone_new,
           marketing = v_mk, tags = v_tags, external_ids = v_ext,
           updated_at = now()
     where id = v_row.id
    returning * into v_row;
    v_changed := true;
  end if;

  return jsonb_build_object('customer', to_jsonb(v_row), 'created', v_created, 'changed', v_changed);
end;
$$;

revoke all on function public.core_upsert_customer(
  uuid, uuid, text, text, text, jsonb, text[], jsonb
) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.core_upsert_customer(
      uuid, uuid, text, text, text, jsonb, text[], jsonb
    ) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.core_upsert_customer(
      uuid, uuid, text, text, text, jsonb, text[], jsonb
    ) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.core_upsert_customer(
      uuid, uuid, text, text, text, jsonb, text[], jsonb
    ) to service_role;
  end if;
end
$$;

commit;

notify pgrst, 'reload schema';
