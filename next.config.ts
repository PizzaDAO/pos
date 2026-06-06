import path from "node:path";
import type { NextConfig } from "next";
import withSerwistInit from "@serwist/next";
import { SECURITY_HEADERS } from "./src/lib/security/headers";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Pin the workspace root to this project. A stray lockfile in a parent
  // directory can otherwise cause Next to infer the wrong root for file tracing.
  outputFileTracingRoot: path.join(__dirname),
  // Security headers + CSP applied to EVERY route (Phase 7 hardening). Static
  // (no env reads) so the zero-env build is unaffected; see
  // src/lib/security/headers.ts for the CSP design + no-nonce trade-off.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: SECURITY_HEADERS,
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

export default withSerwist(nextConfig);
