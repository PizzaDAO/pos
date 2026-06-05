/**
 * Stripe Connect onboarding panel (Phase 2 scaffold).
 *
 * Starts/refreshes Connect onboarding for the active demo tenant and shows the
 * connected-account status. Real Stripe Connect calls happen server-side behind
 * an env guard; with no key the API returns a simulated `connected` account so
 * card rails work end-to-end. Status persists via the DB abstraction.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, ExternalLink, Loader2 } from "lucide-react";
import { DEMO_TENANT_ID, type ConnectAccount } from "@/lib/db";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ConnectOnboarding({
  tenantId = DEMO_TENANT_ID,
}: {
  tenantId?: string;
}) {
  const [account, setAccount] = useState<ConnectAccount | null>(null);
  const [simulated, setSimulated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/connect?tenantId=${tenantId}`);
      const data = (await res.json()) as {
        account: ConnectAccount | null;
        simulated: boolean;
      };
      setAccount(data.account);
      setSimulated(data.simulated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load status.");
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function startOnboarding() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId }),
      });
      const data = (await res.json()) as {
        account: ConnectAccount;
        onboardingUrl: string;
        simulated: boolean;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setAccount(data.account);
      setSimulated(data.simulated);
      if (!data.simulated && data.onboardingUrl) {
        window.location.href = data.onboardingUrl;
      } else {
        await load();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Onboarding failed.");
    } finally {
      setLoading(false);
    }
  }

  const status = account?.status ?? "not_started";
  const connected = status === "connected";

  return (
    <div className="mx-auto max-w-xl space-y-4 p-6">
      <div>
        <h1 className="text-xl font-bold">Payments — Stripe Connect</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect your Stripe account so card payments settle to{" "}
          <strong>your</strong> bank. We take a small per-order platform fee via{" "}
          <code>application_fee</code>; subscription billing is separate.
        </p>
      </div>

      {simulated && (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-amber-700">
          Running in <strong>simulated</strong> mode — no live Stripe keys are
          configured. Onboarding completes instantly and card rails approve
          without a real charge. Set <code>STRIPE_SECRET_KEY</code> to enable the
          real Connect flow.
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="rounded-lg border p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">Account status</div>
            <div
              className={cn(
                "mt-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold uppercase",
                connected
                  ? "bg-emerald-500/15 text-emerald-700"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {connected && <CheckCircle2 className="h-3.5 w-3.5" />}
              {status.replace("_", " ")}
            </div>
          </div>
          {account && (
            <div className="text-right text-xs text-muted-foreground">
              <div>{account.account_id}</div>
              <div>
                charges {account.charges_enabled ? "✓" : "—"} · payouts{" "}
                {account.payouts_enabled ? "✓" : "—"}
              </div>
            </div>
          )}
        </div>

        <div className="mt-4 flex gap-2">
          <Button onClick={startOnboarding} disabled={loading}>
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Working…
              </>
            ) : connected ? (
              "Re-run onboarding"
            ) : (
              <>
                Start onboarding <ExternalLink className="ml-1 h-4 w-4" />
              </>
            )}
          </Button>
          <Button variant="outline" onClick={() => void load()}>
            Refresh status
          </Button>
        </div>
      </div>
    </div>
  );
}
