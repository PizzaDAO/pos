/**
 * Readiness endpoint (Phase 7 observability).
 *
 * Liveness (`/api/health`) says "the process is up"; readiness says "the app's
 * dependencies are usable, so it can serve traffic". Today the only data
 * dependency is the driver (mock or, later, Supabase). We probe it with a cheap
 * call and report each dependency's status. It returns 200 when ready (the mock
 * driver is always ready, so the zero-env preview/CI is green) and 503 if a
 * future live dependency is unreachable.
 *
 * Also surfaces whether the deployment is in TRAINING/demo mode so operators can
 * tell a live store from a training one at a glance.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import { demoModeInfo } from "@/lib/demo/mode";
import {
  captureError,
  resolveRequestId,
  traceResponseHeaders,
} from "@/lib/observability";

export const runtime = "nodejs";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export async function GET(request: Request) {
  const requestId = resolveRequestId(request.headers);
  const checks: Check[] = [];

  // Driver probe: a trivial read proves the data layer is wired + responsive.
  try {
    const driver = getPosDriver();
    await driver.listTenants();
    checks.push({ name: "driver", ok: true, detail: driver.name });
  } catch (err) {
    captureError(err, { requestId, scope: "ready" });
    checks.push({
      name: "driver",
      ok: false,
      detail: err instanceof Error ? err.message : "unavailable",
    });
  }

  const ready = checks.every((c) => c.ok);
  const demo = demoModeInfo();
  return NextResponse.json(
    {
      ok: ready,
      status: ready ? "ready" : "not_ready",
      checks,
      trainingMode: demo.trainingMode,
      driver: demo.driver,
      time: new Date().toISOString(),
      requestId,
    },
    { status: ready ? 200 : 503, headers: traceResponseHeaders(requestId) },
  );
}
