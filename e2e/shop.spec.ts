/**
 * Online ordering (/shop/<slug>) E2E — PUBLIC, no auth required.
 *
 * Covers: build a half-and-half pizza → cart → checkout for PICKUP and for
 * DELIVERY (in-zone address quote) → order confirmation → tracking page shows a
 * status timeline. Payments are simulated in the preview (no live keys).
 */
import { test, expect, type Page } from "@playwright/test";
import { buildHalfAndHalf } from "./support/terminal";
import {
  SHOP_SLUG_PICKUP_DELIVERY,
  SHOP_SLUG_PICKUP_ONLY,
} from "./support/env";

async function openShop(page: Page, slug: string) {
  await page.goto(`/shop/${slug}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Order online")).toBeVisible();
  await expect(page.getByRole("button", { name: "Pizzas" })).toBeVisible({
    timeout: 30_000,
  });
}

async function addHalfAndHalfAndOpenCheckout(page: Page) {
  await buildHalfAndHalf(page, {
    itemName: "Pepperoni",
    leftTopping: "Mushrooms",
    rightTopping: "Onions",
    // Shared builder; same confirm label as the terminal.
    addButtonName: "Add to order",
  });
  // Open the cart (sticky CTA appears once there's an item), then Checkout.
  await page
    .getByRole("button", { name: /View cart/ })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "Your order" })).toBeVisible();
  await page.getByRole("button", { name: "Checkout", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Checkout" })).toBeVisible();
}

/**
 * Selects the "When" for the order: ASAP if the store is open now (button
 * enabled), otherwise the first available scheduled slot from the dropdown.
 * This keeps the spec green regardless of the wall-clock time of the run
 * relative to the seeded store hours (11:00–22:00).
 */
async function chooseWhen(page: Page) {
  const asap = page.getByRole("button", { name: /^ASAP/ });
  if (await asap.isEnabled().catch(() => false)) {
    await asap.click();
    return;
  }
  // Store closed now → schedule for later. Pick the first real slot option.
  const select = page.locator("select").last();
  const values = await select
    .locator("option")
    .evaluateAll((opts) =>
      (opts as HTMLOptionElement[]).map((o) => o.value).filter((v) => v !== ""),
    );
  test.skip(
    values.length === 0,
    "No ASAP and no scheduled slots available for the seeded hours.",
  );
  await select.selectOption(values[0]!);
}

async function fillIdentityAndPay(page: Page) {
  // STEP 2 — identity (guest): email is required to continue.
  await page.getByPlaceholder("Email").fill("e2e-customer@example.com");
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  // STEP 3 — payment: default rail "Card", simulated. Place + pay.
  await expect(page.getByRole("heading", { name: "Payment" })).toBeVisible();
  await page.getByRole("button", { name: /^Pay / }).click();

  // STEP 4 — confirmation.
  await expect(page.getByText("Thanks for your order!")).toBeVisible({
    timeout: 30_000,
  });
}

test("online order — PICKUP — places and tracks", async ({ page }) => {
  await openShop(page, SHOP_SLUG_PICKUP_ONLY);
  await addHalfAndHalfAndOpenCheckout(page);

  // STEP 1 — fulfillment: pickup is the default. Pick a valid time, then Continue.
  await expect(
    page.getByRole("button", { name: "Pickup", exact: true }),
  ).toBeVisible();
  await chooseWhen(page);
  const cont = page.getByRole("button", { name: "Continue", exact: true });
  await expect(cont).toBeEnabled({ timeout: 15_000 });
  await cont.click();

  await fillIdentityAndPay(page);

  // Track.
  await page.getByRole("button", { name: "Track your order" }).click();
  await expect(page).toHaveURL(/\/shop\/.+\/track\/.+/);
  await expect(page.getByText("Order received")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("Ready for pickup")).toBeVisible();
});

test("online order — DELIVERY — in-zone quote, places and tracks", async ({
  page,
}) => {
  await openShop(page, SHOP_SLUG_PICKUP_DELIVERY);
  await addHalfAndHalfAndOpenCheckout(page);

  // STEP 1 — fulfillment: choose Delivery, fill an IN-ZONE address (ZIP 10001),
  // get a quote, then Continue.
  await page.getByRole("button", { name: "Delivery", exact: true }).click();
  await page.getByPlaceholder("Street address").fill("123 Main St");
  await page.getByPlaceholder("City").fill("New York");
  await page.getByPlaceholder("State").fill("NY");
  await page.getByPlaceholder("ZIP / postal code").fill("10001");
  await page
    .getByRole("button", { name: "Check delivery & get a quote" })
    .click();
  await expect(page.getByText("Delivery available:")).toBeVisible({
    timeout: 30_000,
  });
  await chooseWhen(page);
  const cont = page.getByRole("button", { name: "Continue", exact: true });
  await expect(cont).toBeEnabled({ timeout: 15_000 });
  await cont.click();

  await fillIdentityAndPay(page);

  // Track — delivery timeline includes "Out for delivery".
  await page.getByRole("button", { name: "Track your order" }).click();
  await expect(page).toHaveURL(/\/shop\/.+\/track\/.+/);
  await expect(page.getByText("Order received")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("Out for delivery")).toBeVisible();
});
