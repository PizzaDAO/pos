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
