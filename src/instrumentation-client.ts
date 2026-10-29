/**
 * Browser Sentry init (§7). Inert unless `NEXT_PUBLIC_SENTRY_DSN` is set.
 *
 * The SDK is imported DYNAMICALLY behind a direct `process.env.NEXT_PUBLIC_*`
 * test. Next inlines that var at build time, so with no DSN the bundler sees a
 * constant-false branch and the SDK never reaches the client bundle (no
 * first-load JS cost). The CSP allows the ingest host only when the DSN is set —
 * see `buildSecurityHeaders` in src/lib/security/headers.ts.
 */
if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  void import("@sentry/nextjs").then((Sentry) => {
    Sentry.init({
      dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
      tracesSampleRate: 0,
    });
  });
}

/** Router-transition hook: a no-op unless the SDK is enabled (lazy-loaded). */
export function onRouterTransitionStart(
  url: string,
  navigationType: "push" | "replace" | "traverse",
) {
  if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
    void import("@sentry/nextjs").then((Sentry) =>
      Sentry.captureRouterTransitionStart(url, navigationType),
    );
  }
}
