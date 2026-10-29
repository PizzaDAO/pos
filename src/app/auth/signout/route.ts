/**
 * Sign out — POST /auth/signout
 *
 * Ends the Supabase session (clears auth cookies) and redirects to the login.
 * ENV-GUARDED: a no-op redirect in simulated/mock mode (no real session). Used
 * by the "Sign out" control on every authenticated surface.
 */
import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/auth/supabase-server";
import { getCurrentUser } from "@/lib/auth/session";
import { getPosDriver } from "@/lib/db";
import {
  ACTIVE_STAFF_COOKIE,
  activeStaffCookieOptions,
} from "@/lib/auth/active-staff";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const url = new URL(request.url);
  const redirectTo = url.searchParams.get("redirect") || "/login";
  // Revoke every terminal staff session this device login opened, so a copied
  // active-staff cookie stops working the moment the device signs out.
  const user = await getCurrentUser().catch(() => null);
  if (user) {
    await getPosDriver()
      .revokeStaffSessionsForUser(user.id)
      .catch(() => null);
  }
  const supabase = await getServerSupabase();
  if (supabase) {
    await supabase.auth.signOut();
  }
  const safePath =
    redirectTo.startsWith("/") && !redirectTo.startsWith("//")
      ? redirectTo
      : "/login";
  const res = NextResponse.redirect(new URL(safePath, url.origin), {
    status: 303,
  });
  res.cookies.set(ACTIVE_STAFF_COOKIE, "", {
    ...activeStaffCookieOptions(),
    maxAge: 0,
  });
  return res;
}
