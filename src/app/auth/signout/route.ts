/**
 * Sign out — POST /auth/signout
 *
 * Ends the Supabase session (clears auth cookies) and redirects to the login.
 * ENV-GUARDED: a no-op redirect in simulated/mock mode (no real session). Used
 * by the "Sign out" control on every authenticated surface.
 */
import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/auth/supabase-server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const url = new URL(request.url);
  const redirectTo = url.searchParams.get("redirect") || "/login";
  const supabase = await getServerSupabase();
  if (supabase) {
    await supabase.auth.signOut();
  }
  const safePath = redirectTo.startsWith("/") ? redirectTo : "/login";
  return NextResponse.redirect(new URL(safePath, url.origin), { status: 303 });
}
