/**
 * Approval limits for refunds, comps/discounts and voids at one location
 * (GET/POST /api/admin/adjustment-policy). A cashier may act alone up to each
 * limit; above it an owner or manager approves by PIN at the till. 0 = always.
 * Only the owner can save (the API enforces it).
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import type { AdjustmentPolicy } from "@/lib/db";
import { Button } from "@/components/ui/button";

const FIELDS: { key: keyof AdjustmentPolicy; label: string }[] = [
  { key: "refund_approval_cents", label: "Refunds up to" },
  { key: "comp_approval_cents", label: "Comps / discounts up to" },
  { key: "void_approval_cents", label: "Voids of food already sent up to" },
];

export function ApprovalLimits({ tenantId, locationId }: { tenantId: string; locationId: string }) {
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(
      `/api/admin/adjustment-policy?tenantId=${encodeURIComponent(tenantId)}&locationId=${encodeURIComponent(locationId)}`,
    );
    if (!res.ok) return;
    const { policy } = (await res.json()) as { policy: AdjustmentPolicy };
    setValues(
      Object.fromEntries(FIELDS.map((f) => [f.key, (policy[f.key] / 100).toFixed(2)])),
    );
  }, [tenantId, locationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!values) return;
    setBusy(true);
    setMsg(null);
    try {
      const body: Record<string, unknown> = { tenantId, locationId };
      for (const f of FIELDS) body[f.key] = Math.max(0, Math.round(parseFloat(values[f.key] ?? "0") * 100) || 0);
      const res = await fetch("/api/admin/adjustment-policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { error?: string };
      setMsg(res.ok ? "Saved." : (data.error ?? "Could not save."));
      if (res.ok) await load();
    } finally {
      setBusy(false);
    }
  }

  if (!values) return null;
  return (
    <section className="rounded-xl border p-4" aria-labelledby="approval-limits-title">
      <div className="mb-1 flex items-center gap-2">
        <ShieldCheck className="h-4 w-4" aria-hidden="true" />
        <h3 id="approval-limits-title" className="text-sm font-semibold">
          Approval limits (this location)
        </h3>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        A cashier can do these alone up to the amount; above it an owner or manager
        approves with their PIN. $0.00 = always needs a manager.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        {FIELDS.map((f) => (
          <label key={f.key} className="text-sm">
            <span className="text-muted-foreground">{f.label} ($)</span>
            <input
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              value={values[f.key]}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
              className="mt-1 h-10 w-full rounded-md border bg-background px-2 text-right"
            />
          </label>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button size="sm" disabled={busy} onClick={() => void save()}>
          Save limits
        </Button>
        {msg && (
          <span role="status" className="text-xs text-muted-foreground">
            {msg}
          </span>
        )}
      </div>
    </section>
  );
}
