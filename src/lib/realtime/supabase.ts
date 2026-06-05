/**
 * Supabase Realtime provider — DEFERRED seam (Phase 3).
 *
 * This file documents (and stubs) how the live implementation drops in without
 * any component change. When a Supabase project exists, this is the only place
 * that changes plus the one-line selection in `index.ts`:
 *
 *   import { createClient } from "@supabase/supabase-js";
 *
 *   export function createSupabaseRealtimeProvider(
 *     config: { url: string; anonKey: string },
 *   ): RealtimeProvider {
 *     const client = createClient(config.url, config.anonKey);
 *     return {
 *       name: "supabase",
 *       subscribe(topic, fetcher, listener) {
 *         // 1. Initial load via the same fetcher the poller uses:
 *         void fetcher().then((data) =>
 *           listener({ data, source: "realtime", at: new Date().toISOString() }),
 *         );
 *         // 2. Listen to Postgres changes on the `orders` table for this
 *         //    location and re-run `fetcher()` (or apply the row delta) on each
 *         //    INSERT/UPDATE, pushing a fresh snapshot:
 *         const channel = client
 *           .channel(topic)
 *           .on(
 *             "postgres_changes",
 *             { event: "*", schema: "public", table: "orders", filter: `location_id=eq.${locationId}` },
 *             async () => {
 *               const data = await fetcher();
 *               listener({ data, source: "realtime", at: new Date().toISOString() });
 *             },
 *           )
 *           .subscribe();
 *         return () => { void client.removeChannel(channel); };
 *       },
 *     };
 *   }
 *
 * The `subscribe()` contract is identical to the polling provider, so the KDS
 * board, station views, and any future tracker swap transport with zero edits.
 * Until the dependency + project are wired, `getRealtimeProvider()` always
 * returns the polling provider, so the app builds and runs with NO env vars.
 */
export {};
