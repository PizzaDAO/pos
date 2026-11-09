/**
 * Marketplace inbox settings + demo simulator (owner|manager).
 *
 * GET  ?tenantId=&locationId=
 *   -> { settings, providers: [{ key, label, docs, configured }] }
 * PUT  { tenantId, locationId, enabled, auto_accept, providers: { <key>: { enabled, store_id } } }
 *   -> saves the location's settings. Everything is OFF until enabled here.
 * POST { tenantId, locationId, simulate: true }
 *   -> generates one realistic simulated order through the real ingest path
 *      (needs the simulator provider enabled for the location).
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import type {
  MarketplaceSettings,
  MarketplaceProviderSettings,
} from "@/lib/db";
import { requireTenantAccess } from "@/lib/auth/tenant-guard";
import { getAdapter } from "@/lib/marketplace/adapters";
import {
  buildSimulatedOrder,
  signSimulatedWebhook,
} from "@/lib/marketplace/adapters/simulator";
import { getProviderConfig, isProviderConfigured } from "@/lib/marketplace/env";
import { ingestMarketplaceWebhook } from "@/lib/marketplace/service";
import {
  MARKETPLACE_PROVIDERS,
  MarketplaceError,
  providerLabel,
} from "@/lib/marketplace/types";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const auth = await requireTenantAccess(
    searchParams.get("tenantId"),
    "admin",
    {
      locationId: searchParams.get("locationId"),
      requireLocation: true,
    },
  );
  if (!auth.ok) return auth.res;
  const settings = await getPosDriver().getStoreSettings(
    auth.tenantId,
    auth.locationId as string,
  );
  return NextResponse.json({
    settings: settings.marketplace ?? {
      enabled: false,
      auto_accept: false,
      providers: {},
    },
    providers: MARKETPLACE_PROVIDERS.map((key) => ({
      key,
      label: providerLabel(key),
      docs: getAdapter(key).docs,
      configured: isProviderConfigured(key),
    })),
  });
}

export async function PUT(request: Request) {
  let body: Partial<MarketplaceSettings> & {
    tenantId?: string;
    locationId?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const auth = await requireTenantAccess(body.tenantId, "admin", {
    locationId: body.locationId,
    requireLocation: true,
  });
  if (!auth.ok) return auth.res;
  const driver = getPosDriver();
  const current = (
    await driver.getStoreSettings(auth.tenantId, auth.locationId as string)
  ).marketplace;
  const providers: MarketplaceSettings["providers"] = {};
  for (const key of MARKETPLACE_PROVIDERS) {
    const p = (body.providers?.[key] ??
      null) as Partial<MarketplaceProviderSettings> | null;
    if (!p) continue;
    // Store ids of REAL providers are assigned by a platform admin only
    // (/api/platform/marketplace): whatever the body says, keep what is assigned.
    // (A tenant that could pick its own store id could claim another
    // restaurant's orders.) The simulator has no real store, so it may be set.
    const assigned =
      key === "simulator"
        ? typeof p.store_id === "string" && p.store_id.trim()
          ? p.store_id.trim().slice(0, 120)
          : null
        : (current?.providers[key]?.store_id ?? null);
    if (p.enabled === true && key !== "simulator") {
      const hits = assigned
        ? await driver.findMarketplaceLocations(key, assigned)
        : [];
      if (hits.length !== 1 || hits[0]!.location_id !== auth.locationId) {
        return NextResponse.json(
          {
            error: `${providerLabel(key)} has no store assigned to this location yet. Ask support to assign it.`,
          },
          { status: 422 },
        );
      }
    }
    providers[key] = { enabled: p.enabled === true, store_id: assigned };
  }
  // Providers the body omitted keep their assignment (still disabled).
  for (const key of MARKETPLACE_PROVIDERS) {
    if (!providers[key] && current?.providers[key]?.store_id) {
      providers[key] = {
        enabled: false,
        store_id: current.providers[key]!.store_id,
      };
    }
  }
  const next: MarketplaceSettings = {
    enabled: body.enabled === true,
    auto_accept: body.auto_accept === true,
    providers,
  };
  const saved = await getPosDriver().setMarketplaceSettings(
    auth.tenantId,
    auth.locationId as string,
    next,
  );
  return NextResponse.json({ settings: saved.marketplace });
}

export async function POST(request: Request) {
  let body: { tenantId?: string; locationId?: string; simulate?: boolean };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (body.simulate !== true) {
    return NextResponse.json(
      { error: "Body must include simulate: true." },
      { status: 422 },
    );
  }
  const auth = await requireTenantAccess(body.tenantId, "admin", {
    locationId: body.locationId,
    requireLocation: true,
  });
  if (!auth.ok) return auth.res;
  const config = getProviderConfig("simulator");
  if (!config) {
    return NextResponse.json(
      { error: "The simulator is disabled in this environment." },
      { status: 503 },
    );
  }
  const settings = await getPosDriver().getStoreSettings(
    auth.tenantId,
    auth.locationId as string,
  );
  const storeId = settings.marketplace?.providers.simulator?.store_id ?? null;
  const signed = signSimulatedWebhook(
    buildSimulatedOrder(Date.now(), { storeId }),
    config.webhookSecret,
  );
  try {
    const result = await ingestMarketplaceWebhook({
      provider: "simulator",
      location: {
        tenantId: auth.tenantId,
        locationId: auth.locationId as string,
      },
      rawBody: signed.rawBody,
      headers: signed.headers,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof MarketplaceError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: 409 },
      );
    }
    throw err;
  }
}
