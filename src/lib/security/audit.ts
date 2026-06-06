/**
 * Audit-logging helper (Phase 7 hardening).
 *
 * A thin, **fail-open** wrapper over the existing `PosDriver.appendAuditLog` /
 * `audit_log` table. It broadens audit coverage from platform-operator actions
 * (impersonation, tenant lifecycle) to other sensitive, tenant-scoped actions —
 * staff/admin sign-in, role/membership changes, payment refunds/voids, menu 86,
 * Connect changes, and tenant/subscription lifecycle.
 *
 * Design:
 *   - **Tenant-scoped.** Every entry carries `tenant_id`, so `/platform` and
 *     `listAuditLog(tenantId)` show one coherent, per-tenant trail.
 *   - **Never breaks the primary action.** Auditing is observability, not the
 *     business operation: a failure to write the log is captured (structured
 *     error) but swallowed, so a logging hiccup can't fail a refund or a login.
 *   - **Zero-env safe.** Uses the active driver (mock by default), so it works
 *     in the no-env build/suite exactly like the rest of the app.
 */
import { getPosDriver } from "@/lib/db";
import type { AuditAction, AuditLogEntry } from "@/lib/db";
import { captureError } from "@/lib/observability";

export interface AuditActor {
  /** The acting user's id (session user id, or a system marker). */
  id: string;
  /** Human-readable label captured at write time (typically the email). */
  label: string;
}

export interface AuditInput {
  actor: AuditActor;
  action: AuditAction;
  /** Target tenant — keeps the entry tenant-scoped. Null for platform-global. */
  tenantId: string | null;
  /** Free-form context (reason, amount, ids). Truncated defensively. */
  detail?: string | null;
}

/** Cap detail length so an oversized/abusive string can't bloat the table. */
const MAX_DETAIL = 500;

/**
 * Append a tenant-scoped audit entry. Resolves to the written entry, or `null`
 * if the write failed (which is logged but never thrown). Awaiting it is
 * optional — callers may fire-and-forget after the primary action succeeds.
 */
export async function recordAudit(
  input: AuditInput,
): Promise<AuditLogEntry | null> {
  try {
    const driver = getPosDriver();
    const detail =
      input.detail == null ? null : String(input.detail).slice(0, MAX_DETAIL);
    return await driver.appendAuditLog({
      actor_user_id: input.actor.id,
      actor_label: input.actor.label,
      action: input.action,
      tenant_id: input.tenantId,
      detail,
    });
  } catch (err) {
    // Audit is fail-open: log the failure, never break the caller's action.
    captureError(err, {
      scope: "audit",
      action: input.action,
      tenantId: input.tenantId ?? undefined,
    });
    return null;
  }
}
