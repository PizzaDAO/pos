/**
 * Platform-fee math (Phase 2). All integer cents; round half-up once.
 *
 * The platform fee is what the PLATFORM charges per CARD order via Stripe
 * Connect `application_fee_amount`. It is `pct(bps) + flat`, computed on the
 * charge amount INCLUDING tip (Stripe takes the application fee off the full
 * transaction that settles to the connected account). Crypto + cash rails carry
 * no per-order application fee in v1 (per PLAN.md — crypto is subscription-only).
 */
import type { PaymentRailKey } from "./PaymentRail";

/** Round half-up to the nearest integer (cent). */
export function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5);
}

/** Card rails carry a per-order platform fee; cash + crypto do not (v1). */
export function railChargesApplicationFee(
  rail: PaymentRailKey | "cash",
): boolean {
  return rail === "stripe_terminal" || rail === "stripe_online";
}

export interface PlatformFeeInput {
  /** Amount the fee is computed on, in cents (base + tip for the tender). */
  amountCents: number;
  /** Fee rate in basis points (250 = 2.50%). */
  feeBps: number;
  /** Flat fee component, in cents. */
  feeFlatCents: number;
}

/**
 * Compute the Connect `application_fee_amount` for a card tender. Clamped to the
 * charge amount so the fee can never exceed what settles.
 */
export function computeApplicationFeeCents(input: PlatformFeeInput): number {
  if (input.amountCents <= 0) return 0;
  const pct = roundHalfUp((input.amountCents * input.feeBps) / 10_000);
  const fee = pct + Math.max(0, input.feeFlatCents);
  return Math.max(0, Math.min(fee, input.amountCents));
}
