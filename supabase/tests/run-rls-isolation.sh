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
# It applies migrations idempotently-ish (create-or-replace functions; tables
# will error if already present — point it at a FRESH database). The isolation
# test itself runs in a transaction and rolls back, mutating nothing persistent.
# ============================================================================
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL to a Postgres connection string}"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MIGRATIONS_DIR="$ROOT/supabase/migrations"
TEST_FILE="$ROOT/supabase/tests/rls_isolation.sql"

echo "==> Applying tenancy migrations from $MIGRATIONS_DIR"
for f in "$MIGRATIONS_DIR"/*.sql; do
  echo "    - $(basename "$f")"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done

echo "==> Running RLS isolation test"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$TEST_FILE"

echo "==> RLS isolation harness complete."
