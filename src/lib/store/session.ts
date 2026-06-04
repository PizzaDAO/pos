import { create } from "zustand";

/**
 * Session store skeleton (Zustand).
 *
 * Phase 0: shape only — holds the active tenant/location context that scopes
 * every query and mutation in the app. Populated by the auth layer in a later
 * phase; for now it is a typed placeholder so call sites can be wired up.
 */
export type MembershipRole = "owner" | "manager" | "cashier" | "kitchen";

export interface SessionState {
  /** Currently selected tenant (pizzeria business) id, or null when unauthenticated. */
  tenantId: string | null;
  /** Currently selected location id within the tenant, or null. */
  locationId: string | null;
  /** The signed-in user's role within the active tenant, or null. */
  role: MembershipRole | null;
  /** Whether the signed-in user is a platform super-admin (outside tenant scope). */
  isPlatformAdmin: boolean;

  setTenant: (tenantId: string | null) => void;
  setLocation: (locationId: string | null) => void;
  setRole: (role: MembershipRole | null) => void;
  setPlatformAdmin: (isPlatformAdmin: boolean) => void;
  reset: () => void;
}

const initialState = {
  tenantId: null,
  locationId: null,
  role: null,
  isPlatformAdmin: false,
} as const;

export const useSessionStore = create<SessionState>((set) => ({
  ...initialState,
  setTenant: (tenantId) => set({ tenantId, locationId: null }),
  setLocation: (locationId) => set({ locationId }),
  setRole: (role) => set({ role }),
  setPlatformAdmin: (isPlatformAdmin) => set({ isPlatformAdmin }),
  reset: () => set({ ...initialState }),
}));
