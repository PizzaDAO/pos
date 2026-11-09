/**
 * Stuck card refunds (/admin -> Late payments, below the late payments).
 *
 * Card refunds POS could not finish by itself: the card processor never gave a
 * clear answer (it stays "pending"), or a refund was recorded without its Stripe
 * id. "Check Stripe" looks it up (nothing changes); the manager then presses the
 * outcome Stripe supports: Confirm (Stripe has it: record it) or Release (Stripe
 * has none / failed it: the money is held again, refund it again or another
 * way). Backed by /api/admin/refunds/resolve; every action is audited.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { formatMoney } from "@/lib/pricing";

interface StuckRow {
  paymentId: string;
  orderId: string;
  refundId: string;
  amountCents: number;
  currency: string;
  at: string;
  kind: "pending" | "no_ref";
  pastWindow: boolean;
}

type Outcome = "confirmed" | "released" | "ref_recorded";

interface Check {
  outcome: Outcome;
  stripeRefund: { id: string; status: string; amount: number } | null;
}

const ACTION_LABEL: Record<Outcome, string> = {
  confirmed: "Confirm refund",
  released: "Release (not refunded)",
  ref_recorded: "Record Stripe id",
};

function rowKey(r: Pick<StuckRow, "paymentId" | "refundId">) {
  return `${r.paymentId}:${r.refundId}`;
}

export function StuckRefunds({ tenantId, locationId }: { tenantId: string; locationId: string }) {
  const [rows, setRows] = useState<StuckRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const [reIds, setReIds] = useState<Record<string, string>>({});
  const [asking, setAsking] = useState<StuckRow | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(
      `/api/admin/refunds/resolve?tenantId=${tenantId}&locationId=${locationId}`,
      { cache: "no-store" },
    );
    if (res.ok) setRows(((await res.json()) as { refunds: StuckRow[] }).refunds);
    else setError("Could not load stuck refunds.");
  }, [tenantId, locationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function call(row: StuckRow, extra: { dryRun?: boolean; expect?: Outcome }) {
    const key = rowKey(row);
    setBusy(key);
    setError(null);
    try {
      const stripeRefundId = reIds[key]?.trim() || undefined;
      const res = await fetch("/api/admin/refunds/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId,
          paymentId: row.paymentId,
          refundId: row.refundId,
          stripeRefundId,
          ...extra,
        }),
      });
      const d = (await res.json().catch(() => ({}))) as {
        error?: string;
        outcome?: Outcome;
        stripeRefund?: Check["stripeRefund"];
      };
      if (!res.ok) {
        setError(d.error ?? `HTTP ${res.status}`);
        setChecks(({ [key]: _drop, ...rest }) => rest);
        return;
      }
      if (extra.dryRun && d.outcome) {
        setChecks((c) => ({ ...c, [key]: { outcome: d.outcome!, stripeRefund: d.stripeRefund ?? null } }));
        return;
      }
      setChecks(({ [key]: _drop, ...rest }) => rest);
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (rows !== null && rows.length === 0 && !error) return null;

  return (
    <section className="space-y-4" data-testid="stuck-refunds">
      <div className="flex items-center gap-2">
        <RotateCcw className="h-5 w-5 text-amber-500" />
        <h2 className="text-lg font-semibold">Stuck card refunds</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        The card processor never confirmed these refunds. Check Stripe first, then press what it
        shows: <strong>Confirm</strong> if Stripe refunded it, <strong>Release</strong> if it did not
        (the money is held again; refund it again or another way). If you found the refund in the
        Stripe dashboard, paste its <code>re_</code> id.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {rows === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => {
            const key = rowKey(row);
            const check = checks[key];
            return (
              <li key={key} className="space-y-2 rounded-lg border p-3" data-testid="stuck-refund-row">
                <div className="text-sm">
                  <div className="font-semibold">
                    {formatMoney(row.amountCents, row.currency)} ·{" "}
                    {row.kind === "pending" ? "outcome unknown" : "no Stripe id recorded"}
                    {row.pastWindow ? " · over a day old" : ""}
                  </div>
                  <div className="text-muted-foreground">
                    Order {row.orderId.slice(0, 8)} · asked {new Date(row.at).toLocaleString()}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    className="w-56 rounded-md border bg-background px-3 py-1.5 text-sm"
                    placeholder="re_… (optional)"
                    aria-label="Stripe refund id"
                    value={reIds[key] ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      setReIds((m) => ({ ...m, [key]: v }));
                      setChecks(({ [key]: _drop, ...rest }) => rest);
                    }}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy === key}
                    onClick={() => void call(row, { dryRun: true })}
                  >
                    Check Stripe
                  </Button>
                  {check && (
                    <Button
                      size="sm"
                      variant={check.outcome === "released" ? "destructive" : "default"}
                      disabled={busy === key}
                      onClick={() =>
                        check.outcome === "released"
                          ? setAsking(row)
                          : void call(row, { expect: check.outcome })
                      }
                    >
                      {ACTION_LABEL[check.outcome]}
                    </Button>
                  )}
                </div>
                {check && (
                  <p className="text-sm" data-testid="stuck-refund-check">
                    {check.stripeRefund
                      ? `Stripe: ${check.stripeRefund.id} is ${check.stripeRefund.status} (${formatMoney(check.stripeRefund.amount, row.currency)}).`
                      : "Stripe has no refund for this: nothing was returned."}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {asking && (
        <ConfirmDialog
          title="Release this refund?"
          description="Stripe shows no completed refund: POS will treat the money as NOT returned. Refund it again or another way."
          confirmLabel="Release"
          onCancel={() => setAsking(null)}
          onConfirm={() => {
            const row = asking;
            setAsking(null);
            void call(row, { expect: "released" });
          }}
        />
      )}
    </section>
  );
}
