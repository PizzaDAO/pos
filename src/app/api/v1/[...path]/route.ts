/**
 * Open Pizza `/v1` API (POS as commerce source). All logic lives in
 * `@/lib/core/v1`; this file only adapts Next route handlers to it.
 * Auth is a hub-issued bearer JWT (see `@/lib/core/auth`), NOT a browser session.
 */
import { handleV1 } from "@/lib/core/v1";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ path: string[] }> };

async function handle(req: Request, ctx: Ctx): Promise<Response> {
  const { path } = await ctx.params;
  return handleV1(req, path ?? []);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
