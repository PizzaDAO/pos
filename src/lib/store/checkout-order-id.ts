/**
 * One order id per checkout.
 *
 * Every Pay click used to mint a NEW order id, so a retry, a reload or a 3DS
 * return created a second order. Instead the client mints the id once per
 * checkout and keeps it in `sessionStorage`, keyed by a signature of what is
 * being bought (cart + fulfillment + customer email + tip). Retries, reloads and
 * returns from a payment provider reuse the id, so the server sees the same order
 * and the same (derived) tender. A MATERIAL change (different cart, address,
 * time, tip...) is a different checkout: a new id is minted and the previous
 * unpaid order is handed back so the caller can cancel it best-effort.
 *
 * Pure over an injected `Storage` so it is unit-testable; all storage access is
 * try/catch'd (private mode, blocked storage) and degrades to a fresh id per call.
 */
import type { DeliveryAddress, OrderItem } from "@/lib/db";

const KEY_PREFIX = "openpizza.checkout.";

export interface CheckoutSignatureInput {
  /**
   * The storefront key — `storefrontKey({ tenantSlug, locationSlug })` — used
   * both as the storage key and inside the signature, so two tenants'
   * same-slug locations never share (or supersede) a checkout.
   */
  slug: string;
  items: OrderItem[];
  fulfillmentType: "pickup" | "delivery";
  scheduledFor: string;
  address?: DeliveryAddress;
  email: string;
  /** Contact + notes are part of the order the server stores, so a change is a new checkout. */
  name?: string;
  phone?: string;
  notes?: string;
  deliveryNotes?: string;
  tipCents: number;
}

/** Stable string describing the checkout's material inputs. */
export function checkoutSignature(input: CheckoutSignatureInput): string {
  const lines = input.items.map((i) => [
    i.item_id,
    i.size_id ?? "",
    i.quantity,
    i.notes ?? "",
    i.modifiers
      .map((m) => `${m.modifier_id}:${m.placement}`)
      .sort()
      .join(","),
  ]);
  const addr = input.address
    ? [
        input.address.line1,
        input.address.line2 ?? "",
        input.address.city,
        input.address.region,
        input.address.postal_code,
      ]
    : [];
  return fnv1a(
    JSON.stringify([
      input.slug,
      lines,
      input.fulfillmentType,
      input.scheduledFor,
      addr,
      input.email.trim().toLowerCase(),
      (input.name ?? "").trim(),
      (input.phone ?? "").trim(),
      (input.notes ?? "").trim(),
      (input.deliveryNotes ?? "").trim(),
      input.tipCents,
    ]),
  );
}

/** 32-bit FNV-1a, hex. Collisions only matter within one browser session. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

interface Stored {
  sig: string;
  id: string;
}

function read(storage: Storage | null, slug: string): Stored | null {
  try {
    const raw = storage?.getItem(KEY_PREFIX + slug);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Stored>;
    return typeof v.sig === "string" && typeof v.id === "string"
      ? { sig: v.sig, id: v.id }
      : null;
  } catch {
    return null;
  }
}

function write(storage: Storage | null, slug: string, v: Stored | null): void {
  try {
    if (v) storage?.setItem(KEY_PREFIX + slug, JSON.stringify(v));
    else storage?.removeItem(KEY_PREFIX + slug);
  } catch {
    // storage unavailable: the checkout still works, retries just mint new ids.
  }
}

export function defaultCheckoutStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/**
 * The order id for this checkout. `superseded` is the previous unpaid order id
 * when the checkout materially changed (cancel it best-effort).
 */
export function getCheckoutOrderId(
  input: CheckoutSignatureInput,
  newId: () => string,
  storage: Storage | null = defaultCheckoutStorage(),
): { id: string; superseded: string | null } {
  const sig = checkoutSignature(input);
  const stored = read(storage, input.slug);
  if (!stored) {
    // Migrate an entry written by a build that keyed by the location slug
    // alone (a customer mid-checkout across the deploy).
    const legacy = legacyKeyOf(input.slug);
    const old = legacy ? read(storage, legacy) : null;
    if (legacy && old) {
      write(storage, legacy, null);
      if (old.sig === checkoutSignature({ ...input, slug: legacy })) {
        // The same checkout: keep its order id under the new key.
        write(storage, input.slug, { sig, id: old.id });
        return { id: old.id, superseded: null };
      }
      // A different checkout: drop it but never supersede (cancel) it. A
      // slug-only entry can't prove which tenant it belonged to, so it may be
      // another tenant's unpaid order; the sweeper abandons it after its window.
    }
  }
  if (stored && stored.sig === sig) return { id: stored.id, superseded: null };
  const id = newId();
  write(storage, input.slug, { sig, id });
  return { id, superseded: stored?.id ?? null };
}

/**
 * Forget the stored id (paid, cancelled, or the server said it is abandoned).
 * Also clears a legacy slug-only entry for the same storefront, so a paid or
 * cancelled order from before the re-key can't resurface as "superseded".
 */
export function forgetCheckoutOrderId(
  key: string,
  storage: Storage | null = defaultCheckoutStorage(),
): void {
  write(storage, key, null);
  const legacy = legacyKeyOf(key);
  if (legacy) write(storage, legacy, null);
}

/**
 * The pre-re-key storage key for a storefront key (`tenant/location` →
 * `location`): earlier builds keyed by the location slug alone. Slugs never
 * contain `/`.
 */
function legacyKeyOf(key: string): string | null {
  const i = key.lastIndexOf("/");
  return i > 0 && i < key.length - 1 ? key.slice(i + 1) : null;
}
