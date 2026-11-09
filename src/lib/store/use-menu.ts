/**
 * Menu loading hook. Fetches the assembled menu + store settings from
 * `/api/menu` (which the service worker caches for offline use) via TanStack
 * Query. Falls back to the demo context. Re-polled every 30 s (and on focus)
 * so an 86 made in Admin or at another till shows as "Sold out" here quickly.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import {
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_TENANT_ID,
  type Menu,
  type PaymentSettings,
  type StoreSettings,
} from "@/lib/db";
import type { MenuAvailability } from "@/lib/menu-availability";

export interface MenuResponse {
  menu: Menu;
  settings: StoreSettings;
  paymentSettings: PaymentSettings;
  /** Ids 86'd at this location (absent on an old cached response). */
  unavailable?: MenuAvailability;
  driver: string;
}

/** How often the till re-reads the menu (picks up 86 / un-86). */
export const MENU_REFRESH_MS = 30_000;

export function useMenu(
  tenantId: string = DEMO_TENANT_ID,
  locationId: string = DEMO_LOCATION_DOWNTOWN_ID,
) {
  return useQuery<MenuResponse>({
    queryKey: ["menu", tenantId, locationId],
    queryFn: async () => {
      const res = await fetch(
        `/api/menu?tenantId=${encodeURIComponent(
          tenantId,
        )}&locationId=${encodeURIComponent(locationId)}`,
      );
      if (!res.ok) throw new Error(`Failed to load menu (HTTP ${res.status})`);
      return (await res.json()) as MenuResponse;
    },
    staleTime: 5 * 60_000,
    // Availability (86) changes during service: keep the till current.
    refetchInterval: MENU_REFRESH_MS,
    refetchOnWindowFocus: true,
  });
}
