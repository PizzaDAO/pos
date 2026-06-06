import type { Metadata } from "next";
import { TerminalClient } from "./components/terminal-client";
import { requireLocationSurface } from "@/lib/auth/guard";

export const metadata: Metadata = {
  title: "Terminal",
  description: "Offline-first counter POS terminal.",
  robots: { index: false, follow: false },
};

/**
 * Counter terminal (real-auth). SERVER component: the device must be signed in
 * as an operational role (owner|manager|cashier|kitchen) of the active
 * location's tenant (requireLocationSurface → redirects to /login signed out,
 * /forbidden without the role). The active tenant/location come FROM THE SESSION
 * (no hardcoded demo context); cashiers then quick-switch the active STAFF via
 * PIN on the client. In simulated/zero-env mode the session is the seeded demo
 * owner, so the terminal stays usable with no config.
 */
export const dynamic = "force-dynamic";

export default async function TerminalPage({
  searchParams,
}: {
  searchParams: Promise<{ tenant?: string; location?: string }>;
}) {
  const { tenant, location } = await searchParams;
  const ctx = await requireLocationSurface("terminal", {
    tenant: tenant ?? null,
    location: location ?? null,
  });
  return (
    <TerminalClient
      initialTenantId={ctx.tenantId}
      initialLocationId={ctx.locationId ?? undefined}
    />
  );
}
