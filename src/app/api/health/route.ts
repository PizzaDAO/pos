import { NextResponse } from "next/server";
import { resolveRequestId, traceResponseHeaders } from "@/lib/observability";

/**
 * Liveness endpoint — is the process up and serving? Cheap, dependency-free, and
 * always 200 with no env vars. Echoes the request id for trace continuity.
 */
export const runtime = "nodejs";

export function GET(request: Request) {
  const requestId = resolveRequestId(request.headers);
  return NextResponse.json(
    { ok: true, status: "live", time: new Date().toISOString(), requestId },
    { headers: traceResponseHeaders(requestId) },
  );
}
