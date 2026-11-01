-- ============================================================================
-- Migration: phone_key_country  (pos-v1-gaps phase 4)
--
-- core_phone_key(phone) ignored the country: a national number typed in one
-- country collided with the same digits in another (a Mexican 10-digit number
-- and a US one), and "drop a leading 1" applied to anything. The comparison key
-- now takes the country the NATIONAL numbers are read in:
--
--   * international (+ or 00 prefix): the digits, with the NANP +1 dropped
--     (so +1 415... equals 415...); other country codes are kept in the key
--   * national, country US or CA: the NANP rule (10 digits, or 11 with a leading 1)
--   * national, any other or UNKNOWN (null) country: NO key. We do not guess a
--     country; such a number never matches (or merges with) another customer.
--
-- core_upsert_customer gains `p_country`. OMITTED it defaults to 'US' (what every
-- caller before this migration implicitly assumed, so an old worker keeps its
-- behaviour); the new code always sends it, and an explicit null means "unknown
-- country, do not guess". The one-argument core_phone_key and its index
-- (customers_tenant_phone_key_idx) are left alone, so the migration builds no
-- index; the verified-contact trigger keeps comparing formatting only. The 2-arg
-- key is not index-backed: lookups scan one tenant's customers (small, filtered by
-- tenant_id first).
--
-- DEPLOY ORDER: migration first, code second (old code calls the function without
-- p_country and keeps working). The old 9-argument function is dropped in the same
-- transaction so a named call cannot be ambiguous. Live-safe: functions only.
-- ============================================================================

begin;
set local lock_timeout = '3s';

create or replace function public.core_phone_key(p_phone text, p_country text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select case
    when d is null or length(d) < 7 then null
    when intl then
      case when length(d) = 11 and left(d, 1) = '1' then substr(d, 2) else d end
    when upper(coalesce(p_country, '')) in ('US', 'CA') then
      case when length(d) = 11 and left(d, 1) = '1' then substr(d, 2) else d end
    else null
  end
  from (
    select
      case when btrim(coalesce(p_phone, '')) ~ '^00[0-9]'
           then nullif(substr(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), 3), '')
           else nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), '')
      end as d,
      btrim(coalesce(p_phone, '')) ~ '^(\+|00)[0-9]' as intl
  ) x
$$;

drop function if exists public.core_upsert_customer(
  uuid, uuid, text, text, text, jsonb, text[], jsonb, text
);

create or replace function public.core_upsert_customer(
  p_tenant_id uuid,
  p_new_id uuid,
  p_email text,
  p_phone text,
  p_name text,
  p_marketing jsonb,
  p_tags text[],
  p_external_ids jsonb,
  p_verified_contact text default null,
  p_country text default 'US'
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
  v_pkey := public.core_phone_key(v_phone, p_country);
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
         and public.core_phone_key(phone, p_country) = v_pkey
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
       and public.core_phone_key(phone, p_country) = v_pkey
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
         and public.core_phone_key(c.phone, p_country) = v_pkey
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
           and (v_phone_new = v_phone or public.core_phone_key(v_phone_new, p_country) = v_pkey)
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
  uuid, uuid, text, text, text, jsonb, text[], jsonb, text, text
) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.core_upsert_customer(
      uuid, uuid, text, text, text, jsonb, text[], jsonb, text, text
    ) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.core_upsert_customer(
      uuid, uuid, text, text, text, jsonb, text[], jsonb, text, text
    ) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.core_upsert_customer(
      uuid, uuid, text, text, text, jsonb, text[], jsonb, text, text
    ) to service_role;
  end if;
end
$$;

commit;

notify pgrst, 'reload schema';
