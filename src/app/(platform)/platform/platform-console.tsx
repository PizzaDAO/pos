/**
 * Platform console client (Phase 6, super-admin).
 *
 * Two views: a tenant-health list and a tenant detail/billing overview. The
 * detail view exposes AUDITED support impersonation — starting an impersonation
 * session opens the tenant's back office "as the tenant" and records an audit
 * entry; ending it records another. A persistent banner indicates an active
 * impersonation session. Suspend/reactivate are likewise audited.
 *
 * All actions hit /api/platform (which gates on platform_admins + writes the
 * audit log). No env vars required.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Building2,
  CircleAlert,
  Eye,
  EyeOff,
  ShieldCheck,
} from "lucide-react";
import type {
  AuditLogEntry,
  ConnectAccount,
  Location,
  Subscription,
  Tenant,
  TenantHealth,
  TenantOnboarding,
} from "@/lib/db";
import { Button } from "@/components/ui/button";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { formatMoney } from "@/lib/pricing";
import { cn } from "@/lib/utils";

interface ListData {
  tenants: TenantHealth[];
  audit: AuditLogEntry[];
  admin: { id: string; email: string };
}

interface DetailData {
  tenant: Tenant;
  health: TenantHealth | null;
  locations: Location[];
  subscription: Subscription | null;
  connect: ConnectAccount | null;
  onboarding: TenantOnboarding | null;
  audit: AuditLogEntry[];
  admin: { id: string; email: string };
}

function subBadge(sub: Subscription | null): { label: string; cls: string } {
  if (!sub) return { label: "no plan", cls: "bg-muted text-muted-foreground" };
  switch (sub.status) {
    case "active":
      return { label: "active", cls: "bg-emerald-500/15 text-emerald-700" };
    case "trialing":
      return { label: "trialing", cls: "bg-sky-500/15 text-sky-700" };
    case "past_due":
      return { label: "past due", cls: "bg-amber-500/15 text-amber-700" };
    case "canceled":
      return { label: "canceled", cls: "bg-destructive/15 text-destructive" };
  }
}

async function postJson<T>(body: unknown): Promise<T> {
  const res = await fetch("/api/platform", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export function PlatformConsole() {
  const [list, setList] = useState<ListData | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailData | null>(null);
  const [impersonating, setImpersonating] = useState<{
    tenantId: string;
    name: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadList = useCallback(async () => {
    const res = await fetch("/api/platform");
    if (!res.ok) {
      setError("Not authorized.");
      return;
    }
    setList((await res.json()) as ListData);
  }, []);

  const loadDetail = useCallback(async (tenantId: string) => {
    const res = await fetch(`/api/platform?tenantId=${tenantId}`);
    setDetail((await res.json()) as DetailData);
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (selected) void loadDetail(selected);
  }, [selected, loadDetail]);

  async function act(
    action: "impersonate_start" | "impersonate_end" | "suspend" | "reactivate",
    tenantId: string,
    name: string,
  ) {
    setBusy(true);
    setError(null);
    try {
      await postJson({ action, tenantId });
      if (action === "impersonate_start") {
        setImpersonating({ tenantId, name });
        window.open(`/admin?tenant=${tenantId}&impersonate=1`, "_blank");
      } else if (action === "impersonate_end") {
        setImpersonating(null);
      }
      await Promise.all([loadList(), selected ? loadDetail(selected) : null]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  }

  if (error && !list) {
    return (
      <main className="mx-auto max-w-md px-4 py-16 text-center">
        <CircleAlert className="mx-auto h-8 w-8 text-destructive" />
        <p className="mt-2 text-sm text-muted-foreground">{error}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <header className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5" />
          <h1 className="text-lg font-bold">Platform admin</h1>
        </div>
        <div className="flex items-center gap-3">
          {list && (
            <span className="text-xs text-muted-foreground">
              Signed in as {list.admin.email}
            </span>
          )}
          <SignOutButton redirect="/platform/login" />
        </div>
      </header>

      {impersonating && (
        <div className="mb-4 flex items-center justify-between rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm text-amber-800">
          <span className="flex items-center gap-2">
            <Eye className="h-4 w-4" /> Impersonating{" "}
            <strong>{impersonating.name}</strong> — actions are audited.
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              act("impersonate_end", impersonating.tenantId, impersonating.name)
            }
          >
            <EyeOff className="mr-1 h-3.5 w-3.5" /> End session
          </Button>
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {!selected ? (
        <>
          {/* Tenant health list */}
          <div className="overflow-hidden rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Tenant</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Plan</th>
                  <th className="px-3 py-2 text-right">Locations</th>
                  <th className="px-3 py-2 text-right">Orders (30d)</th>
                  <th className="px-3 py-2 text-right">Volume (30d)</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {(list?.tenants ?? []).map((t) => {
                  const badge = subBadge(t.subscription);
                  return (
                    <tr key={t.tenant_id} className="border-t">
                      <td className="px-3 py-2 font-medium">
                        {t.name}
                        <div className="text-xs text-muted-foreground">
                          {t.slug}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 text-xs",
                            t.status === "active"
                              ? "bg-emerald-500/15 text-emerald-700"
                              : t.status === "suspended"
                                ? "bg-amber-500/15 text-amber-700"
                                : "bg-destructive/15 text-destructive",
                          )}
                        >
                          {t.status}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 text-xs",
                            badge.cls,
                          )}
                        >
                          {t.subscription?.tier ?? "—"} · {badge.label}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right">
                        {t.location_count}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {t.recent_order_count}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {formatMoney(t.recent_gross_cents)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setSelected(t.tenant_id)}
                        >
                          View
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Recent audit log */}
          <section className="mt-6">
            <h2 className="mb-2 text-sm font-semibold">Recent audit log</h2>
            <AuditList entries={list?.audit ?? []} />
          </section>
        </>
      ) : (
        detail && (
          <TenantDetail
            detail={detail}
            busy={busy}
            impersonatingId={impersonating?.tenantId ?? null}
            onBack={() => {
              setSelected(null);
              setDetail(null);
            }}
            onAct={act}
          />
        )
      )}
    </main>
  );
}

function AuditList({ entries }: { entries: AuditLogEntry[] }) {
  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No audit entries yet.</p>
    );
  }
  return (
    <ul className="space-y-1 rounded-lg border p-3 text-xs">
      {entries.map((e) => (
        <li key={e.id} className="flex items-start justify-between gap-3">
          <span>
            <span className="font-mono font-medium">{e.action}</span>{" "}
            <span className="text-muted-foreground">— {e.detail}</span>
          </span>
          <span className="whitespace-nowrap text-muted-foreground">
            {e.actor_label} · {new Date(e.created_at).toLocaleString()}
          </span>
        </li>
      ))}
    </ul>
  );
}

function TenantDetail({
  detail,
  busy,
  impersonatingId,
  onBack,
  onAct,
}: {
  detail: DetailData;
  busy: boolean;
  impersonatingId: string | null;
  onBack: () => void;
  onAct: (
    action: "impersonate_start" | "impersonate_end" | "suspend" | "reactivate",
    tenantId: string,
    name: string,
  ) => void;
}) {
  const { tenant, locations, subscription, connect, onboarding } = detail;
  const badge = subBadge(subscription);
  const isImpersonating = impersonatingId === tenant.id;

  return (
    <div className="space-y-5">
      <Button size="sm" variant="ghost" onClick={onBack}>
        <ArrowLeft className="mr-1 h-4 w-4" /> All tenants
      </Button>

      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2">
          <Building2 className="h-6 w-6" />
          <div>
            <h2 className="text-xl font-bold">{tenant.name}</h2>
            <p className="text-xs text-muted-foreground">
              {tenant.slug} · {tenant.status}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {!isImpersonating ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => onAct("impersonate_start", tenant.id, tenant.name)}
            >
              <Eye className="mr-1 h-4 w-4" /> View as tenant
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => onAct("impersonate_end", tenant.id, tenant.name)}
            >
              <EyeOff className="mr-1 h-4 w-4" /> End session
            </Button>
          )}
          {tenant.status === "active" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => onAct("suspend", tenant.id, tenant.name)}
            >
              Suspend
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => onAct("reactivate", tenant.id, tenant.name)}
            >
              Reactivate
            </Button>
          )}
        </div>
      </div>

      {/* Billing overview */}
      <section className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border p-4">
          <div className="text-xs uppercase text-muted-foreground">
            Subscription
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span className="font-semibold capitalize">
              {subscription?.tier ?? "none"}
            </span>
            <span className={cn("rounded-full px-2 py-0.5 text-xs", badge.cls)}>
              {badge.label}
            </span>
          </div>
          {subscription && (
            <div className="mt-2 text-xs text-muted-foreground">
              Renews{" "}
              {new Date(subscription.current_period_end).toLocaleDateString()}
              {subscription.simulated && " · simulated"}
            </div>
          )}
        </div>
        <div className="rounded-lg border p-4">
          <div className="text-xs uppercase text-muted-foreground">Payments</div>
          <div className="mt-1 font-semibold">
            {connect?.status === "connected" ? "Connected" : "Not connected"}
          </div>
          <div className="mt-2 text-xs text-muted-foreground">
            {connect?.account_id ?? "No Connect account"}
          </div>
        </div>
        <div className="rounded-lg border p-4">
          <div className="text-xs uppercase text-muted-foreground">Footprint</div>
          <div className="mt-1 font-semibold">
            {locations.length} location{locations.length === 1 ? "" : "s"}
          </div>
          <div className="mt-2 text-xs text-muted-foreground">
            Onboarding {onboarding?.live ? "live" : (onboarding?.current_step ?? "—")}
          </div>
        </div>
      </section>

      {/* Locations */}
      <section>
        <h3 className="mb-2 text-sm font-semibold">Locations</h3>
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
              <Link
                className="text-xs underline"
                href={`/shop/${l.slug}`}
                target="_blank"
              >
                storefront
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {/* Tenant audit trail */}
      <section>
        <h3 className="mb-2 text-sm font-semibold">Audit trail</h3>
        <AuditList entries={detail.audit} />
      </section>
    </div>
  );
}
