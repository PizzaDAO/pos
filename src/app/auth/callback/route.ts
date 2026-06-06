/**
 * Supabase Auth callback — GET /auth/callback?code=...&redirect=...
 *
 * The magic-link / OAuth redirect lands here; we exchange the `code` for a
 * session (cookies are set by the SSR server client) and then bounce to the
 * post-login destination. ENV-GUARDED: when Supabase auth isn't configured this
 * just redirects home (there is no real session to establish in mock mode).
 */
import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/auth/supabase-server";
import { getPosDriver } from "@/lib/db";
import { recordAudit } from "@/lib/security";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const redirectTo = url.searchParams.get("redirect") || "/admin";

  const supabase = await getServerSupabase();
  if (supabase && code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      const dest = new URL("/login", url.origin);
      dest.searchParams.set("error", "link_invalid");
      return NextResponse.redirect(dest);
    }

    // Audit the successful staff/admin sign-in, tenant-scoped per membership.
    // Platform admins with no tenant membership get a single null-tenant entry.
    // (Customer sign-ins — no membership, not admin — are not audited here.)
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        const driver = getPosDriver();
        const [memberships, isAdmin] = await Promise.all([
          driver.listMembershipsForUser(user.id),
          driver.isPlatformAdmin(user.id),
        ]);
        const label = user.email ?? user.id;
        if (memberships.length > 0) {
          for (const m of memberships) {
            await recordAudit({
              actor: { id: user.id, label },
              action: "auth_sign_in",
              tenantId: m.tenant_id,
              detail: `Signed in (role ${m.role}).`,
            });
          }
        } else if (isAdmin) {
          await recordAudit({
            actor: { id: user.id, label },
            action: "auth_sign_in",
            tenantId: null,
            detail: "Platform admin signed in.",
          });
        }
      }
    } catch {
      // Auditing must never block login — swallow.
    }
  }

  // Safe-list the redirect to same-origin internal paths only.
  const safePath = redirectTo.startsWith("/") ? redirectTo : "/admin";
  return NextResponse.redirect(new URL(safePath, url.origin));
}
