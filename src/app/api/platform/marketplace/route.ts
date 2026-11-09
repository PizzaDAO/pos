/**
 * Marketplace store assignment (PLATFORM ADMIN only).
 *
 * PUT { tenantId, locationId, provider, storeId | null }
 *   Assigns (or clears, with null) the provider's store id for a location. Tenants
 *   cannot do this: the store id decides whose orders a webhook delivers, so only
 *   an operator who has verified the restaurant owns that store may set it. One
 *   (provider, store id) belongs to exactly one location (unique key, 409 if taken).
 *   The assignment is mirrored into the location's marketplace settings (shown to
 *   the owner, read-only); clearing it also switches that provider off.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { requirePlatformAdminApi } from "@/lib/auth/tenant-guard";
import { MarketplaceStoreTakenError } from "@/lib/marketplace/guard";
import { isMarketplaceProvider } from "@/lib/marketplace/types";

export const runtime = "nodejs";

export async function PUT(request: Request) {
  const admin = await requirePlatformAdminApi();
  if (!admin.ok) return admin.res;
  let body: {
    tenantId?: string;
    locationId?: string;
    provider?: string;
    storeId?: string | null;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { tenantId, locationId, provider } = body;
  if (
    !tenantId ||
    !locationId ||
    !provider ||
    !isMarketplaceProvider(provider) ||
    provider === "simulator"
  ) {
    return NextResponse.json(
      { error: "tenantId, locationId and a real provider are required." },
      { status: 422 },
    );
  }
  const storeId =
    typeof body.storeId === "string" && body.storeId.trim()
      ? body.storeId.trim().slice(0, 120)
      : null;
  if (body.storeId != null && !storeId) {
    return NextResponse.json(
      { error: "storeId must be a non-empty string or null." },
      { status: 422 },
    );
  }
  const driver = getPosDriver();
  const locations = await driver.listLocations(tenantId);
  if (!locations.some((l) => l.id === locationId)) {
    return NextResponse.json({ error: "Location not found." }, { status: 404 });
  }
  try {
    await driver.assignMarketplaceStore({
      provider,
      tenantId,
      locationId,
      storeId,
      assignedBy: admin.user.email,
    });
  } catch (err) {
    if (err instanceof MarketplaceStoreTakenError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
  const settings = await driver.getStoreSettings(tenantId, locationId);
  const m = settings.marketplace ?? {
    enabled: false,
    auto_accept: false,
    providers: {},
  };
  const prev = m.providers[provider];
  const saved = await driver.setMarketplaceSettings(tenantId, locationId, {
    ...m,
    providers: {
      ...m.providers,
      [provider]: {
        enabled: storeId ? (prev?.enabled ?? false) : false,
        store_id: storeId,
      },
    },
  });
  return NextResponse.json({ settings: saved.marketplace });
}
