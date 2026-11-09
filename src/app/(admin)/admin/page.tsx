import type { Metadata } from "next";
import { cookies } from "next/headers";
import { AdminShell } from "./components/admin-shell";
import { AdminLock } from "./components/admin-lock";
import { requireAdmin } from "@/lib/auth/guard";
import {
  ADMIN_UNLOCK_COOKIE,
  adminGateRequired,
  resolveAdminUnlock,
} from "@/lib/auth/admin-gate";
import { isRealMode } from "@/lib/auth/signing-secret";

export const metadata: Metadata = {
  // Title intentionally avoids the literal "Back office" — the shell renders that
  // phrase and the e2e suite asserts it via a strict/substring getByText.
  title: "Tenant Dashboard",
  description: "Tenant dashboard: menu, inventory, reports, staff, billing.",
  robots: { index: false, follow: false },
};

/**
 * Tenant back office (Phase 5/6 + real-auth). This is now a SERVER component: it
 * gates entry to owner|manager of the active tenant (requireAdmin → redirects to
 * /login signed out, /forbidden without the role) and resolves the active tenant
 * FROM THE SESSION'S memberships (no hardcoded demo tenant). In simulated /
 * zero-env mode the session is the seeded demo owner, so /admin stays usable
 * with no config. The resolved tenant is handed to the client shell; an explicit
 * ?tenant= (audited platform impersonation) still overrides on the client.
 *
 * Back-office PIN gate (src/lib/auth/admin-gate.ts): once the tenant has an
 * owner/manager PIN, the shell renders only behind a fresh (10-minute) owner or
 * manager PIN unlock. The server enforces the same gate on every /api/admin/*
 * route; AdminLock only decides what to show.
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
  const [required, unlock] = await Promise.all([
    adminGateRequired(ctx.tenantId),
    (async () =>
      resolveAdminUnlock(
        (await cookies()).get(ADMIN_UNLOCK_COOKIE)?.value,
        ctx.tenantId,
        ctx.user.id,
      ))(),
  ]);
  return (
    <AdminLock
      tenantId={ctx.tenantId}
      initial={{
        required,
        nudge: !required && isRealMode(),
        staff: unlock
          ? {
              id: unlock.staff.id,
              name: unlock.staff.name,
              role: unlock.staff.role,
            }
          : null,
        expiresAt: unlock?.expiresAt ?? null,
      }}
    >
      <AdminShell initialTenantId={ctx.tenantId} />
    </AdminLock>
  );
}
