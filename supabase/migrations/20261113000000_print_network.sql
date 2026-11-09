-- ============================================================================
-- Network kitchen-ticket printing (pull protocols: Star CloudPRNT, Epson Server
-- Direct Print). Additive. The shop printer POLLS our HTTPS endpoints, so
-- nothing needs inbound access to the shop and it works from serverless.
--
--   print_printers        one row per physical printer at a location. The device
--                         authenticates with a generated token; only its sha256
--                         `token_hash` is stored (the token is shown once).
--   print_jobs            per-printer queue. `document` is the protocol-neutral
--                         ticket; it is rendered when the printer fetches it.
--   print_location_settings  per-location auto-print switch (off by default).
--
-- Access model (same as security_revoke_client_writes / terminal_readers):
-- everything here is written AND read only by the service-role server path
-- (src/lib/db/supabase.ts). `token_hash` is a credential, so even SELECT is not
-- granted to staff: RLS is enabled + forced, no policy, all grants revoked from
-- anon/authenticated. The admin UI reads through the API (owner/manager).
-- Re-runnable; additive; no locks on existing tables.
-- ============================================================================

create table if not exists public.print_printers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  label text not null default '',
  protocol text not null check (protocol in ('star_cloudprnt', 'epson_sdp')),
  -- Star only: 'markup' (Star Document Markup) or 'text' (plain text).
  format text not null default 'markup' check (format in ('markup', 'text')),
  columns int not null default 42 check (columns in (42, 48)),
  token_hash text not null,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists print_printers_location_idx
  on public.print_printers (tenant_id, location_id);

create table if not exists public.print_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  printer_id uuid not null references public.print_printers (id) on delete cascade,
  order_id uuid references public.orders (id) on delete set null,
  kind text not null default 'ticket' check (kind in ('ticket', 'test')),
  document jsonb not null,
  status text not null default 'queued'
    check (status in ('queued', 'sent', 'done', 'failed', 'expired')),
  attempts int not null default 0,
  error text,
  -- Idempotency for auto-print (one fire = one ticket per printer). Manual
  -- reprints leave it null. Unique so a retried fire can never double-print.
  dedupe_key text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  claimed_at timestamptz,
  done_at timestamptz
);
create unique index if not exists print_jobs_dedupe_key
  on public.print_jobs (printer_id, dedupe_key) where dedupe_key is not null;
create index if not exists print_jobs_pending_idx
  on public.print_jobs (printer_id, created_at) where status in ('queued', 'sent');

create table if not exists public.print_location_settings (
  location_id uuid primary key references public.locations (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  auto_print boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.print_printers enable row level security;
alter table public.print_printers force row level security;
alter table public.print_jobs enable row level security;
alter table public.print_jobs force row level security;
alter table public.print_location_settings enable row level security;
alter table public.print_location_settings force row level security;

revoke all on public.print_printers from anon, authenticated;
revoke all on public.print_jobs from anon, authenticated;
revoke all on public.print_location_settings from anon, authenticated;
