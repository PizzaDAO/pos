/**
 * `customers.upsert` identity rules, as pure functions over a tenant's customers.
 *
 * The Supabase driver runs the same rules in ONE transaction in
 * `public.core_upsert_customer` (supabase/migrations/20261106000200); the mock
 * driver calls {@link applyCustomerIdentity}. Keep the two in step.
 *
 * ORDINARY mode:
 *   - match by email (case-insensitive), else by normalised phone (a verified
 *     phone first);
 *   - NEVER merge two customers: a phone that belongs to someone with a different
 *     email is not attached to the new email's customer, and an email is never
 *     attached to a row whose phone/email is verified;
 *   - only FILL blanks, and never a contact onto a row that has a verified contact
 *     (planting a contact there must never make the row reachable by a one-time
 *     code); never sets verified state;
 *   - consent changes only with an `at` (a future `at` is clamped to now, an older
 *     `at` never beats a newer) and only for a contact that ended up attached;
 *   - tags union; existing external ids win, new keys are added.
 *
 * OTP mode (`verifiedContact`): only the proven contact is used. Phone: matches
 * ONLY a row whose phone is already verified, otherwise a NEW row. Email: the row
 * holding that email (one per tenant) is the row. The proven contact is stamped
 * verified.
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

/** True when the row has a proven contact (the legacy `verified` stub does not count). */
export function hasVerifiedContact(c: Pick<Customer, "email_verified_at" | "phone_verified_at">): boolean {
  return Boolean(c.email_verified_at || c.phone_verified_at);
}

function mergeConsent(
  current: Customer["marketing"],
  incoming: CustomerIdentityWrite["marketing"],
  attached: { email: boolean; sms: boolean },
  now: string,
): NonNullable<Customer["marketing"]> {
  const out: NonNullable<Customer["marketing"]> = { ...(current ?? {}) };
  for (const ch of ["email", "sms"] as const) {
    let next: CustomerConsent | undefined = incoming[ch];
    if (!next?.at || !attached[ch]) continue; // no evidence, or the contact is not on the row
    if (Date.parse(next.at) > Date.parse(now)) next = { ...next, at: now };
    const prev = out[ch];
    if (!prev?.at || Date.parse(next.at!) >= Date.parse(prev.at)) out[ch] = next;
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
  const vc = input.verifiedContact;
  const email = vc === "phone" ? null : normaliseEmail(input.email);
  const phone = vc === "email" ? null : input.phone?.trim() || null;
  const pkey = phoneKey(phone);
  const mine = tenantCustomers.filter((c) => c.tenant_id === tenantId);
  if (!email && !phone) throw new Error("email or phone is required");

  const blank = (): Customer => ({
    id: input.newId,
    tenant_id: tenantId,
    email: null,
    phone: null,
    name: null,
    verified: false,
    marketing: {},
    tags: [],
    external_ids: {},
    email_verified_at: null,
    phone_verified_at: null,
    created_at: now,
    updated_at: now,
  });

  // ------------------------------------------------------------------ OTP mode
  if (vc === "email") {
    const row = mine.find((c) => c.email === email);
    if (row) {
      if (row.email_verified_at) return { customer: row, created: false, changed: false };
      return {
        customer: { ...row, email_verified_at: now, verified: true, updated_at: now },
        created: false,
        changed: true,
      };
    }
    return {
      customer: { ...blank(), email, email_verified_at: now, verified: true },
      created: true,
      changed: true,
    };
  }
  if (vc === "phone") {
    if (!pkey) throw new Error("the verified phone has no usable digits");
    const row = mine
      .filter((c) => c.phone && c.phone_verified_at && phoneKey(c.phone) === pkey)
      .sort(
        (a, b) =>
          a.phone_verified_at!.localeCompare(b.phone_verified_at!) || a.id.localeCompare(b.id),
      )[0];
    if (row) return { customer: row, created: false, changed: false };
    // Nothing verified holds this phone: a NEW row, never an unverified one.
    return {
      customer: { ...blank(), phone, phone_verified_at: now, verified: true },
      created: true,
      changed: true,
    };
  }

  // ------------------------------------------------------------- ordinary mode
  let found = email ? (mine.find((c) => c.email === email) ?? null) : null;
  let phoneTaken = false;
  if (!found && pkey) {
    const byPhone = mine
      .filter((c) => c.phone && phoneKey(c.phone) === pkey)
      .sort(
        (a, b) =>
          Number(!a.phone_verified_at) - Number(!b.phone_verified_at) ||
          Number(a.email === null) - Number(b.email === null) ||
          a.created_at.localeCompare(b.created_at) ||
          a.id.localeCompare(b.id),
      )[0];
    if (byPhone) {
      const frozen = hasVerifiedContact(byPhone);
      if (
        email &&
        ((byPhone.email && byPhone.email !== email) || (byPhone.email === null && frozen))
      ) {
        phoneTaken = true;
      } else {
        found = byPhone;
      }
    }
  }

  if (!found) {
    const newPhone = phoneTaken ? null : phone;
    return {
      created: true,
      changed: true,
      customer: {
        ...blank(),
        email,
        phone: newPhone,
        name: input.name?.trim() || null,
        marketing: mergeConsent(undefined, input.marketing, { email: !!email, sms: !!newPhone }, now),
        tags: sortedUnique(input.tags),
        external_ids: { ...input.externalIds },
      },
    };
  }

  const frozen = hasVerifiedContact(found);
  const phoneFree =
    pkey !== null &&
    !mine.some((c) => c.id !== found.id && c.phone && phoneKey(c.phone) === pkey);
  const nextEmail = frozen ? found.email : (found.email ?? email);
  const nextPhone = found.phone ?? (phone && phoneFree && !frozen ? phone : null);
  const next: Customer = {
    ...found,
    email: nextEmail,
    name: found.name?.trim() ? found.name : input.name?.trim() || null,
    phone: nextPhone,
    marketing: mergeConsent(
      found.marketing,
      input.marketing,
      {
        email: !!email && nextEmail === email,
        sms: !!phone && !!nextPhone && (nextPhone === phone || phoneKey(nextPhone) === pkey),
      },
      now,
    ),
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
