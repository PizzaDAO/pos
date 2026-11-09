/**
 * Epson Server Direct Print endpoint. Set the printer's Server Direct Print URL
 * to `https://<host>/api/print/epson/<token>` (shown once in Admin > Printers).
 * The printer POSTs form data (`ConnectionType=GetRequest` to poll,
 * `SetResponse` to report the result). See `src/lib/printing/protocols.ts`.
 */
import { NextResponse } from "next/server";
import { epsonRequest } from "@/lib/printing/protocols";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const raw = await req.text();
  const r = await epsonRequest((await params).token, raw.slice(0, 200_000));
  return new NextResponse(r.body ?? null, {
    status: r.status,
    headers: {
      "Cache-Control": "no-store",
      ...(r.contentType ? { "Content-Type": r.contentType } : {}),
    },
  });
}
