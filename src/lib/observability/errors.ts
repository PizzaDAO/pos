/**
 * Error-tracking seam (Phase 7 observability).
 *
 * A provider-agnostic `captureError` that is a structured-log no-op by default
 * and lights up a real error tracker (e.g. Sentry) ONLY when `SENTRY_DSN` is
 * present. This mirrors the payment/billing env-guard pattern: the integration
 * code path exists but stays dormant with zero env vars, so the app builds and
 * tests run without any secrets or network calls.
 *
 * The actual Sentry SDK is intentionally NOT a dependency here (live wiring is a
 * later phase). When a DSN is configured we still record the error via the
 * structured logger tagged `sink: "sentry"`, and document where the real
 * `Sentry.captureException` call slots in. Swapping in the SDK later requires no
 * call-site changes.
 */
import { logger } from "./logger";

/** Whether an external error tracker is configured (lazy env read). */
export function isErrorTrackingConfigured(): boolean {
  return Boolean(process.env.SENTRY_DSN);
}

export interface ErrorContext {
  /** Correlation id so the captured error joins the request's log trail. */
  requestId?: string;
  /** Tenant scope, when known (never include PII / card data). */
  tenantId?: string;
  locationId?: string;
  /** Coarse area tag (e.g. "payments", "orders") for grouping. */
  scope?: string;
  [key: string]: unknown;
}

/** Normalize any thrown value into a `{ message, stack }` shape for logging. */
export function normalizeError(err: unknown): {
  message: string;
  stack?: string;
  name?: string;
} {
  if (err instanceof Error) {
    return { message: err.message, stack: err.stack, name: err.name };
  }
  return { message: typeof err === "string" ? err : JSON.stringify(err) };
}

/**
 * Capture an error. Always emits a structured `error` log; additionally routes
 * to the external tracker when configured. Returns the sink used so callers/tests
 * can assert behaviour without a live SDK.
 */
export function captureError(
  err: unknown,
  context: ErrorContext = {},
): "log" | "sentry" {
  const normalized = normalizeError(err);
  const tracked = isErrorTrackingConfigured();
  logger.error("captured_error", {
    ...context,
    error: normalized.message,
    error_name: normalized.name,
    stack: normalized.stack,
    sink: tracked ? "sentry" : "log",
  });
  // When SENTRY_DSN is set, the real SDK call slots in here:
  //   import * as Sentry from "@sentry/nextjs";
  //   Sentry.captureException(err, { tags: context });
  // Kept dormant (no dependency) until the live-wiring phase.
  return tracked ? "sentry" : "log";
}
