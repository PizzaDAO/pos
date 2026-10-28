/**
 * Next.js instrumentation hook — server + edge Sentry init (§7).
 *
 * Completely inert unless `SENTRY_DSN` is set: with no DSN nothing is
 * initialised, so the zero-env build/runtime is unchanged.
 */
import * as Sentry from "@sentry/nextjs";

export async function register() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  if (
    process.env.NEXT_RUNTIME === "nodejs" ||
    process.env.NEXT_RUNTIME === "edge"
  ) {
    Sentry.init({
      dsn,
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
      // Errors only; no performance tracing (the SDK sends no PII by default).
      tracesSampleRate: 0,
    });
  }
}

// Captures errors from nested Server Components / route handlers. A no-op while
// the SDK is uninitialised (no DSN).
export const onRequestError = Sentry.captureRequestError;
