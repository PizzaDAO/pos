-- ============================================================================
-- Staff identity guards (migration 20261104000000_core_pos_asks):
--   * a manager cannot change an owner's email
--   * a manager cannot relink / demote / promote an owner's staff row, so the
--     demote -> relink -> promote bypass and self-promotion are closed
--   * owners, self, and the service role (no JWT user) are unaffected
--
-- Run (after the migrations; rolls back, fixture-scoped):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/staff_identity_guards.sql
-- Needs a role that is not subject to RLS on these tables (the migration owner),
-- like rls_isolation.sql; the actor is simulated through request.jwt.claims.
-- ============================================================================
begin;
set client_min_messages = warning;

insert into public.tenants (id, name, slug)
values ('0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a', 'guard-t', 'guard-t');
insert into public.users (id, email) values
  ('0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b01', 'g-owner@x.example'),
  ('0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b02', 'g-mgr@x.example'),
  ('0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b03', 'g-cash@x.example');
insert into public.memberships (user_id, tenant_id, role) values
  ('0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b01', '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a', 'owner'),
  ('0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b02', '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a', 'manager'),
  ('0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b03', '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a', 'cashier');
insert into public.staff (id, tenant_id, name, role, user_id) values
  ('0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c01', '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a',
   'Boss', 'owner', '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b01'),
  ('0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c02', '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a',
   'Mgr', 'manager', '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b02');

create or replace function pg_temp.act_as(p_uid text) returns void language sql as $$
  select set_config('request.jwt.claims',
    case when p_uid = '' then '{}' else '{"sub":"' || p_uid || '"}' end, true);
$$;

-- Runs p_sql as p_uid and asserts it was (not) refused with 42501.
create or replace function pg_temp.expect(p_uid text, p_sql text, p_denied boolean, p_label text)
returns void language plpgsql as $$
declare v_denied boolean := false;
begin
  perform pg_temp.act_as(p_uid);
  begin
    execute p_sql;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  perform pg_temp.act_as('');
  if v_denied is distinct from p_denied then
    raise exception 'FAIL: % (expected %, got %)', p_label,
      case when p_denied then 'denied' else 'allowed' end,
      case when v_denied then 'denied' else 'allowed' end;
  end if;
end;
$$;

do $$
declare
  owner_u constant text := '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b01';
  mgr_u   constant text := '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b02';
  owner_s constant text := '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c01';
  mgr_s   constant text := '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c02';
  t constant text := '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
begin
  -- emails
  perform pg_temp.expect(mgr_u, format('update public.users set email=%L where id=%L', 'evil@x.example', owner_u), true, 'manager -> owner email');
  perform pg_temp.expect(mgr_u, format('update public.users set email=%L where id=%L', 'mine@x.example', mgr_u), false, 'manager -> own email');
  perform pg_temp.expect(owner_u, format('update public.users set email=%L where id=%L', 'm2@x.example', mgr_u), false, 'owner -> manager email');
  perform pg_temp.expect('', format('update public.users set email=%L where id=%L', 'svc@x.example', owner_u), false, 'service role -> owner email');

  -- the three-step bypass: demote owner row, relink, promote
  perform pg_temp.expect(mgr_u, format('update public.staff set role=%L where id=%L', 'cashier', owner_s), true, 'step 1: manager demotes owner row');
  perform pg_temp.expect(mgr_u, format('update public.staff set user_id=%L where id=%L', mgr_u, owner_s), true, 'step 2: manager relinks owner row');
  perform pg_temp.expect(mgr_u, format('update public.staff set role=%L where id=%L', 'owner', mgr_s), true, 'manager promotes own row to owner');
  perform pg_temp.expect(mgr_u, format('insert into public.staff (tenant_id,name,role) values (%L,%L,%L)', t, 'X', 'owner'), true, 'manager inserts owner row');
  perform pg_temp.expect(mgr_u, format('insert into public.staff (tenant_id,name,role) values (%L,%L,%L)', t, 'C', 'cashier'), false, 'manager inserts cashier row');
  perform pg_temp.expect(mgr_u, format('update public.staff set name=%L where id=%L', 'Renamed', owner_s), false, 'unrelated update is not guarded');
  perform pg_temp.expect(owner_u, format('update public.staff set role=%L where id=%L', 'manager', mgr_s), false, 'owner changes a manager row');
  perform pg_temp.expect('', format('update public.staff set role=%L where id=%L', 'owner', mgr_s), false, 'service role promotes');
  -- the cross-tenant bypass: move the row to a tenant where the actor ranks higher
  insert into public.tenants (id, name, slug)
  values ('0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0b', 'guard-t2', 'guard-t2');
  insert into public.memberships (user_id, tenant_id, role)
  values (mgr_u::uuid, '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0b', 'owner');
  perform pg_temp.expect(mgr_u, format('update public.staff set tenant_id=%L where id=%L', '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0b', owner_s), true, 'manager moves owner row to another tenant');
  raise notice 'staff identity guards: ok';
end
$$;

rollback;
