/**
 * Reason codes for refunds, voids and comps (pure; safe in client bundles).
 *
 * Every adjustment needs a reason: a preset code, plus free text. `other`
 * requires the free text; the other codes take it optionally.
 */
import type { AdjustmentKind } from "@/lib/db/adjustment-types";

export interface ReasonOption {
  code: string;
  label: string;
}

const REFUND_REASONS: ReasonOption[] = [
  { code: "wrong_item", label: "Wrong item / order" },
  { code: "quality", label: "Food quality" },
  { code: "late", label: "Too slow / late" },
  { code: "missing_item", label: "Missing item" },
  { code: "overcharged", label: "Overcharged" },
  { code: "customer_changed_mind", label: "Customer changed mind" },
  { code: "other", label: "Other" },
];

const VOID_REASONS: ReasonOption[] = [
  { code: "entry_error", label: "Rung in by mistake" },
  { code: "customer_changed_mind", label: "Customer changed mind" },
  { code: "out_of_stock", label: "Out of stock" },
  { code: "walkout", label: "Customer left" },
  { code: "test_order", label: "Test / training order" },
  { code: "other", label: "Other" },
];

const COMP_REASONS: ReasonOption[] = [
  { code: "quality", label: "Food quality" },
  { code: "wait_time", label: "Long wait" },
  { code: "staff_meal", label: "Staff meal" },
  { code: "loyalty", label: "Regular / loyalty" },
  { code: "promotion", label: "Promotion" },
  { code: "manager_discretion", label: "Manager discretion" },
  { code: "other", label: "Other" },
];

export function reasonOptions(kind: AdjustmentKind): ReasonOption[] {
  switch (kind) {
    case "refund":
      return REFUND_REASONS;
    case "void_line":
    case "void_order":
      return VOID_REASONS;
    case "comp":
    case "discount":
      return COMP_REASONS;
  }
}

export function reasonLabel(kind: AdjustmentKind, code: string): string {
  return reasonOptions(kind).find((r) => r.code === code)?.label ?? code;
}

export const REASON_TEXT_MAX = 300;

/**
 * Validate a reason. Returns the cleaned reason or an error message. Free text
 * is trimmed, capped and required for `other`.
 */
export function validateReason(
  kind: AdjustmentKind,
  code: unknown,
  text: unknown,
): { ok: true; code: string; text: string | null } | { ok: false; error: string } {
  if (typeof code !== "string" || !reasonOptions(kind).some((r) => r.code === code)) {
    return { ok: false, error: "A reason is required." };
  }
  if (text !== undefined && text !== null && typeof text !== "string") {
    return { ok: false, error: "Reason text must be a string." };
  }
  const clean = typeof text === "string" ? text.trim().slice(0, REASON_TEXT_MAX) : "";
  if (code === "other" && !clean) {
    return { ok: false, error: "Describe the reason (required for Other)." };
  }
  return { ok: true, code, text: clean || null };
}

/** One-line reason for receipts, audit rows and the Stripe refund metadata. */
export function reasonSummary(
  kind: AdjustmentKind,
  code: string,
  text: string | null,
): string {
  const label = reasonLabel(kind, code);
  return text ? `${label}: ${text}` : label;
}
