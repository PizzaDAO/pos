/**
 * Print-friendly kitchen ticket (client). Auto-opens the browser print dialog
 * on mount and prints a compact, receipt-width ticket. The `print:` Tailwind
 * variants + a tiny print stylesheet strip everything but the ticket so it fits
 * a standard kitchen printer roll. This is the `browserPrinter` path of the
 * printer seam (see `@/lib/printing/provider`); a network printer would render
 * the same data to ESC/POS instead.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Order } from "@/lib/db";
import { channelLabel } from "@/lib/kds/format";
import { TicketItems } from "../../components/ticket-items";

export function PrintView({
  order,
  networkPrinters = 0,
}: {
  order: Order;
  /** Registered network printers at the order's location; 0 = browser printing. */
  networkPrinters?: number;
}) {
  const [net, setNet] = useState<{ state: "idle" | "sending" | "sent" | "error"; message?: string }>(
    { state: "idle" },
  );
  const sentOnce = useRef(false);

  const sendToPrinter = useCallback(
    async (reprint: boolean) => {
      setNet({ state: "sending" });
      try {
        const res = await fetch("/api/kitchen/print", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderId: order.id, reprint }),
        });
        const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        if (!res.ok) throw new Error(data.error ?? data.message ?? `HTTP ${res.status}`);
        setNet({ state: "sent", message: data.message });
      } catch (e) {
        setNet({ state: "error", message: e instanceof Error ? e.message : "Could not print." });
      }
    },
    [order.id],
  );

  useEffect(() => {
    if (networkPrinters > 0) {
      // Send once per visit; "Reprint" is an explicit second ticket.
      if (!sentOnce.current) {
        sentOnce.current = true;
        void sendToPrinter(false);
      }
      return;
    }
    // Defer to next frame so layout settles before the print dialog opens.
    const handle = window.setTimeout(() => window.print(), 250);
    return () => window.clearTimeout(handle);
  }, [networkPrinters, sendToPrinter]);

  const placed = new Date(order.created_at);

  return (
    <div className="mx-auto max-w-sm p-4 font-mono text-sm">
      <div className="mb-2 flex items-center justify-between print:hidden">
        <a href="/kitchen" className="text-sm underline">
          ← Back to board
        </a>
        <div className="flex gap-2">
          {networkPrinters > 0 && (
            <button
              onClick={() => void sendToPrinter(true)}
              disabled={net.state === "sending"}
              className="rounded-md border px-3 py-1 text-sm"
            >
              Reprint
            </button>
          )}
          <button
            onClick={() => window.print()}
            className="rounded-md border px-3 py-1 text-sm"
          >
            {networkPrinters > 0 ? "Browser print" : "Print"}
          </button>
        </div>
      </div>
      {networkPrinters > 0 && (
        <p
          role="status"
          className={`mb-2 text-xs print:hidden ${net.state === "error" ? "text-destructive" : "text-muted-foreground"}`}
        >
          {net.state === "sending" && "Sending to kitchen printer…"}
          {net.state === "sent" && `Sent to kitchen printer. ${net.message ?? ""}`}
          {net.state === "error" && `Kitchen printer: ${net.message}. Use Browser print.`}
        </p>
      )}

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
