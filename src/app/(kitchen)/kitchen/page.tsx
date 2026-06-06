import type { Metadata } from "next";
import { KitchenBoard } from "./components/kitchen-board";
import { requireLocationSurface } from "@/lib/auth/guard";

export const metadata: Metadata = {
  title: "Kitchen Display",
  description: "Realtime kitchen display system for active orders.",
  robots: { index: false, follow: false },
};

/**
 * Kitchen Display System (real-auth). SERVER component: the device must be
 * signed in as an operational role (owner|manager|cashier|kitchen) of the active
 * location's tenant (requireLocationSurface → redirects to /login signed out,
 * /forbidden without the role). The active tenant/location come FROM THE SESSION
 * (no hardcoded demo context). In simulated/zero-env mode the session is the
 * seeded demo owner, so the KDS stays usable with no config.
 */
export const dynamic = "force-dynamic";

export default async function KitchenPage({
  searchParams,
}: {
  searchParams: Promise<{ tenant?: string; location?: string }>;
}) {
  const { tenant, location } = await searchParams;
  const ctx = await requireLocationSurface("kitchen", {
    tenant: tenant ?? null,
    location: location ?? null,
  });
  return (
    <KitchenBoard
      initialTenantId={ctx.tenantId}
      initialLocationId={ctx.locationId ?? undefined}
    />
  );
}
