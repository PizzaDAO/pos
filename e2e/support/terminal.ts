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
 * (defaulted), and per-topping tiles (Whole) with L / R toggles (aria-pressed).
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

/**
 * Place a topping: the topping tile (`data-topping`) is the Whole tap, with
 * separate L / R half toggles (aria-pressed on whichever applied).
 */
async function placeTopping(
  page: Page,
  dialog: ReturnType<Page["getByRole"]>,
  topping: string,
  placement: "L" | "Whole" | "R",
): Promise<void> {
  const tile = dialog.locator(`[data-topping="${topping}"]`);
  const button =
    placement === "Whole"
      ? tile.locator("button").first()
      : tile.getByRole("button", { name: placement, exact: true });
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}
