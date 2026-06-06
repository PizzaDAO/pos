/**
 * Customer magic-link request — POST /api/shop/auth/magic-link
 *
 * Body: { locationSlug, email, name? }. The /shop stays PUBLIC (guest checkout
 * never needs this); this lets a customer claim an OPTIONAL account so they can
 * sign in and see their orders.
 *
 * REAL MODE (Supabase auth configured): sends a REAL Supabase Auth magic link
 * (`signInWithOtp`) to the email; the link returns to /shop/<slug>?signedin=1.
 * We still ensure a per-tenant `customers` row so orders attribute correctly.
 * The token is NOT returned.
 *
 * SIMULATED MODE (no Supabase env): falls back to the legacy stub — mints a
 * never-emailed token and RETURNS the link so the flow stays demoable end-to-end.
 *
 * Env-guarded; builds/runs with zero env (stub path).
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { ensureCustomer, requestMagicLink } from "@/lib/shop/auth";
import {
  getServerSupabase,
  isSupabaseAuthConfigured,
} from "@/lib/auth/supabase-server";

export const runtime = "nodejs";

interface Body {
  locationSlug: string;
  email: string;
  name?: string;
}

function isValid(body: unknown): body is Body {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return typeof b.locationSlug === "string" && typeof b.email === "string";
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!isValid(body)) {
    return NextResponse.json({ error: "email is required." }, { status: 422 });
  }

  const driver = getPosDriver();
  const location = await driver.getLocationBySlug(body.locationSlug);
  if (!location) {
    return NextResponse.json({ error: "Location not found." }, { status: 404 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin;

  // ---- REAL MODE: send a genuine Supabase Auth magic link. ----
  if (isSupabaseAuthConfigured()) {
    const supabase = await getServerSupabase();
    if (supabase) {
      // Keep a per-tenant customer row so orders attribute to this email.
      const customer = await ensureCustomer({
        tenantId: location.tenant_id,
        email: body.email,
        name: body.name ?? null,
      });
      const redirectTo = `${appUrl.replace(/\/$/, "")}/shop/${location.slug}?signedin=1`;
      const { error } = await supabase.auth.signInWithOtp({
        email: body.email.trim(),
        options: { emailRedirectTo: redirectTo },
      });
      if (error) {
        return NextResponse.json(
          { error: "Could not send sign-in link." },
          { status: 502 },
        );
      }
      return NextResponse.json({ customer, simulated: false, sent: true });
    }
  }

  // ---- SIMULATED MODE: legacy stub (link returned, never emailed). ----
  const result = await requestMagicLink({
    tenantId: location.tenant_id,
    email: body.email,
    name: body.name ?? null,
    appUrl,
  });

  return NextResponse.json({
    customer: result.customer,
    simulated: true,
    magicLinkUrl: result.magicLinkUrl,
  });
}
