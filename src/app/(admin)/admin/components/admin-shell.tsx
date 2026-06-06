/**
 * Back-office shell (Phase 5 + Phase 6, /admin).
 *
 * Top-level client surface for the tenant back office. Phase 6 makes it
 * TENANT-AWARE: the active tenant is resolved from `?tenant=` (defaulting to the
 * demo tenant) so a newly self-served tenant's back office works in isolation,
 * and an `?impersonate=1` flag shows a clear "viewing as tenant" banner (the
 * audited platform impersonation lands here). Locations + entitlements are
 * fetched live, so plan gating (location cap, online-ordering/advanced-reports
 * features) reflects the tenant's subscription. All data flows through the
 * /api/admin/* + /api/entitlements + /api/billing routes (mock driver, no env).
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import {
  BarChart3,
  Boxes,
  ClipboardList,
  CreditCard,
  Eye,
  LayoutGrid,
  MapPin,
  Receipt,
  Truck,
  Users,
  Wallet,
} from "lucide-react";
import { DEMO_TENANT_ID, type Location } from "@/lib/db";
import { useEntitlements } from "@/lib/saas/use-entitlements";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Tab panels are lazy-loaded: only one tab is visible at a time, so code-split
 * each heavy manager and load it on demand. This trims the back-office initial
 * JS substantially with no behaviour change (each module is the same component,
 * just fetched when its tab opens). `ssr: false` is safe — these are
 * client-only, data-fetching panels behind an authenticated shell.
 */
const PanelFallback = () => (
  <div className="space-y-3" aria-busy="true" aria-label="Loading section">
    <Skeleton className="h-8 w-48" />
    <Skeleton className="h-40 w-full" />
    <Skeleton className="h-40 w-full" />
  </div>
);
const MenuManager = dynamic(
  () => import("./menu-manager").then((m) => m.MenuManager),
  { loading: PanelFallback },
);
const InventoryManager = dynamic(
  () => import("./inventory-manager").then((m) => m.InventoryManager),
  { loading: PanelFallback },
);
const ReportsView = dynamic(
  () => import("./reports-view").then((m) => m.ReportsView),
  { loading: PanelFallback },
);
const StaffShifts = dynamic(
  () => import("./staff-shifts").then((m) => m.StaffShifts),
  { loading: PanelFallback },
);
const EndOfDay = dynamic(() => import("./end-of-day").then((m) => m.EndOfDay), {
  loading: PanelFallback,
});
const LocationsManager = dynamic(
  () => import("./locations-manager").then((m) => m.LocationsManager),
  { loading: PanelFallback },
);
const PlanBilling = dynamic(
  () => import("./plan-billing").then((m) => m.PlanBilling),
  { loading: PanelFallback },
);
const ConnectOnboarding = dynamic(
  () => import("../connect-onboarding").then((m) => m.ConnectOnboarding),
  { loading: PanelFallback },
);
const DeliveryDispatch = dynamic(
  () => import("../delivery-dispatch").then((m) => m.DeliveryDispatch),
  { loading: PanelFallback },
);

type Tab =
  | "menu"
  | "inventory"
  | "reports"
  | "staff"
  | "eod"
  | "locations"
  | "plan"
  | "payments"
  | "delivery";

function readTenantParam(fallbackTenantId: string): {
  tenantId: string;
  impersonate: boolean;
} {
  if (typeof window === "undefined") {
    return { tenantId: fallbackTenantId, impersonate: false };
  }
  const params = new URLSearchParams(window.location.search);
  return {
    tenantId: params.get("tenant") ?? fallbackTenantId,
    impersonate: params.get("impersonate") === "1",
  };
}

/**
 * `initialTenantId` is the SESSION-DERIVED active tenant resolved + authorized
 * by the server guard (src/lib/auth/guard.ts#requireAdmin). It defaults to the
 * demo tenant for the simulated/zero-env path. An explicit `?tenant=` (platform
 * impersonation) still wins so the audited "view as tenant" flow is unchanged.
 */
export function AdminShell({
  initialTenantId = DEMO_TENANT_ID,
}: {
  initialTenantId?: string;
}) {
  const [{ tenantId, impersonate }] = useState(() =>
    readTenantParam(initialTenantId),
  );
  const [tenantName, setTenantName] = useState("Back office");
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationId, setLocationId] = useState<string>("");
  const [tab, setTab] = useState<Tab>("menu");

  const { entitlements, refresh: refreshEntitlements } =
    useEntitlements(tenantId);

  const loadLocations = useCallback(async () => {
    const res = await fetch(`/api/admin/locations?tenantId=${tenantId}`, {
      cache: "no-store",
    });
    if (res.ok) {
      const data = (await res.json()) as { locations: Location[] };
      setLocations(data.locations);
      setLocationId((cur) => cur || data.locations[0]?.id || "");
    }
    const t = await fetch(`/api/signup?tenantId=${tenantId}`);
    if (t.ok) {
      const td = (await t.json()) as { tenant?: { name: string } };
      if (td.tenant?.name) setTenantName(td.tenant.name);
    }
  }, [tenantId]);

  useEffect(() => {
    void loadLocations();
  }, [loadLocations]);

  const advancedReportsAllowed =
    entitlements?.entitlements.advanced_reports ?? false;
  const deliveryAllowed = entitlements?.entitlements.delivery ?? false;

  const tabs = useMemo(() => {
    const base: { id: Tab; label: string; icon: typeof LayoutGrid }[] = [
      { id: "menu", label: "Menu", icon: LayoutGrid },
      { id: "inventory", label: "Inventory", icon: Boxes },
      { id: "reports", label: "Reports", icon: BarChart3 },
      { id: "staff", label: "Staff & shifts", icon: Users },
      { id: "eod", label: "End of day", icon: Receipt },
      { id: "locations", label: "Locations", icon: MapPin },
      { id: "plan", label: "Plan", icon: Wallet },
      { id: "payments", label: "Payments", icon: CreditCard },
      { id: "delivery", label: "Delivery", icon: Truck },
    ];
    return base;
  }, []);

  return (
    <div className="min-h-screen">
      {impersonate && (
        <div className="flex items-center justify-center gap-2 bg-amber-500 px-4 py-1.5 text-center text-xs font-semibold text-amber-950">
          <Eye className="h-3.5 w-3.5" /> Platform support session — viewing as{" "}
          {tenantName}. This view is audited.
        </div>
      )}
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto max-w-6xl px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <ClipboardList className="h-5 w-5" />
              <h1 className="text-lg font-bold">{tenantName} — Back office</h1>
              {entitlements && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {entitlements.plan_name}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              {locations.length > 0 && (
                <label className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">Location</span>
                  <select
                    className="rounded-md border bg-background px-2 py-1.5 text-sm"
                    value={locationId}
                    onChange={(e) => setLocationId(e.target.value)}
                  >
                    {locations.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <SignOutButton redirect="/login" />
            </div>
          </div>

          {entitlements?.past_due && (
            <div className="mt-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-800">
              Your subscription is past due. Update billing on the Plan tab to
              keep premium features.
            </div>
          )}

          <nav
            aria-label="Back office sections"
            className="mt-3 flex flex-wrap gap-1"
          >
            {tabs.map((t) => {
              const Icon = t.icon;
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    active
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {t.label}
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      <main id="main-content" className="mx-auto max-w-6xl px-4 py-6">
        {tab === "menu" && locationId && (
          <MenuManager tenantId={tenantId} locationId={locationId} />
        )}
        {tab === "inventory" && locationId && (
          <InventoryManager tenantId={tenantId} locationId={locationId} />
        )}
        {tab === "reports" &&
          (advancedReportsAllowed ? (
            <ReportsView tenantId={tenantId} locations={locations} />
          ) : (
            <FeatureLocked
              feature="Advanced reports"
              detail="Sales rollups, payment-mix, and exports require the Pro plan or higher."
            />
          ))}
        {tab === "staff" && locationId && (
          <StaffShifts tenantId={tenantId} locationId={locationId} />
        )}
        {tab === "eod" && locationId && (
          <EndOfDay
            tenantId={tenantId}
            locationId={locationId}
            locationName={
              locations.find((l) => l.id === locationId)?.name ?? locationId
            }
          />
        )}
        {tab === "locations" && (
          <LocationsManager
            tenantId={tenantId}
            onLocationsChanged={() => {
              void loadLocations();
              void refreshEntitlements();
            }}
          />
        )}
        {tab === "plan" && (
          <PlanBilling
            tenantId={tenantId}
            onChanged={() => void refreshEntitlements()}
          />
        )}
        {tab === "payments" && <ConnectOnboarding tenantId={tenantId} />}
        {tab === "delivery" &&
          (deliveryAllowed ? (
            <DeliveryDispatch />
          ) : (
            <FeatureLocked
              feature="Delivery"
              detail="Delivery dispatch requires the Pro plan or higher."
            />
          ))}
      </main>
    </div>
  );
}

function FeatureLocked({
  feature,
  detail,
}: {
  feature: string;
  detail: string;
}) {
  return (
    <div className="mx-auto max-w-md rounded-lg border border-amber-500/50 bg-amber-500/10 p-6 text-center">
      <div className="text-lg font-semibold text-amber-800">
        {feature} is locked
      </div>
      <p className="mt-1 text-sm text-amber-800">{detail}</p>
      <p className="mt-2 text-xs text-muted-foreground">
        Upgrade on the Plan tab to unlock it.
      </p>
    </div>
  );
}
