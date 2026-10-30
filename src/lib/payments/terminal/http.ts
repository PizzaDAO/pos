/**
 * Shared route helpers for the card-reader API: authorization against a
 * (tenant, location) pair, and mapping flow errors to HTTP responses.
 */
import { NextResponse } from "next/server";
import { getPosDriver } from "@/lib/db";
import type { Location, MembershipRole, Payment } from "@/lib/db";
import { requireTenantRole } from "@/lib/auth/api";
import { captureError } from "@/lib/observability";
import { CardPaymentsNotReadyError } from "../connect";
import { LiveKeyOutsideProductionError } from "../env";
import { StripeError } from "../providers/stripe-client";
import { publicTender } from "../public";
import { PaymentConflictError, getOrderBalance } from "../service";
import { LiveTenderConflictError } from "@/lib/db/payment-types";
import { TerminalFlowError } from "./flow";
import {
  TerminalAddressRequiredError,
  TerminalLocationNotFoundError,
} from "./locations";
import { ReaderNotFoundError, ReaderRegistrationError } from "./readers";

/** In-store card work: the same roles that may take a till payment. */
export const TILL_ROLES: MembershipRole[] = ["owner", "manager", "cashier"];
/** Reader administration: owner or manager. */
export const ADMIN_ROLES: MembershipRole[] = ["owner", "manager"];

/**
 * Authorize `roles` on `tenantId` and check `locationId` really belongs to that
 * tenant (a caller could otherwise name another tenant's location).
 */
export async function authorizeLocation(
  tenantId: unknown,
  locationId: unknown,
  roles: MembershipRole[],
): Promise<
  | { ok: true; tenantId: string; location: Location }
  | { ok: false; res: NextResponse }
> {
  if (typeof tenantId !== "string" || typeof locationId !== "string" || !tenantId || !locationId) {
    return {
      ok: false,
      res: NextResponse.json({ error: "tenantId and locationId are required." }, { status: 400 }),
    };
  }
  const auth = await requireTenantRole(tenantId, roles);
  if (!auth.ok) return auth;
  const location = (await getPosDriver().listLocations(tenantId)).find(
    (l) => l.id === locationId,
  );
  if (!location) {
    return { ok: false, res: NextResponse.json({ error: "Location not found." }, { status: 404 }) };
  }
  return { ok: true, tenantId, location };
}

/**
 * Load a card tender and authorize `roles` against ITS tenant (never a
 * client-supplied one). A malformed/unknown id is a clean 404.
 */
export async function authorizeTender(
  paymentId: string,
  roles: MembershipRole[],
): Promise<
  | { ok: true; payment: Payment }
  | { ok: false; res: NextResponse }
> {
  let payment: Payment | null = null;
  try {
    payment = await getPosDriver().getPayment(paymentId);
  } catch {
    payment = null;
  }
  if (!payment || payment.rail !== "stripe_terminal") {
    return { ok: false, res: NextResponse.json({ error: "Payment not found." }, { status: 404 }) };
  }
  const auth = await requireTenantRole(payment.tenant_id, roles);
  if (!auth.ok) return auth;
  return { ok: true, payment };
}

/** The `{ payment, balanceCents, orderStatus }` body every tender route returns. */
export async function tenderResponseBody(
  payment: Payment,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const order = await getPosDriver().getOrder(payment.order_id);
  return {
    payment: publicTender(payment),
    balanceCents: order ? await getOrderBalance(order) : 0,
    orderStatus: order?.status,
    ...extra,
  };
}

/** Map a thrown error to a JSON response; unknown errors are 502 (provider) with their message. */
export function errorResponse(err: unknown, fallback = "Card payment failed."): NextResponse {
  if (err instanceof TerminalFlowError) {
    return NextResponse.json(
      {
        error: err.message,
        code: err.code,
        payment: err.payment ? publicTender(err.payment) : undefined,
      },
      { status: err.status },
    );
  }
  if (
    err instanceof CardPaymentsNotReadyError ||
    err instanceof PaymentConflictError ||
    err instanceof LiveTenderConflictError
  ) {
    return NextResponse.json({ error: err.message }, { status: 409 });
  }
  if (err instanceof TerminalAddressRequiredError) {
    return NextResponse.json({ error: err.message, code: "address_required" }, { status: 422 });
  }
  if (err instanceof ReaderRegistrationError) {
    return NextResponse.json({ error: err.message }, { status: 422 });
  }
  if (err instanceof ReaderNotFoundError || err instanceof TerminalLocationNotFoundError) {
    return NextResponse.json({ error: err.message }, { status: 404 });
  }
  if (err instanceof LiveKeyOutsideProductionError) {
    return NextResponse.json({ error: err.message }, { status: 409 });
  }
  if (err instanceof StripeError) {
    // Stripe's message is shown to staff (e.g. an invalid pairing code).
    captureError(err, { scope: "terminal-route", code: err.code });
    return NextResponse.json(
      { error: err.message || fallback, code: err.code ?? undefined },
      { status: err.status >= 400 && err.status < 500 ? 422 : 502 },
    );
  }
  captureError(err, { scope: "terminal-route" });
  return NextResponse.json(
    { error: err instanceof Error ? err.message : fallback },
    { status: 502 },
  );
}
