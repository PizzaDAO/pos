/**
 * Thin Stripe REST client (Phase 2).
 *
 * We talk to Stripe's HTTP API directly with `fetch` rather than pulling in the
 * `stripe` SDK, so the bundle has no provider dependency and builds with zero
 * env vars. This is REAL integration code — it is only ever constructed when
 * `STRIPE_SECRET_KEY` is present (see `getStripeConfig`); with no key the rails
 * never reach here and use the simulated path instead.
 *
 * Connect: card charges are created with the `Stripe-Account` header set to the
 * tenant's connected-account id, so funds settle to the tenant. The platform
 * fee is attached via `application_fee_amount`. Idempotency keys are forwarded
 * end-to-end so retries never double-charge.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { getStripeConfig } from "../env";

const STRIPE_API = "https://api.stripe.com/v1";

export interface StripeRequestOptions {
  /** Connected-account id (acct_…). Sets the `Stripe-Account` header. */
  stripeAccount?: string | null;
  /** Idempotency key forwarded to Stripe to dedupe retries. */
  idempotencyKey?: string;
}

/** Flatten a nested object into Stripe's form-encoded `a[b][c]=v` syntax. */
function encodeForm(
  data: Record<string, unknown>,
  prefix = "",
): string[] {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    const path = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === "object" && !Array.isArray(value)) {
      parts.push(...encodeForm(value as Record<string, unknown>, path));
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => {
        if (v !== null && typeof v === "object") {
          parts.push(
            ...encodeForm(v as Record<string, unknown>, `${path}[${i}]`),
          );
        } else {
          parts.push(`${encodeURIComponent(`${path}[${i}]`)}=${encodeURIComponent(String(v))}`);
        }
      });
    } else {
      parts.push(`${encodeURIComponent(path)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts;
}

export class StripeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly raw: unknown,
  ) {
    super(message);
    this.name = "StripeError";
  }
}

/** POST a form-encoded request to the Stripe API. Throws on non-2xx. */
export async function stripeRequest<T = Record<string, unknown>>(
  path: string,
  body: Record<string, unknown>,
  opts: StripeRequestOptions = {},
): Promise<T> {
  const config = getStripeConfig();
  if (!config) {
    throw new StripeError("Stripe is not configured.", 500, null);
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.secretKey}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (opts.stripeAccount) headers["Stripe-Account"] = opts.stripeAccount;
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

  const res = await fetch(`${STRIPE_API}${path}`, {
    method: "POST",
    headers,
    body: encodeForm(body).join("&"),
  });

  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const err = (json.error ?? {}) as { message?: string };
    throw new StripeError(
      err.message ?? `Stripe request failed (HTTP ${res.status})`,
      res.status,
      json,
    );
  }
  return json as T;
}

/** GET a Stripe resource (e.g. account or payment_intent status). */
export async function stripeGet<T = Record<string, unknown>>(
  path: string,
  opts: StripeRequestOptions = {},
): Promise<T> {
  const config = getStripeConfig();
  if (!config) {
    throw new StripeError("Stripe is not configured.", 500, null);
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.secretKey}`,
  };
  if (opts.stripeAccount) headers["Stripe-Account"] = opts.stripeAccount;

  const res = await fetch(`${STRIPE_API}${path}`, { method: "GET", headers });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const err = (json.error ?? {}) as { message?: string };
    throw new StripeError(
      err.message ?? `Stripe request failed (HTTP ${res.status})`,
      res.status,
      json,
    );
  }
  return json as T;
}

/** Max age of a signed Stripe event before it is rejected (replay guard). */
export const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * Verify a Stripe webhook signature (the `Stripe-Signature` header). Returns
 * false when no webhook secret is configured. Implements Stripe's scheme:
 * `signed_payload = "{t}.{rawBody}"`, expected = HMAC-SHA256(secret, payload),
 * accepting any of the header's `v1` signatures (secret rotation) and rejecting
 * timestamps outside a 5-minute tolerance (replay protection).
 *
 * `secret` defaults to STRIPE_WEBHOOK_SECRET (Connect payments); the Billing
 * webhook passes STRIPE_BILLING_WEBHOOK_SECRET explicitly.
 */
export function verifyStripeWebhook(
  rawBody: string,
  signatureHeader: string | null,
  secret?: string | null,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  const webhookSecret =
    secret === undefined ? (getStripeConfig()?.webhookSecret ?? null) : secret;
  if (!webhookSecret || !signatureHeader) return false;

  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const kv of signatureHeader.split(",")) {
    const idx = kv.indexOf("=");
    if (idx <= 0) continue;
    const k = kv.slice(0, idx).trim();
    const v = kv.slice(idx + 1).trim();
    if (k === "t") timestamp = v;
    else if (k === "v1" && v) signatures.push(v);
  }
  if (!timestamp || signatures.length === 0) return false;
  const ts = Number(timestamp);
  if (
    !Number.isFinite(ts) ||
    Math.abs(nowSeconds - ts) > STRIPE_WEBHOOK_TOLERANCE_SECONDS
  ) {
    return false;
  }

  const expected = Buffer.from(
    createHmac("sha256", webhookSecret)
      .update(`${timestamp}.${rawBody}`)
      .digest("hex"),
    "hex",
  );
  return signatures.some((sig) => {
    try {
      const b = Buffer.from(sig, "hex");
      return b.length === expected.length && timingSafeEqual(expected, b);
    } catch {
      return false;
    }
  });
}

/**
 * Map a Stripe PaymentIntent status to our `ChargeStatus`. Stripe statuses:
 * requires_payment_method | requires_confirmation | requires_action |
 * processing | requires_capture | canceled | succeeded.
 */
export function mapIntentStatus(
  stripeStatus: string,
): "requires_action" | "pending" | "authorized" | "captured" | "failed" | "canceled" {
  switch (stripeStatus) {
    case "succeeded":
      return "captured";
    case "requires_capture":
      return "authorized";
    case "processing":
      return "pending";
    case "requires_action":
    case "requires_confirmation":
    case "requires_payment_method":
      return "requires_action";
    case "canceled":
      return "canceled";
    default:
      return "pending";
  }
}
