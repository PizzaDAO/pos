/**
 * Card readers panel (Admin > Payments), next to Stripe Connect onboarding.
 *
 * Sets up in-store card payments for ONE location: the structured address Stripe
 * needs for its Terminal Location, how tips are collected (on the reader, on the
 * till, or not at all), and the registered readers. A reader is added by the
 * pairing code it shows (S700: Settings -> Generate pairing code). In Stripe TEST
 * mode a simulated reader can be added with one click; with no Stripe key every
 * location already has a built-in simulated reader. Owner/manager only (the API
 * enforces it).
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { CreditCard, Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type Mode = "simulated" | "stripe_test" | "stripe_live";
type TipMode = "reader" | "pos" | "none";

interface Reader {
  id: string;
  label: string;
  deviceType: string | null;
  serialNumber: string | null;
  status: "online" | "offline" | "unknown";
  simulated: boolean;
}

interface Address {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postal_code: string;
  country?: string;
}

interface Setup {
  mode: Mode;
  tipMode: TipMode;
  address: Address | null;
  hasTerminalLocation: boolean;
  ready: boolean;
  notReadyReason: "connect_not_ready" | "no_reader" | null;
  readers: Reader[];
}

const TIP_MODE_LABELS: Record<TipMode, string> = {
  reader: "On the card reader (customer chooses)",
  pos: "On the till (cashier enters)",
  none: "No tipping on cards",
};

const EMPTY_ADDRESS: Address = {
  line1: "",
  line2: "",
  city: "",
  state: "",
  postal_code: "",
};

async function readJson<T>(res: Response): Promise<T & { error?: string }> {
  return (await res.json().catch(() => ({}))) as T & { error?: string };
}

export function CardReaders({
  tenantId,
  locationId,
}: {
  tenantId: string;
  locationId: string;
}) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [address, setAddress] = useState<Address>(EMPTY_ADDRESS);
  const [tipMode, setTipMode] = useState<TipMode>("reader");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");

  const query = `tenantId=${encodeURIComponent(tenantId)}&locationId=${encodeURIComponent(locationId)}`;

  const apply = useCallback((data: Setup) => {
    setSetup(data);
    setAddress({ ...EMPTY_ADDRESS, ...(data.address ?? {}) });
    setTipMode(data.tipMode);
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/terminal?${query}`);
      const data = await readJson<Setup>(res);
      if (!res.ok) {
        setError(data.error ?? `Failed to load card readers (HTTP ${res.status}).`);
        return;
      }
      setError(null);
      apply(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load card readers.");
    }
  }, [query, apply]);

  useEffect(() => {
    setSetup(null);
    void load();
  }, [load]);

  /** Run a request, surface its error, and reload on success. */
  async function run(fn: () => Promise<Response>, onOk?: () => void) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fn();
      const data = await readJson<Record<string, unknown>>(res);
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      onOk?.();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  function saveSetup() {
    void run(
      () =>
        fetch("/api/admin/terminal", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tenantId,
            locationId,
            // The address is only needed (and validated) for real Stripe modes.
            ...(setup?.mode !== "simulated" ? { address } : {}),
            tipMode,
          }),
        }),
      () => setSaved(true),
    );
  }

  function addReader(registrationCode: string, readerLabel: string) {
    void run(
      () =>
        fetch("/api/admin/terminal/readers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tenantId,
            locationId,
            registrationCode,
            label: readerLabel,
          }),
        }),
      () => {
        setShowAdd(false);
        setCode("");
        setLabel("");
      },
    );
  }

  function removeReader(r: Reader) {
    if (!window.confirm(`Remove ${r.label}? It will stop taking card payments here.`)) {
      return;
    }
    void run(() =>
      fetch(`/api/admin/terminal/readers/${encodeURIComponent(r.id)}?${query}`, {
        method: "DELETE",
      }),
    );
  }

  const field =
    "w-full rounded-md border bg-background px-2 py-1.5 text-sm";
  const mode = setup?.mode;
  const notReady = setup?.notReadyReason === "connect_not_ready";
  const canAdd = !!setup?.hasTerminalLocation && !notReady;

  return (
    <div className="mx-auto max-w-xl space-y-4 px-6 pb-6">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-bold">
          <CreditCard className="h-5 w-5" aria-hidden="true" /> Card readers
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Take in-store card payments on a Stripe card reader (S700). The reader
          needs internet; when the shop is offline the till is cash-only.
        </p>
      </div>

      {mode === "simulated" && (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-amber-700">
          <strong>Simulated</strong> — no Stripe key is configured, so every
          location has one built-in simulated reader. The till shows Simulate
          approve / decline buttons instead of a real card tap.
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      {!setup && !error && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      )}

      {setup && notReady && (
        <div
          data-testid="card-readers-not-ready"
          className="rounded-md border p-3 text-sm"
        >
          Card payments aren&apos;t enabled yet. Finish Stripe Connect onboarding
          above (charges must be enabled), then come back to add a reader.
        </div>
      )}

      {setup && (
        <div className="space-y-3 rounded-lg border p-4">
          <div className="text-sm font-medium">Location setup</div>
          {mode !== "simulated" && (
            <div className="grid grid-cols-6 gap-2">
              <input
                aria-label="Street address"
                placeholder="Street address"
                className={cn(field, "col-span-6")}
                value={address.line1}
                onChange={(e) => setAddress({ ...address, line1: e.target.value })}
              />
              <input
                aria-label="Address line 2"
                placeholder="Suite, floor (optional)"
                className={cn(field, "col-span-6")}
                value={address.line2 ?? ""}
                onChange={(e) => setAddress({ ...address, line2: e.target.value })}
              />
              <input
                aria-label="City"
                placeholder="City"
                className={cn(field, "col-span-3")}
                value={address.city}
                onChange={(e) => setAddress({ ...address, city: e.target.value })}
              />
              <input
                aria-label="State"
                placeholder="State"
                maxLength={2}
                className={cn(field, "col-span-1 uppercase")}
                value={address.state}
                onChange={(e) =>
                  setAddress({ ...address, state: e.target.value.toUpperCase() })
                }
              />
              <input
                aria-label="ZIP code"
                placeholder="ZIP"
                inputMode="numeric"
                className={cn(field, "col-span-2")}
                value={address.postal_code}
                onChange={(e) =>
                  setAddress({ ...address, postal_code: e.target.value })
                }
              />
            </div>
          )}
          <label className="block space-y-1 text-sm">
            <span className="text-muted-foreground">Card tips</span>
            <select
              aria-label="Card tips"
              className={field}
              value={tipMode}
              onChange={(e) => setTipMode(e.target.value as TipMode)}
            >
              {(Object.keys(TIP_MODE_LABELS) as TipMode[]).map((m) => (
                <option key={m} value={m}>
                  {TIP_MODE_LABELS[m]}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-center gap-3">
            <Button onClick={saveSetup} disabled={busy || notReady}>
              {busy ? "Saving…" : "Save"}
            </Button>
            {saved && <span className="text-sm text-emerald-700">Saved</span>}
          </div>
        </div>
      )}

      {setup && !notReady && (
        <div className="space-y-3 rounded-lg border p-4">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">Readers</div>
            {mode !== "simulated" && (
              <div className="flex gap-2">
                {mode === "stripe_test" && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || !canAdd}
                    onClick={() => addReader("simulated-wpe", "Simulated reader")}
                  >
                    Add simulated reader
                  </Button>
                )}
                <Button
                  size="sm"
                  disabled={busy || !canAdd}
                  onClick={() => setShowAdd(true)}
                >
                  <Plus className="mr-1 h-4 w-4" aria-hidden="true" /> Add reader
                </Button>
              </div>
            )}
          </div>
          {mode !== "simulated" && !setup.hasTerminalLocation && (
            <p className="text-sm text-muted-foreground">
              Save the shop address first; readers are registered to it.
            </p>
          )}
          {setup.readers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No readers yet.</p>
          ) : (
            <ul className="divide-y">
              {setup.readers.map((r) => (
                <li
                  key={r.id}
                  data-testid="reader-row"
                  className="flex items-center justify-between gap-3 py-2 text-sm"
                >
                  <div>
                    <div className="font-medium">{r.label}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.simulated ? "Simulated" : (r.deviceType ?? "Card reader")}
                      {r.serialNumber ? ` · ${r.serialNumber}` : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-xs font-semibold uppercase",
                        r.status === "online"
                          ? "bg-emerald-500/15 text-emerald-700"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      {r.status}
                    </span>
                    {!r.simulated && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove ${r.label}`}
                        disabled={busy}
                        onClick={() => removeReader(r)}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {showAdd && (
        <Dialog
          onClose={() => setShowAdd(false)}
          labelledBy="add-reader-title"
        >
          <div className="w-full max-w-sm space-y-3 rounded-2xl bg-background p-5 shadow-xl">
            <h3 id="add-reader-title" className="text-base font-bold">
              Add a card reader
            </h3>
            <p className="text-sm text-muted-foreground">
              S700: Settings → Generate pairing code. Type the code it shows
              (like <code>apple-orange-banana</code>).
            </p>
            <input
              aria-label="Pairing code"
              placeholder="Pairing code"
              autoFocus
              className={field}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <input
              aria-label="Reader name"
              placeholder="Name (e.g. Front counter)"
              className={field}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowAdd(false)}>
                Cancel
              </Button>
              <Button
                disabled={busy || !code.trim()}
                onClick={() => addReader(code.trim(), label.trim())}
              >
                {busy ? "Adding…" : "Add reader"}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
