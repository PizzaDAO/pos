/**
 * E2E environment helpers.
 *
 * The suite is designed to run in two modes against the SAME specs:
 *
 *  1. SIMULATED / MOCK (zero env) — `npm run build && npm run start` with no
 *     Supabase env. Every gated surface resolves the seeded demo session, so the
 *     public + terminal + KDS + shop + back-office flows run end-to-end against
 *     the in-memory mock driver. Real-login / role-gating specs `test.skip()`.
 *
 *  2. REAL AUTH — `BASE_URL` points at a preview/prod deployment that has the
 *     Supabase env set (real Supabase Auth). The orchestrator supplies the
 *     bootstrapped test credentials via `E2E_*` env vars. The auth-gating +
 *     real-login specs then run; specs whose creds are missing skip gracefully.
 *
 * No password is ever hardcoded in the repo — credentials come from env only.
 */

export const OWNER_EMAIL =
  process.env.E2E_OWNER_EMAIL || "tony@tonys-pizza.example";
export const PLATFORM_EMAIL =
  process.env.E2E_PLATFORM_EMAIL || "ops@pizzapos.example";

export const OWNER_PASSWORD = process.env.E2E_OWNER_PASSWORD || "";
export const PLATFORM_PASSWORD = process.env.E2E_PLATFORM_PASSWORD || "";

/** Seeded demo storefront slugs (Tony's Pizza). Downtown = pickup+delivery. */
export const SHOP_SLUG_PICKUP_DELIVERY =
  process.env.E2E_SHOP_SLUG || "tonys-downtown";
export const SHOP_SLUG_PICKUP_ONLY =
  process.env.E2E_SHOP_SLUG_PICKUP || "tonys-uptown";

/** Demo seed staff PINs (Tony 1111 · Carmela 2222 · Christopher 3333 · Furio 4444). */
export const STAFF_PIN = process.env.E2E_STAFF_PIN || "1111";

/**
 * Real-auth mode is in play when the target deployment uses real Supabase Auth.
 * We can only *know* this from the app itself (see `detectRealAuth`), but a fast
 * pre-check is whether owner credentials were supplied: without a password we
 * cannot perform a real login, so real-login specs must skip.
 */
export function hasOwnerCreds(): boolean {
  return Boolean(OWNER_PASSWORD);
}

export function hasPlatformCreds(): boolean {
  return Boolean(PLATFORM_PASSWORD);
}
