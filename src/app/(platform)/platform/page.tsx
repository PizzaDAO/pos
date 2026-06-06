import type { Metadata } from "next";
import { PlatformConsole } from "./platform-console";
import { requirePlatformAdmin } from "@/lib/auth/guard";

export const metadata: Metadata = {
  title: "Platform Admin",
  description: "Super-admin console: tenants, billing, and support.",
  robots: { index: false, follow: false },
};

/**
 * Super-admin platform console (real-auth). SERVER component: gated to
 * platform_admins ONLY (requirePlatformAdmin → redirects to /platform/login when
 * signed out or not an admin). Operates OUTSIDE tenant RLS. In simulated/zero-env
 * mode the seeded platform-operator identity drives the surface so it stays
 * reachable with no config. All data flows through getPosDriver().
 */
export const dynamic = "force-dynamic";

export default async function PlatformPage() {
  await requirePlatformAdmin();
  return <PlatformConsole />;
}
