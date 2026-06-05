/**
 * Realtime abstraction (Phase 3).
 *
 * The KDS needs a live stream of active orders, but Supabase Realtime is
 * deferred (no live backend). So components depend ONLY on this provider seam —
 * never on a transport directly — and we ship a **polling** implementation today
 * (`createPollingProvider`). A Supabase Realtime implementation drops in later
 * (`createSupabaseRealtimeProvider`, documented in `supabase.ts`) WITHOUT
 * touching any component: same `subscribe()` contract, just a websocket push
 * instead of an interval poll.
 *
 * Selection happens in `index.ts` via `getRealtimeProvider()`, mirroring the
 * `getPosDriver()` pattern in `@/lib/db`.
 */

/** A snapshot handed to subscribers on each tick / push. */
export interface RealtimeSnapshot<T> {
  /** The latest payload. */
  data: T;
  /** Monotonic source for the snapshot ("poll" today, "realtime" later). */
  source: "poll" | "realtime";
  /** When the snapshot was produced (ISO). */
  at: string;
}

/** Called with each new snapshot; also called once immediately on subscribe. */
export type RealtimeListener<T> = (snapshot: RealtimeSnapshot<T>) => void;

/** Tear down a subscription. Safe to call more than once. */
export type Unsubscribe = () => void;

/**
 * A channel keyed by an opaque `topic` (e.g. `kds:<tenant>:<location>`). The
 * provider decides how to source data for that topic (poll an API now, listen
 * to a Supabase channel later). Components don't care which.
 */
export interface RealtimeProvider {
  /** Stable id of the active implementation (diagnostics / status UI). */
  readonly name: "polling" | "supabase";

  /**
   * Subscribe to a topic. `fetcher` produces the current payload on demand —
   * the polling provider calls it on each interval; a realtime provider may use
   * it for the initial load and rely on pushes thereafter. The listener fires
   * once immediately, then on every subsequent change.
   */
  subscribe<T>(
    topic: string,
    fetcher: () => Promise<T>,
    listener: RealtimeListener<T>,
    options?: { intervalMs?: number },
  ): Unsubscribe;
}
