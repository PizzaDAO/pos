-- order_adjustments: drop the Supabase default TRUNCATE/TRIGGER/REFERENCES
-- grants that 20261113001000 left on anon and authenticated, matching every
-- other public table (clients keep SELECT under RLS only).
begin;
set local lock_timeout = '3s';

revoke truncate, trigger, references on public.order_adjustments from anon, authenticated;

commit;
