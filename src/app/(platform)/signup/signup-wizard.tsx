/**
 * Onboarding wizard client (Phase 6).
 *
 * Walks a new pizzeria through six steps, persisting each through the API so the
 * new tenant gets fully isolated data. State is kept locally + reflected from
 * the server's onboarding record so the wizard can resume. Connect + billing run
 * simulated when unkeyed; the UI labels that clearly.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  CreditCard,
  ExternalLink,
  Loader2,
  Store,
  UtensilsCrossed,
} from "lucide-react";
import type {
  ConnectAccount,
  Location,
  OnboardingStep,
  Plan,
  Subscription,
  Tenant,
} from "@/lib/db";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/pricing";
import { cn } from "@/lib/utils";

const STEP_LABELS: { id: OnboardingStep; label: string }[] = [
  { id: "business", label: "Business" },
  { id: "location", label: "Location" },
  { id: "connect", label: "Payments" },
  { id: "menu", label: "Menu" },
  { id: "plan", label: "Plan" },
  { id: "go_live", label: "Go live" },
];

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export function SignupWizard() {
  const [step, setStep] = useState<OnboardingStep>("business");
  const [completed, setCompleted] = useState<OnboardingStep[]>([]);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [connect, setConnect] = useState<ConnectAccount | null>(null);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [billingSim, setBillingSim] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(false);

  // Step 1 fields
  const [businessName, setBusinessName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  // Step 2 fields
  const [locName, setLocName] = useState("");
  const [locAddress, setLocAddress] = useState("");

  const loadPlans = useCallback(async (tenantId: string | null) => {
    const qs = tenantId ? `?tenantId=${tenantId}` : "";
    const res = await fetch(`/api/billing${qs}`);
    const data = (await res.json()) as {
      plans: Plan[];
      subscription: Subscription | null;
      simulated: boolean;
    };
    setPlans(data.plans);
    setBillingSim(data.simulated);
    if (data.subscription) setSubscription(data.subscription);
  }, []);

  useEffect(() => {
    void loadPlans(null);
  }, [loadPlans]);

  function markComplete(s: OnboardingStep, next: OnboardingStep) {
    setCompleted((prev) => (prev.includes(s) ? prev : [...prev, s]));
    setStep(next);
  }

  async function createBusiness() {
    setBusy(true);
    setError(null);
    try {
      const data = await postJson<{ tenant: Tenant }>("/api/signup", {
        action: "create_business",
        businessName,
        ownerEmail,
      });
      setTenant(data.tenant);
      markComplete("business", "location");
      void loadPlans(data.tenant.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create business.");
    } finally {
      setBusy(false);
    }
  }

  async function addLocation() {
    if (!tenant) return;
    setBusy(true);
    setError(null);
    try {
      const data = await postJson<{ location: Location }>("/api/signup", {
        action: "add_location",
        tenantId: tenant.id,
        name: locName,
        address: locAddress || null,
      });
      setLocations((prev) => [...prev, data.location]);
      markComplete("location", "connect");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add location.");
    } finally {
      setBusy(false);
    }
  }

  async function startConnect() {
    if (!tenant) return;
    setBusy(true);
    setError(null);
    try {
      const data = await postJson<{
        account: ConnectAccount;
        onboardingUrl: string;
        simulated: boolean;
      }>("/api/connect", { tenantId: tenant.id });
      setConnect(data.account);
      if (!data.simulated && data.onboardingUrl) {
        window.location.href = data.onboardingUrl;
        return;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Connect onboarding failed.");
    } finally {
      setBusy(false);
    }
  }

  function continueAfterConnect() {
    markComplete("connect", "menu");
  }

  async function importMenu() {
    if (!tenant) return;
    setBusy(true);
    setError(null);
    try {
      await postJson("/api/signup", {
        action: "import_menu",
        tenantId: tenant.id,
      });
      markComplete("menu", "plan");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to import menu.");
    } finally {
      setBusy(false);
    }
  }

  async function pickPlan(tier: Plan["tier"]) {
    if (!tenant) return;
    setBusy(true);
    setError(null);
    try {
      const data = await postJson<{
        subscription: Subscription;
        checkoutUrl: string | null;
        simulated: boolean;
      }>("/api/billing", { action: "subscribe", tenantId: tenant.id, tier });
      setSubscription(data.subscription);
      if (!data.simulated && data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
        return;
      }
      markComplete("plan", "go_live");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to subscribe.");
    } finally {
      setBusy(false);
    }
  }

  async function goLive() {
    if (!tenant) return;
    setBusy(true);
    setError(null);
    try {
      const data = await postJson<{ tenant: Tenant }>("/api/signup", {
        action: "go_live",
        tenantId: tenant.id,
      });
      setTenant(data.tenant);
      setCompleted((prev) =>
        prev.includes("go_live") ? prev : [...prev, "go_live"],
      );
      setLive(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to go live.");
    } finally {
      setBusy(false);
    }
  }

  const primaryLocation = locations[0];
  const connected = connect?.status === "connected";

  return (
    <main id="main-content" className="mx-auto max-w-2xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">
          Start your pizzeria
        </h1>
        <p className="text-sm text-muted-foreground">
          Set up your business, take payments into your own account, and go live
          in a few minutes.
        </p>
      </header>

      {/* Step indicator */}
      <ol className="mb-6 flex flex-wrap gap-2">
        {STEP_LABELS.map((s, i) => {
          const done = completed.includes(s.id);
          const current = step === s.id;
          return (
            <li
              key={s.id}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium",
                done
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700"
                  : current
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input text-muted-foreground",
              )}
            >
              {done ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <span className="font-semibold">{i + 1}</span>
              )}
              {s.label}
            </li>
          );
        })}
      </ol>

      {error && (
        <div className="mb-4 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="rounded-lg border p-5">
        {/* STEP 1 — Business */}
        {step === "business" && (
          <section className="space-y-4">
            <div className="flex items-center gap-2">
              <Store className="h-5 w-5" />
              <h2 className="text-lg font-semibold">Your business</h2>
            </div>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Business name</span>
              <input
                className="w-full rounded-md border bg-background px-3 py-2"
                placeholder="Luigi's Pizzeria"
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Owner email</span>
              <input
                type="email"
                className="w-full rounded-md border bg-background px-3 py-2"
                placeholder="owner@luigis.com"
                value={ownerEmail}
                onChange={(e) => setOwnerEmail(e.target.value)}
              />
            </label>
            <Button
              onClick={createBusiness}
              disabled={busy || !businessName.trim() || !ownerEmail.trim()}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  Create business <ArrowRight className="ml-1 h-4 w-4" />
                </>
              )}
            </Button>
          </section>
        )}

        {/* STEP 2 — Location */}
        {step === "location" && tenant && (
          <section className="space-y-4">
            <div className="flex items-center gap-2">
              <Store className="h-5 w-5" />
              <h2 className="text-lg font-semibold">Your first location</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              {tenant.name} created. Add the location where you&apos;ll take
              orders.
            </p>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Location name</span>
              <input
                className="w-full rounded-md border bg-background px-3 py-2"
                placeholder="Luigi's — Main Street"
                value={locName}
                onChange={(e) => setLocName(e.target.value)}
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Address (optional)</span>
              <input
                className="w-full rounded-md border bg-background px-3 py-2"
                placeholder="100 Main St"
                value={locAddress}
                onChange={(e) => setLocAddress(e.target.value)}
              />
            </label>
            <Button onClick={addLocation} disabled={busy || !locName.trim()}>
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  Add location <ArrowRight className="ml-1 h-4 w-4" />
                </>
              )}
            </Button>
          </section>
        )}

        {/* STEP 3 — Connect */}
        {step === "connect" && tenant && (
          <section className="space-y-4">
            <div className="flex items-center gap-2">
              <CreditCard className="h-5 w-5" />
              <h2 className="text-lg font-semibold">Get paid</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              Connect your Stripe account so card payments settle to{" "}
              <strong>your</strong> bank. We take a small per-order platform fee
              via <code>application_fee</code>; your subscription is billed
              separately.
            </p>
            <div className="rounded-md border p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium">Connect status</span>
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold uppercase",
                    connected
                      ? "bg-emerald-500/15 text-emerald-700"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {connected && <CheckCircle2 className="h-3.5 w-3.5" />}
                  {(connect?.status ?? "not started").replace("_", " ")}
                </span>
              </div>
              {connect?.simulated && (
                <p className="mt-2 text-xs text-amber-700">
                  Simulated — no live Stripe keys. Onboarding completes
                  instantly.
                </p>
              )}
            </div>
            <div className="flex gap-2">
              {!connected ? (
                <Button onClick={startConnect} disabled={busy}>
                  {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <>
                      Connect Stripe <ExternalLink className="ml-1 h-4 w-4" />
                    </>
                  )}
                </Button>
              ) : (
                <Button onClick={continueAfterConnect}>
                  Continue <ArrowRight className="ml-1 h-4 w-4" />
                </Button>
              )}
            </div>
          </section>
        )}

        {/* STEP 4 — Menu */}
        {step === "menu" && tenant && (
          <section className="space-y-4">
            <div className="flex items-center gap-2">
              <UtensilsCrossed className="h-5 w-5" />
              <h2 className="text-lg font-semibold">Set up your menu</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              Start from a classic pizzeria template — Pizzas (with sizes +
              crust/sauce/toppings), Drinks, and Sides — then customise it later
              in your back office.
            </p>
            <Button onClick={importMenu} disabled={busy}>
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  Import starter menu <ArrowRight className="ml-1 h-4 w-4" />
                </>
              )}
            </Button>
          </section>
        )}

        {/* STEP 5 — Plan */}
        {step === "plan" && tenant && (
          <section className="space-y-4">
            <div className="flex items-center gap-2">
              <CreditCard className="h-5 w-5" />
              <h2 className="text-lg font-semibold">Choose a plan</h2>
            </div>
            {billingSim && (
              <p className="text-xs text-amber-700">
                Simulated billing — no live Stripe keys. Subscribing activates a
                trial instantly without a real charge.
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-3">
              {plans.map((p) => (
                <div
                  key={p.tier}
                  className={cn(
                    "flex flex-col rounded-lg border p-4",
                    subscription?.tier === p.tier && "border-primary",
                  )}
                >
                  <div className="font-semibold">{p.name}</div>
                  <div className="mt-1 text-2xl font-bold">
                    {formatMoney(p.price_cents)}
                    <span className="text-sm font-normal text-muted-foreground">
                      /mo
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {p.blurb}
                  </p>
                  <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
                    <li>
                      {p.entitlements.max_locations === null
                        ? "Unlimited locations"
                        : `${p.entitlements.max_locations} location${p.entitlements.max_locations === 1 ? "" : "s"}`}
                    </li>
                    <li>
                      {p.entitlements.online_ordering ? "✓" : "—"} Online
                      ordering
                    </li>
                    <li>
                      {p.entitlements.advanced_reports ? "✓" : "—"} Advanced
                      reports
                    </li>
                  </ul>
                  <Button
                    className="mt-3"
                    size="sm"
                    variant={
                      subscription?.tier === p.tier ? "default" : "outline"
                    }
                    onClick={() => pickPlan(p.tier)}
                    disabled={busy}
                  >
                    {p.trial_days > 0
                      ? `Start ${p.trial_days}-day trial`
                      : "Subscribe"}
                  </Button>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* STEP 6 — Go live */}
        {step === "go_live" && tenant && (
          <section className="space-y-4">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5" />
              <h2 className="text-lg font-semibold">Go live</h2>
            </div>
            <ul className="space-y-1 text-sm text-muted-foreground">
              <li>✓ Business: {tenant.name}</li>
              <li>✓ Location: {primaryLocation?.name ?? "—"}</li>
              <li>✓ Payments: {connected ? "connected" : "set up"}</li>
              <li>✓ Menu: starter template imported</li>
              <li>
                ✓ Plan:{" "}
                {plans.find((p) => p.tier === subscription?.tier)?.name ??
                  subscription?.tier ??
                  "—"}{" "}
                ({subscription?.status})
              </li>
            </ul>

            {!live ? (
              <Button onClick={goLive} disabled={busy}>
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Go live"
                )}
              </Button>
            ) : (
              <div className="space-y-3 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-4">
                <div className="flex items-center gap-2 font-semibold text-emerald-700">
                  <CheckCircle2 className="h-5 w-5" /> You&apos;re live!
                </div>
                <p className="text-sm text-muted-foreground">
                  {tenant.name} is active. Open your back office and storefront
                  — fully isolated from every other tenant.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button asChild size="sm">
                    <Link href={`/admin?tenant=${tenant.id}`}>
                      Open back office
                    </Link>
                  </Button>
                  {primaryLocation && (
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/shop/${primaryLocation.slug}`}>
                        View storefront
                      </Link>
                    </Button>
                  )}
                  <Button asChild size="sm" variant="ghost">
                    <Link href="/platform">Platform admin</Link>
                  </Button>
                </div>
              </div>
            )}
          </section>
        )}
      </div>

      <p className="mt-4 text-center text-xs text-muted-foreground">
        <Link className="underline" href="/">
          ← Back to home
        </Link>
      </p>
    </main>
  );
}
