-- ============================================================================
-- Phase 4 checks: core_link_tender_session (compare-and-set), core_publish_allergens,
-- core_phone_key(text, text) and core_upsert_customer's p_country. Run by
-- scripts/pglite-migrate.mjs after the migrations + seed. Raises on the first
-- failed expectation; rolled back at the end.
-- ============================================================================
begin;

do $$
declare
  t uuid := '10000000-0000-0000-0000-000000000001';
  t2 uuid := gen_random_uuid();
  loc uuid;
  o uuid := gen_random_uuid();
  p uuid := gen_random_uuid();
  p2 uuid := gen_random_uuid();
  item uuid;
  size uuid;
  modi uuid;
  r jsonb;
  n int;
  item2 uuid := gen_random_uuid();
  cat2 uuid := gen_random_uuid();
begin
  select id into loc from public.locations where tenant_id = t limit 1;
  insert into public.tenants (id, name, slug, status) values (t2, 'Other', 'other-phase4', 'active');
  insert into public.orders (id, tenant_id, location_id, status, currency, totals, order_number)
  values (o, t, loc, 'draft', 'USD', '{"total_cents":2000,"tip_cents":0}'::jsonb, 'P4-1');

  -- ---------------- core_link_tender_session ----------------
  insert into public.payments (id, order_id, tenant_id, location_id, rail, status, amount_cents, tip_cents, currency, simulated, raw)
  values (p, o, t, loc, 'stripe_online', 'requires_action', 2000, 0, 'USD', false, '{"keep":"me"}'::jsonb);
  r := public.core_link_tender_session(t2, p, 'cs_test_1');
  if r ->> 'outcome' <> 'not_found' then raise exception 'foreign tenant must not link: %', r; end if;
  r := public.core_link_tender_session(t, p, 'cs_test_1');
  if r ->> 'outcome' <> 'ok' then raise exception 'link: %', r; end if;
  if (select raw ->> 'checkout_session_id' from public.payments where id = p) <> 'cs_test_1'
     or (select raw ->> 'keep' from public.payments where id = p) <> 'me' then
    raise exception 'link must merge into raw';
  end if;
  -- closed meanwhile: the late link writes NOTHING (this is the race the upsert lost)
  update public.payments set status = 'canceled' where id = p;
  r := public.core_link_tender_session(t, p, 'cs_test_2');
  if r ->> 'outcome' <> 'not_open' or r ->> 'status' <> 'canceled' then raise exception 'closed link: %', r; end if;
  if (select raw ->> 'checkout_session_id' from public.payments where id = p) <> 'cs_test_1'
     or (select status::text from public.payments where id = p) <> 'canceled' then
    raise exception 'a closed tender was resurrected or rewritten';
  end if;
  r := public.core_link_tender_session(t, gen_random_uuid(), 'cs_x');
  if r ->> 'outcome' <> 'not_found' then raise exception 'missing: %', r; end if;

  -- ---------------- core_publish_allergens ----------------
  select id into item from public.menu_items where tenant_id = t limit 1;
  select id into size from public.item_sizes where item_id = item limit 1;
  select m.id into modi from public.modifiers m join public.modifier_groups g on g.id = m.group_id
   where g.tenant_id = t limit 1;
  perform public.core_set_outbox_enabled(true);
  delete from public.core_outbox where event_type = 'menu.allergens.published';

  r := public.core_publish_allergens(t, 'v1', 'hash-aaaaaaaa', null, 'backofhouse', jsonb_build_array(
    jsonb_build_object('target_type', 'item', 'target_id', item, 'contains', jsonb_build_array('milk')),
    jsonb_build_object('target_type', 'size', 'target_id', size),
    jsonb_build_object('target_type', 'modifier', 'target_id', modi, 'tags', jsonb_build_array('vegan'))));
  if r ->> 'outcome' <> 'ok' or (r -> 'publication' ->> 'row_count')::int <> 3 then raise exception 'publish: %', r; end if;
  select count(*) into n from public.core_outbox where event_type = 'menu.allergens.published' and tenant_id = t;
  if n <> 1 then raise exception 'expected 1 announcement, got %', n; end if;

  -- replay: nothing new
  r := public.core_publish_allergens(t, 'v1', 'hash-aaaaaaaa', null, 'backofhouse', '[]'::jsonb);
  if r ->> 'outcome' <> 'replay' then raise exception 'replay: %', r; end if;
  select count(*) into n from public.core_outbox where event_type = 'menu.allergens.published' and tenant_id = t;
  if n <> 1 then raise exception 'replay emitted again'; end if;
  -- same version, other hash
  r := public.core_publish_allergens(t, 'v1', 'hash-bbbbbbbb', null, null, '[]'::jsonb);
  if r ->> 'outcome' <> 'conflict' then raise exception 'conflict: %', r; end if;

  -- another tenant's item is refused and nothing is written
  insert into public.menu_categories (id, tenant_id, name) values (cat2, t2, 'c');
  insert into public.menu_items (id, tenant_id, category_id, name) values (item2, t2, cat2, 'foreign');
  r := public.core_publish_allergens(t, 'v2', 'hash-cccccccc', null, null, jsonb_build_array(
    jsonb_build_object('target_type', 'item', 'target_id', item),
    jsonb_build_object('target_type', 'item', 'target_id', item2)));
  if r ->> 'outcome' <> 'unknown_target' then raise exception 'foreign target: %', r; end if;
  if exists (select 1 from public.menu_allergen_publications where tenant_id = t and version = 'v2') then
    raise exception 'a refused publication was stored';
  end if;
  r := public.core_publish_allergens(t, 'v2', 'hash-cccccccc', null, null, jsonb_build_array(
    jsonb_build_object('target_type', 'item', 'target_id', 'not-a-uuid')));
  if r ->> 'outcome' <> 'unknown_target' then raise exception 'malformed id: %', r; end if;
  r := public.core_publish_allergens(t, 'v2', 'hash-cccccccc', array[gen_random_uuid()], null, '[]'::jsonb);
  if r ->> 'outcome' <> 'unknown_location' then raise exception 'foreign location: %', r; end if;
  r := public.core_publish_allergens(t, 'v2', 'hash-cccccccc', null, null, jsonb_build_array(
    jsonb_build_object('target_type', 'item', 'target_id', item),
    jsonb_build_object('target_type', 'item', 'target_id', item)));
  if r ->> 'outcome' <> 'duplicate' then raise exception 'duplicate: %', r; end if;

  -- a newer version replaces the matrix
  r := public.core_publish_allergens(t, 'v3', 'hash-dddddddd', null, null, jsonb_build_array(
    jsonb_build_object('target_type', 'item', 'target_id', item, 'contains', jsonb_build_array('soy'))));
  if r ->> 'outcome' <> 'ok' then raise exception 'v3: %', r; end if;
  select count(*) into n from public.menu_allergen_rows where tenant_id = t;
  if n <> 1 then raise exception 'matrix not replaced (% rows)', n; end if;

  -- ---------------- core_phone_key ----------------
  if public.core_phone_key('(415) 555-0199', 'US') <> '4155550199' then raise exception 'us national'; end if;
  if public.core_phone_key('+1 415 555 0199', null) <> '4155550199' then raise exception 'nanp intl'; end if;
  if public.core_phone_key('1 415 555 0199', 'CA') <> '4155550199' then raise exception 'nanp 11'; end if;
  if public.core_phone_key('5512345678', 'MX') is not null then raise exception 'foreign national must have no key'; end if;
  if public.core_phone_key('5512345678', null) is not null then raise exception 'unknown country must not guess'; end if;
  if public.core_phone_key('+52 55 1234 5678', null) <> '525512345678' then raise exception 'intl keeps its country code'; end if;
  if public.core_phone_key('0052 55 1234 5678', 'US') <> '525512345678' then raise exception '00 prefix'; end if;
  if public.core_phone_key('12345', 'US') is not null then raise exception 'short'; end if;

  -- ---------------- core_upsert_customer with a country ----------------
  r := public.core_upsert_customer(t, gen_random_uuid(), 'mx1@example.com', '5512345678', 'A', '{}'::jsonb, '{}', '{}'::jsonb, null, 'MX');
  if not (r ->> 'created')::boolean then raise exception 'mx1 created'; end if;
  -- the same digits for another email in an unknown country: no key, never merged
  r := public.core_upsert_customer(t, gen_random_uuid(), 'mx2@example.com', '5512345678', 'B', '{}'::jsonb, '{}', '{}'::jsonb, null, null);
  if r -> 'customer' ->> 'email' <> 'mx2@example.com' then raise exception 'mx2: %', r; end if;
  -- the legacy 9-argument call still works and means US
  r := public.core_upsert_customer(t, gen_random_uuid(), 'us1@example.com', '(415) 555-0100', 'C', '{}'::jsonb, '{}', '{}'::jsonb, null);
  r := public.core_upsert_customer(t, gen_random_uuid(), 'us2@example.com', '415-555-0100', null, '{}'::jsonb, '{}', '{}'::jsonb, null);
  if r -> 'customer' ->> 'phone' is not null then raise exception 'a phone held by another customer was attached: %', r; end if;
end
$$;

rollback;
