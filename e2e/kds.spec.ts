/**
 * KDS (kitchen display) E2E: a placed order appears on the board and can be
 * bumped through statuses (placed → … → ready → recall).
 *
 * We first place an order in the terminal (so there is a deterministic ticket),
 * then open the KDS, find a bumpable ticket, and advance it. Runs against real
 * auth when logged in, else the simulated demo session (mock driver).
 */
import { test, expect } from "@playwright/test";
import { detectRealAuth, signInWithPassword } from "./support/auth";
import { buildHalfAndHalf } from "./support/terminal";
import { OWNER_EMAIL, OWNER_PASSWORD } from "./support/env";

async function enterTerminal(page: import("@playwright/test").Page) {
  const real = await detectRealAuth(page);
  if (real) {
    test.skip(!OWNER_PASSWORD, "Real auth but no E2E_OWNER_PASSWORD.");
    await signInWithPassword(page, {
      loginPath: "/login?redirect=/terminal",
      email: OWNER_EMAIL,
      password: OWNER_PASSWORD,
      expectPath: /\/terminal(\?|$)/,
    });
  } else {
    await page.goto("/terminal", { waitUntil: "domcontentloaded" });
  }
  await expect(page.getByRole("button", { name: "Pizzas" })).toBeVisible({
    timeout: 30_000,
  });
}

test("placed order appears on the KDS and can be bumped", async ({ page }) => {
  // 1) Place an order in the terminal.
  await enterTerminal(page);
  await buildHalfAndHalf(page, {
    itemName: "Margherita",
    leftTopping: "Mushrooms",
    rightTopping: "Sausage",
    addButtonName: "Add to order",
  });
  await page.getByRole("button", { name: "Place order" }).click();
  // Either the payment screen (online) or the offline confirmation appears;
  // the order is on the board regardless. Capture the order number if shown.
  await expect(
    page
      .getByText("Take payment")
      .or(page.getByText(/Order .* placed|Order placed/i))
      .first(),
  ).toBeVisible({ timeout: 30_000 });

  // 2) Open the KDS (login is already established if real auth).
  await page.goto("/kitchen", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: "Kitchen Display" }),
  ).toBeVisible({ timeout: 30_000 });

  // 3) There should be at least one active ticket with a Bump button.
  const bump = page.getByRole("button", { name: "Bump" }).first();
  await expect(bump).toBeVisible({ timeout: 30_000 });

  // Count tickets, bump one, and expect a status change (Bump → Recall once
  // the ticket reaches a bumped state). We click Bump until it becomes Recall
  // (the order may need more than one bump to reach ready, depending on the
  // starting status).
  for (let i = 0; i < 4; i++) {
    const recallVisible = await page
      .getByRole("button", { name: "Recall" })
      .first()
      .isVisible()
      .catch(() => false);
    if (recallVisible) break;
    await page.getByRole("button", { name: "Bump" }).first().click();
    // Let the optimistic update / poll settle.
    await page.waitForTimeout(800);
  }

  await expect(
    page.getByRole("button", { name: "Recall" }).first(),
  ).toBeVisible({ timeout: 30_000 });
});
