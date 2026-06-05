/**
 * Plan & billing (Phase 6, /admin → Plan).
 *
 * Shows the tenant's current subscription + entitlement summary, lets the owner
 * switch tiers (simulated when unkeyed), and exposes demo lifecycle controls
 * (enter dunning → past_due, recover → active) so plan gating + the past-due
 * banner are demoable without a real Stripe webhook. OUR revenue, distinct from
 * the tenant's Connect (card) revenue.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { CreditCard } from "lucide-react";
import type { Plan, Subscription, SubscriptionStatus } from "@/lib/db";
import type { Entitlements } from "@/lib/saas/entitlements";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/pricing";
import { cn } from "@/lib/utils";

interface Props {
  tenantId: string;
  onChanged?: () => void;
}

export function PlanBilling({ tenantId, onChanged }: Props) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [entitlements, setEntitlements] = useState<Entitlements | null>(null);
  const [simulated, setSimulated] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/billing?tenantId=${tenantId}`, {
      cache: "no-store",
    });
    if (res.ok) {
      const data = (await res.json()) as {
        plans: Plan[];
        subscription: Subscription | null;
        entitlements: Entitlements;
        simulated: boolean;
      };
      setPlans(data.plans);
      setSubscription(data.subscription);
      setEntitlements(data.entitlements);
      setSimulated(data.simulated);
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function subscribe(tier: Plan["tier"]) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/billing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "subscribe", tenantId, tier }),
      });
      const data = (await res.json()) as {
        checkoutUrl: string | null;
        simulated: boolean;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      if (!data.simulated && data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
        return;
      }
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to change plan.");
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(status: SubscriptionStatus) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/billing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_status", tenantId, status }),
      });
      if (!res.ok) {
        const d = (await res.json()) as { error?: string };
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update status.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <CreditCard className="h-5 w-5" /> Plan &amp; billing
      </h2>

      {simulated && (
        <p className="text-xs text-amber-700">
          Simulated billing — no live Stripe keys. Plan changes + dunning are
          in-app and don&apos;t hit Stripe.
        </p>
      )}

      {subscription && entitlements && (
        <div
          className={cn(
            "rounded-lg border p-4",
            subscription.status === "past_due" &&
              "border-amber-500/50 bg-amber-500/10",
            subscription.status === "canceled" &&
              "border-destructive/50 bg-destructive/10",
          )}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="font-semibold">
                {entitlements.plan_name} plan
              </div>
              <div className="text-sm text-muted-foreground">
                Status: {subscription.status}
                {subscription.trial_end &&
                  subscription.status === "trialing" &&
                  ` · trial ends ${new Date(subscription.trial_end).toLocaleDateString()}`}
              </div>
            </div>
            <div className="flex gap-2">
              {subscription.status !== "past_due" && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setStatus("past_due")}
                >
                  Simulate past-due
                </Button>
              )}
              {subscription.status !== "active" && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setStatus("active")}
                >
                  Recover
                </Button>
              )}
            </div>
          </div>
          {subscription.status === "past_due" && (
            <p className="mt-2 text-sm text-amber-800">
              Payment failed — your account is in dunning. Update billing to keep
              your plan features.
            </p>
          )}
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        {plans.map((p) => {
          const current = subscription?.tier === p.tier;
          return (
            <div
              key={p.tier}
              className={cn(
                "flex flex-col rounded-lg border p-4",
                current && "border-primary",
              )}
            >
              <div className="font-semibold">{p.name}</div>
              <div className="mt-1 text-2xl font-bold">
                {formatMoney(p.price_cents)}
                <span className="text-sm font-normal text-muted-foreground">
                  /mo
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{p.blurb}</p>
              <Button
                className="mt-3"
                size="sm"
                variant={current ? "default" : "outline"}
                disabled={busy || current}
                onClick={() => subscribe(p.tier)}
              >
                {current ? "Current plan" : "Switch"}
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
