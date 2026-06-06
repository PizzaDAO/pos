/**
 * Public entry for the realtime layer. Import from `@/lib/realtime` so the
 * underlying transport (polling today, Supabase Realtime later) can change in
 * one place without touching call sites — mirroring `@/lib/db`.
 */
import { createPollingProvider } from "./polling";
import { createSupabaseRealtimeProvider } from "./supabase";
import type { RealtimeProvider } from "./provider";

export * from "./provider";

let cached: RealtimeProvider | null = null;

/**
 * True when the public Supabase env is present (production / preview with the
 * project wired). Read at CALL time — nothing here touches env at module load,
 * so the bundle evaluates and every build/test runs with NO env vars. This
 * mirrors the `getPosDriver()` / `readDbConfig()` guard in `@/lib/db`.
 */
function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}

/**
 * Returns the active realtime provider, chosen lazily by env (memoized):
 *   - Supabase env present  → Supabase Realtime (websocket push; falls back to
 *     polling internally for any subscription it can't serve, e.g. SSR render).
 *   - Otherwise (local/CI)  → the interval poller (the zero-env default, so the
 *     build, Vercel preview, and the full Vitest suite stay green with no env).
 *
 * Both implement the same `subscribe()` contract, so `use-kitchen-board` and
 * `use-order-tracking` are unchanged either way.
 */
export function getRealtimeProvider(): RealtimeProvider {
  if (cached) return cached;
  cached = isSupabaseConfigured()
    ? createSupabaseRealtimeProvider()
    : createPollingProvider();
  return cached;
}

/** Test/HMR helper to clear the memoized provider. */
export function resetRealtimeProvider(): void {
  cached = null;
}
