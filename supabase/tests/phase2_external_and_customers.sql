-- ============================================================================
-- Phase 2 checks (run by scripts/pglite-migrate.mjs after the migrations + seed;
-- also valid on any Postgres with the schema applied). Raises on the first
-- failed expectation. Everything is rolled back at the end.
-- ============================================================================
begin;

do $$
declare
  t uuid := '10000000-0000-0000-0000-000000000001';
  t2 uuid := gen_random_uuid();
  loc uuid;
  o uuid := gen_random_uuid();
  o2 uuid := gen_random_uuid();
  r jsonb;
  r2 jsonb;
  c1 jsonb;
  c2 jsonb;
  cid uuid;
  n int;
begin
  select id into loc from public.locations where tenant_id = t limit 1;
  insert into public.tenants (id, name, slug, status) values (t2, 'Other', 'other-phase2', 'active');

  insert into public.orders (id, tenant_id, location_id, status, currency, totals, order_number)
  values (o, t, loc, 'draft', 'USD', '{"total_cents":2000,"tip_cents":0}'::jsonb, 'P2-1'),
         (o2, t, loc, 'draft', 'USD', '{"total_cents":2000,"tip_cents":0}'::jsonb, 'P2-2');

  -- ---------------- core_record_external_tender ----------------
  -- stale fingerprint: nothing written
  r := public.core_record_external_tender(t, o, gen_random_uuid(), 'card', 'stripe_terminal', 'pi_1',
         1000, 0, 'captured', 'captured', 'terminal', null,
         '{"n":5,"amount":0,"tip":0,"refunded":0}'::jsonb);
  if r ->> 'outcome' <> 'stale' then raise exception 'expected stale, got %', r; end if;

  -- foreign tenant: not_found, nothing leaked
  r := public.core_record_external_tender(t2, o, gen_random_uuid(), 'card', 'stripe_terminal', 'pi_1',
         1000, 0, 'captured', 'captured', 'terminal', null,
         '{"n":0,"amount":0,"tip":0,"refunded":0}'::jsonb);
  if r ->> 'outcome' <> 'not_found' then raise exception 'expected not_found, got %', r; end if;

  -- pending invoice, then captured with the same ref supersedes it
  r := public.core_record_external_tender(t, o, '00000000-0000-0000-0000-0000000000a1', 'external', 'catering', 'inv_9',
         2000, 0, 'pending', 'pending', 'invoice', null,
         '{"n":0,"amount":0,"tip":0,"refunded":0}'::jsonb);
  if r ->> 'outcome' <> 'ok' then raise exception 'pending insert: %', r; end if;
  if (r -> 'payment' ->> 'simulated')::boolean then raise exception 'external must not be simulated'; end if;
  if r -> 'payment' ->> 'rail' <> 'external' then raise exception 'rail: %', r; end if;

  r := public.core_record_external_tender(t, o, '00000000-0000-0000-0000-0000000000a2', 'external', 'catering', 'inv_9',
         2000, 0, 'captured', 'captured', 'invoice', null,
         '{"n":1,"amount":2000,"tip":0,"refunded":0}'::jsonb);
  if r ->> 'outcome' <> 'ok' then raise exception 'captured insert: %', r; end if;
  if (select status::text from public.payments where id = '00000000-0000-0000-0000-0000000000a1') <> 'canceled' then
    raise exception 'pending tender was not superseded';
  end if;

  -- replay of the same id
  r := public.core_record_external_tender(t, o, '00000000-0000-0000-0000-0000000000a2', 'external', 'catering', 'inv_9',
         2000, 0, 'captured', 'captured', 'invoice', null,
         '{"n":1,"amount":2000,"tip":0,"refunded":0}'::jsonb);
  if r ->> 'outcome' <> 'exists' then raise exception 'expected exists, got %', r; end if;

  -- same processor + ref again under a NEW id (another idempotency key): refused
  r := public.core_record_external_tender(t, o2, gen_random_uuid(), 'external', 'catering', 'inv_9',
         2000, 0, 'captured', 'captured', 'invoice', null,
         '{"n":0,"amount":0,"tip":0,"refunded":0}'::jsonb);
  if r ->> 'outcome' <> 'duplicate_ref' then raise exception 'expected duplicate_ref, got %', r; end if;

  -- the unique index is the backstop for a direct insert
  begin
    insert into public.payments (id, order_id, tenant_id, location_id, rail, status, amount_cents, currency, simulated,
                                 processor, processor_ref)
    values (gen_random_uuid(), o2, t, loc, 'external', 'captured', 1, 'USD', false, 'catering', 'inv_9');
    raise exception 'unique index payments_external_ref_uq did not fire';
  exception when unique_violation then null;
  end;

  -- voided order: invalid_state
  update public.orders set status = 'voided' where id = o2;
  r := public.core_record_external_tender(t, o2, gen_random_uuid(), 'cash', 'driver', null,
         100, 0, 'captured', 'captured', 'cash_on_delivery', null,
         '{"n":0,"amount":0,"tip":0,"refunded":0}'::jsonb);
  if r ->> 'outcome' <> 'invalid_state' then raise exception 'expected invalid_state, got %', r; end if;

  -- ---------------- core_cancel_order: pending external never blocks ----------------
  update public.orders set status = 'draft' where id = o2;
  r := public.core_record_external_tender(t, o2, '00000000-0000-0000-0000-0000000000b1', 'cash', 'driver', 'cod_1',
         500, 0, 'pending', 'pending', 'cash_on_delivery', null,
         '{"n":0,"amount":0,"tip":0,"refunded":0}'::jsonb);
  if r ->> 'outcome' <> 'ok' then raise exception 'pending cod: %', r; end if;
  r := public.core_cancel_order(o2, t);
  if (r ->> 'ok')::boolean is not true then raise exception 'cancel with pending external: %', r; end if;
  if (select status::text from public.payments where id = '00000000-0000-0000-0000-0000000000b1') <> 'canceled' then
    raise exception 'pending external not voided with the order';
  end if;
  -- a captured external tender blocks the cancel
  r := public.core_cancel_order(o, t);
  if r ->> 'reason' <> 'captured' then raise exception 'cancel with captured external: %', r; end if;

  -- ---------------- core_upsert_customer ----------------
  -- phone only
  c1 := public.core_upsert_customer(t, null, null, '+15555550123', 'Pat', '{}'::jsonb, '{a}', '{"guests":"g1"}');
  if (c1 ->> 'created')::boolean is not true then raise exception 'phone-only create: %', c1; end if;
  cid := (c1 -> 'customer' ->> 'id')::uuid;
  if c1 -> 'customer' ->> 'email' is not null then raise exception 'email should be null'; end if;

  -- same phone, different formatting, now with an email: matches, fills the blank email
  c2 := public.core_upsert_customer(t, null, 'Pat@Example.com', '(555) 555-0123', 'Other Name', '{}'::jsonb, '{b}', '{"guests":"g2","x":"y"}');
  if (c2 -> 'customer' ->> 'id')::uuid <> cid then raise exception 'phone match failed: %', c2; end if;
  if c2 -> 'customer' ->> 'email' <> 'pat@example.com' then raise exception 'email not filled: %', c2; end if;
  if c2 -> 'customer' ->> 'name' <> 'Pat' then raise exception 'name overwritten: %', c2; end if;
  if (c2 -> 'customer' -> 'external_ids' ->> 'guests') <> 'g1' then raise exception 'external id overwritten: %', c2; end if;
  if c2 -> 'customer' -> 'external_ids' ->> 'x' <> 'y' then raise exception 'external id not added: %', c2; end if;
  if (c2 -> 'customer' -> 'tags') <> '["a","b"]'::jsonb then raise exception 'tags: %', c2; end if;

  -- a DIFFERENT email with the same phone: never merged, phone stays with its owner
  c1 := public.core_upsert_customer(t, null, 'sam@example.com', '+15555550123', 'Sam', '{}'::jsonb, '{}', '{}');
  if (c1 ->> 'created')::boolean is not true then raise exception 'different email must create: %', c1; end if;
  if c1 -> 'customer' ->> 'phone' is not null then raise exception 'phone must not move: %', c1; end if;

  -- email wins over a conflicting phone: stored phone untouched
  c2 := public.core_upsert_customer(t, null, 'pat@example.com', '+15555559999', null, '{}'::jsonb, '{}', '{}');
  if (c2 -> 'customer' ->> 'id')::uuid <> cid then raise exception 'email match failed'; end if;
  if c2 -> 'customer' ->> 'phone' <> '+15555550123' then raise exception 'phone overwritten: %', c2; end if;

  -- consent: only with an `at`, and an older `at` never beats a newer one
  c2 := public.core_upsert_customer(t, null, 'pat@example.com', null, null,
          '{"sms":{"opt_in":true,"at":"2026-01-02T00:00:00Z"}}'::jsonb, '{}', '{}');
  if (c2 -> 'customer' -> 'marketing' -> 'sms' ->> 'opt_in')::boolean is not true then raise exception 'consent not stored'; end if;
  c2 := public.core_upsert_customer(t, null, 'pat@example.com', null, null,
          '{"sms":{"opt_in":false,"at":"2026-01-01T00:00:00Z"}}'::jsonb, '{}', '{}');
  if (c2 -> 'customer' -> 'marketing' -> 'sms' ->> 'opt_in')::boolean is not true then raise exception 'older consent overwrote newer'; end if;
  c2 := public.core_upsert_customer(t, null, 'pat@example.com', null, null,
          '{"sms":{"opt_in":false,"at":"2026-02-01T00:00:00Z"}}'::jsonb, '{}', '{}');
  if (c2 -> 'customer' -> 'marketing' -> 'sms' ->> 'opt_in')::boolean is not false then raise exception 'newer consent not applied'; end if;

  -- verified is never touched
  update public.customers set verified = true where id = cid;
  c2 := public.core_upsert_customer(t, null, 'pat@example.com', null, 'Nope', '{}'::jsonb, '{}', '{}');
  if (c2 -> 'customer' ->> 'verified')::boolean is not true then raise exception 'verified was unset'; end if;

  -- a no-op upsert does not bump updated_at (no customer.updated event)
  declare u1 timestamptz; u2 timestamptz;
  begin
    select updated_at into u1 from public.customers where id = cid;
    perform public.core_upsert_customer(t, null, 'pat@example.com', null, null, '{}'::jsonb, '{}', '{}');
    select updated_at into u2 from public.customers where id = cid;
    if u1 <> u2 then raise exception 'no-op upsert touched updated_at'; end if;
  end;

  -- tenant isolation: the same email at another tenant is another row
  c1 := public.core_upsert_customer(t2, null, 'pat@example.com', null, null, '{}'::jsonb, '{}', '{}');
  if (c1 ->> 'created')::boolean is not true then raise exception 'other tenant must create'; end if;
  select count(*) into n from public.customers where email = 'pat@example.com';
  if n <> 2 then raise exception 'expected 2 rows for the email across tenants, got %', n; end if;

  -- email or phone is required
  begin
    perform public.core_upsert_customer(t, null, null, null, 'x', '{}'::jsonb, '{}', '{}');
    raise exception 'empty identity accepted';
  exception when raise_exception then
    if sqlerrm like 'empty identity%' then raise; end if;
  end;
end
$$;

rollback;
