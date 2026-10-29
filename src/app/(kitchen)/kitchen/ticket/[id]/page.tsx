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
import { redirect } from "next/navigation";
import { getPosDriver } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth/session";
import { canEnterSurface } from "@/lib/auth/roles";
import { PrintView } from "./print-view";

export const runtime = "nodejs";

export default async function TicketPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // The ticket must belong to a tenant the session may run a kitchen for —
  // never print another tenant's order by guessing/sharing its id.
  const user = await getCurrentUser();
  if (!user) redirect("/login?redirect=/kitchen");
  const driver = getPosDriver();
  const found = await driver.getOrder(id).catch(() => null);
  const order =
    found && canEnterSurface(user.memberships, "kitchen", found.tenant_id)
      ? found
      : null;

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
