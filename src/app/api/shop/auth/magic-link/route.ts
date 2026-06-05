/**
 * Magic-link request — POST /api/shop/auth/magic-link
 *
 * Body: { locationSlug, email, name? }. Creates/links a customer and mints a
 * SIMULATED magic-link token. No email is sent (no provider in scope) — the link
 * is returned in the response so the account-claim flow is demoable end-to-end.
 * A real impl would email the link and NOT return the token.
 *
 * No env vars required.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { requestMagicLink } from "@/lib/shop/auth";

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

  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin;
  const result = await requestMagicLink({
    tenantId: location.tenant_id,
    email: body.email,
    name: body.name ?? null,
    appUrl,
  });

  return NextResponse.json({
    customer: result.customer,
    // Simulated: a real impl emails this instead of returning it.
    simulated: true,
    magicLinkUrl: result.magicLinkUrl,
  });
}
