/**
 * Terminal critical-path E2E: build a HALF-AND-HALF pizza → add to cart →
 * place order → take a (simulated) payment → see the receipt.
 *
 * Also exercises the staff PIN quick-switch. Runs against real auth when the
 * device is logged in (E2E_OWNER_PASSWORD), otherwise against the simulated
 * demo session (mock driver) — the terminal is usable in both.
 */
import { test, expect } from "@playwright/test";
import { detectRealAuth, signInWithPassword } from "./support/auth";
import { buildHalfAndHalf } from "./support/terminal";
import { OWNER_EMAIL, OWNER_PASSWORD, STAFF_PIN } from "./support/env";

test.describe("terminal order → payment → receipt", () => {
  test.beforeEach(async ({ page }) => {
    const real = await detectRealAuth(page);
    if (real) {
      test.skip(
        !OWNER_PASSWORD,
        "Real auth but no E2E_OWNER_PASSWORD to log the device in.",
      );
      await signInWithPassword(page, {
        loginPath: "/login?redirect=/terminal",
        email: OWNER_EMAIL,
        password: OWNER_PASSWORD,
        expectPath: /\/terminal(\?|$)/,
      });
    } else {
      await page.goto("/terminal", { waitUntil: "domcontentloaded" });
    }
    // Menu loaded.
    await expect(page.getByRole("button", { name: "Pizzas" })).toBeVisible({
      timeout: 30_000,
    });
  });

  test("staff PIN quick-switch sets the active cashier", async ({ page }) => {
    // The status-bar control reads "Sign in staff" (none active) or "Staff: …".
    await page
      .getByRole("button", { name: /Sign in staff|^Staff:/ })
      .first()
      .click();
    await expect(
      page.getByRole("heading", { name: "Switch staff" }),
    ).toBeVisible();

    // Wait for the staff picker to populate (GET /api/terminal/pin), then pick
    // the staff member that the configured PIN belongs to. Demo PIN 1111 → Tony;
    // when E2E_STAFF_PIN is overridden, fall back to the first real option.
    const select = page.locator("select").first();
    await expect
      .poll(async () => select.locator("option").count())
      .toBeGreaterThan(1);
    const labels = await select.locator("option").allTextContents();
    const realLabels = labels.filter((o) => o && !/select/i.test(o));
    test.skip(realLabels.length === 0, "No staff options available.");
    const target =
      STAFF_PIN === "1111"
        ? (realLabels.find((o) => /tony/i.test(o)) ?? realLabels[0]!)
        : realLabels[0]!;
    await select.selectOption({ label: target });

    await page.getByPlaceholder("••••").fill(STAFF_PIN);
    await page.getByRole("button", { name: "Switch", exact: true }).click();

    // On success the dialog closes; the status bar shows the active staff.
    await expect(
      page.getByRole("heading", { name: "Switch staff" }),
    ).toBeHidden({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: /^Staff:/ })).toBeVisible();
  });

  test("build half-and-half, place order, pay cash, receipt", async ({
    page,
  }) => {
    await buildHalfAndHalf(page, {
      itemName: "Pepperoni",
      leftTopping: "Mushrooms",
      rightTopping: "Onions",
      addButtonName: "Add to order",
    });

    // The line shows in the cart with the half-and-half placements (L)/(R).
    await expect(page.getByText("Current order")).toBeVisible();
    await expect(page.getByText(/Mushrooms \(L\)/)).toBeVisible();
    await expect(page.getByText(/Onions \(R\)/)).toBeVisible();

    // Place the order.
    await page.getByRole("button", { name: "Place order" }).click();

    // Online (default in preview) → the payment screen opens.
    await expect(page.getByText("Take payment")).toBeVisible({
      timeout: 30_000,
    });

    // Cash is the default rail. The order finishes flushing to the server a beat
    // after the screen opens, so wait for the balance to load (Charge enabled
    // with a non-zero amount), then charge.
    const charge = page.getByRole("button", { name: /^Charge / });
    await expect(charge).toBeEnabled({ timeout: 20_000 });
    await expect(charge).not.toHaveText(/Charge \$0\.00/);
    await charge.click();

    // Paid in full → receipt + "Payment complete".
    await expect(page.getByText("Payment complete")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("Order paid in full.")).toBeVisible();
    // The receipt panel should show our half-and-half line item.
    await expect(page.getByText("Pepperoni").first()).toBeVisible();
  });
});
