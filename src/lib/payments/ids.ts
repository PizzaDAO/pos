/**
 * Deterministic tender ids.
 *
 * An ONLINE order's tender id is derived from the order id, the rail and a
 * sequence number, so it is stable across retries, reloads and lost responses:
 * the same (order, rail, seq) always yields the same UUID. That id is BOTH the
 * `payments` primary key and the provider idempotency key (Stripe PaymentIntent
 * create), so a repeat `/api/payments` call returns the existing tender instead
 * of creating a second charge, and the client never needs to keep tender ids.
 *
 * UUIDv5 (RFC 4122, SHA-1) with a fixed namespace; server-side only (`node:crypto`).
 */
import { createHash } from "node:crypto";

/** Fixed namespace for tender ids (random v4, generated once; never change). */
const TENDER_NAMESPACE = "6f1b6a5e-3c3e-4d8a-9a52-0d6f6a8e4c11";

function uuidV5(name: string, namespace: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1")
    .update(ns)
    .update(Buffer.from(name, "utf8"))
    .digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50; // version 5
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = b.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/** Stable tender id for `(orderId, rail, seq)`. `seq` 0 is the first attempt. */
export function deriveTenderId(
  orderId: string,
  rail: string,
  seq = 0,
): string {
  return uuidV5(`tender:${orderId}:${rail}:${seq}`, TENDER_NAMESPACE);
}
