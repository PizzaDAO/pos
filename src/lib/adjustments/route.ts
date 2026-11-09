/**
 * Shared request handling for the till's refund / void / comp endpoints
 * (`/api/orders/[id]/refund|void|discount`): rate limit, body + request id +
 * reason validation, the order's tenant authorizes the caller (never a
 * client-supplied tenant), the acting staff member, and the approval policy
 * bound to the location.
 */
import { NextResponse } from "next/server";
import { getPosDriver, type Order } from "@/lib/db";
import type { AdjustmentKind } from "@/lib/db/adjustment-types";
import { enforceRateLimit, isClientId, readJsonBody } from "@/lib/security";
import { authorizeAdjustment, loadPolicy, parseApproval, resolveTillActor } from "./authorize";
import { validateReason } from "./reasons";
import type { ActionInput } from "./service";

export interface PreparedAction {
  order: Order;
  body: Record<string, unknown>;
  input: ActionInput;
}

const REQUEST_ID_MAX = 64;

export async function prepareAction(
  request: Request,
  orderId: string,
  reasonKind: AdjustmentKind,
): Promise<{ ok: true; action: PreparedAction } | { ok: false; res: NextResponse }> {
  // Money moves / prices change: rate-limit like payments.
  const limited = enforceRateLimit(request, "payments");
  if (limited) return { ok: false, res: limited };
  const parsed = await readJsonBody(request);
  if (!parsed.ok) {
    return { ok: false, res: NextResponse.json({ error: parsed.error }, { status: parsed.status }) };
  }
  const body = (parsed.body ?? {}) as Record<string, unknown>;
  if (
    typeof body !== "object" ||
    !isClientId(body.requestId) ||
    (body.requestId as string).length > REQUEST_ID_MAX
  ) {
    return {
      ok: false,
      res: NextResponse.json({ error: "requestId is required (8-64 chars, A-Z a-z 0-9 _ -)." }, { status: 422 }),
    };
  }
  const reason = validateReason(reasonKind, body.reasonCode, body.reasonText);
  if (!reason.ok) {
    return { ok: false, res: NextResponse.json({ error: reason.error, code: "reason_required" }, { status: 422 }) };
  }
  let order: Order | null = null;
  try {
    order = await getPosDriver().getOrder(orderId);
  } catch {
    order = null;
  }
  if (!order) return { ok: false, res: NextResponse.json({ error: "Order not found." }, { status: 404 }) };
  const who = await resolveTillActor(request, order.tenant_id);
  if (!who.ok) return who;
  const approval = parseApproval(body.approval);
  if (body.approval !== undefined && body.approval !== null && !approval) {
    return {
      ok: false,
      res: NextResponse.json({ error: "Manager PIN incorrect.", code: "approval_pin_incorrect" }, { status: 401 }),
    };
  }
  const policy = await loadPolicy(order.tenant_id, order.location_id);
  const tenantId = order.tenant_id;
  const locationId = order.location_id;
  const actor = who.actor;
  return {
    ok: true,
    action: {
      order,
      body,
      input: {
        orderId: order.id,
        requestId: body.requestId as string,
        reason: { code: reason.code, text: reason.text },
        actor,
        authorize: (kind, amountCents, opts) =>
          authorizeAdjustment({
            request,
            tenantId,
            locationId,
            actor,
            policy,
            kind,
            amountCents,
            fired: opts?.fired,
            approval,
          }),
      },
    },
  };
}

/** Optional non-negative integer cents (undefined passes). */
export function optCents(v: unknown): v is number | undefined {
  return v === undefined || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 100_000_000);
}

/** `[{ lineId, quantity }]` from the body, or null when malformed. */
export function parseLineSelections(
  v: unknown,
  { quantityRequired }: { quantityRequired: boolean },
): { line_id: string; quantity?: number }[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > 100) return null;
  const out: { line_id: string; quantity?: number }[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.lineId !== "string" || !r.lineId || r.lineId.length > 64) return null;
    if (r.quantity === undefined) {
      if (quantityRequired) return null;
      out.push({ line_id: r.lineId });
      continue;
    }
    if (typeof r.quantity !== "number" || !Number.isSafeInteger(r.quantity) || r.quantity <= 0) {
      return null;
    }
    out.push({ line_id: r.lineId, quantity: r.quantity });
  }
  return out;
}

export function respond(result: { ok: true; body: Record<string, unknown> } | { ok: false; res: NextResponse }) {
  return result.ok ? NextResponse.json(result.body) : result.res;
}
