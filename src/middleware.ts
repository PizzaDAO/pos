/**
 * Next.js middleware — Supabase Auth session refresh + coarse route gating.
 *
 * Responsibilities (REAL MODE, Supabase env present):
 *   1. Refresh the auth session on every matched request (rotates the cookie so
 *      it never silently expires) via `@supabase/ssr`.
 *   2. Coarse gate: redirect UNAUTHENTICATED visitors away from protected
 *      surfaces to the right login (/login for tenant apps, /platform/login for
 *      the super-admin). Authoritative ROLE checks (owner|manager etc.) happen
 *      in each route's server component against the session's memberships —
 *      middleware only checks presence of a session here.
 *
 * SIMULATED MODE (no Supabase env — the zero-env / CI / local default):
 *   The Supabase client is null, there is no cookie to refresh, and the app runs
 *   with a simulated "logged-in" demo session, so middleware is a pass-through.
 *   This is what keeps the build + the full test suite green with no env.
 *
 * /shop stays PUBLIC and is never matched. Lazy env read; no throw on unset.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getMiddlewareSupabase } from "@/lib/auth/supabase-server";

/** Path prefixes that require an authenticated session (coarse gate). */
const TENANT_PROTECTED = ["/admin", "/terminal", "/kitchen"];
const PLATFORM_PROTECTED = ["/platform"];
// Login + auth-callback routes must stay reachable while signed out.
const PLATFORM_ALLOW = ["/platform/login"];

function startsWithAny(pathname: string, prefixes: string[]): boolean {
  return prefixes.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

export async function middleware(req: NextRequest) {
  const res = NextResponse.next({ request: { headers: req.headers } });

  const supabase = getMiddlewareSupabase(req, res);
  // SIMULATED MODE: no Supabase env → no real auth → pass through untouched.
  if (!supabase) return res;

  // Refresh the session (writes rotated cookies onto `res`).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = req.nextUrl;

  // Platform surface: must be signed in (platform-admin role checked in-route).
  if (
    startsWithAny(pathname, PLATFORM_PROTECTED) &&
    !startsWithAny(pathname, PLATFORM_ALLOW)
  ) {
    if (!user) {
      const url = req.nextUrl.clone();
      url.pathname = "/platform/login";
      url.searchParams.set("redirect", pathname);
      return NextResponse.redirect(url);
    }
    return res;
  }

  // Tenant surfaces: must be signed in (role checked in-route).
  if (startsWithAny(pathname, TENANT_PROTECTED)) {
    if (!user) {
      const url = req.nextUrl.clone();
      url.pathname = "/login";
      url.searchParams.set("redirect", pathname);
      return NextResponse.redirect(url);
    }
  }

  return res;
}

export const config = {
  // Run on the protected surfaces only. /shop, /, /api, static assets excluded
  // so public browsing + the mock-mode app are never touched.
  matcher: ["/admin/:path*", "/terminal/:path*", "/kitchen/:path*", "/platform/:path*"],
};
