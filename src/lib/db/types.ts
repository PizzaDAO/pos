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
  /**
   * True when the PLATFORM suspended the tenant (set in the same write as the
   * status change). New tenants are also `suspended` until go-live, but with
   * this false — self-serve go-live is refused only when it is true.
   */
  suspended_by_platform?: boolean;
  created_at: string;
}

export interface Location {
  id: string;
  tenant_id: string;
  name: string;
  slug: string;
  timezone: string;
  address: string | null;
  created_at: string;
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
