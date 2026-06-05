/**
 * Print-friendly kitchen ticket (client). Auto-opens the browser print dialog
 * on mount and prints a compact, receipt-width ticket. The `print:` Tailwind
 * variants + a tiny print stylesheet strip everything but the ticket so it fits
 * a standard kitchen printer roll. This is the `browserPrinter` path of the
 * printer seam (see `@/lib/printing/provider`); a network printer would render
 * the same data to ESC/POS instead.
 */
"use client";

import { useEffect } from "react";
import type { Order } from "@/lib/db";
import { channelLabel } from "@/lib/kds/format";
import { TicketItems } from "../../components/ticket-items";

export function PrintView({ order }: { order: Order }) {
  useEffect(() => {
    // Defer to next frame so layout settles before the print dialog opens.
    const handle = window.setTimeout(() => window.print(), 250);
    return () => window.clearTimeout(handle);
  }, []);

  const placed = new Date(order.created_at);

  return (
    <div className="mx-auto max-w-sm p-4 font-mono text-sm">
      <div className="mb-2 flex items-center justify-between print:hidden">
        <a href="/kitchen" className="text-sm underline">
          ← Back to board
        </a>
        <button
          onClick={() => window.print()}
          className="rounded-md border px-3 py-1 text-sm"
        >
          Print
        </button>
      </div>

      <div className="ticket border border-dashed p-3 print:border-0 print:p-0">
        <header className="border-b border-dashed pb-2 text-center">
          <h1 className="text-lg font-bold">KITCHEN TICKET</h1>
          <p className="text-2xl font-extrabold tracking-wide">
            {order.order_number}
          </p>
          <p className="text-xs">{channelLabel(order.channel)}</p>
          <p className="text-xs">
            {placed.toLocaleDateString()} {placed.toLocaleTimeString()}
          </p>
        </header>

        <div className="py-2">
          <TicketItems items={order.items} />
        </div>

        {order.notes && (
          <p className="border-t border-dashed pt-2 text-xs font-semibold">
            NOTE: {order.notes}
          </p>
        )}

        <footer className="mt-2 border-t border-dashed pt-2 text-center text-[10px] uppercase">
          {order.items.filter((i) => !i.voided).length} item(s) · station copy
        </footer>
      </div>
    </div>
  );
}
