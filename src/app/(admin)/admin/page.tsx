import { AdminShell } from "./components/admin-shell";
import { requireAdmin } from "@/lib/auth/guard";

/**
 * Tenant back office (Phase 5/6 + real-auth). This is now a SERVER component: it
 * gates entry to owner|manager of the active tenant (requireAdmin → redirects to
 * /login signed out, /forbidden without the role) and resolves the active tenant
 * FROM THE SESSION'S memberships (no hardcoded demo tenant). In simulated /
 * zero-env mode the session is the seeded demo owner, so /admin stays usable
 * with no config. The resolved tenant is handed to the client shell; an explicit
 * ?tenant= (audited platform impersonation) still overrides on the client.
 *
 * All data still flows through getPosDriver(); the surface builds + runs with
 * zero env vars.
 */
export const dynamic = "force-dynamic";

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ tenant?: string }>;
}) {
  const { tenant } = await searchParams;
  const ctx = await requireAdmin(tenant ?? null);
  return <AdminShell initialTenantId={ctx.tenantId} />;
}
