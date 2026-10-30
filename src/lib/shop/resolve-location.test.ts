import { describe, expect, it } from "vitest";
import { DEMO_LOCATION_DOWNTOWN_ID, DEMO_TENANT_ID, getPosDriver } from "@/lib/db";
import {
  resolveLegacyShopSlug,
  resolveStorefrontLocation,
} from "./resolve-location";
import { storefrontPath } from "./storefront";

/**
 * Location slugs are unique only WITHIN a tenant (DB: unique (tenant_id,
 * slug)). Two tenants can both own "tonys-downtown"; storefront resolution must
 * use the tenant slug and never pick a tenant arbitrarily.
 */
describe("storefront slug resolution across tenants (mock driver)", () => {
  const driver = getPosDriver();

  it("lets two tenants share a location slug and resolves each by tenant slug", async () => {
    const { tenant: rival } = await driver.createTenant({
      businessName: "Rival Slice Co",
      ownerEmail: "owner@rival-slice.example",
    });
    // Same display name as the demo tenant's downtown store → same slug.
    const rivalLoc = await driver.createLocation({
      tenant_id: rival.id,
      name: "Tonys Downtown",
    });
    expect(rivalLoc.slug).toBe("tonys-downtown");

    const demoTenant = await driver.getTenant(DEMO_TENANT_ID);
    expect(demoTenant).not.toBeNull();

    const demo = await driver.getLocationBySlugs(
      demoTenant!.slug,
      "tonys-downtown",
    );
    const other = await driver.getLocationBySlugs(rival.slug, "tonys-downtown");
    expect(demo?.id).toBe(DEMO_LOCATION_DOWNTOWN_ID);
    expect(demo?.tenant_id).toBe(DEMO_TENANT_ID);
    expect(other?.id).toBe(rivalLoc.id);
    expect(other?.tenant_id).toBe(rival.id);

    // Both share the bare slug — the legacy lookup sees the collision.
    const matches = await driver.listLocationsBySlug("tonys-downtown");
    expect(matches.map((l) => l.tenant_id).sort()).toEqual(
      [DEMO_TENANT_ID, rival.id].sort(),
    );

    // Pair resolution is exact; bare legacy slug is ambiguous → 409.
    const byPair = await resolveStorefrontLocation({
      tenantSlug: rival.slug,
      locationSlug: "tonys-downtown",
    });
    expect(byPair.ok && byPair.location.id).toBe(rivalLoc.id);

    const legacy = await resolveStorefrontLocation({
      locationSlug: "tonys-downtown",
    });
    expect(legacy.ok).toBe(false);
    if (!legacy.ok) expect(legacy.status).toBe(409);

    // A slug held by one tenant only still resolves via the legacy form.
    const uptown = await resolveStorefrontLocation({
      locationSlug: "tonys-uptown",
    });
    expect(uptown.ok && uptown.location.tenant_id).toBe(DEMO_TENANT_ID);
  });

  it("returns 404 for an unknown pair and never crosses tenants", async () => {
    const none = await resolveStorefrontLocation({
      tenantSlug: "no-such-tenant",
      locationSlug: "tonys-downtown",
    });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.status).toBe(404);
  });

  it("reserves the 'track' slug for the legacy tracking route", async () => {
    const loc = await driver.createLocation({
      tenant_id: DEMO_TENANT_ID,
      name: "Track",
    });
    expect(loc.slug).not.toBe("track");
  });

  it("legacy /shop/{slug}: tenant slug wins; tenant+location collision → chooser", async () => {
    // Tenant slug with ONE location → redirect to it.
    const { tenant: solo } = await driver.createTenant({
      businessName: "Solo Slice",
      ownerEmail: "solo@example.com",
    });
    const soloLoc = await driver.createLocation({
      tenant_id: solo.id,
      name: "Main Street",
    });
    expect(await resolveLegacyShopSlug(solo.slug)).toEqual({
      kind: "redirect",
      path: storefrontPath({ tenantSlug: solo.slug, locationSlug: soloLoc.slug }),
    });

    // A tenant whose slug equals ANOTHER tenant's location slug → chooser
    // with both, never a guess.
    const { tenant: clash } = await driver.createTenant({
      businessName: "Tonys Uptown",
      ownerEmail: "clash@example.com",
    });
    expect(clash.slug).toBe("tonys-uptown");
    await driver.createLocation({ tenant_id: clash.id, name: "Only Store" });
    const res = await resolveLegacyShopSlug("tonys-uptown");
    expect(res.kind).toBe("choose");
    if (res.kind === "choose") {
      expect(new Set(res.choices.map((c) => c.tenant.id))).toEqual(
        new Set([clash.id, DEMO_TENANT_ID]),
      );
    }

    // A bare, unique legacy location slug still redirects.
    const { tenant: other } = await driver.createTenant({
      businessName: "Legacy Only",
      ownerEmail: "legacy@example.com",
    });
    const legacy = await driver.createLocation({
      tenant_id: other.id,
      name: "Very Unique Store Name",
    });
    expect(await resolveLegacyShopSlug(legacy.slug)).toEqual({
      kind: "redirect",
      path: storefrontPath({ tenantSlug: other.slug, locationSlug: legacy.slug }),
    });
    expect((await resolveLegacyShopSlug("nothing-here")).kind).toBe("none");
  });

  it("builds canonical storefront paths", () => {
    expect(
      storefrontPath({ tenantSlug: "tonys-pizza", locationSlug: "tonys-downtown" }),
    ).toBe("/shop/tonys-pizza/tonys-downtown");
  });
});
