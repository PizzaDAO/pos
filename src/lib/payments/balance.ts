/**
 * Which tenders hold an order's balance (pure; shared by the service, the mock
 * driver and mirrored in SQL by public.reserve_payment).
 *
 * Failed/canceled tenders never count. An UNSETTLED tender (pending /
 * requires_action) that never reached a rail (no charge_id) is an abandoned or
 * crashed attempt: after STALE_TENDER_TTL_MS it stops holding the balance so it
 * can't block the order forever (staff can also void it explicitly).
 * Keep the TTL in sync with supabase/migrations/20260611000000_*.sql.
 */
import type { Payment } from "@/lib/db";

export const STALE_TENDER_TTL_MS = 15 * 60_000;

export function isStaleUnsettled(p: Payment, nowMs = Date.now()): boolean {
  return (
    (p.status === "pending" || p.status === "requires_action") &&
    !p.charge_id &&
    new Date(p.created_at).getTime() < nowMs - STALE_TENDER_TTL_MS
  );
}

export function countsTowardBalance(p: Payment, nowMs = Date.now()): boolean {
  if (p.status === "failed" || p.status === "canceled") return false;
  return !isStaleUnsettled(p, nowMs);
}
