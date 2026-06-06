# focaccia-51842 — Supabase Realtime for KDS + order tracking

**Priority:** P1 (live operations surface)
**Parent plan:** `../PLAN.md`
**Builds on:** Phase 3 KDS (`basil-44217`), Phase 4 shop tracking
(`calabrese-55389`), the Supabase wiring (`napoletana-99713`), and real auth
(`real-auth`).

## Goal
Upgrade the realtime layer from **interval polling** to **Supabase Realtime** so
the Kitchen Display System and the customer order tracker receive **instant**
push updates, WITHOUT changing any component or the provider contract. Like every
prior phase, the build, type-check, lint, and full Vitest suite stay green with
**ZERO env vars** — Supabase Realtime activates only when the public Supabase env
is present (production/preview); local/CI fall back to the existing poller.

## Core design rule (unchanged): realtime behind one seam
Components depend ONLY on the `RealtimeProvider` seam (`src/lib/realtime/`), never
on a transport. The `subscribe(topic, fetcher, listener, opts)` contract is
identical for polling and Supabase, so `use-kitchen-board` and
`use-order-tracking` are **byte-for-byte unchanged**.

## What was built

### Supabase Realtime provider — `src/lib/realtime/supabase.ts`
Replaces the documented stub with a real `createSupabaseRealtimeProvider()`:
- **Browser client reuse:** subscribes via `getBrowserSupabase()` (the
  `@supabase/ssr` client from real-auth), so the websocket authenticates as the
  signed-in user and Realtime enforces the SAME RLS SELECT policies as PostgREST.
- **Topic → table filter:** parses the opaque topic the hooks already pass —
  `kds:<tenant>:<location>` → `location_id=eq.<location>`, `track:<orderId>` →
  `id=eq.<orderId>` — and opens a `postgres_changes` (`event: "*"`) channel on
  `public.orders` scoped by that server-side filter.
- **Initial load + live deltas:** runs the SAME `fetcher` the poller used for the
  immediate first snapshot, then re-runs it (debounced 150ms to coalesce bursts)
  on every INSERT/UPDATE/DELETE — preserving the server-computed payload shape
  (KDS elapsed/age/station, tracker live delivery state) so there's one source of
  truth. Concurrent re-fetches are de-duped (queue-once), errors swallowed
  per-attempt like the poller.
- **Reconnect:** on each `SUBSCRIBED` transition (initial + after a dropped
  socket) it re-fetches to reconcile anything missed offline.
- **Cleanup:** the returned unsubscribe is idempotent — cancels the pending
  debounce, removes the channel, and ignores late fetch results.
- **Graceful fallback:** when there's no browser client (SSR/RSC render) or the
  topic is unrecognised, it transparently delegates that subscription to the
  poller — so behavior never goes dark and new topics are forward-compatible.

### Selection logic — `src/lib/realtime/index.ts`
`getRealtimeProvider()` now chooses lazily at CALL time (memoized), mirroring the
`getPosDriver()` / `readDbConfig()` env-guard:
- `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` present → Supabase
  Realtime.
- otherwise → the interval poller (the zero-env default).
No env is read at module load, so the bundle evaluates with nothing configured.

### Tests — `src/lib/realtime/realtime.test.ts`
Env-free Node tests asserting: poller selected with no env; Supabase provider
selected when env present; provider memoized; and the Supabase provider's
per-subscription fallback still does the initial fetch + pushes a
`source: "realtime"`-shaped snapshot for both `kds:` and `track:` topics, with
idempotent teardown. No real websocket/network is opened.

### Docs — `supabase/README.md`
New "Enabling Supabase Realtime" section with the EXACT publication SQL the
orchestrator runs on the live DB (`replica identity full` + add `orders` to
`supabase_realtime`), verification queries, and the RLS-is-the-boundary note.

## Scope discipline
Only the realtime layer + its doc/test. No changes to auth/middleware, payments,
`next.config`, or `package.json` (no new deps — `@supabase/supabase-js` and
`@supabase/ssr` are already present). Components unchanged; money/RLS correctness
untouched.

## Orchestrator action (live DB)
Run once on the live project (see `supabase/README.md` for verification):

```sql
alter table public.orders replica identity full;
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end$$;
alter publication supabase_realtime add table public.orders;
```
