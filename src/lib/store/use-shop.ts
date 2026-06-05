/**
 * Storefront data hook (Phase 4). Loads the resolved location + menu + store
 * settings (incl. fulfillment) + payment settings from `/api/shop/location` via
 * TanStack Query, keyed by the public location slug.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import type {
  Location,
  Menu,
  PaymentSettings,
  StoreSettings,
} from "@/lib/db";

export interface ShopResponse {
  location: Location;
  menu: Menu;
  settings: StoreSettings;
  paymentSettings: PaymentSettings;
  driver: string;
}

export function useShop(slug: string) {
  return useQuery<ShopResponse>({
    queryKey: ["shop", slug],
    queryFn: async () => {
      const res = await fetch(
        `/api/shop/location?slug=${encodeURIComponent(slug)}`,
        { cache: "no-store" },
      );
      if (!res.ok) throw new Error(`Failed to load shop (HTTP ${res.status})`);
      return (await res.json()) as ShopResponse;
    },
    staleTime: 60_000,
  });
}
