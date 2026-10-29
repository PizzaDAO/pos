-- ============================================================================
-- connect_accounts lockdown.
--
-- 1) account_id must be unique: the Stripe webhook (account.updated) routes by
--    account id, so two tenants must never share one.
-- 2) The row decides where a tenant's card revenue settles. Tenant staff
--    (owner/manager, via a user JWT / PostgREST) must NOT be able to write it
--    directly — only the server (service_role, which bypasses RLS) writes it,
--    after the Stripe-backed onboarding flow. Drop the owner/manager write
--    policy and revoke write privileges from `authenticated`. The tenant-member
--    SELECT policy (connect_accounts_select) and the SELECT grant stay.
--
-- The app writes connect_accounts only through the service-role server driver
-- (src/lib/db/supabase.ts); the browser Supabase client is used for auth and
-- realtime only.
-- ============================================================================

create unique index if not exists connect_accounts_account_id_key
  on public.connect_accounts (account_id);

drop policy if exists connect_accounts_write on public.connect_accounts;

revoke insert, update, delete on public.connect_accounts from authenticated;
revoke insert, update, delete on public.connect_accounts from anon;
