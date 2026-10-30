/**
 * Late payments (/admin -> Late payments).
 *
 * Lists online orders where the customer's money settled AFTER the checkout had
 * expired (the order was abandoned, so it never reached the kitchen). The owner
 * or manager either Accepts (promotes the order to paid and sends it to the
 * kitchen) or Refunds. Backed by /api/admin/late-payments.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import type { Order, Payment } from "@/lib/db";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/pricing";

interface Row {
  order: Order;
  payments: (Payment & { return_address: string | null; manual_refund: boolean })[];
}

export function LatePayments({
  tenantId,
  locationId,
}: {
  tenantId: string;
  locationId: string;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(
      `/api/admin/late-payments?tenantId=${tenantId}&locationId=${locationId}`,
      { cache: "no-store" },
    );
    if (res.ok) {
      setRows(((await res.json()) as { latePayments: Row[] }).latePayments);
    } else {
      setError("Could not load late payments.");
    }
  }, [tenantId, locationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function resolve(
    orderId: string,
    action: "accept" | "refund" | "mark_refunded",
  ) {
    setBusy(orderId);
    setError(null);
    try {
      const res = await fetch("/api/admin/late-payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, action }),
      });
      const d = (await res.json().catch(() => ({}))) as {
        error?: string;
        note?: string;
      };
      if (!res.ok) setError(d.error ?? `HTTP ${res.status}`);
      else if (d.note) setError(d.note);
      await load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-5 w-5 text-amber-500" />
        <h2 className="text-lg font-semibold">Late payments</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        These customers paid after their checkout expired, so the order was never
        sent to the kitchen. Accept to cook it, or refund the payment.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {rows === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="no-late-payments">
          No late payments.
        </p>
      ) : (
        <ul className="space-y-3">
          {rows.map(({ order, payments }) => {
            const m = order.fulfillment?.late_payment;
            const owed = m?.resolved === "refund_owed_manual";
            const duplicate = m?.kind === "duplicate";
            const manual = payments.filter((p) => p.manual_refund);
            return (
              <li
                key={order.id}
                className="space-y-2 rounded-lg border p-3"
                data-testid="late-payment-row"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm">
                    <div className="font-semibold">
                      {duplicate ? "Duplicate payment, refund one" : "Late payment"} ·
                      Order {order.order_number} ·{" "}
                      {formatMoney(m?.amount_cents ?? 0, order.currency)}
                    </div>
                    <div className="text-muted-foreground">
                      {order.status} · {payments.length} payment
                      {payments.length === 1 ? "" : "s"} · flagged{" "}
                      {m ? new Date(m.flagged_at).toLocaleString() : ""}
                      {m?.claim ? ` · ${m.claim}…` : ""}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    {owed ? (
                      <Button
                        size="sm"
                        disabled={busy === order.id}
                        onClick={() => void resolve(order.id, "mark_refunded")}
                      >
                        Mark refunded
                      </Button>
                    ) : (
                      <>
                        {!duplicate && (
                          <Button
                            size="sm"
                            disabled={busy === order.id || order.status !== "abandoned"}
                            onClick={() => void resolve(order.id, "accept")}
                          >
                            Accept
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy === order.id}
                          onClick={() => void resolve(order.id, "refund")}
                        >
                          Refund
                        </Button>
                      </>
                    )}
                  </div>
                </div>
                {owed && (
                  <div
                    className="rounded-md border border-amber-500/60 bg-amber-500/10 p-2 text-sm"
                    data-testid="manual-refund-instructions"
                  >
                    <p className="font-medium">
                      Refund owed by hand: no money has been sent.
                    </p>
                    <ul className="mt-1 list-disc pl-5">
                      {(m?.manual_refunds ?? []).map((r) => {
                        const p = manual.find((x) => x.id === r.payment_id);
                        return (
                          <li key={r.payment_id}>
                            Send {formatMoney(r.amount_cents, order.currency)} back
                            {p?.return_address
                              ? ` to ${p.return_address}`
                              : " (no return address on file: ask the customer)"}
                            {p?.crypto_tx_hash ? ` · tx ${p.crypto_tx_hash}` : ""}
                            {p?.rail === "crypto_coinbase" && (
                              <>
                                {" · "}
                                <a
                                  className="underline"
                                  href="https://commerce.coinbase.com/dashboard/payments"
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  open Coinbase
                                </a>
                              </>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                    <p className="mt-1 text-muted-foreground">
                      Press Mark refunded after you have sent it.
                    </p>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
