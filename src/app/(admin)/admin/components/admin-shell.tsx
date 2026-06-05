/**
 * Back-office shell (Phase 5, /admin).
 *
 * Top-level client surface for the tenant back office. Holds the active LOCATION
 * (the seed tenant has 2 locations + a tenant-rollup option for reports) and a
 * demo STAFF identity (no real auth — a switcher so staff/shift views are
 * demoable), and renders the section tabs. Each section is its own client
 * component talking to the /api/admin/* routes (mock driver, no env vars).
 */
"use client";

import { useState } from "react";
import {
  BarChart3,
  Boxes,
  ClipboardList,
  CreditCard,
  LayoutGrid,
  Receipt,
  Truck,
  Users,
} from "lucide-react";
import {
  DEMO_LOCATION_DOWNTOWN_ID,
  DEMO_LOCATION_UPTOWN_ID,
  DEMO_TENANT_ID,
} from "@/lib/db";
import { cn } from "@/lib/utils";
import { MenuManager } from "./menu-manager";
import { InventoryManager } from "./inventory-manager";
import { ReportsView } from "./reports-view";
import { StaffShifts } from "./staff-shifts";
import { EndOfDay } from "./end-of-day";
import { ConnectOnboarding } from "../connect-onboarding";
import { DeliveryDispatch } from "../delivery-dispatch";

export const LOCATIONS = [
  { id: DEMO_LOCATION_DOWNTOWN_ID, name: "Tony's Downtown" },
  { id: DEMO_LOCATION_UPTOWN_ID, name: "Tony's Uptown" },
] as const;

export const TENANT_ID = DEMO_TENANT_ID;

type Tab =
  | "menu"
  | "inventory"
  | "reports"
  | "staff"
  | "eod"
  | "payments"
  | "delivery";

const TABS: { id: Tab; label: string; icon: typeof LayoutGrid }[] = [
  { id: "menu", label: "Menu", icon: LayoutGrid },
  { id: "inventory", label: "Inventory", icon: Boxes },
  { id: "reports", label: "Reports", icon: BarChart3 },
  { id: "staff", label: "Staff & shifts", icon: Users },
  { id: "eod", label: "End of day", icon: Receipt },
  { id: "payments", label: "Payments", icon: CreditCard },
  { id: "delivery", label: "Delivery", icon: Truck },
];

export function AdminShell() {
  const [tab, setTab] = useState<Tab>("menu");
  const [locationId, setLocationId] = useState<string>(
    DEMO_LOCATION_DOWNTOWN_ID,
  );

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto max-w-6xl px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <ClipboardList className="h-5 w-5" />
              <h1 className="text-lg font-bold">Tony&apos;s Pizza — Back office</h1>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Location</span>
              <select
                className="rounded-md border bg-background px-2 py-1.5 text-sm"
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
              >
                {LOCATIONS.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <nav className="mt-3 flex flex-wrap gap-1">
            {TABS.map((t) => {
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    tab === t.id
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {t.label}
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        {tab === "menu" && (
          <MenuManager tenantId={TENANT_ID} locationId={locationId} />
        )}
        {tab === "inventory" && (
          <InventoryManager tenantId={TENANT_ID} locationId={locationId} />
        )}
        {tab === "reports" && <ReportsView tenantId={TENANT_ID} />}
        {tab === "staff" && (
          <StaffShifts tenantId={TENANT_ID} locationId={locationId} />
        )}
        {tab === "eod" && (
          <EndOfDay tenantId={TENANT_ID} locationId={locationId} />
        )}
        {tab === "payments" && <ConnectOnboarding />}
        {tab === "delivery" && <DeliveryDispatch />}
      </main>
    </div>
  );
}
