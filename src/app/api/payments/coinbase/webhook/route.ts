/**
 * Coinbase Commerce webhook handler (Phase 2).
 *
 * POST /api/payments/coinbase/webhook — receives charge lifecycle events
 * (charge:confirmed / charge:resolved / charge:failed) and updates the matching
 * tender's status via the DB abstraction, then marks the order paid if covered.
 * The raw body signature (`X-CC-Webhook-Signature`) is verified with
 * COINBASE_COMMERCE_WEBHOOK_SECRET when present; with no secret the handler is a
 * no-op (200) so the route is harmless in the preview.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import type { PaymentStatus } from "@/lib/db";
import {
  mapCoinbaseStatus,
  verifyCoinbaseWebhook,
} from "@/lib/payments/providers/coinbase-client";
import { isCoinbaseConfigured } from "@/lib/payments/env";
import { refreshPaymentStatus } from "@/lib/payments/service";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const rawBody = await request.text();

  if (!isCoinbaseConfigured()) {
    return NextResponse.json({ received: true, simulated: true });
  }

  const signature = request.headers.get("x-cc-webhook-signature");
  if (!verifyCoinbaseWebhook(rawBody, signature)) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  let event: {
    event?: { type?: string; data?: { id?: string; timeline?: { status: string }[] } };
  };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const chargeId = event.event?.data?.id;
  if (!chargeId) return NextResponse.json({ received: true });

  const last = event.event?.data?.timeline?.at(-1)?.status;
  const mapped: PaymentStatus = mapCoinbaseStatus(last);

  const driver = getPosDriver();
  const matched = await driver.getPaymentByChargeId(chargeId);
  if (matched) {
    await driver.upsertPayment({ ...matched, status: mapped });
    await refreshPaymentStatus(matched.id);
  }

  return NextResponse.json({ received: true });
}
