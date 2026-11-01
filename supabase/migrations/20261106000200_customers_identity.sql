-- ============================================================================
-- Migration: customers_identity  (pos-v1-gaps, phase 2)
--
-- `customers.upsert` (POST /v1/customers): a customer can be known by phone
-- alone (SMS/OTP login, a phone order), and carries marketing consent, tags,
-- external ids and PER-CONTACT verified state.
--
--   * customers.email becomes NULLable. The existing unique (tenant_id, email)
--     already treats NULLs as distinct, so phone-only customers coexist; it still
--     enforces one row per email within a tenant. A check keeps at least one of
--     email / phone so a row is always reachable.
--   * marketing / tags / external_ids columns (constant defaults: no rewrite).
--   * email_verified_at / phone_verified_at (nullable, no default: metadata only).
--     The ONLY thing that ever sets them is the OTP mode of core_upsert_customer
--     (`p_verified_contact`), reachable only with the literal `customers:verify`
--     scope. The legacy boolean `verified` (the shop's magic-link STUB, which hands
--     the link back to whoever asked) proves nothing and is never trusted.
--   * core_phone_key(): the comparison key for phones. Digits only, a leading
--     NANP "1" dropped, shorter than 7 digits = no key. Indexed per tenant so a
--     phone lookup is an index probe, not a scan of every customer.
--   * core_upsert_customer(): ONE transaction, serialized per identity by advisory
--     locks (email first, then phone: one fixed order, so no deadlock).
--
--     ORDINARY mode: match by email, else by phone (verified phones first); NEVER
--     merge two customers (a phone owned by someone with a different email is not
--     attached; nor is an email offered to a phone-only row); only FILL
--     blanks, and never a contact onto a row that has a verified contact (so
--     planting a contact there can never make it reachable by OTP); never sets
--     verified state; consent changes only with an `at` (a future `at` is clamped
--     to now(), an older `at` never overwrites a newer one) and only for a contact
--     that ended up ATTACHED to the row. Writes nothing when nothing changed.
--
--     OTP mode (`p_verified_contact` = 'email' | 'phone'): only the named contact is
--     used. Phone: matches ONLY a row whose phone is already verified, otherwise
--     creates a new row, so an unverified (possibly planted) phone is never
--     resolved to. Email: the (tenant, email) unique constraint allows one row per
--     email, so the row holding that email is the row; proving control of the
--     email IS the proof that it is theirs, and it is stamped verified. Either way
--     the proven contact gets its verified timestamp.
--
-- Additive and live-safe (3s lock_timeout; column adds are metadata-only; the
-- check is added NOT VALID then validated). Service role only for the function;
-- no new tables, so no new grants beyond it.
-- ============================================================================

begin;
set local lock_timeout = '3s';

alter table public.customers alter column email drop not null;

alter table public.customers add column if not exists marketing jsonb not null default '{}'::jsonb;
alter table public.customers add column if not exists tags text[] not null default '{}'::text[];
alter table public.customers add column if not exists external_ids jsonb not null default '{}'::jsonb;
alter table public.customers add column if not exists email_verified_at timestamptz;
alter table public.customers add column if not exists phone_verified_at timestamptz;

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

-- A verified timestamp proves ONE contact value. Two rules, enforced for every
-- actor (including the service role and the owner of the SECURITY DEFINER upsert):
--   1. when a contact's value changes, that contact's stamp is cleared, so a
--      contact swapped under a stamp (a checkout fill, a PostgREST edit, a
--      back-office fix) is unverified again. The OTP upsert never changes a
--      contact value on an existing row (it matches or creates, and stamps), so
--      it is unaffected. Phones compare by core_phone_key, so only a formatting
--      change keeps the stamp.
--   2. tenant members (and a customer on their own row) can write `customers`
--      through PostgREST under RLS; for the user roles the stamps are read-only.
create or replace function public.core_guard_customer_verified()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if current_user in ('anon', 'authenticated') then
      new.email_verified_at := null;
      new.phone_verified_at := null;
    end if;
    return new;
  end if;
  if current_user in ('anon', 'authenticated') then
    new.email_verified_at := old.email_verified_at;
    new.phone_verified_at := old.phone_verified_at;
  end if;
  if new.email is distinct from old.email then
    new.email_verified_at := null;
  end if;
  if coalesce(public.core_phone_key(new.phone), new.phone)
     is distinct from coalesce(public.core_phone_key(old.phone), old.phone) then
    new.phone_verified_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists customers_guard_verified on public.customers;
create trigger customers_guard_verified
  before insert or update on public.customers
  for each row execute function public.core_guard_customer_verified();

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
-- Returns {customer: <row>, created: bool, changed: bool}.
create or replace function public.core_upsert_customer(
  p_tenant_id uuid,
  p_new_id uuid,
  p_email text,
  p_phone text,
  p_name text,
  p_marketing jsonb,
  p_tags text[],
  p_external_ids jsonb,
  p_verified_contact text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_pkey text;
  v_row public.customers;
  v_found boolean := false;
  v_phone_taken boolean := false;
  v_frozen boolean;
  v_phone_new text;
  v_email_new text;
  v_name_new text;
  v_mk jsonb;
  v_in jsonb;
  v_tags text[];
  v_ext jsonb;
  v_attached boolean;
  ch text;
  v_changed boolean := false;
  v_now_txt text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if p_verified_contact is not null and p_verified_contact not in ('email', 'phone') then
    raise exception 'core_upsert_customer: bad verified contact %', p_verified_contact;
  end if;
  -- OTP mode: only the proven contact exists for this call.
  if p_verified_contact = 'email' then v_phone := null; end if;
  if p_verified_contact = 'phone' then v_email := null; end if;
  v_pkey := public.core_phone_key(v_phone);
  if v_email is null and v_phone is null then
    raise exception 'core_upsert_customer: email or phone is required';
  end if;

  if v_email is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':e:' || v_email, 0));
  end if;
  if v_pkey is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':p:' || v_pkey, 0));
  end if;

  -- ------------------------------------------------------------------ OTP mode
  if p_verified_contact is not null then
    if p_verified_contact = 'email' then
      select * into v_row from public.customers
       where tenant_id = p_tenant_id and email = v_email
       for update;
      if found then
        if v_row.email_verified_at is null then
          update public.customers
             set email_verified_at = now(), verified = true, updated_at = now()
           where id = v_row.id
          returning * into v_row;
          v_changed := true;
        end if;
        return jsonb_build_object('customer', to_jsonb(v_row), 'created', false, 'changed', v_changed);
      end if;
      insert into public.customers (id, tenant_id, email, email_verified_at, verified)
      values (coalesce(p_new_id, gen_random_uuid()), p_tenant_id, v_email, now(), true)
      returning * into v_row;
    else
      if v_pkey is null then
        raise exception 'core_upsert_customer: the verified phone has no usable digits';
      end if;
      select * into v_row from public.customers
       where tenant_id = p_tenant_id and phone is not null
         and phone_verified_at is not null
         and public.core_phone_key(phone) = v_pkey
       order by phone_verified_at, id
       limit 1
       for update;
      if found then
        return jsonb_build_object('customer', to_jsonb(v_row), 'created', false, 'changed', false);
      end if;
      -- Nothing verified holds this phone: a NEW row, never an unverified one.
      insert into public.customers (id, tenant_id, phone, phone_verified_at, verified)
      values (coalesce(p_new_id, gen_random_uuid()), p_tenant_id, v_phone, now(), true)
      returning * into v_row;
    end if;
    return jsonb_build_object('customer', to_jsonb(v_row), 'created', true, 'changed', true);
  end if;

  -- ------------------------------------------------------------- ordinary mode
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
     order by (phone_verified_at is null), (email is null), created_at, id
     limit 1
     for update;
    if found then
      if v_email is not null
         and (v_row.email is null or v_row.email <> v_email) then
        -- A different email, or an email offered to a PHONE-ONLY row: two
        -- different people as far as we can tell. Never merge; the phone stays
        -- with its owner.
        v_phone_taken := true;
      else
        v_found := true;
      end if;
    end if;
  end if;

  if not v_found then
    -- Create. A phone already held by another customer is not attached.
    v_phone_new := case when v_phone_taken then null else v_phone end;
    v_mk := '{}'::jsonb;
    foreach ch in array array['email', 'sms'] loop
      v_in := p_marketing -> ch;
      v_attached := case ch when 'email' then v_email is not null else v_phone_new is not null end;
      if v_in is not null and (v_in ->> 'at') is not null and v_attached then
        if (v_in ->> 'at')::timestamptz > now() then
          v_in := jsonb_set(v_in, '{at}', to_jsonb(v_now_txt));
        end if;
        v_mk := jsonb_set(v_mk, array[ch], v_in);
      end if;
    end loop;
    insert into public.customers (id, tenant_id, email, phone, name, marketing, tags, external_ids)
    values (
      coalesce(p_new_id, gen_random_uuid()), p_tenant_id, v_email, v_phone_new,
      nullif(btrim(coalesce(p_name, '')), ''),
      v_mk,
      coalesce((select array_agg(distinct t order by t) from unnest(coalesce(p_tags, '{}')) t), '{}'),
      coalesce(p_external_ids, '{}'::jsonb)
    )
    returning * into v_row;
    return jsonb_build_object('customer', to_jsonb(v_row), 'created', true, 'changed', true);
  end if;

  -- Existing customer: fill blanks only, and never a contact onto a row that has a
  -- verified contact.
  v_frozen := v_row.email_verified_at is not null or v_row.phone_verified_at is not null;
  v_email_new := case when v_frozen then v_row.email else coalesce(v_row.email, v_email) end;
  v_name_new := coalesce(nullif(btrim(coalesce(v_row.name, '')), ''), nullif(btrim(coalesce(p_name, '')), ''));
  v_phone_new := v_row.phone;
  if v_phone_new is null and v_phone is not null and not v_frozen then
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
    v_in := p_marketing -> ch;
    v_attached := case ch
      when 'email' then v_email is not null and v_email_new = v_email
      else v_phone is not null and v_phone_new is not null
           and (v_phone_new = v_phone or public.core_phone_key(v_phone_new) = v_pkey)
    end;
    if v_in is not null and (v_in ->> 'at') is not null and v_attached then
      if (v_in ->> 'at')::timestamptz > now() then
        v_in := jsonb_set(v_in, '{at}', to_jsonb(v_now_txt));
      end if;
      if (v_mk -> ch ->> 'at') is null
         or (v_in ->> 'at')::timestamptz >= (v_mk -> ch ->> 'at')::timestamptz then
        v_mk := jsonb_set(v_mk, array[ch], v_in);
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

  return jsonb_build_object('customer', to_jsonb(v_row), 'created', false, 'changed', v_changed);
end;
$$;

revoke all on function public.core_upsert_customer(
  uuid, uuid, text, text, text, jsonb, text[], jsonb, text
) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.core_upsert_customer(
      uuid, uuid, text, text, text, jsonb, text[], jsonb, text
    ) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.core_upsert_customer(
      uuid, uuid, text, text, text, jsonb, text[], jsonb, text
    ) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.core_upsert_customer(
      uuid, uuid, text, text, text, jsonb, text[], jsonb, text
    ) to service_role;
  end if;
end
$$;

commit;

notify pgrst, 'reload schema';
