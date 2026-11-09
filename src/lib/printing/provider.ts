/**
 * Kitchen-ticket printer abstraction: provider seam.
 *
 * Components/routes depend on `TicketPrinter`, never on a concrete device.
 *  - `browserPrinter`: renders a print-friendly page the cashier prints through
 *    the browser dialog (no device, no env). The fallback.
 *  - `networkPrinter`: queues the ticket for the location's registered
 *    printers. Printers PULL jobs over HTTPS (Star CloudPRNT, Epson Server
 *    Direct Print), so this works from serverless with no inbound connection to
 *    the shop. See `queue.ts` and the routes under `src/app/api/print/`.
 *
 * `resolveTicketPrinter` picks network when the location has at least one
 * printer, else browser. Nothing here makes an outbound call.
 */
import type { Order } from "@/lib/db";
import { getPosDriver } from "@/lib/db";
import { enqueueOrderTicket } from "./queue";

export interface PrintResult {
  ok: boolean;
  /** How the ticket was handled. */
  via: "browser" | "network" | "noop";
  message: string;
  /** Network only: how many printers the ticket was queued on. */
  queued?: number;
}

export interface TicketPrinter {
  readonly name: "browser" | "network";
  /**
   * Dispatch a ticket for `order`. The browser printer is a no-op on the server
   * (the print happens client-side via `window.print()` in the print view); the
   * network printer queues a job per printer at the order's location.
   */
  print(order: Order, opts?: { reprint?: boolean }): Promise<PrintResult>;
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

export const networkPrinter: TicketPrinter = {
  name: "network",
  async print(order, opts): Promise<PrintResult> {
    const jobs = await enqueueOrderTicket(order, { reprint: opts?.reprint });
    return jobs.length > 0
      ? {
          ok: true,
          via: "network",
          queued: jobs.length,
          message: `Queued on ${jobs.length} printer${jobs.length === 1 ? "" : "s"}.`,
        }
      : { ok: false, via: "noop", message: "No network printer is set up for this location." };
  },
};

/** Network printer when the location has one registered, else the browser fallback. */
export async function resolveTicketPrinter(
  tenantId: string,
  locationId: string,
): Promise<TicketPrinter> {
  const printers = await getPosDriver().listPrinters(tenantId, locationId);
  return printers.length > 0 ? networkPrinter : browserPrinter;
}
