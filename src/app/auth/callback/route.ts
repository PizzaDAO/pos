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
  }

  // Safe-list the redirect to same-origin internal paths only.
  const safePath = redirectTo.startsWith("/") ? redirectTo : "/admin";
  return NextResponse.redirect(new URL(safePath, url.origin));
}
