/**
 * Browser Sentry init (§7). Inert unless `NEXT_PUBLIC_SENTRY_DSN` is set (it is
 * inlined at build time). The CSP allows the ingest host only when that DSN is
 * set — see `buildSecurityHeaders` in src/lib/security/headers.ts.
 */
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0,
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
