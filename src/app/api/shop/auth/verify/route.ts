/**
 * Magic-link verify — GET /api/shop/auth/verify?token=
 *
 * Consumes a (stubbed) magic-link token, verifying the customer, then redirects
 * back into the shop with a `verified` flag. No email/session infra in scope —
 * verification simply flips the customer's `verified` flag so a returning
 * customer can be recognized by email.
 */
import { NextResponse } from "next/server";
import { consumeMagicLink } from "@/lib/shop/auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const token = searchParams.get("token");
  if (!token) {
    return NextResponse.json({ error: "token is required." }, { status: 400 });
  }

  const customer = await consumeMagicLink(token);
  if (!customer) {
    return NextResponse.json(
      { error: "This link is invalid or has expired." },
      { status: 410 },
    );
  }

  // Redirect into the shop home with a confirmation flag (no slug context here,
  // so land on the generic shop entry — the customer is recognized by email).
  const url = new URL("/", origin);
  url.searchParams.set("verified", customer.email);
  return NextResponse.json({
    ok: true,
    customer: { id: customer.id, email: customer.email, verified: true },
    message: "Email verified. You can now sign in with this email.",
  });
}
