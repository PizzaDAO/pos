/**
 * Marketplace environment configuration (lazy: nothing reads env at module load).
 *
 * A real provider is "configured" only when its secrets are present. With none
 * set (the default, incl. every preview) the inbox is inert: webhooks for a real
 * provider are refused (503) and no status callback is ever sent. The simulator
 * needs no secrets; it is allowed outside production, or anywhere when
 * MARKETPLACE_SIMULATOR=1 (a demo deployment).
 *
 *   DoorDash Marketplace   DOORDASH_MARKETPLACE_WEBHOOK_SECRET  (verify inbound)
 *                          DOORDASH_MARKETPLACE_CLIENT_ID / _CLIENT_SECRET (callbacks)
 *   Uber Eats              UBEREATS_CLIENT_ID / UBEREATS_CLIENT_SECRET
 *                          (the client secret also signs webhooks: X-Uber-Signature)
 *   Grubhub                GRUBHUB_WEBHOOK_SECRET
 *                          GRUBHUB_CLIENT_ID / GRUBHUB_CLIENT_SECRET (callbacks)
 *   Simulator              MARKETPLACE_SIMULATOR_SECRET (optional; else a per-process random secret)
 *   Base URLs              DOORDASH_MARKETPLACE_BASE_URL, UBEREATS_BASE_URL,
 *                          GRUBHUB_BASE_URL (override, e.g. sandbox)
 */
import { randomBytes } from "node:crypto";
import type { MarketplaceProviderKey } from "./types";

/** Test-only fixed secret. Outside NODE_ENV=test the simulator uses env or a per-process random one. */
export const SIMULATOR_DEV_SECRET = "marketplace-simulator-dev-secret";
let processSecret: string | null = null;
function simulatorSecret(): string {
  const fromEnv = env("MARKETPLACE_SIMULATOR_SECRET");
  if (fromEnv) return fromEnv;
  if (process.env.NODE_ENV === "test") return SIMULATOR_DEV_SECRET;
  // Never a guessable default: only this process (the admin "simulate" button) can sign.
  processSecret ??= randomBytes(32).toString("hex");
  return processSecret;
}

export interface ProviderConfig {
  /** Verifies inbound webhooks. */
  webhookSecret: string;
  clientId: string | null;
  clientSecret: string | null;
  baseUrl: string;
}

const env = (k: string): string | null => process.env[k]?.trim() || null;

export function getProviderConfig(
  p: MarketplaceProviderKey,
): ProviderConfig | null {
  switch (p) {
    case "doordash": {
      const webhookSecret = env("DOORDASH_MARKETPLACE_WEBHOOK_SECRET");
      if (!webhookSecret) return null;
      return {
        webhookSecret,
        clientId: env("DOORDASH_MARKETPLACE_CLIENT_ID"),
        clientSecret: env("DOORDASH_MARKETPLACE_CLIENT_SECRET"),
        baseUrl:
          env("DOORDASH_MARKETPLACE_BASE_URL") ??
          "https://openapi.doordash.com",
      };
    }
    case "ubereats": {
      const clientId = env("UBEREATS_CLIENT_ID");
      const clientSecret = env("UBEREATS_CLIENT_SECRET");
      if (!clientId || !clientSecret) return null;
      return {
        webhookSecret: clientSecret,
        clientId,
        clientSecret,
        baseUrl: env("UBEREATS_BASE_URL") ?? "https://api.uber.com",
      };
    }
    case "grubhub": {
      const webhookSecret = env("GRUBHUB_WEBHOOK_SECRET");
      if (!webhookSecret) return null;
      return {
        webhookSecret,
        clientId: env("GRUBHUB_CLIENT_ID"),
        clientSecret: env("GRUBHUB_CLIENT_SECRET"),
        baseUrl:
          env("GRUBHUB_BASE_URL") ?? "https://api-third-party-gtm.grubhub.com",
      };
    }
    case "simulator": {
      if (
        process.env.NODE_ENV === "production" &&
        process.env.MARKETPLACE_SIMULATOR !== "1"
      ) {
        return null;
      }
      return {
        webhookSecret: simulatorSecret(),
        clientId: null,
        clientSecret: null,
        baseUrl: "",
      };
    }
  }
}

export function isProviderConfigured(p: MarketplaceProviderKey): boolean {
  return getProviderConfig(p) !== null;
}

/** Outbound callbacks are real only for a real provider that has API credentials. */
export function canCallProvider(p: MarketplaceProviderKey): boolean {
  if (p === "simulator") return false;
  const c = getProviderConfig(p);
  return !!c && !!c.clientId && !!c.clientSecret;
}
