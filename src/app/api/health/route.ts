import { NextResponse } from "next/server";

/** Liveness/health endpoint. Returns 200 with a static body — no env vars required. */
export const dynamic = "force-static";

export function GET() {
  return NextResponse.json({ ok: true });
}
