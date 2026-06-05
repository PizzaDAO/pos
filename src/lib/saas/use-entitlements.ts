/**
 * useEntitlements — client hook over /api/entitlements (Phase 6).
 *
 * Fetches the tenant's effective plan entitlements + current usage so back-office
 * UI can gate features (disable an over-limit "Add location", hide advanced
 * reports, surface an upgrade nudge). The server is the source of truth — this is
 * a convenience mirror for UX; routes re-check before mutating.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import type { Entitlements } from "./entitlements";

export interface EntitlementsState {
  entitlements: Entitlements | null;
  usage: { locations: number; staff: number } | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

export function useEntitlements(tenantId: string): EntitlementsState {
  const [entitlements, setEntitlements] = useState<Entitlements | null>(null);
  const [usage, setUsage] = useState<{ locations: number; staff: number } | null>(
    null,
  );
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/entitlements?tenantId=${tenantId}`, {
        cache: "no-store",
      });
      if (res.ok) {
        const data = (await res.json()) as {
          entitlements: Entitlements;
          usage: { locations: number; staff: number };
        };
        setEntitlements(data.entitlements);
        setUsage(data.usage);
      }
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { entitlements, usage, loading, refresh };
}
