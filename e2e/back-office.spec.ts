/**
 * Back office (/admin) E2E: reports render with data, and an item can be 86'd
 * (marked unavailable at a location) then un-86'd.
 *
 * Runs against real auth when the owner logs in (E2E_OWNER_PASSWORD), else the
 * simulated demo owner session (mock driver). The demo tenant is on the Pro
 * plan, so advanced reports are unlocked.
 */
import { test, expect, type Page } from "@playwright/test";
import { detectRealAuth, signInWithPassword } from "./support/auth";
import { OWNER_EMAIL, OWNER_PASSWORD } from "./support/env";

async function enterAdmin(page: Page) {
  const real = await detectRealAuth(page);
  if (real) {
    test.skip(!OWNER_PASSWORD, "Real auth but no E2E_OWNER_PASSWORD.");
    await signInWithPassword(page, {
      loginPath: "/login?redirect=/admin",
      email: OWNER_EMAIL,
      password: OWNER_PASSWORD,
      expectPath: /\/admin(\?|$)/,
    });
  } else {
    await page.goto("/admin", { waitUntil: "domcontentloaded" });
  }
  await expect(page.getByText("Back office")).toBeVisible({ timeout: 30_000 });
}

test("reports tab renders KPIs and payment mix", async ({ page }) => {
  await enterAdmin(page);

  await page.getByRole("button", { name: "Reports" }).click();
  await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();

  // KPI cards + the payment-mix section render once data loads.
  await expect(page.getByText("Orders").first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("Gross")).toBeVisible();
  await expect(
    page.getByText("Payment mix (cash / card / crypto)"),
  ).toBeVisible();
  // By-channel / by-item rollups render.
  await expect(page.getByText("By channel")).toBeVisible();
  await expect(page.getByText("Top items")).toBeVisible();
});

test("86 a menu item at a location, then un-86", async ({ page }) => {
  await enterAdmin(page);

  // Menu is the default tab. Operate on a SPECIFIC item ("Pepperoni") so we can
  // scope the 86/Un-86 controls to that item's row and reliably restore it —
  // never leaving a menu item hidden for other specs sharing the mock state.
  await page.getByRole("button", { name: "Menu" }).first().click();

  // The item row's name button reads e.g. "Pepperonioven · ½&½ · 3 sizes". Find
  // the smallest row container holding that button plus its 86 control.
  const row = page
    .locator("div.px-4.py-3")
    .filter({
      has: page.getByRole("button", { name: /^Pepperoni/ }),
    })
    .first();
  await expect(row).toBeVisible({ timeout: 30_000 });

  // 86 it (mark unavailable at this location).
  await row.getByRole("button", { name: "86", exact: true }).click();

  // The row now shows the "86'd here" badge and a Un-86 control.
  await expect(row.getByText("86'd here")).toBeVisible({ timeout: 30_000 });
  const un86 = row.getByRole("button", { name: "Un-86", exact: true });
  await expect(un86).toBeVisible();

  // Restore so the run is idempotent against the shared (mock/live) state.
  await un86.click();
  await expect(row.getByText("86'd here")).toBeHidden({ timeout: 30_000 });
  await expect(
    row.getByRole("button", { name: "86", exact: true }),
  ).toBeVisible();
});
