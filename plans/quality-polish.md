# Quality Polish Pass — a11y, performance, PWA, SEO, UX states

**Branch:** `polish` · **Worktree:** `../pos-polish2` (off `origin/main`)
**Scope:** presentational/quality only. No business logic, auth, payments,
realtime, RLS, security headers/CSP, or data-model changes. Zero-env build +
160 Vitest tests stay green.

---

## What changed

### New shared UI primitives (`src/components/ui/`)
- **`dialog.tsx`** — accessible modal wrapper: `role="dialog"` + `aria-modal`,
  focus trap (Tab/Shift+Tab cycle), focus-in on open + restore on close,
  Esc-to-close, backdrop-click-to-close (optional), body scroll-lock. Applied to
  every hand-rolled modal so they all behave identically.
- **`skeleton.tsx`** — pulsing loading placeholder (replaces "Loading…" text).
- **`empty-state.tsx`** — consistent empty-state block (icon/title/desc/action).
- **`error-state.tsx`** + **`route-error.tsx`** — shared error-boundary UI +
  reusable body that logs via the existing `captureError` observability seam.
- **`toast.tsx`** — dependency-free toast provider with an `aria-live="polite"`
  region; wired into `providers.tsx`. Terminal place-order uses it.

### Accessibility (WCAG AA)
- Skip-to-content link in root layout; `id="main-content"` landmark on every
  surface (terminal, shop, kitchen, admin, home, placeholders, offline, 404).
- Focus-visible: shared Button bumped to `ring-2 + offset`; global
  `:focus-visible` ring for native interactive elements in `globals.css`.
- All five modals refactored onto `Dialog` (focus-trap + Esc): pizza builder,
  terminal cart confirmation, customer cart drawer, staff switch, payment.
- KDS: polite `aria-live` region announces newly-arrived tickets; ticket cards
  get descriptive `aria-label`s; Bump/Recall/Print buttons labelled per order.
- Menu category buttons use `aria-pressed`; menu item buttons get descriptive
  `aria-label`s (name + price). Admin nav gets `aria-current`.
- Staff-switch: `htmlFor`/`id` label association, `aria-invalid`/`aria-describedby`
  + `role="alert"` on the PIN error.
- Decorative icons marked `aria-hidden`.

### Performance
- `next/font` (Inter, self-hosted variable font via `--font-sans` → Tailwind
  `font-sans`) — no runtime Google Fonts request, CSP-safe, builds offline.
- Admin back-office tab panels lazy-loaded with `next/dynamic` + skeleton
  fallback (9 heavy managers code-split out of the initial bundle; only the open
  tab loads).
- `React.memo` on hot lists: KDS `TicketCard` and `MenuBrowse`.
- Loading skeletons for terminal, shop, KDS, and admin panels.

### PWA
- Manifest enriched: `id`, `lang`, `dir`, `categories`, `screenshots`
  (wide + narrow PNGs), kept maskable icons + theme/background colors.
- Offline fallback page (`/offline`) wired into Serwist `fallbacks` (navigation
  requests that miss network + precache get the offline shell, not the browser
  error page). Terminal's own offline-first flow is unaffected.
- `InstallPrompt` (captures `beforeinstallprompt`, dismissible) on the terminal.
- `theme-color` meta via root `viewport` (light/dark).

### SEO / metadata
- Root `metadata` with `metadataBase`, title template, OG + Twitter cards,
  favicons (SVG + PNG), `applicationName`, manifest link.
- Per-route metadata: terminal/kitchen/admin/platform/track → `noindex`;
  storefront `generateMetadata` (per-location title/desc/OG, canonical, indexable);
  signup indexable.
- `robots.ts` (storefront + home crawlable; app surfaces disallowed) and
  `sitemap.ts` (home + each seeded storefront, derived at build time, no DB call).
- `favicon.svg`, `og.png` (1200×630) assets.

### UX states
- Consistent loading skeletons + empty states (empty cart, no KDS tickets,
  load errors with Retry).
- Route error boundaries per surface (`error.tsx` in each route group) + root
  `error.tsx`, `not-found.tsx`, and `global-error.tsx`.
- Toast feedback on order placement (placed / saved-offline / failed).
- Home page copy modernized (dropped the stale "Phase 0 scaffold / placeholders"
  line and the `/api/health` debug link).

### Scope guardrails honoured
- No edits to `src/lib/security/*`, `src/lib/realtime/*`, payment rails,
  migrations, or any data/auth flow. CSP unchanged (no inline scripts added;
  `global-error.tsx` uses React style objects, not inline `<script>`).
- Per-route `<title>` strings deliberately avoid phrases the e2e suite asserts
  via `getByText` (e.g. shop title is "… — Pizza pickup & delivery", admin is
  "Tenant Dashboard") to keep the Playwright suite green.

---

## Verification

- `npm run build` — green, **zero env vars** (adds `/offline`, `/robots.txt`,
  `/sitemap.xml` to the route table).
- `npm run typecheck` — clean.
- `npm run lint` — clean.
- `npm run test:run` — **160/160** passing.
- Playwright (`npm run e2e`, mock mode): terminal, KDS, shop (pickup+delivery),
  back-office, and storefront specs pass. The `onboarding` spec fails
  identically on clean `origin/main` (pre-existing in-memory-mock state issue
  under `npm run start`); the auth-gated specs are skipped in mock mode. CI's
  required gates are build + unit tests.

## Lighthouse (desktop preset)

Before = production (`main`); After = this preview.

| Page | Perf (before → after) | A11y | Best Practices | SEO |
|---|---|---|---|---|
| `/` | 100 → 100 | 100 → 100 | 96 → 93* | 60 → 63** |
| `/shop/[slug]` | 100 → 96 | 100 → 100 | 96 → 93* | 60 → 66** |
| `/terminal` (→ /login) | 100 → 100 | 100 → 100 | 96 → 93* | 60 → 54** |

\* The −3 Best-Practices delta is **Vercel Live's preview-only feedback script**
being blocked by the app's strict CSP (a console error Lighthouse counts). It
does not appear in production and confirms the CSP is working — the app ships no
inline/3rd-party scripts of its own.

\** SEO is **capped on previews** by Vercel's automatic `X-Robots-Tag: noindex`
header on every preview deploy (Lighthouse penalizes "blocked from indexing").
In production the new metadata/OG/robots/sitemap apply and that header is absent.
Verified on the preview via curl: title templates, OG/Twitter tags, favicons,
and a correct `robots.txt` + `sitemap.xml` are all present.
