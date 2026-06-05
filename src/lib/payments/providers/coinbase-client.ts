/**
 * Thin Coinbase Commerce REST client (Phase 2).
 *
 * Only used when COINBASE_COMMERCE_API_KEY is configured. Talks to the Commerce
 * API over `fetch` (no SDK dependency). Creates hosted charges and verifies
 * webhook signatures.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { getCoinbaseConfig } from "../env";

const COINBASE_API = "https://api.commerce.coinbase.com";

export interface CoinbaseCharge {
  id: string;
  code: string;
  hosted_url: string;
  timeline: { status: string }[];
}

/** Create a Coinbase Commerce charge. Throws if not configured. */
export async function createCoinbaseCharge(params: {
  name: string;
  description: string;
  amount: string;
  currency: string;
  metadata: Record<string, string>;
  idempotencyKey: string;
}): Promise<CoinbaseCharge> {
  const config = getCoinbaseConfig();
  if (!config) throw new Error("Coinbase Commerce is not configured.");

  const res = await fetch(`${COINBASE_API}/charges`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CC-Api-Key": config.apiKey,
      "X-CC-Version": "2018-03-22",
      "Idempotency-Key": params.idempotencyKey,
    },
    body: JSON.stringify({
      name: params.name,
      description: params.description,
      pricing_type: "fixed_price",
      local_price: { amount: params.amount, currency: params.currency },
      metadata: params.metadata,
    }),
  });
  const json = (await res.json()) as { data?: CoinbaseCharge; error?: { message: string } };
  if (!res.ok || !json.data) {
    throw new Error(json.error?.message ?? `Coinbase charge failed (HTTP ${res.status})`);
  }
  return json.data;
}

/** Fetch a charge by id/code to read its current timeline status. */
export async function getCoinbaseCharge(id: string): Promise<CoinbaseCharge> {
  const config = getCoinbaseConfig();
  if (!config) throw new Error("Coinbase Commerce is not configured.");
  const res = await fetch(`${COINBASE_API}/charges/${id}`, {
    headers: { "X-CC-Api-Key": config.apiKey, "X-CC-Version": "2018-03-22" },
  });
  const json = (await res.json()) as { data?: CoinbaseCharge; error?: { message: string } };
  if (!res.ok || !json.data) {
    throw new Error(json.error?.message ?? `Coinbase fetch failed (HTTP ${res.status})`);
  }
  return json.data;
}

/**
 * Verify a Coinbase Commerce webhook signature (HMAC-SHA256 of the raw body
 * with the shared webhook secret). Returns false when no secret is configured.
 */
export function verifyCoinbaseWebhook(
  rawBody: string,
  signature: string | null,
): boolean {
  const config = getCoinbaseConfig();
  if (!config?.webhookSecret || !signature) return false;
  const expected = createHmac("sha256", config.webhookSecret)
    .update(rawBody)
    .digest("hex");
  try {
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(signature, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Map a Coinbase charge timeline status to our ChargeStatus. */
export function mapCoinbaseStatus(
  status: string | undefined,
): "pending" | "captured" | "failed" | "canceled" {
  switch (status) {
    case "COMPLETED":
    case "CONFIRMED":
    case "RESOLVED":
      return "captured";
    case "EXPIRED":
    case "CANCELED":
      return "canceled";
    case "UNRESOLVED":
      return "failed";
    default:
      return "pending";
  }
}
