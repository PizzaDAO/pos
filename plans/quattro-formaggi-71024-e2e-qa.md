# quattro-formaggi-71024 — End-to-end QA (Playwright) + bug fixes

Adds a **Playwright** end-to-end suite for the critical flows of the multi-tenant
SaaS pizzeria POS, runs it against the app, and **fixes the real bugs it found**.
The E2E suite is fully **separate from Vitest** and the **zero-env build + Vitest
gates stay green and independent of Playwright**.

## What was added

- **Playwright** as a devDependency (`@playwright/test`), chromium project.
- `playwright.config.ts` — targets `BASE_URL` (defaults to a locally-started
  `npm run start` on port 3100; point it at a preview/prod URL to run the same
  specs against a deployment). Serial, 1 worker (specs share mock/live state),
  `trace/screenshot/video` on failure, GitHub reporter in CI.
- `e2e/support/` helpers:
  - `env.ts` — reads `E2E_*` creds + slugs/PINs from env (no secrets in repo).
  - `auth.ts` — `detectRealAuth()` (reads the login UI to tell real vs simulated
    auth) + `signInWithPassword()` for real-mode login.
  - `terminal.ts` — builds a **half-and-half** pizza in the shared PizzaBuilder.
- npm scripts: `e2e`, `e2e:ui`, `e2e:report`.
- **Optional, non-blocking** `e2e` CI job (modeled on `rls-isolation`):
  `continue-on-error: true`, builds + runs the suite on a local server; reads
  `E2E_*` from secrets (absent → real-auth specs skip). The required gates
  (`build`, `test`) do not depend on it.

## Flows covered (`e2e/*.spec.ts`)

| Spec | Flow |
|---|---|
| `auth-gating` | Public `/shop/<slug>` reachable without auth. **Real-auth only:** unauth `/admin`→`/login`, `/platform`→`/platform/login`, owner login→`/admin`, platform admin→`/platform` (skip in simulated mode). |
| `terminal` | Staff **PIN quick-switch**; build a **half-and-half** pizza → cart → place order → take a (simulated) payment → **receipt** ("paid in full"). |
| `kds` | A placed order **appears on the KDS** and is **bumped** through statuses (→ Recall). |
| `shop` | `/shop/<slug>` build half-and-half → checkout for **PICKUP** and **DELIVERY** (in-zone address quote) → confirmation → **tracking** timeline. Chooses ASAP if the store is open, else a scheduled slot. |
| `back-office` | **Reports** render KPIs + payment mix + rollups; **86 an item** then **un-86** (scoped to a named item, restores state). |
| `onboarding` | Signup wizard creates a tenant end-to-end (business → location → Connect → menu → plan → **go live**). Disposable in mock mode; against a real deployment it only runs with `E2E_RUN_ONBOARDING=1` and uses a clearly-marked throwaway name + unique email so the live demo tenant is never polluted. |

Run result (local, mock/simulated mode, zero env): **9 passed, 4 skipped**
(the 4 real-auth specs skip gracefully without creds).

## Bugs found and FIXED (app code)

1. **Payment screen showed "Charge $0.00" / disabled after placing an order
   (could not take payment).**
   - *Root cause:* the terminal opens the payment screen immediately after
     `placeOrderOffline()`, which enqueues the order and flushes to `/api/orders`
     **fire-and-forget** (`void flushNow()`). The checkout's initial
     `GET /api/payments?orderId=…` therefore raced the flush and frequently hit a
     **404 (order not yet persisted)** → `useCheckout` left `balanceCents = 0`,
     so the Charge button was disabled at $0.00 with no recovery.
   - *Fix:* `src/lib/store/use-checkout.ts` `refresh()` now **retries on a
     transient 404** (bounded, ~8×400ms) before surfacing an error, and clears a
     prior error on success — so the balance loads as soon as the order syncs.
     Surgical; no contract/UX change.

2. **86'ing a menu item in the back office made it VANISH from the editor — no
   way to un-86 it.**
   - *Root cause:* the menu manager rendered its editable item list from the
     **customer-assembled** menu (`driver.getMenu`), which **excludes** items/
     modifiers 86'd at the location. So after 86, `load()` refetched a menu
     without the item, the row disappeared, and the "86'd here" badge + **Un-86**
     control were unreachable. The 86 override persisted server-side (item hidden
     from terminal/shop) with no UI path back.
   - *Fix:* added an optional `getMenu(tenant, location, { includeUnavailable })`
     to the `PosDriver` contract (`src/lib/db/driver.ts`) and **both drivers**
     (`mock.ts` `assembleMenu`/`buildMenuItemDetail`, `supabase.ts` `assembleMenu`),
     and made the **back-office** read pass `includeUnavailable: true`
     (`src/app/api/admin/menu/route.ts`). Customer reads (`/api/menu`,
     `/api/shop/*`) are unchanged — still exclude 86'd items. The badge + Un-86
     now render and work. Default behaviour and the Vitest suite are unaffected.

Both fixes keep the **zero-env build + Vitest (122 tests) green**.

## Flows blocked by config (not code)

- **Real-auth specs** (owner/platform login, gating redirects) require a
  deployment with Supabase Auth env set + the **bootstrapped accounts** and the
  `E2E_*` passwords. They `test.skip()` gracefully in simulated/mock mode and run
  when an orchestrator supplies `BASE_URL` + creds against a preview/prod.
- **Live payment rails / DoorDash / crypto finality** are simulated in the
  preview (no live keys) — the specs assert the simulated settlement path, which
  is the intended preview behaviour.

## How to run E2E

```bash
# Local, zero env (mock driver / simulated auth) — public + simulated flows:
npm run build && npm run e2e          # webServer starts `npm run start` on :3100

# Against a deployed preview/prod (public + simulated flows):
BASE_URL=https://<preview>.vercel.app npm run e2e

# Real-auth flows against a live/preview deployment (Supabase env set there):
BASE_URL=https://<preview>.vercel.app \
E2E_OWNER_EMAIL=tony@tonys-pizza.example  E2E_OWNER_PASSWORD=*** \
E2E_PLATFORM_EMAIL=ops@pizzapos.example   E2E_PLATFORM_PASSWORD=*** \
  npm run e2e

# Optional knobs:
#   E2E_SHOP_SLUG / E2E_SHOP_SLUG_PICKUP  (default tonys-downtown / tonys-uptown)
#   E2E_STAFF_PIN                         (default 1111 → Tony)
#   E2E_RUN_ONBOARDING=1                  (allow tenant creation against a real deploy)
```

**No passwords are stored in the repo** — they are read from env only; the
orchestrator supplies them when running the real-auth suite. The new CI `e2e`
job is **optional/non-blocking**; `build` + `test` remain the required gates.
