/**
 * Supabase Realtime provider — the LIVE realtime transport.
 *
 * Implements the EXACT same `RealtimeProvider.subscribe()` contract as the
 * polling provider (`polling.ts`), so the KDS board (`use-kitchen-board`), the
 * customer tracker (`use-order-tracking`), and any future consumer swap from
 * interval-polling to websocket-push with ZERO component changes. The selection
 * happens once in `index.ts` via `getRealtimeProvider()` (mirroring the
 * `getPosDriver()` env-guard): Supabase Realtime when the public Supabase env is
 * present, polling otherwise.
 *
 * How a subscription works:
 *   1. INITIAL LOAD — call the SAME `fetcher` the poller uses and push the first
 *      snapshot immediately (so the UI fills in exactly as it does today, with no
 *      wait for the first websocket event).
 *   2. LIVE UPDATES — open a Supabase Realtime channel listening to Postgres
 *      changes (`postgres_changes`, `event: "*"`) on the `orders` table, SCOPED by
 *      a server-side `filter` to the topic's location (KDS) or order id
 *      (tracking). On each INSERT/UPDATE/DELETE we re-run `fetcher()` and push a
 *      fresh snapshot. Re-fetching (rather than patching the row delta) keeps the
 *      server-computed shape — KDS tickets carry server-side elapsed time / age
 *      coloring, tracking pulls live delivery state — identical to the poll path,
 *      so there is a single source of truth for the payload.
 *   3. RECONNECT — Realtime resubscribes automatically after a dropped socket;
 *      on each (re)subscribe transition we re-fetch so a snapshot missed while
 *      offline is reconciled. A short debounce coalesces bursts of row events
 *      (e.g. an order + its line items changing together) into one fetch.
 *   4. CLEANUP — the returned unsubscribe removes the channel; it is idempotent
 *      and also cancels any pending debounced fetch and ignores late results.
 *
 * RLS / tenant scoping: the channel uses the browser Supabase client from the
 * auth work (`@supabase/ssr`), so the websocket authenticates as the signed-in
 * user. Supabase Realtime enforces the same RLS SELECT policies as PostgREST on
 * `postgres_changes`, so a user only ever receives rows for tenants/locations
 * they're a member of — the `filter` below narrows further but is NOT the
 * security boundary (RLS is). The `orders` table must be in the
 * `supabase_realtime` publication with `REPLICA IDENTITY FULL` for UPDATE/DELETE
 * filters to match on old rows — see `supabase/README.md`.
 */
import { getBrowserSupabase } from "@/lib/auth/supabase-browser";
import { createPollingProvider } from "./polling";
import type {
  RealtimeListener,
  RealtimeProvider,
  Unsubscribe,
} from "./provider";

/** Coalesce a burst of row events into a single re-fetch. */
const REFETCH_DEBOUNCE_MS = 150;

/**
 * What to subscribe to, derived from the opaque `topic` the hooks pass:
 *   - `kds:<tenantId>:<locationId>` → all of a location's orders.
 *   - `track:<orderId>`            → a single order.
 * Returns `null` for an unrecognised topic, so the caller transparently falls
 * back to polling for that subscription (forward-compatible with new topics).
 */
function parseOrdersFilter(topic: string): string | null {
  const kds = /^kds:([^:]+):([^:]+)$/.exec(topic);
  if (kds) {
    // location_id uniquely identifies the board feed; tenant scope is enforced
    // by RLS (a location belongs to exactly one tenant).
    return `location_id=eq.${kds[2]}`;
  }
  const track = /^track:(.+)$/.exec(topic);
  if (track) {
    return `id=eq.${track[1]}`;
  }
  return null;
}

/**
 * Build the Supabase Realtime provider. Constructed lazily by
 * `getRealtimeProvider()` only when the Supabase env is present.
 */
export function createSupabaseRealtimeProvider(): RealtimeProvider {
  // Fall back to polling for any subscription Supabase can't serve (no browser
  // client — e.g. SSR/initial RSC render — or an unrecognised topic), so behavior
  // degrades gracefully instead of going dark.
  const polling = createPollingProvider();

  return {
    name: "supabase",

    subscribe<T>(
      topic: string,
      fetcher: () => Promise<T>,
      listener: RealtimeListener<T>,
      options?: { intervalMs?: number },
    ): Unsubscribe {
      const client = getBrowserSupabase();
      const filter = parseOrdersFilter(topic);

      // No browser client (server render) or a topic we don't map to a table →
      // use the interval poller, preserving the live-update guarantee everywhere.
      if (!client || !filter) {
        return polling.subscribe(topic, fetcher, listener, options);
      }

      let active = true;
      let inFlight = false;
      let queued = false;
      let debounceHandle: ReturnType<typeof setTimeout> | null = null;

      const push = (data: T) => {
        if (!active) return;
        listener({ data, source: "realtime", at: new Date().toISOString() });
      };

      // Re-fetch the full payload and push a snapshot. De-dupes concurrent runs:
      // if a fetch is already running when another change arrives, we re-run once
      // it finishes (so we never miss the final state, never pile up requests).
      const runFetch = async () => {
        if (!active) return;
        if (inFlight) {
          queued = true;
          return;
        }
        inFlight = true;
        try {
          const data = await fetcher();
          push(data);
        } catch {
          // Transient failure — keep the last good snapshot; the next change (or
          // reconnect re-fetch) recovers, exactly like the poller swallows ticks.
        } finally {
          inFlight = false;
          if (active && queued) {
            queued = false;
            void runFetch();
          }
        }
      };

      const scheduleFetch = () => {
        if (!active) return;
        if (debounceHandle) clearTimeout(debounceHandle);
        debounceHandle = setTimeout(() => {
          debounceHandle = null;
          void runFetch();
        }, REFETCH_DEBOUNCE_MS);
      };

      // 1. Initial load via the same fetcher the poller uses (no debounce — fill
      //    the UI immediately).
      void runFetch();

      // 2. Live updates: Postgres changes on `orders`, scoped to this topic.
      const channel = client
        .channel(`realtime:${topic}`)
        .on(
          // postgres_changes payload typing varies across supabase-js minors;
          // the handler only needs the event to trigger a re-fetch.
          "postgres_changes" as never,
          {
            event: "*",
            schema: "public",
            table: "orders",
            filter,
          } as never,
          () => {
            scheduleFetch();
          },
        )
        .subscribe((status) => {
          // 3. Reconnect/resubscribe: after the socket recovers, Realtime fires
          //    SUBSCRIBED again — re-fetch to reconcile anything missed offline.
          if (status === "SUBSCRIBED") {
            scheduleFetch();
          }
        });

      // 4. Cleanup — idempotent: cancel pending work, drop the channel, ignore
      //    any late fetch result.
      return () => {
        if (!active) return;
        active = false;
        if (debounceHandle) {
          clearTimeout(debounceHandle);
          debounceHandle = null;
        }
        void client.removeChannel(channel);
      };
    },
  };
}
