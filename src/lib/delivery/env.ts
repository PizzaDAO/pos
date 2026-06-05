/**
 * Delivery environment configuration + guards (Phase 4).
 *
 * Mirrors the payments env-guard design (`src/lib/payments/env.ts`): the REAL
 * DoorDash Drive code path is implemented, but only activates when its
 * credentials are present. With NO keys (the default, incl. the Vercel preview)
 * the provider falls back to a deterministic SIMULATED quote/dispatch/track so
 * the whole delivery flow works end-to-end without secrets.
 *
 * The in-house provider needs NO env — it computes zone/fee/ETA from store
 * config and is always "real". Nothing here reads env vars at module load; every
 * read happens lazily inside a function so the bundle evaluates with no env set.
 */

/** DoorDash Drive is "configured" once its three credentials are present. */
export function getDoorDashConfig(): {
  developerId: string;
  keyId: string;
  signingSecret: string;
  baseUrl: string;
} | null {
  const developerId = process.env.DOORDASH_DEVELOPER_ID;
  const keyId = process.env.DOORDASH_KEY_ID;
  const signingSecret = process.env.DOORDASH_SIGNING_SECRET;
  if (!developerId || !keyId || !signingSecret) return null;
  return {
    developerId,
    keyId,
    signingSecret,
    baseUrl:
      process.env.DOORDASH_BASE_URL ?? "https://openapi.doordash.com",
  };
}

export function isDoorDashConfigured(): boolean {
  return getDoorDashConfig() !== null;
}
