/**
 * Thin database-access layer.
 *
 * Phase 0 (DEFERRED Supabase): this module defines the *shape* of DB access so
 * the rest of the app imports from `@/lib/db` and never talks to Supabase
 * directly. When a live Supabase project is provisioned in a later phase, the
 * `getDb()` implementation is swapped to return a real Supabase client (server +
 * RLS-aware) WITHOUT changing any call sites.
 *
 * IMPORTANT: nothing here reads env vars at module load — the app must build and
 * the bundle must evaluate with NO Supabase env vars set. Env access happens
 * lazily inside `getDb()` only when a query is actually executed at runtime.
 */

export interface DbClientConfig {
  url: string;
  anonKey: string;
}

/**
 * Reads Supabase connection config from the environment at call time.
 * Returns null when not configured (Phase 0 default) so callers can degrade
 * gracefully instead of throwing at import/build time.
 */
export function readDbConfig(): DbClientConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

/**
 * Placeholder DB handle. In a later phase this returns a configured Supabase
 * client. Today it throws if used, because no live DB exists yet — but only
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
