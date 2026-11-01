/**
 * Simulated pay page for a `/v1` payment session. Only renders on a deployment
 * with simulated card rails (zero-env preview, CI, training); 404 otherwise, and
 * 404 for any session that is not itself simulated. No real card is ever taken.
 */
import { notFound } from "next/navigation";
import { getSimulatedSession } from "@/lib/core/sim-session";

export const dynamic = "force-dynamic";

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(cents / 100);
}

export default async function SimulatedPayPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getSimulatedSession(id);
  if (!session) notFound();
  const open = session.status === "open" && Date.parse(session.expires_at) > Date.now();
  const total = session.amount_cents + session.tip_cents;
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
      <p className="rounded bg-amber-100 px-3 py-2 text-sm text-amber-900">
        Simulated payment. No real card is charged.
      </p>
      <h1 className="text-xl font-semibold">Pay {money(total, session.currency)}</h1>
      {session.tip_cents > 0 ? (
        <p className="text-sm text-neutral-600">
          Includes a {money(session.tip_cents, session.currency)} tip.
        </p>
      ) : null}
      {open ? (
        <form method="post" action={`/api/payment-sessions/${session.id}/simulate`}>
          <button
            type="submit"
            className="w-full rounded bg-black px-4 py-3 text-white"
          >
            Pay (simulated)
          </button>
        </form>
      ) : (
        <p className="text-sm">
          {session.status === "completed"
            ? "This payment is complete."
            : "This payment link is no longer open."}
        </p>
      )}
    </main>
  );
}
