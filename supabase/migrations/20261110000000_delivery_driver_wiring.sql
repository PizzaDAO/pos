-- ============================================================================
-- Migration: delivery_driver_wiring  (POS -> Open Pizza driver module)
--
--   * staff.module_roles: extra roles for other Open Pizza modules ('driver',
--     'dispatcher'), emitted in the contract staff `roles` next to the POS role.
--     Never a POS permission; the POS role column is unchanged.
--   * deliveries.dispatch_attempts / dispatch_error / dispatch_next_at: retry
--     bookkeeping for outbound dispatch to the driver module (used by a later PR).
--
-- Additive and live-safe: new columns with constant defaults (no table rewrite),
-- a CHECK added NOT VALID then validated, an idempotent partial index. Re-runnable.
-- DEPLOY ORDER migration first, then code. lock_timeout bounds the catalog locks.
-- ============================================================================

begin;
set local lock_timeout = '3s';

alter table public.staff
  add column if not exists module_roles text[] not null default '{}';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'staff_module_roles_chk'
       and conrelid = 'public.staff'::regclass
  ) then
    alter table public.staff
      add constraint staff_module_roles_chk
      check (module_roles <@ array['driver','dispatcher']::text[]) not valid;
    alter table public.staff validate constraint staff_module_roles_chk;
  end if;
end
$$;

alter table public.deliveries
  add column if not exists dispatch_attempts integer not null default 0;
alter table public.deliveries
  add column if not exists dispatch_error text;
alter table public.deliveries
  add column if not exists dispatch_next_at timestamptz;

create index if not exists deliveries_dispatch_retry_idx
  on public.deliveries (dispatch_next_at)
  where status = 'quoted' and provider = 'openpizza_driver';

commit;

notify pgrst, 'reload schema';
