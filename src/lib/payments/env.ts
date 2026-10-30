/**
 * Payment environment configuration + guards (Phase 2).
 *
 * THE CORE DESIGN RULE OF THIS PHASE: the real Stripe / Coinbase / onchain code
 * paths are implemented, but each only activates when its credentials are
 * present in the environment. With NO keys (the default, including the Vercel
 * preview) every rail falls back to a deterministic SIMULATED settlement so the
 * whole checkout flow works end-to-end without secrets.
 *
 * IMPORTANT: nothing here reads env vars at module load. Every read happens
 * lazily inside a function so the app builds and the bundle evaluates with NO
 * payment env vars set. Call sites check `isXConfigured()` and branch to the
 * simulated path when false.
 */

/** Stripe is "configured" once a secret key is present. */
export function getStripeConfig(): {
  secretKey: string;
  webhookSecret: string | null;
  connectClientId: string | null;
  publishableKey: string | null;
} | null {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return null;
  return {
    secretKey,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? null,
    connectClientId: process.env.STRIPE_CONNECT_CLIENT_ID ?? null,
    publishableKey:
      process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ??
      process.env.STRIPE_PUBLISHABLE_KEY ??
      null,
  };
}

export function isStripeConfigured(): boolean {
  return getStripeConfig() !== null;
}

/** True when the Stripe key is a TEST-mode key (`sk_test_...` or restricted `rk_test_...`). */
export function isStripeTestKey(): boolean {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  return key.startsWith("sk_test_") || key.startsWith("rk_test_");
}

/** True for a LIVE-mode key (`sk_live_...` or restricted `rk_live_...`). */
export function isStripeLiveKey(): boolean {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  return key.startsWith("sk_live_") || key.startsWith("rk_live_");
}

export class LiveKeyOutsideProductionError extends Error {
  constructor() {
    super(
      "A live Stripe key is configured outside production (VERCEL_ENV is not 'production'); refusing to create real Connect accounts or charges from a preview/dev deployment.",
    );
    this.name = "LiveKeyOutsideProductionError";
  }
}

/**
 * Guard for REAL money-moving Stripe operations (Connect account creation, card
 * charges): a live key must only ever be used by the production deployment, so a
 * preview or local run that inherited the production env can't create real
 * accounts or charge real cards.
 */
export function assertLiveKeyAllowed(): void {
  if (isStripeLiveKey() && process.env.VERCEL_ENV !== "production") {
    throw new LiveKeyOutsideProductionError();
  }
}

/** True when `TRAINING_MODE` is explicitly enabled via env. */
export function isTrainingFlagSet(): boolean {
  const v = (process.env.TRAINING_MODE ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

/**
 * True when the app is on the in-memory mock driver. Mirrors `getPosDriver()`'s
 * env-driven selection (kept here, not imported, because the DB drivers import
 * payments code and this module must stay a dependency-free leaf).
 */
export function usingMockDriver(): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return !url || !key;
}

/**
 * Whether CARD rails (Stripe Terminal / online, and Connect) take the SIMULATED
 * path. They simulate when there is no Stripe key, OR whenever training mode is
 * on because of the `TRAINING_MODE` flag or the mock driver -- whatever key is
 * set -- so a training environment can never create a real charge, even with a
 * live key. A `sk_test_` key with no flag on a live driver is the one case that
 * calls Stripe (test mode), so test-mode Stripe is exercised for real.
 */
export function cardRailsSimulated(): boolean {
  return !isStripeConfigured() || isTrainingFlagSet() || usingMockDriver();
}

/**
 * How the in-store card reader runs (plans/terminal-card-reader.md):
 *  - `simulated`: no Stripe key, OR training mode / mock driver (whatever key is
 *    set, so a training env can never reach a real reader or charge). One virtual
 *    reader per location, no Stripe call ever.
 *  - `stripe_test`: an `sk_test_` key: the real Stripe sandbox, with simulated
 *    (`simulated-wpe`) or physical test readers.
 *  - `stripe_live`: a live key: real money.
 */
export type CardReaderMode = "simulated" | "stripe_test" | "stripe_live";

export function cardReaderMode(): CardReaderMode {
  if (cardRailsSimulated()) return "simulated";
  return isStripeTestKey() ? "stripe_test" : "stripe_live";
}

/**
 * Demo helper: when set (ms > 0), a SIMULATED reader tender approves itself that
 * long after it starts, with no cashier click. Default off.
 */
export function terminalSimAutoApproveMs(): number {
  const v = Number.parseInt(process.env.TERMINAL_SIM_AUTO_APPROVE_MS ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Coinbase Commerce is "configured" once an API key is present. */
export function getCoinbaseConfig(): {
  apiKey: string;
  webhookSecret: string | null;
} | null {
  const apiKey = process.env.COINBASE_COMMERCE_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    webhookSecret: process.env.COINBASE_COMMERCE_WEBHOOK_SECRET ?? null,
  };
}

export function isCoinbaseConfigured(): boolean {
  return getCoinbaseConfig() !== null;
}

/** Onchain USDC (Base) is "configured" once an RPC URL is present. */
export function getOnchainConfig(): {
  rpcUrl: string;
  usdcAddress: string;
  /** Pay-to / receiving wallet address (the tenant's wallet in production). */
  payToAddress: string;
  privyAppId: string | null;
  privyAppSecret: string | null;
  chain: string;
} | null {
  const rpcUrl = process.env.BASE_RPC_URL;
  if (!rpcUrl) return null;
  return {
    rpcUrl,
    // USDC on Base mainnet (default well-known address; overridable).
    usdcAddress:
      process.env.USDC_CONTRACT_ADDRESS ??
      process.env.USDC_BASE_ADDRESS ??
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payToAddress: process.env.CRYPTO_PAY_TO_ADDRESS ?? "",
    privyAppId: process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? null,
    privyAppSecret: process.env.PRIVY_APP_SECRET ?? null,
    chain: "base",
  };
}

export function isOnchainConfigured(): boolean {
  return getOnchainConfig() !== null;
}

/**
 * Default platform-fee config used when a tenant has no stored override. Read
 * from PLATFORM_FEE_* env if present, else a sensible default (2.5% + $0.10).
 */
export function getDefaultPlatformFee(): {
  bps: number;
  flatCents: number;
} {
  const bps = Number.parseInt(process.env.PLATFORM_FEE_BPS ?? "", 10);
  const flat = Number.parseInt(process.env.PLATFORM_FEE_FLAT_CENTS ?? "", 10);
  return {
    bps: Number.isFinite(bps) && bps >= 0 ? bps : 250,
    flatCents: Number.isFinite(flat) && flat >= 0 ? flat : 10,
  };
}

/**
 * The kind of deployment creating/sweeping online orders. Orders are stamped with
 * it (`fulfillment.checkout_mode`) and a sweeper only scans its own kind, so prod
 * (live keys) and staging (test keys) can share one database without sweeping
 * each other's orders.
 */
export function deploymentCheckoutMode(): "live" | "test" | "sim" {
  if (cardRailsSimulated()) return "sim";
  return isStripeLiveKey() ? "live" : "test";
}

/**
 * How long an unpaid ONLINE order may sit in `awaiting_payment` before the
 * sweeper abandons it, by the rail of its live tender. Overridable via env
 * (minutes): card/wallets 30 (covers 3DS), Coinbase 60, onchain USDC 60 (a manual
 * exchange withdrawal commonly takes 10-30 min).
 */
export type CheckoutWindowKind = "card" | "coinbase" | "usdc";

const DEFAULT_WINDOW_MIN: Record<CheckoutWindowKind, number> = {
  card: 30,
  coinbase: 60,
  usdc: 60,
};

export function onlineCheckoutWindowMs(kind: CheckoutWindowKind): number {
  const envName = `ONLINE_CHECKOUT_WINDOW_${kind.toUpperCase()}_MIN`;
  const v = Number.parseInt(process.env[envName] ?? "", 10);
  const minutes = Number.isFinite(v) && v > 0 ? v : DEFAULT_WINDOW_MIN[kind];
  return minutes * 60_000;
}
