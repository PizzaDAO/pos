#!/usr/bin/env bash
# ============================================================================
# RLS isolation harness — applies the tenancy migrations to a Postgres and runs
# the tenant-isolation assertions (supabase/tests/rls_isolation.sql).
#
# This CANNOT run without a live Postgres, so it is NOT part of the required CI
# gates. Use it against:
#   * a local throwaway Postgres (e.g. `docker run -e POSTGRES_PASSWORD=postgres
#     -p 5432:5432 postgres:16`), or
#   * a provisioned Supabase project (once the live-wiring phase lands).
#
# Usage:
#   DATABASE_URL="postgres://postgres:postgres@localhost:5432/pos_test" \
#     bash supabase/tests/run-rls-isolation.sh
#
# This SCRIPT applies migrations idempotently-ish (create-or-replace functions;
# tables will error if already present), so point it at a FRESH database.
# The isolation test itself (rls_isolation.sql) is fixture-scoped — its
# assertions only count the two fixture tenants — and runs in a transaction that
# rolls back, so the .sql ALONE is safe to run against a live, non-empty
# database (psql -f supabase/tests/rls_isolation.sql); only this harness needs
# a fresh one.
#
# On a VANILLA Postgres (local/CI) the auth.uid() shim is applied first so the
# policies resolve. Against a REAL Supabase project, set SKIP_AUTH_SHIM=1 — the
# platform already supplies auth.uid() and the shim must NOT overwrite it.
# ============================================================================
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL to a Postgres connection string}"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MIGRATIONS_DIR="$ROOT/supabase/migrations"
TEST_FILE="$ROOT/supabase/tests/rls_isolation.sql"
SHIM_FILE="$ROOT/supabase/tests/auth_shim.sql"

if [ -z "${SKIP_AUTH_SHIM:-}" ]; then
  echo "==> Applying auth.uid() shim (vanilla Postgres; set SKIP_AUTH_SHIM=1 for real Supabase)"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$SHIM_FILE"
fi

echo "==> Applying tenancy migrations from $MIGRATIONS_DIR"
for f in "$MIGRATIONS_DIR"/*.sql; do
  echo "    - $(basename "$f")"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done

echo "==> Running RLS isolation test"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$TEST_FILE"

echo "==> RLS isolation harness complete."
