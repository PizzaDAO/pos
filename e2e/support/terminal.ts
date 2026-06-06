/**
 * Terminal flow helpers — build a half-and-half pizza in the shared PizzaBuilder
 * dialog (reused by both /terminal and /shop) and add it to the active cart.
 */
import { expect, type Page } from "@playwright/test";

/** Escape a string for safe use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Opens the builder for `itemName`, places `leftTopping` on the Left half and
 * `rightTopping` on the Right half (a true half-and-half), and confirms.
 *
 * The builder is a role="dialog" with size buttons, single-select crust/sauce
 * (defaulted), and per-topping L/Whole/R segmented controls (aria-pressed).
 */
export async function buildHalfAndHalf(
  page: Page,
  opts: {
    itemName: string;
    leftTopping: string;
    rightTopping: string;
    addButtonName: string; // "Add to order" (terminal) — builder is shared
  },
): Promise<void> {
  // Make sure we're on the Pizzas category, then open the item. The item card's
  // accessible name concatenates its name + description + price + "half & half"
  // badge, so match the LEADING item name rather than an exact string.
  await page.getByRole("button", { name: "Pizzas" }).click();
  await page
    .getByRole("button", { name: new RegExp(`^${escapeRe(opts.itemName)}\\b`) })
    .first()
    .click();

  const dialog = page.getByRole("dialog", {
    name: new RegExp(`Build ${opts.itemName}`),
  });
  await expect(dialog).toBeVisible();

  // Place the two toppings on opposite halves. Each topping row has three
  // segmented buttons labelled L / Whole / R; we scope by the topping name row.
  await placeTopping(page, dialog, opts.leftTopping, "L");
  await placeTopping(page, dialog, opts.rightTopping, "R");

  // Confirm.
  await dialog.getByRole("button", { name: opts.addButtonName }).click();
  await expect(dialog).toBeHidden();
}

/** Click the L/Whole/R placement button within a named topping row. */
async function placeTopping(
  page: Page,
  dialog: ReturnType<Page["getByRole"]>,
  topping: string,
  placement: "L" | "Whole" | "R",
): Promise<void> {
  // Each topping is a bordered row: the topping name + a 3-button segmented
  // control (L / Whole / R). Find the SMALLEST div that holds both the topping
  // text and the placement button (the row), then click that button. Using the
  // button's own aria-pressed to confirm the placement actually applied.
  const row = dialog
    .locator("div.rounded-lg.border")
    .filter({ hasText: topping })
    .filter({
      has: page.getByRole("button", { name: placement, exact: true }),
    })
    .first();
  const button = row.getByRole("button", { name: placement, exact: true });
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}
