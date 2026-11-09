-- Stored value tables: force RLS like every other server-only table
-- (rls_isolation.sql requires it). No client role has any grant on these
-- tables, and the sv_* SECURITY DEFINER functions run as postgres, which has
-- BYPASSRLS, so forcing changes nothing for the functions.
begin;
set local lock_timeout = '3s';

alter table public.stored_value_accounts force row level security;
alter table public.stored_value_ledger force row level security;
alter table public.stored_value_guard force row level security;

commit;
