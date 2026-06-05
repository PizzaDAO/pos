/**
 * Kitchen-ticket printer abstraction (Phase 3) — provider seam, STUB only.
 *
 * Mirrors the realtime/payment-rail pattern: components/routes depend on a
 * `TicketPrinter` interface, never on a concrete device. Today the only
 * implementation is `browserPrinter` (renders a print-friendly page the cashier
 * prints via the browser dialog — no device, no env). A real network-printer
 * implementation (ESC/POS over TCP, Star CloudPRNT, PrintNode, etc.) drops in
 * later behind the SAME interface without touching the print route or the board.
 *
 * NOTHING here makes external calls. The network implementation is documented
 * but intentionally NOT wired (the preview has no printer + no env).
 */
import type { Order } from "@/lib/db";

export interface PrintResult {
  ok: boolean;
  /** How the ticket was handled ("browser" today; "network" once wired). */
  via: "browser" | "network" | "noop";
  message: string;
}

export interface TicketPrinter {
  readonly name: "browser" | "network";
  /**
   * Dispatch a ticket for `order`. The browser printer is a no-op on the server
   * (the actual print happens client-side via `window.print()` in the print
   * view); a network printer would format ESC/POS bytes and POST them to the
   * device here.
   */
  print(order: Order): Promise<PrintResult>;
}

/** Default browser printer: relies on the print route + `window.print()`. */
export const browserPrinter: TicketPrinter = {
  name: "browser",
  async print(): Promise<PrintResult> {
    return {
      ok: true,
      via: "browser",
      message: "Rendered print-friendly ticket; use the browser print dialog.",
    };
  },
};

/**
 * Selection seam. With no printer env configured (the default/preview) this is
 * always the browser printer. A future network implementation:
 *
 *   if (process.env.KITCHEN_PRINTER_URL) return createNetworkPrinter({...});
 *
 * — formats the ticket as ESC/POS and POSTs to KITCHEN_PRINTER_URL. Documented
 * in `.env.example`; absence → browser/stub path.
 */
export function getTicketPrinter(): TicketPrinter {
  return browserPrinter;
}
