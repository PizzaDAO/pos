/**
 * Menu loading hook. Fetches the assembled menu + store settings from
 * `/api/menu` (which the service worker caches for offline use) via TanStack
 * Query. Falls back to the demo context.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import {
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_TENANT_ID,
  type Menu,
  type StoreSettings,
} from "@/lib/db";

export interface MenuResponse {
  menu: Menu;
  settings: StoreSettings;
  driver: string;
}

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
  });
}
