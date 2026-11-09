/**
 * Approval policy for refunds, comps/discounts and voids (pure; client-safe).
 *
 * Owners and managers never need a second approval. Anyone else (a cashier)
 * may act alone only up to the location's threshold for that action; above it
 * an owner/manager approves by PIN at the till. Thresholds default to 0, which
 * keeps the old rule: only an owner/manager refunds or discounts at all.
 * Voids need approval only for food that was already sent to the kitchen.
 */
import type { MembershipRole } from "@/lib/db";
import {
  DEFAULT_ADJUSTMENT_POLICY,
  type AdjustmentKind,
  type AdjustmentPolicy,
} from "@/lib/db/adjustment-types";

const MAX_THRESHOLD_CENTS = 10_000_000; // $100k: anything above is a typo

function cleanThreshold(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= MAX_THRESHOLD_CENTS
    ? v
    : fallback;
}

/** The location's policy with every field validated (bad/missing -> default). */
export function resolvePolicy(raw: Partial<AdjustmentPolicy> | null | undefined): AdjustmentPolicy {
  const d = DEFAULT_ADJUSTMENT_POLICY;
  return {
    refund_approval_cents: cleanThreshold(raw?.refund_approval_cents, d.refund_approval_cents),
    comp_approval_cents: cleanThreshold(raw?.comp_approval_cents, d.comp_approval_cents),
    void_approval_cents: cleanThreshold(raw?.void_approval_cents, d.void_approval_cents),
  };
}

/** Validate an admin-submitted policy; null when any field is invalid. */
export function parsePolicy(raw: unknown): AdjustmentPolicy | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const keys: (keyof AdjustmentPolicy)[] = [
    "refund_approval_cents",
    "comp_approval_cents",
    "void_approval_cents",
  ];
  for (const k of keys) {
    if (cleanThreshold(r[k], -1) < 0) return null;
  }
  return resolvePolicy(r as Partial<AdjustmentPolicy>);
}

export function isManagerRole(role: MembershipRole | null | undefined): boolean {
  return role === "owner" || role === "manager";
}

/** The threshold that applies to an action. */
export function thresholdFor(policy: AdjustmentPolicy, kind: AdjustmentKind): number {
  switch (kind) {
    case "refund":
      return policy.refund_approval_cents;
    case "comp":
    case "discount":
      return policy.comp_approval_cents;
    case "void_line":
    case "void_order":
      return policy.void_approval_cents;
  }
}

/**
 * Does this action need an owner/manager approval? `fired` matters for voids
 * only: voiding food that never reached the kitchen needs none.
 */
export function needsApproval(input: {
  policy: AdjustmentPolicy;
  kind: AdjustmentKind;
  amountCents: number;
  role: MembershipRole | null;
  fired?: boolean;
}): boolean {
  if (isManagerRole(input.role)) return false;
  if ((input.kind === "void_line" || input.kind === "void_order") && !input.fired) {
    return false;
  }
  return input.amountCents > thresholdFor(input.policy, input.kind);
}
