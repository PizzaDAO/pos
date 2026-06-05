/**
 * Customer auth stub (Phase 4) — guest checkout + a SIMULATED magic-link account.
 *
 * No real email is ever sent (no email provider in scope). `requestMagicLink`
 * creates/links a customer for the (tenant, email) and mints a token; instead of
 * emailing it, the API returns the magic-link URL directly so the flow is
 * demoable end-to-end. `consumeMagicLink` verifies the customer. A real impl
 * would email the link and never expose the token in the response.
 *
 * Guest checkout simply upserts a customer with `verified: false`; ordering does
 * NOT require verification.
 */
import { getPosDriver } from "@/lib/db";
import type { Customer } from "@/lib/db";

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const TOKEN_TTL_MS = 30 * 60_000; // 30 minutes

/** Upsert a (guest) customer for the tenant by email. Idempotent on email. */
export async function ensureCustomer(input: {
  tenantId: string;
  email: string;
  name?: string | null;
  phone?: string | null;
}): Promise<Customer> {
  const driver = getPosDriver();
  const now = new Date().toISOString();
  return driver.upsertCustomer({
    id: newId(),
    tenant_id: input.tenantId,
    email: input.email,
    name: input.name ?? null,
    phone: input.phone ?? null,
    verified: false,
    created_at: now,
    updated_at: now,
  });
}

export interface MagicLinkResult {
  customer: Customer;
  token: string;
  /** The link a real impl would EMAIL; returned here so the flow is demoable. */
  magicLinkUrl: string;
}

/**
 * Create-or-link a customer and mint a (never-emailed) magic-link token. Returns
 * the link so the stub can surface it directly in the UI.
 */
export async function requestMagicLink(input: {
  tenantId: string;
  email: string;
  name?: string | null;
  appUrl: string;
}): Promise<MagicLinkResult> {
  const driver = getPosDriver();
  const customer = await ensureCustomer({
    tenantId: input.tenantId,
    email: input.email,
    name: input.name,
  });
  const token = newId().replace(/-/g, "");
  const now = new Date();
  await driver.createMagicLinkToken({
    token,
    tenant_id: input.tenantId,
    email: customer.email,
    customer_id: customer.id,
    expires_at: new Date(now.getTime() + TOKEN_TTL_MS).toISOString(),
    consumed: false,
    created_at: now.toISOString(),
  });
  const base = input.appUrl.replace(/\/$/, "");
  return {
    customer,
    token,
    magicLinkUrl: `${base}/api/shop/auth/verify?token=${token}`,
  };
}

/** Consume a magic-link token, verifying the customer. */
export async function consumeMagicLink(
  token: string,
): Promise<Customer | null> {
  const driver = getPosDriver();
  return driver.consumeMagicLinkToken(token);
}
