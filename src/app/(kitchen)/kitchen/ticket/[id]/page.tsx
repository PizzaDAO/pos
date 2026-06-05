/**
 * Printed kitchen ticket route (Phase 3, optional path).
 *
 * Server component: resolves the order via the DB abstraction, then hands it to
 * the client `PrintView` which renders a receipt-width ticket and auto-opens the
 * browser print dialog. This is the browser-printer path of the printer seam
 * (`@/lib/printing/provider`); a network-printer implementation would dispatch
 * ESC/POS to a device behind the same interface (documented, not wired — no
 * device + no env in the preview).
 */
import Link from "next/link";
import { getPosDriver } from "@/lib/db";
import { PrintView } from "./print-view";

export const runtime = "nodejs";

export default async function TicketPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const driver = getPosDriver();
  const order = await driver.getOrder(id);

  if (!order) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-muted-foreground">
          Order not found. It may have aged off this server instance (mock data
          is not persisted across serverless cold starts).
        </p>
        <Link className="text-sm underline" href="/kitchen">
          ← Back to kitchen board
        </Link>
      </main>
    );
  }

  return <PrintView order={order} />;
}
