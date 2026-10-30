-- ============================================================================
-- Stripe Terminal (server-driven): per-location Terminal Location + readers.
-- Additive. See plans/terminal-card-reader.md.
--
-- Everything Stripe-side lives on the TENANT's connected account (direct
-- charges): the Terminal Location (tml_), Configuration (tmc_) and readers
-- (tmr_). These tables are our index of them, keyed by our own ids.
--
-- Access model (mirrors connect_accounts_lockdown): tenant members may READ their
-- own rows; the rows route card-present money (which account a reader belongs
-- to), so they are written ONLY by the service-role server path, after the
-- Stripe call succeeds. No INSERT/UPDATE/DELETE policy or grant for staff.
-- ============================================================================

-- One Stripe Terminal Location per POS location.
create table if not exists public.terminal_locations (
  location_id uuid primary key references public.locations (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  -- The connected account + key mode these Stripe ids were created under. A
  -- re-onboarded account or a test<->live key flip invalidates the row.
  connect_account_id text,
  stripe_location_id text,
  configuration_id text,
  livemode boolean not null default false,
  -- Structured address Stripe requires (line1/city/state/postal_code/country).
  address jsonb,
  -- Who collects the tip: the customer on the reader, our POS, or nobody.
  tip_mode text not null default 'reader'
    check (tip_mode in ('reader', 'pos', 'none')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists terminal_locations_tenant_idx
  on public.terminal_locations (tenant_id);

-- Registered card readers (Stripe `tmr_` ids; one row per physical reader).
create table if not exists public.terminal_readers (
  id text primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  connect_account_id text not null,
  label text not null default '',
  device_type text,
  serial_number text,
  livemode boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists terminal_readers_location_idx
  on public.terminal_readers (tenant_id, location_id);

alter table public.terminal_locations enable row level security;
alter table public.terminal_locations force row level security;
alter table public.terminal_readers enable row level security;
alter table public.terminal_readers force row level security;

drop policy if exists terminal_locations_select on public.terminal_locations;
create policy terminal_locations_select on public.terminal_locations
  for select
  using (public.is_platform_admin() or public.is_tenant_member(tenant_id));

drop policy if exists terminal_readers_select on public.terminal_readers;
create policy terminal_readers_select on public.terminal_readers
  for select
  using (public.is_platform_admin() or public.is_tenant_member(tenant_id));

-- Least privilege: read-only for signed-in users, nothing for anon.
revoke all on public.terminal_locations from anon, authenticated;
revoke all on public.terminal_readers from anon, authenticated;
grant select on public.terminal_locations to authenticated;
grant select on public.terminal_readers to authenticated;

-- One OPEN card-present tender per order: a second concurrent /terminal/payments
-- start (double-tap, two tablets) can never leave two live PaymentIntents. A
-- settled/canceled/failed tender frees the slot, so a split (card + cash) or a
-- retry after cancel still works.
create unique index if not exists payments_one_live_terminal
  on public.payments (order_id)
  where rail = 'stripe_terminal'
    and status in ('requires_action', 'pending');
