#!/usr/bin/env bash
# ============================================================================
# apply.sh — apply ALL migrations (in order) + the seed to a Postgres / Supabase.
#
# This is the turnkey "stand up the schema" step for go-live. It applies every
# file in supabase/migrations/*.sql (lexicographically — the timestamp prefixes
# guarantee the right order: tenancy core/RLS first, then the domain core/RLS),
# then loads supabase/seed.sql (the demo "Tony's Pizza" tenant).
#
# Usage (plain Postgres / Supabase pooler connection string):
#   DATABASE_URL="postgres://postgres:<pw>@<host>:5432/postgres" \
#     bash supabase/apply.sh
#
# Options:
#   SKIP_SEED=1        — apply migrations only (no demo data; production go-live
#                        typically seeds a real tenant via the signup flow instead).
#   SKIP_AUTH_SHIM=1   — set on a REAL Supabase project (it already provides
#                        auth.uid()). On a vanilla Postgres the shim is applied
#                        first so the RLS policies resolve. Default: shim applied
#                        ONLY if the `auth` schema is absent (auto-detected).
#
# Requires `psql` on PATH. For the Supabase CLI path see supabase/README.md
# (`supabase db push`), which is equivalent for the migrations.
# ============================================================================
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL to a Postgres connection string}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATIONS_DIR="$ROOT/supabase/migrations"
SEED_FILE="$ROOT/supabase/seed.sql"
SHIM_FILE="$ROOT/supabase/tests/auth_shim.sql"

psql_run() { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 "$@"; }

# Auto-detect whether auth.uid() exists; apply the shim only on vanilla Postgres
# unless SKIP_AUTH_SHIM forces it off.
if [ -z "${SKIP_AUTH_SHIM:-}" ]; then
  has_auth="$(psql "$DATABASE_URL" -tAc \
    "select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace \
     where n.nspname='auth' and p.proname='uid' limit 1" 2>/dev/null || true)"
  if [ "$has_auth" != "1" ]; then
    echo "==> auth.uid() not found — applying vanilla-Postgres auth shim"
    psql_run -f "$SHIM_FILE"
  else
    echo "==> auth.uid() present (Supabase) — skipping auth shim"
  fi
fi

echo "==> Applying migrations from $MIGRATIONS_DIR"
for f in "$MIGRATIONS_DIR"/*.sql; do
  echo "    - $(basename "$f")"
  psql_run -f "$f"
done

if [ -z "${SKIP_SEED:-}" ]; then
  echo "==> Loading seed ($(basename "$SEED_FILE"))"
  psql_run -f "$SEED_FILE"
else
  echo "==> SKIP_SEED set — not loading demo data"
fi

echo "==> Done. Schema + RLS applied$([ -z "${SKIP_SEED:-}" ] && echo ' + seed loaded')."
