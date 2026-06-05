/**
 * Thin database-access layer.
 *
 * Phase 0 (DEFERRED Supabase): this module defines the *shape* of DB access so
 * the rest of the app imports from `@/lib/db` and never talks to Supabase
 * directly. When a live Supabase project is provisioned in a later phase, the
 * `getDb()` / `getPosDriver()` implementations are swapped to return a real
 * Supabase-backed driver (server + RLS-aware) WITHOUT changing any call sites.
 *
 * IMPORTANT: nothing here reads env vars at module load — the app must build and
 * the bundle must evaluate with NO Supabase env vars set. Env access happens
 * lazily inside the getters only when actually invoked at runtime.
 */
import type { PosDriver } from "./driver";
import { mockDriver } from "./mock";
import { createSupabaseDriver, readSupabaseConfig } from "./supabase";

export interface DbClientConfig {
  url: string;
  anonKey: string;
}

/**
 * Reads Supabase connection config from the environment at call time.
 * Returns null when not configured (Phase 0/1 default) so callers can degrade
 * gracefully instead of throwing at import/build time.
 */
export function readDbConfig(): DbClientConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

/**
 * Placeholder low-level DB handle. In a later phase this returns a configured
 * Supabase client. Today it only reports whether config is present — but only
 * when actually invoked at runtime, never at build time.
 */
export interface Db {
  readonly configured: boolean;
}

let cached: Db | null = null;

export function getDb(): Db {
  if (cached) return cached;
  const config = readDbConfig();
  cached = { configured: config !== null };
  return cached;
}

/** Test/HMR helper to clear the memoized client. */
export function resetDb(): void {
  cached = null;
}

// ----------------------------------------------------------------------------
// PosDriver selection (live-wiring)
//
// The terminal talks to menu/order data ONLY through `getPosDriver()`. The
// selection is env-driven and LAZY (read at call time, never at module load):
//   * Supabase env present (NEXT_PUBLIC_SUPABASE_URL + a SUPABASE_* key) → the
//     real Supabase-backed driver.
//   * Otherwise → the in-memory mock driver (the zero-env default, so the app
//     builds/runs/tests with no configuration).
// NO call site changes are required either way — both implement `PosDriver`.
// ----------------------------------------------------------------------------

let cachedDriver: PosDriver | null = null;

export function getPosDriver(): PosDriver {
  if (cachedDriver) return cachedDriver;
  const config = readSupabaseConfig();
  cachedDriver = config ? createSupabaseDriver(config) : mockDriver;
  return cachedDriver;
}

/** Test/HMR helper to clear the memoized driver. */
export function resetPosDriver(): void {
  cachedDriver = null;
}
