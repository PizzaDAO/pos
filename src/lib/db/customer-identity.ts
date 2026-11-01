/**
 * `customers.upsert` identity rules, as pure functions over a tenant's customers.
 *
 * The Supabase driver runs the same rules in ONE transaction in
 * `public.core_upsert_customer` (supabase/migrations/20261106000200); the mock
 * driver calls {@link applyCustomerIdentity}. Keep the two in step.
 *
 *   - match by email (case-insensitive), else by normalised phone;
 *   - NEVER merge two customers: a phone that belongs to someone with a
 *     different email is not attached to the new email's customer;
 *   - only FILL blanks (name, phone, email); `verified` is never touched;
 *   - consent changes only with an `at`, and an older `at` never beats a newer;
 *   - tags union; existing external ids win, new keys are added.
 */
import type { Customer, CustomerConsent, CustomerIdentityWrite } from "./customer-types";

/**
 * Comparison key for a phone: digits only, a leading NANP "1" dropped, shorter
 * than 7 digits = no key (mirrors `public.core_phone_key`).
 */
export function phoneKey(phone: string | null | undefined): string | null {
  const d = (phone ?? "").replace(/[^0-9]/g, "");
  if (d.length < 7) return null;
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
}

export function normaliseEmail(email: string | null | undefined): string | null {
  const e = (email ?? "").trim().toLowerCase();
  return e || null;
}

function sortedUnique(xs: string[]): string[] {
  return [...new Set(xs)].sort();
}

function mergeConsent(
  current: Customer["marketing"],
  incoming: CustomerIdentityWrite["marketing"],
): NonNullable<Customer["marketing"]> {
  const out: NonNullable<Customer["marketing"]> = { ...(current ?? {}) };
  for (const ch of ["email", "sms"] as const) {
    const next: CustomerConsent | undefined = incoming[ch];
    if (!next?.at) continue; // consent without evidence is never stored
    const prev = out[ch];
    if (!prev?.at || Date.parse(next.at) >= Date.parse(prev.at)) out[ch] = next;
  }
  return out;
}

export interface IdentityResult {
  /** The customer after the write (the stored row, or the new one). */
  customer: Customer;
  created: boolean;
  /** False when nothing changed (the caller writes nothing, no event). */
  changed: boolean;
}

/**
 * Decide the write for `input` against `tenantCustomers` (ALL of one tenant's
 * customers). Pure: the caller persists `customer` when `created || changed`.
 */
export function applyCustomerIdentity(
  tenantId: string,
  tenantCustomers: readonly Customer[],
  input: CustomerIdentityWrite,
  now: string,
): IdentityResult {
  const email = normaliseEmail(input.email);
  const phone = input.phone?.trim() || null;
  const pkey = phoneKey(phone);
  const mine = tenantCustomers.filter((c) => c.tenant_id === tenantId);

  let found = email ? (mine.find((c) => c.email === email) ?? null) : null;
  let phoneTaken = false;
  if (!found && pkey) {
    const byPhone = mine
      .filter((c) => c.phone && phoneKey(c.phone) === pkey)
      .sort(
        (a, b) =>
          Number(a.email === null) - Number(b.email === null) ||
          a.created_at.localeCompare(b.created_at) ||
          a.id.localeCompare(b.id),
      )[0];
    if (byPhone) {
      if (email && byPhone.email && byPhone.email !== email) phoneTaken = true;
      else found = byPhone;
    }
  }

  if (!found) {
    return {
      created: true,
      changed: true,
      customer: {
        id: input.newId,
        tenant_id: tenantId,
        email,
        phone: phoneTaken ? null : phone,
        name: input.name?.trim() || null,
        verified: false,
        marketing: mergeConsent(undefined, input.marketing),
        tags: sortedUnique(input.tags),
        external_ids: { ...input.externalIds },
        created_at: now,
        updated_at: now,
      },
    };
  }

  const phoneFree =
    pkey !== null &&
    !mine.some((c) => c.id !== found.id && c.phone && phoneKey(c.phone) === pkey);
  const next: Customer = {
    ...found,
    email: found.email ?? email,
    name: found.name?.trim() ? found.name : input.name?.trim() || null,
    phone: found.phone ?? (phone && phoneFree ? phone : null),
    marketing: mergeConsent(found.marketing, input.marketing),
    tags: sortedUnique([...(found.tags ?? []), ...input.tags]),
    external_ids: { ...input.externalIds, ...(found.external_ids ?? {}) },
  };
  const changed =
    next.email !== found.email ||
    next.name !== found.name ||
    next.phone !== found.phone ||
    JSON.stringify(next.marketing) !== JSON.stringify(found.marketing ?? {}) ||
    JSON.stringify(next.tags) !== JSON.stringify(found.tags ?? []) ||
    JSON.stringify(sortKeys(next.external_ids)) !==
      JSON.stringify(sortKeys(found.external_ids ?? {}));
  return {
    created: false,
    changed,
    customer: changed ? { ...next, updated_at: now } : found,
  };
}

function sortKeys(o: Record<string, string> | undefined): [string, string][] {
  return Object.entries(o ?? {}).sort(([a], [b]) => a.localeCompare(b));
}
