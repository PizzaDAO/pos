/**
 * Auth + route-gating E2E.
 *
 * REAL-AUTH assertions (unauthenticated redirects, owner→/admin,
 * platform-admin→/platform) only run when the target deployment uses real
 * Supabase Auth AND the orchestrator supplied `E2E_*` creds. In simulated/mock
 * mode (zero env), middleware is a pass-through and there is no real login, so
 * those specs `test.skip()` — the public storefront spec always runs.
 */
import { test, expect } from "@playwright/test";
import { detectRealAuth, signInWithPassword } from "./support/auth";
import {
  OWNER_EMAIL,
  OWNER_PASSWORD,
  PLATFORM_EMAIL,
  PLATFORM_PASSWORD,
  SHOP_SLUG_PICKUP_DELIVERY,
} from "./support/env";

test.describe("public storefront is reachable without auth", () => {
  test("GET /shop/<slug> renders the storefront", async ({ page }) => {
    await page.goto(`/shop/${SHOP_SLUG_PICKUP_DELIVERY}`, {
      waitUntil: "domcontentloaded",
    });
    // Storefront header copy + the menu category tab prove a public render.
    await expect(page.getByText("Order online")).toBeVisible();
    await expect(page.getByRole("button", { name: "Pizzas" })).toBeVisible({
      timeout: 20_000,
    });
    // It must NOT have bounced us to a login.
    expect(page.url()).toContain(`/shop/${SHOP_SLUG_PICKUP_DELIVERY}`);
  });
});

test.describe("real-auth gating", () => {
  test("unauthenticated /admin redirects to /login", async ({ page }) => {
    const real = await detectRealAuth(page);
    test.skip(!real, "Simulated auth: middleware is a pass-through.");

    await page.context().clearCookies();
    await page.goto("/admin", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });

  test("unauthenticated /platform redirects to /platform/login", async ({
    page,
  }) => {
    const real = await detectRealAuth(page);
    test.skip(!real, "Simulated auth: middleware is a pass-through.");

    await page.context().clearCookies();
    await page.goto("/platform", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/platform\/login(\?|$)/);
  });

  test("owner can log in and reach /admin", async ({ page }) => {
    const real = await detectRealAuth(page);
    test.skip(!real, "Simulated auth: no real login.");
    test.skip(!OWNER_PASSWORD, "No E2E_OWNER_PASSWORD supplied.");

    await signInWithPassword(page, {
      loginPath: "/login?redirect=/admin",
      email: OWNER_EMAIL,
      password: OWNER_PASSWORD,
      expectPath: /\/admin(\?|$)/,
    });
    await expect(page.getByText("Back office")).toBeVisible();
  });

  test("platform admin can log in and reach /platform", async ({ page }) => {
    const real = await detectRealAuth(page);
    test.skip(!real, "Simulated auth: no real login.");
    test.skip(!PLATFORM_PASSWORD, "No E2E_PLATFORM_PASSWORD supplied.");

    await signInWithPassword(page, {
      loginPath: "/platform/login",
      email: PLATFORM_EMAIL,
      password: PLATFORM_PASSWORD,
      expectPath: /\/platform(\?|$)/,
    });
    await expect(
      page.getByRole("heading", { name: "Platform admin" }),
    ).toBeVisible();
  });
});
