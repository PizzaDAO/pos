import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E config — SEPARATE from the Vitest suite.
 *
 * - Specs live under `e2e/` (`*.spec.ts`); Vitest only includes
 *   `src/**` + `tests/**` `*.test.ts`, so the two suites never overlap and the
 *   zero-env Vitest job is unaffected by Playwright.
 * - `BASE_URL` selects the target app. Default: a locally-started production
 *   server (`npm run start` after a build) on port 3100. Point it at a Vercel
 *   preview/prod URL to run the same specs against a deployed app:
 *     `BASE_URL=https://<preview>.vercel.app npx playwright test`
 * - When `BASE_URL` is an external URL, the local `webServer` is NOT started.
 * - Real-auth specs read credentials from `E2E_*` env (owner/platform-admin
 *   passwords, staff PINs). When those (or the Supabase env) are absent the app
 *   runs in SIMULATED-AUTH / mock-driver mode and the auth-gating specs that
 *   need a real login `test.skip()` gracefully — the public + simulated flows
 *   still run end-to-end against the mock driver with zero env.
 */

const BASE_URL =
  process.env.BASE_URL?.replace(/\/$/, "") || "http://127.0.0.1:3100";

/** True when BASE_URL points at an already-running (likely remote) server. */
const isExternalTarget = Boolean(process.env.BASE_URL);

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  // The onboarding/86 specs mutate shared (mock or live) state, so run files
  // serially by default to keep flows deterministic against one app instance.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }], ["list"]]
    : [["html", { open: "never" }], ["list"]],
  timeout: 60_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  // Start a local production server only when targeting localhost. Targeting a
  // remote BASE_URL (preview/prod) reuses that server and skips this entirely.
  webServer: isExternalTarget
    ? undefined
    : {
        command: "npm run start -- --port 3100",
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        stdout: "pipe",
        stderr: "pipe",
      },
});
