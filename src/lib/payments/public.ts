/**
 * Client-safe view of a tender. `Payment.raw` holds rail internals (fee math,
 * Stripe status, provider payloads), so API responses expose only the handful of
 * fields a payer legitimately needs (e.g. the USDC pay-to address, the Coinbase
 * hosted checkout URL). Everything else, notably any intent secret, is dropped.
 */
import type { Payment } from "@/lib/db";

const PUBLIC_RAW_KEYS = [
  "simulated",
  "payToAddress",
  "token",
  "usdcUnits",
  "hostedUrl",
] as const;

export function publicTender(p: Payment): Payment {
  const raw: Record<string, unknown> = {};
  for (const k of PUBLIC_RAW_KEYS) {
    if (p.raw && k in p.raw) raw[k] = p.raw[k];
  }
  return { ...p, raw: Object.keys(raw).length > 0 ? raw : null };
}
