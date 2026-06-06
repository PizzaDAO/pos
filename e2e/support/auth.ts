/**
 * Auth helpers for E2E.
 *
 * Detects whether the target app runs REAL Supabase Auth or SIMULATED auth, and
 * provides a password sign-in used to mint a per-role storage state once.
 */
import { expect, type Page } from "@playwright/test";

/**
 * Returns true when the deployment uses REAL Supabase Auth.
 *
 * The shared `SignInForm` renders a "simulated auth" notice (with a Continue
 * link) when Supabase is NOT configured, and an email/password form when it is.
 * We probe the tenant login page and read which UI is present.
 */
export async function detectRealAuth(page: Page): Promise<boolean> {
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  // Real mode shows an email input; simulated mode shows the "simulated auth"
  // notice + a Continue link and no email field.
  const emailField = page.getByPlaceholder("you@pizzeria.com");
  const simulatedNotice = page.getByText("simulated auth", { exact: false });
  // Whichever resolves first tells us the mode.
  const real = await emailField
    .waitFor({ state: "visible", timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  if (real) return true;
  // Confirm it really is the simulated notice (not a transient load failure).
  await expect(simulatedNotice).toBeVisible({ timeout: 8000 });
  return false;
}

/**
 * Real-mode password sign-in. Fills the email/password form on `loginPath`,
 * submits, and waits for the post-login destination. Throws if the form is not
 * in real mode (caller should gate on detectRealAuth first).
 */
export async function signInWithPassword(
  page: Page,
  opts: {
    loginPath: string;
    email: string;
    password: string;
    expectPath: string | RegExp;
  },
): Promise<void> {
  await page.goto(opts.loginPath, { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder("you@pizzeria.com").fill(opts.email);
  // Toggle to the password form.
  await page.getByRole("button", { name: "Use a password instead" }).click();
  await page.locator('input[type="password"]').fill(opts.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(opts.expectPath, { timeout: 30_000 });
}
