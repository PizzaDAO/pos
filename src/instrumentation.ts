/**
 * Next.js instrumentation hook — server Sentry init (§7).
 *
 * Completely inert unless `SENTRY_DSN` is set. The SDK is imported dynamically
 * and ONLY for the Node runtime (`NEXT_RUNTIME` is substituted per target at
 * compile time), so it is never bundled into the edge/middleware build. Edge
 * (middleware) errors are therefore not reported to Sentry.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.SENTRY_DSN) {
    const Sentry = await import("@sentry/nextjs");
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
      // Errors only; no performance tracing (the SDK sends no PII by default).
      tracesSampleRate: 0,
    });
  }
}

// Captures errors from nested Server Components / route handlers. A no-op
// without a DSN; Node runtime only (see above).
export async function onRequestError(
  ...args: Parameters<typeof import("@sentry/nextjs").captureRequestError>
) {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.SENTRY_DSN) {
    const Sentry = await import("@sentry/nextjs");
    Sentry.captureRequestError(...args);
  }
}
