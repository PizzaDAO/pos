/**
 * Locations + plan gating (Phase 6, /admin → Locations).
 *
 * Lists the tenant's locations and lets the owner add another — but the "Add"
 * action is GATED by the plan's `max_locations` entitlement. On a Starter plan
 * (1 location) the add form is blocked with an upgrade nudge; the server
 * re-checks and returns 402 if bypassed. This is a concrete proof that
 * entitlements gate a real action.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, MapPin, Plus, ShieldAlert } from "lucide-react";
import type { Entitlements } from "@/lib/saas/entitlements";
import type { Location } from "@/lib/db";
import { Button } from "@/components/ui/button";

interface Props {
  tenantId: string;
  onLocationsChanged?: () => void;
}

export function LocationsManager({ tenantId, onLocationsChanged }: Props) {
  const [locations, setLocations] = useState<Location[]>([]);
  const [entitlements, setEntitlements] = useState<Entitlements | null>(null);
  const [gate, setGate] = useState<{ allowed: boolean; reason?: string }>({
    allowed: true,
  });
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/locations?tenantId=${tenantId}`, {
      cache: "no-store",
    });
    if (res.ok) {
      const data = (await res.json()) as {
        locations: Location[];
        entitlements: Entitlements;
        gate: { allowed: boolean; reason?: string };
      };
      setLocations(data.locations);
      setEntitlements(data.entitlements);
      setGate(data.gate);
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function addLocation() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/locations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId, name, address: address || null }),
      });
      const data = (await res.json()) as { error?: string };
      if (res.status === 402) {
        // Plan limit hit (server-side gate).
        setError(data.error ?? "Plan limit reached.");
        return;
      }
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setName("");
      setAddress("");
      await load();
      onLocationsChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add location.");
    } finally {
      setBusy(false);
    }
  }

  const max = entitlements?.entitlements.max_locations ?? null;
  const maxLabel = max === null || !Number.isFinite(max) ? "∞" : String(max);

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <MapPin className="h-5 w-5" /> Locations
        </h2>
        {entitlements && (
          <span className="text-sm text-muted-foreground">
            {locations.length} of {maxLabel} used · {entitlements.plan_name} plan
          </span>
        )}
      </div>

      <ul className="space-y-1 text-sm">
        {locations.map((l) => (
          <li
            key={l.id}
            className="flex items-center justify-between rounded-md border px-3 py-2"
          >
            <span>
              {l.name}{" "}
              <span className="text-xs text-muted-foreground">/{l.slug}</span>
            </span>
            <span className="text-xs text-muted-foreground">
              {l.address ?? "no address"}
            </span>
          </li>
        ))}
      </ul>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Add-location form — gated by plan entitlement. */}
      {gate.allowed ? (
        <div className="space-y-3 rounded-lg border p-4">
          <div className="text-sm font-medium">Add a location</div>
          <input
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            placeholder="Location name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            placeholder="Address (optional)"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
          <Button onClick={addLocation} disabled={busy || !name.trim()}>
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>
                <Plus className="mr-1 h-4 w-4" /> Add location
              </>
            )}
          </Button>
        </div>
      ) : (
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/50 bg-amber-500/10 p-4 text-sm text-amber-800">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <div className="font-medium">Location limit reached</div>
            <p className="mt-0.5">{gate.reason}</p>
            <p className="mt-1 text-xs">
              Upgrade your plan in onboarding/billing to add more locations.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
