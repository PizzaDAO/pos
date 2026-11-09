-- ============================================================================
-- marketplace_inbox checks (migration 20261113000500). Run by
-- scripts/pglite-migrate.mjs after the migrations + seed. Rolled back.
--
--   * order_channel accepts 'marketplace'; store_settings.marketplace round-trips
--   * one (location, provider, external id) per marketplace order (unique index)
--   * one (provider, store_id) belongs to ONE location; one store per
--     (location, provider)
--   * clients (authenticated, anon) have no privilege on marketplace_stores
-- ============================================================================
begin;
set client_min_messages = warning;

update public.store_settings set marketplace = '{"enabled": true, "auto_accept": false, "providers": {}}'::jsonb
 where location_id = '10000000-0000-0000-0000-000000000101';

insert into public.orders (id, tenant_id, location_id, status, channel, currency, discount_cents, totals, order_number, source)
values ('3a000000-0000-4000-8000-000000000001', '10000000-0000-0000-0000-000000000001',
        '10000000-0000-0000-0000-000000000101', 'placed', 'marketplace', 'USD', 0, '{}'::jsonb, 'M-1',
        '{"type":"marketplace","module":"doordash","external_ref":"X-1"}'::jsonb);

do $$
declare ok boolean;
begin
  -- same provider order id twice at one location is refused
  begin
    insert into public.orders (id, tenant_id, location_id, status, channel, currency, discount_cents, totals, order_number, source)
    values ('3a000000-0000-4000-8000-000000000002', '10000000-0000-0000-0000-000000000001',
            '10000000-0000-0000-0000-000000000101', 'placed', 'marketplace', 'USD', 0, '{}'::jsonb, 'M-2',
            '{"type":"marketplace","module":"doordash","external_ref":"X-1"}'::jsonb);
    raise exception 'duplicate marketplace order was accepted';
  exception when unique_violation then null;
  end;
  -- same order id on another provider is a different order
  insert into public.orders (id, tenant_id, location_id, status, channel, currency, discount_cents, totals, order_number, source)
  values ('3a000000-0000-4000-8000-000000000003', '10000000-0000-0000-0000-000000000001',
          '10000000-0000-0000-0000-000000000101', 'placed', 'marketplace', 'USD', 0, '{}'::jsonb, 'M-3',
          '{"type":"marketplace","module":"grubhub","external_ref":"X-1"}'::jsonb);

  -- store ids
  insert into public.marketplace_stores (provider, store_id, tenant_id, location_id)
  values ('doordash', 'dd-1', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000101');
  begin
    insert into public.marketplace_stores (provider, store_id, tenant_id, location_id)
    values ('doordash', 'dd-1', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000102');
    raise exception 'one store id was assigned to two locations';
  exception when unique_violation then null;
  end;
  begin
    insert into public.marketplace_stores (provider, store_id, tenant_id, location_id)
    values ('doordash', 'dd-2', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000101');
    raise exception 'a location got two stores for one provider';
  exception when unique_violation then null;
  end;
  -- the upsert the driver uses replaces the location's store in one statement
  insert into public.marketplace_stores (provider, store_id, tenant_id, location_id)
  values ('doordash', 'dd-3', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000101')
  on conflict (location_id, provider) do update set store_id = excluded.store_id;
  if not exists (select 1 from public.marketplace_stores where store_id = 'dd-3') then
    raise exception 'upsert did not replace the store';
  end if;

  -- clients cannot read or write the store table
  select not has_table_privilege('authenticated', 'public.marketplace_stores', 'select')
     and not has_table_privilege('authenticated', 'public.marketplace_stores', 'insert')
     and not has_table_privilege('anon', 'public.marketplace_stores', 'select')
    into ok;
  if not ok then raise exception 'a client role has access to marketplace_stores'; end if;
end;
$$;

rollback;
