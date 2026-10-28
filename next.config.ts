import path from "node:path";
import type { NextConfig } from "next";
import withSerwistInit from "@serwist/next";
import { withSentryConfig } from "@sentry/nextjs/config";
import { buildSecurityHeaders } from "./src/lib/security/headers";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Pin the workspace root to this project. A stray lockfile in a parent
  // directory can otherwise cause Next to infer the wrong root for file tracing.
  outputFileTracingRoot: path.join(__dirname),
  // Security headers + CSP applied to EVERY route (Phase 7 hardening). With no
  // env the policy is static; a Sentry DSN only adds its ingest host to
  // connect-src. See src/lib/security/headers.ts for the CSP design.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: buildSecurityHeaders(
          process.env.NEXT_PUBLIC_SENTRY_DSN ?? process.env.SENTRY_DSN,
        ),
      },
    ];
  },
};

/**
 * PWA via Serwist. Generates a service worker from `src/app/sw.ts` and emits it
 * to `public/sw.js`. Disabled in development to avoid caching churn while
 * iterating. Requires no env vars — builds offline.
 */
const withSerwist = withSerwistInit({
  swSrc: "src/app/sw.ts",
  swDest: "public/sw.js",
  disable: process.env.NODE_ENV === "development",
});

const configured = withSerwist(nextConfig);

/**
 * Sentry (§7) wraps the config ONLY when a DSN is set, so the zero-env build is
 * byte-for-byte what it was. Source maps upload only with SENTRY_AUTH_TOKEN
 * (+ SENTRY_ORG / SENTRY_PROJECT); otherwise the build plugin is told to skip it.
 */
const sentryEnabled = Boolean(
  process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN,
);

export default sentryEnabled
  ? withSentryConfig(configured, {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      silent: true,
      telemetry: false,
      sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
    })
  : configured;
