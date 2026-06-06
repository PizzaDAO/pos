-- ============================================================================
-- Migration: auth_user_bridge (real Supabase Auth)
--
-- Wires Supabase Auth (auth.users) to the app identity (public.users) so that
-- `auth.uid()` resolves to a real `public.users.id` and the existing tenancy RLS
-- (is_tenant_member / has_tenant_role / is_platform_admin via memberships) works
-- against logged-in users. Also adds the two columns real-auth needs:
--   * staff.pin_hash   — salted scrypt PIN for the terminal quick-switch.
--   * orders.staff_id  — attribute an order to the active (PIN-switched) staff.
--
-- IDEMPOTENT / SAFE: re-runnable; uses IF NOT EXISTS and OR REPLACE throughout.
-- DEFERRED on vanilla Postgres: the `auth` schema only exists on a real Supabase
-- project, so the trigger block is guarded and skipped where `auth.users` is
-- absent (the RLS-isolation CI shim has no auth schema).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Identity bridge: auth.users (insert) -> public.users (id = NEW.id, email).
--
-- When Supabase creates an auth user (signup / admin-create / first magic-link),
-- this trigger upserts the matching public.users row so auth.uid() == users.id.
-- Existing public.users rows (the seed owner/admin) are linked by EMAIL: if a
-- public.users row with the same email already exists, its id is migrated to the
-- new auth id (and FKs follow via ON UPDATE CASCADE where present) — otherwise a
-- fresh row is created. This lets the bootstrap script create an auth user for
-- the seed owner and have it line up with the seeded membership.
-- ----------------------------------------------------------------------------

-- Make the user-id FKs cascade on UPDATE so re-pointing a seed user's id to the
-- auth id propagates cleanly to memberships/platform_admins in one statement.
alter table public.memberships
  drop constraint if exists memberships_user_id_fkey,
  add constraint memberships_user_id_fkey
    foreign key (user_id) references public.users (id)
    on update cascade on delete cascade;

alter table public.platform_admins
  drop constraint if exists platform_admins_user_id_fkey,
  add constraint platform_admins_user_id_fkey
    foreign key (user_id) references public.users (id)
    on update cascade on delete cascade;

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_id uuid;
begin
  -- Is there already an app user with this email (e.g. a seed user)?
  select id into existing_id from public.users where lower(email) = lower(new.email);

  if existing_id is null then
    -- Brand-new user: create a public.users row keyed to the auth id.
    insert into public.users (id, email)
    values (new.id, new.email)
    on conflict (id) do nothing;
  elsif existing_id <> new.id then
    -- Pre-existing seed user: re-point its id to the auth id so auth.uid()
    -- matches. The FKs above ON UPDATE CASCADE, so memberships/platform_admins
    -- follow automatically.
    update public.users set id = new.id, email = new.email where id = existing_id;
  else
    -- Same id already present: just keep the email in sync.
    update public.users set email = new.email where id = new.id;
  end if;

  return new;
end;
$$;

-- Attach the trigger only where the auth schema exists (real Supabase project).
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'auth' and table_name = 'users'
  ) then
    -- Drop + recreate so the migration is idempotent.
    execute 'drop trigger if exists on_auth_user_created on auth.users';
    execute $t$
      create trigger on_auth_user_created
      after insert on auth.users
      for each row execute function public.handle_new_auth_user()
    $t$;
  else
    raise notice 'auth.users not present (vanilla Postgres) — identity-bridge trigger skipped.';
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- 2. Staff quick-switch PIN (server-verified; hash never leaves the server).
-- ----------------------------------------------------------------------------
alter table public.staff
  add column if not exists pin_hash text;

-- ----------------------------------------------------------------------------
-- 3. Order -> staff attribution (the PIN-switched active staff at the till).
-- ----------------------------------------------------------------------------
alter table public.orders
  add column if not exists staff_id uuid references public.staff (id) on delete set null;

create index if not exists orders_staff_id_idx on public.orders (staff_id);

-- ----------------------------------------------------------------------------
-- 4. RLS for staff.pin_hash: the column is part of the staff table, already RLS-
--    gated to tenant members (read) / owner-manager (write). To ensure the hash
--    is never exposed even to tenant members via the API, the app NEVER selects
--    pin_hash for client responses (listStaff strips it; only the server-side
--    PIN route reads it via getStaffById). No extra policy needed — but we add a
--    column-level revoke from anon for defense in depth.
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke select (pin_hash) on public.staff from anon;
  end if;
end;
$$;
