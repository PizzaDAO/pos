-- ============================================================================
-- print_network checks (migration 20261113000000). Run by
-- scripts/pglite-migrate.mjs after the migrations + seed. Rolled back.
--
--   * no client role (authenticated, anon) has ANY privilege on print_printers
--     / print_jobs / print_location_settings (token_hash is a credential, and
--     the same revoke-client-writes pattern applies); RLS is enabled + forced
--     and no policy exists, so even a future grant would expose nothing
--   * a tenant member (owner) is refused read AND write
--   * the owner/service path still works; deleting a printer drops its jobs;
--     the dedupe key makes a retried auto-print unique per printer
-- ============================================================================
begin;
set client_min_messages = warning;

insert into public.users (id, email) values
  ('6e100000-0000-4000-8000-000000000001', 'print-owner@x.example');
insert into public.memberships (user_id, tenant_id, role) values
  ('6e100000-0000-4000-8000-000000000001', '10000000-0000-0000-0000-000000000001', 'owner');

insert into public.print_printers (id, tenant_id, location_id, label, protocol, token_hash)
values ('6e10000a-0000-4000-8000-000000000001', '10000000-0000-0000-0000-000000000001',
        '10000000-0000-0000-0000-000000000101', 'Kitchen', 'star_cloudprnt', 'deadbeef');
insert into public.print_jobs (id, tenant_id, location_id, printer_id, document, expires_at, dedupe_key)
values ('6e10000b-0000-4000-8000-000000000001', '10000000-0000-0000-0000-000000000001',
        '10000000-0000-0000-0000-000000000101', '6e10000a-0000-4000-8000-000000000001',
        '{"lines":[]}'::jsonb, now() + interval '30 minutes', 'fire:1');

create or replace function pg_temp.denied(p_uid text, p_role text, p_sql text) returns boolean
language plpgsql as $$
declare v_denied boolean := false; n int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid)::text, true);
  begin
    execute format('set local role %I', p_role);
    execute p_sql;
    -- A SELECT that RLS filters to nothing also counts as no access.
    get diagnostics n = row_count;
    if p_sql ilike 'select%' and n = 0 then v_denied := true; end if;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '{}', true);
  return v_denied;
end;
$$;

do $$
declare
  owner_u constant text := '6e100000-0000-4000-8000-000000000001';
  tbl text;
  priv text;
  role_name text;
begin
  foreach tbl in array array['print_printers', 'print_jobs', 'print_location_settings'] loop
    if not (select relrowsecurity and relforcerowsecurity from pg_class
             where oid = ('public.' || tbl)::regclass) then
      raise exception 'RLS not enabled+forced on %', tbl;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = tbl) then
      raise exception 'a policy exists on % (it should be server-only)', tbl;
    end if;
    foreach role_name in array array['authenticated', 'anon'] loop
      foreach priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
        if has_table_privilege(role_name, 'public.' || tbl, priv) then
          raise exception '% still has % on %', role_name, priv, tbl;
        end if;
      end loop;
    end loop;
  end loop;

  if not pg_temp.denied(owner_u, 'authenticated', 'select token_hash from public.print_printers') then
    raise exception 'a tenant owner could read printer token hashes';
  end if;
  if not pg_temp.denied(owner_u, 'authenticated', $q$
      insert into public.print_jobs (tenant_id, location_id, printer_id, document, expires_at)
      values ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000101',
              '6e10000a-0000-4000-8000-000000000001', '{"lines":[]}', now())$q$) then
    raise exception 'a tenant owner queued a print job directly';
  end if;
  if not pg_temp.denied(owner_u, 'authenticated',
      'update public.print_printers set token_hash = ''x''') then
    raise exception 'a tenant owner rewrote a printer token';
  end if;

  -- Dedupe: the same key on the same printer cannot be inserted twice.
  begin
    insert into public.print_jobs (tenant_id, location_id, printer_id, document, expires_at, dedupe_key)
    values ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000101',
            '6e10000a-0000-4000-8000-000000000001', '{"lines":[]}'::jsonb, now(), 'fire:1');
    raise exception 'duplicate dedupe_key accepted';
  exception when unique_violation then null;
  end;

  -- Deleting a printer drops its jobs.
  delete from public.print_printers where id = '6e10000a-0000-4000-8000-000000000001';
  if exists (select 1 from public.print_jobs where id = '6e10000b-0000-4000-8000-000000000001') then
    raise exception 'jobs survived their printer';
  end if;
end $$;

rollback;
