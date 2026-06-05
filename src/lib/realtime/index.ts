/**
 * Public entry for the realtime layer. Import from `@/lib/realtime` so the
 * underlying transport (polling today, Supabase Realtime later) can change in
 * one place without touching call sites — mirroring `@/lib/db`.
 */
import { createPollingProvider } from "./polling";
import type { RealtimeProvider } from "./provider";

export * from "./provider";

let cached: RealtimeProvider | null = null;

/**
 * Returns the active realtime provider.
 *
 * Today this is always the polling provider (Supabase Realtime deferred — see
 * `supabase.ts`). When a live Supabase project is provisioned, swap the
 * selection here based on `readDbConfig()`:
 *
 *   const config = readDbConfig();
 *   cached = config ? createSupabaseRealtimeProvider(config) : createPollingProvider();
 *
 * No env vars are read here, so the bundle evaluates with nothing configured.
 */
export function getRealtimeProvider(): RealtimeProvider {
  if (cached) return cached;
  cached = createPollingProvider();
  return cached;
}

/** Test/HMR helper to clear the memoized provider. */
export function resetRealtimeProvider(): void {
  cached = null;
}
