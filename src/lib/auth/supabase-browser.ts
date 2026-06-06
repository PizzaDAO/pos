/**
 * Browser-side Supabase client (real-auth) — created via `@supabase/ssr` so the
 * session is stored in cookies that the server + middleware can read/refresh.
 *
 * ENV-GUARDED: returns `null` when the Supabase public env vars are absent (the
 * zero-env / mock default), so callers degrade to the simulated auth path and
 * the app still builds/runs/tests with no configuration. Read at call time —
 * nothing here touches env at module load.
 *
 * Client-only: imported by client components/hooks for sign-in (magic-link,
 * password) and sign-out.
 */
"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

/** True when the public Supabase env is present (real-auth enabled). */
export function isSupabaseAuthConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}

/**
 * The browser Supabase client, or null when unconfigured (mock/simulated auth).
 * Memoized so a single client instance owns the auth cookie/refresh.
 */
export function getBrowserSupabase(): SupabaseClient | null {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  cached = createBrowserClient(url, anonKey);
  return cached;
}
