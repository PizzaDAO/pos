/**
 * Storefront data hook (Phase 4). Loads the resolved location + menu + store
 * settings (incl. fulfillment) + payment settings from `/api/shop/location` via
 * TanStack Query, keyed by the storefront's (tenant slug, location slug) pair.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import type {
  Location,
  Menu,
  PaymentSettings,
  StoreSettings,
} from "@/lib/db";
import type { StorefrontRef } from "@/lib/shop/storefront";

export interface ShopResponse {
  location: Location;
  menu: Menu;
  settings: StoreSettings;
  paymentSettings: PaymentSettings;
  /** Online rails the customer can pay with right now (server-decided). */
  onlineRails?: string[];
  driver: string;
}

export function useShop(store: StorefrontRef) {
  return useQuery<ShopResponse>({
    queryKey: ["shop", store.tenantSlug, store.locationSlug],
    queryFn: async () => {
      const res = await fetch(
        `/api/shop/location?tenant=${encodeURIComponent(store.tenantSlug)}&location=${encodeURIComponent(store.locationSlug)}`,
        { cache: "no-store" },
      );
      if (!res.ok) throw new Error(`Failed to load shop (HTTP ${res.status})`);
      return (await res.json()) as ShopResponse;
    },
    staleTime: 60_000,
  });
}
