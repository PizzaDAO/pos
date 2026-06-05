/**
 * On-screen receipt — full breakdown (items + modifiers incl. half-and-half,
 * discount, tax, tip, platform fee, each tender + change). Print/email/SMS are
 * stubs (no real sending in Phase 2).
 */
"use client";

import { Printer, Mail, MessageSquare } from "lucide-react";
import type { Order, Payment } from "@/lib/db";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/pricing";
import { buildReceipt } from "@/lib/payments/receipt";

export function ReceiptView({
  order,
  payments,
}: {
  order: Order;
  payments: Payment[];
}) {
  const r = buildReceipt(order, payments);
  const c = r.currency;

  function stub(channel: string) {
    // Stubbed — no real sending in Phase 2.
    window.alert(`${channel} receipt for order ${r.orderNumber} (stub — not sent).`);
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-background p-4 font-mono text-sm">
        <div className="text-center">
          <div className="text-base font-bold">Tony&apos;s Pizza</div>
          <div className="text-xs text-muted-foreground">Order {r.orderNumber}</div>
        </div>
        <hr className="my-3 border-dashed" />

        <ul className="space-y-1">
          {r.lines.map((line, i) => (
            <li key={i}>
              <div className="flex justify-between">
                <span>
                  {line.quantity}× {line.name}
                </span>
                <span>{formatMoney(line.lineTotalCents, c)}</span>
              </div>
              {line.modifiers && (
                <div className="pl-4 text-xs text-muted-foreground">
                  {line.modifiers}
                </div>
              )}
              {line.notes && (
                <div className="pl-4 text-xs italic text-muted-foreground">
                  “{line.notes}”
                </div>
              )}
            </li>
          ))}
        </ul>

        <hr className="my-3 border-dashed" />

        <dl className="space-y-1">
          <Row label="Subtotal" value={formatMoney(r.subtotalCents, c)} />
          {r.discountCents > 0 && (
            <Row label="Discount" value={`−${formatMoney(r.discountCents, c)}`} />
          )}
          <Row label="Tax" value={formatMoney(r.taxCents, c)} />
          {r.tipCents > 0 && <Row label="Tip" value={formatMoney(r.tipCents, c)} />}
          <div className="flex justify-between border-t pt-1 font-bold">
            <dt>Total</dt>
            <dd>{formatMoney(r.totalCents, c)}</dd>
          </div>
        </dl>

        {r.tenders.length > 0 && (
          <>
            <hr className="my-3 border-dashed" />
            <div className="text-xs font-semibold uppercase text-muted-foreground">
              Tenders
            </div>
            <dl className="mt-1 space-y-1">
              {r.tenders.map((t, i) => (
                <div key={i}>
                  <div className="flex justify-between">
                    <dt>
                      {t.label}
                      {t.simulated && (
                        <span className="ml-1 text-[10px] uppercase text-amber-600">
                          sim
                        </span>
                      )}
                      <span className="ml-1 text-[10px] uppercase text-muted-foreground">
                        {t.status}
                      </span>
                    </dt>
                    <dd>{formatMoney(t.amountCents, c)}</dd>
                  </div>
                  {t.changeCents !== null && t.changeCents > 0 && (
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <dt>Change</dt>
                      <dd>{formatMoney(t.changeCents, c)}</dd>
                    </div>
                  )}
                </div>
              ))}
            </dl>
          </>
        )}

        {r.applicationFeeCents > 0 && (
          <div className="mt-2 flex justify-between text-[10px] text-muted-foreground">
            <span>Platform fee (incl.)</span>
            <span>{formatMoney(r.applicationFeeCents, c)}</span>
          </div>
        )}

        {r.balanceCents > 0 ? (
          <div className="mt-3 flex justify-between font-bold text-amber-600">
            <span>Balance due</span>
            <span>{formatMoney(r.balanceCents, c)}</span>
          </div>
        ) : (
          <div className="mt-3 text-center text-xs font-semibold uppercase text-emerald-600">
            Paid in full
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Button variant="outline" size="sm" onClick={() => stub("Print")}>
          <Printer className="mr-1 h-4 w-4" /> Print
        </Button>
        <Button variant="outline" size="sm" onClick={() => stub("Email")}>
          <Mail className="mr-1 h-4 w-4" /> Email
        </Button>
        <Button variant="outline" size="sm" onClick={() => stub("SMS")}>
          <MessageSquare className="mr-1 h-4 w-4" /> SMS
        </Button>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
