/**
 * Star CloudPRNT endpoint. Point the printer's CloudPRNT "Server URL" at
 * `https://<host>/api/print/star/<token>` (shown once in Admin > Printers).
 *
 *   POST    poll (printer -> server, JSON status)
 *   GET     ?token=<jobToken>  job body (Star markup or plain text)
 *   DELETE  ?token=<jobToken>&code=<status>  confirm; idempotent
 *
 * Authenticated by the path token alone (devices have no session). See
 * `src/lib/printing/protocols.ts`.
 */
import { NextResponse } from "next/server";
import { starConfirm, starGetJob, starPoll, type DeviceResponse } from "@/lib/printing/protocols";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function respond(r: DeviceResponse): NextResponse {
  return new NextResponse(r.body ?? null, {
    status: r.status,
    headers: {
      "Cache-Control": "no-store",
      ...(r.contentType ? { "Content-Type": r.contentType } : {}),
    },
  });
}

type Ctx = { params: Promise<{ token: string }> };

export async function POST(_req: Request, { params }: Ctx) {
  return respond(await starPoll((await params).token));
}

export async function GET(req: Request, { params }: Ctx) {
  const q = new URL(req.url).searchParams;
  return respond(await starGetJob((await params).token, q.get("token")));
}

export async function DELETE(req: Request, { params }: Ctx) {
  const q = new URL(req.url).searchParams;
  return respond(await starConfirm((await params).token, q.get("token"), q.get("code")));
}
