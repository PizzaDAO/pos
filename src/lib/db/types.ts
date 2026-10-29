/**
 * Row types for the Phase 0 tenancy core. These mirror the SQL migrations under
 * `supabase/migrations/`. Later phases extend this (menu, orders, payments, ...).
 *
 * Kept hand-written for now; once a live Supabase project exists these can be
 * replaced/augmented by generated types (`supabase gen types typescript`).
 */

export type TenantStatus = "active" | "suspended" | "cancelled";

export type MembershipRole = "owner" | "manager" | "cashier" | "kitchen";

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  created_at: string;
}

export interface Location {
  id: string;
  tenant_id: string;
  name: string;
  slug: string;
  timezone: string;
  address: string | null;
  /** Structured address (core contract). All optional; `address` stays the display line. */
  address_line1?: string | null;
  address_line2?: string | null;
  city?: string | null;
  region?: string | null;
  postal_code?: string | null;
  country?: string | null;
  lat?: number | null;
  lng?: number | null;
  created_at: string;
}

/** Who owns inventory depletion for a tenant. */
export type InventoryOwner = "pos_basic" | "backofhouse";

/**
 * Per-tenant POS settings (own table so POS never alters the tenancy tables,
 * see POS-6). Absent row = defaults.
 */
export interface TenantSettings {
  tenant_id: string;
  /** `backofhouse` => POS stops depleting inventory on sale. */
  inventory_owner: InventoryOwner;
  updated_at: string;
}

export interface User {
  id: string;
  email: string;
  created_at: string;
}

export interface Membership {
  id: string;
  user_id: string;
  tenant_id: string;
  role: MembershipRole;
  created_at: string;
}

export interface PlatformAdmin {
  user_id: string;
  created_at: string;
}
