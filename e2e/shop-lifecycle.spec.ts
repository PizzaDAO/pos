/**
 * Online-order lifecycle E2E (simulated rails, zero env).
 *
 * An online order is created `awaiting_payment` and must NOT reach the kitchen
 * board until it is paid. The simulated USDC rail confirms ~6s after creation, so
 * it exposes the unpaid window: we assert the kitchen feed (the same endpoint the
 * KDS polls) has no ticket for the order while it waits, that cancelling leaves
 * it off the board for good, and that it appears once the payment settles.
 */
import { test, expect, type Page } from "@playwright/test";
import { buildHalfAndHalf } from "./support/terminal";
import { SHOP_SLUG_PICKUP_ONLY } from "./support/env";

async function openShop(page: Page, slug: string) {
  await page.goto(`/shop/${slug}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Order online")).toBeVisible();
  await expect(page.getByRole("button", { name: "Pizzas" })).toBeVisible({
    timeout: 30_000,
  });
}

async function chooseWhen(page: Page) {
  const asap = page.getByRole("button", { name: /^ASAP/ });
  if (await asap.isEnabled().catch(() => false)) {
    await asap.click();
    return;
  }
  const select = page.locator("select").last();
  const values = await select
    .locator("option")
    .evaluateAll((opts) =>
      (opts as HTMLOptionElement[]).map((o) => o.value).filter((v) => v !== ""),
    );
  test.skip(values.length === 0, "No ASAP and no scheduled slots available.");
  await select.selectOption(values[0]!);
}

/** Cart -> checkout -> payment step with USDC selected. */
async function reachUsdcPayment(page: Page) {
  await openShop(page, SHOP_SLUG_PICKUP_ONLY);
  await buildHalfAndHalf(page, {
    itemName: "Pepperoni",
    leftTopping: "Mushrooms",
    rightTopping: "Onions",
    addButtonName: "Add to order",
  });
  await page.getByRole("button", { name: /View cart/ }).first().click();
  await page.getByRole("button", { name: "Checkout", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Checkout" })).toBeVisible();
  await chooseWhen(page);
  const cont = page.getByRole("button", { name: "Continue", exact: true });
  await expect(cont).toBeEnabled({ timeout: 15_000 });
  await cont.click();
  await page.getByPlaceholder("Email").fill("e2e-lifecycle@example.com");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Payment" })).toBeVisible();
  await page.getByRole("button", { name: /Crypto/ }).click();
}

/** Click Pay and capture the id the server assigned to the new order. */
async function payAndGetOrderId(page: Page): Promise<string> {
  const created = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/shop/orders") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: /^Pay / }).click();
  const body = (await (await created).json()) as {
    order: { id: string; tenant_id: string; location_id: string; status: string };
  };
  expect(body.order.status).toBe("awaiting_payment");
  return body.order.id;
}

async function kitchenOrderIds(page: Page, slug: string): Promise<string[]> {
  const loc = await page.request.get(`/api/shop/location?slug=${slug}`);
  const { location } = (await loc.json()) as {
    location: { tenant_id: string; id: string };
  };
  const res = await page.request.get(
    `/api/kitchen/orders?tenantId=${location.tenant_id}&locationId=${location.id}`,
  );
  const board = (await res.json()) as { tickets: { order: { id: string } }[] };
  return board.tickets.map((t) => t.order.id);
}

test("an unpaid online order stays off the kitchen board until it is paid", async ({
  page,
}) => {
  await reachUsdcPayment(page);
  const orderId = await payAndGetOrderId(page);

  // Pending crypto: the flow waits and nothing is confirmed yet.
  await expect(page.getByTestId("waiting-for-payment")).toBeVisible();
  await expect(page.getByText("Thanks for your order!")).toHaveCount(0);
  expect(await kitchenOrderIds(page, SHOP_SLUG_PICKUP_ONLY)).not.toContain(
    orderId,
  );

  // The simulated chain confirms; the waiting step polls the server and
  // advances only once the server reports the order paid.
  await expect(page.getByText("Thanks for your order!")).toBeVisible({
    timeout: 30_000,
  });
  await expect
    .poll(async () => kitchenOrderIds(page, SHOP_SLUG_PICKUP_ONLY))
    .toContain(orderId);
});

test("a cancelled checkout never reaches the kitchen board", async ({ page }) => {
  await reachUsdcPayment(page);
  const orderId = await payAndGetOrderId(page);
  await expect(page.getByTestId("waiting-for-payment")).toBeVisible();

  await page
    .getByRole("button", { name: "Cancel and choose another way to pay" })
    .click();
  await expect(page.getByRole("heading", { name: "Payment" })).toBeVisible();

  // Even after the simulated confirmation window has passed, it stays off.
  await page.waitForTimeout(8_000);
  expect(await kitchenOrderIds(page, SHOP_SLUG_PICKUP_ONLY)).not.toContain(
    orderId,
  );

  // Its tracking page says the checkout is over.
  await page.goto(`/shop/${SHOP_SLUG_PICKUP_ONLY}/track/${orderId}`);
  await expect(page.getByTestId("checkout-expired")).toBeVisible({
    timeout: 30_000,
  });
});
