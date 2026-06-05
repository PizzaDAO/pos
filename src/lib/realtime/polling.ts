/**
 * Polling realtime provider (Phase 3 default).
 *
 * Implements the `RealtimeProvider` seam by polling the supplied `fetcher` on a
 * fixed interval and pushing each result to the listener. This is what powers
 * the KDS board today: it re-fetches `/api/kitchen/orders` every few seconds so
 * new/placed/bumped orders appear without a websocket. Because everything flows
 * through `subscribe()`, swapping in Supabase Realtime later (see `supabase.ts`)
 * requires no component changes.
 *
 * Design notes:
 *  - The listener fires once immediately on subscribe (no wait for first tick).
 *  - In-flight ticks are de-duped: if a fetch is still running when the next
 *    interval fires, that tick is skipped (avoids pile-up on a slow network).
 *  - Errors are swallowed per-tick (a transient fetch failure shouldn't kill the
 *    subscription); the previous snapshot simply persists until the next success.
 */
import type {
  RealtimeListener,
  RealtimeProvider,
  Unsubscribe,
} from "./provider";

const DEFAULT_INTERVAL_MS = 4000;

export function createPollingProvider(): RealtimeProvider {
  return {
    name: "polling",

    subscribe<T>(
      _topic: string,
      fetcher: () => Promise<T>,
      listener: RealtimeListener<T>,
      options?: { intervalMs?: number },
    ): Unsubscribe {
      const intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS;
      let active = true;
      let inFlight = false;

      const tick = async () => {
        if (!active || inFlight) return;
        inFlight = true;
        try {
          const data = await fetcher();
          if (!active) return;
          listener({ data, source: "poll", at: new Date().toISOString() });
        } catch {
          // Transient failure — keep the last good snapshot, retry next tick.
        } finally {
          inFlight = false;
        }
      };

      // Fire immediately, then on the interval.
      void tick();
      const handle = setInterval(() => void tick(), intervalMs);

      return () => {
        active = false;
        clearInterval(handle);
      };
    },
  };
}
