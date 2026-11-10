/**
 * A single KDS ticket.
 *
 * - Border + header color reflect AGE (green/yellow/red), recomputed live from
 *   the still-ticking elapsed clock against the location thresholds (so a ticket
 *   "warms up" between polls without waiting for the next snapshot).
 * - Shows order number, channel, status badge, live elapsed mm:ss, line items
 *   (with half-and-half), and order notes.
 * - Bump advances status; a Ready ticket's primary action is the hand-off bump
 *   ("Picked up": ready → completed, which drops it off the board; in-house
 *   delivery goes "Out with driver" then "Delivered"; provider-run delivery has
 *   no hand-off button), with Recall as the secondary; Print opens the
 *   print-friendly ticket route.
 */
"use client";

import { memo, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { KdsThresholds } from "@/lib/db";
import { ageLevelFor, hasKitchenWork } from "@/lib/kds/board";
import { handoffLabel, isHandoffStatus, statusLabel } from "@/lib/kds/status";
import { channelLabel, formatElapsed } from "@/lib/kds/format";
import { orderTypeLabel } from "@/lib/till/order-meta";
import type { AgeLevel, KitchenTicket, StationFilter } from "@/lib/kds/types";
import { MarketplaceBadge } from "@/components/marketplace-badge";
import { TicketItems } from "./ticket-items";

const AGE_STYLES: Record<AgeLevel, { card: string; header: string }> = {
  fresh: {
    card: "border-emerald-500/70",
    header: "bg-emerald-50 text-emerald-900",
  },
  warn: {
    card: "border-amber-500/80",
    header: "bg-amber-50 text-amber-900",
  },
  urgent: {
    card: "border-red-600 ring-2 ring-red-500/40",
    header: "bg-red-100 text-red-900",
  },
};

/** Dark mode: a calm green Bump, not a solid-white slab (glare on a dark wall). */
const BUMP_DARK =
  "dark:border dark:border-emerald-600 dark:bg-emerald-900 dark:text-emerald-50 dark:hover:bg-emerald-800";

const READY_STYLE = {
  card: "border-muted-foreground/40",
  header: "bg-muted text-foreground",
};

/** Elapsed seconds right now, anchored on created_at (independent of polls). */
function useLiveElapsed(createdAtIso: string): number {
  const compute = () =>
    Math.max(
      0,
      Math.floor((Date.now() - new Date(createdAtIso).getTime()) / 1000),
    );
  const [elapsed, setElapsed] = useState(compute);
  useEffect(() => {
    setElapsed(compute());
    const handle = setInterval(() => setElapsed(compute()), 1000);
    return () => clearInterval(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createdAtIso]);
  return elapsed;
}

function TicketCardImpl({
  ticket,
  thresholds,
  stationFilter,
  onBump,
  onRecall,
  onNoPrepHandoff,
  busy,
}: {
  ticket: KitchenTicket;
  thresholds: KdsThresholds;
  stationFilter: StationFilter;
  onBump: (orderId: string) => void;
  onRecall: (orderId: string) => void;
  /** Hand off a drink-only ticket (no station has anything to make). */
  onNoPrepHandoff: (orderId: string) => void;
  busy: boolean;
}) {
  const { order } = ticket;
  // Nothing for any station (e.g. just a soda): shown compact, hand off in one tap.
  const noPrep =
    !hasKitchenWork(order) &&
    !isHandoffStatus(order.status) &&
    order.status !== "recall";
  const typeLabel = orderTypeLabel(order);
  const customer = order.core_ext?.callout_name ?? null;
  const elapsed = useLiveElapsed(order.created_at);
  const ageLevel = ageLevelFor(elapsed, thresholds);
  const isBumped = isHandoffStatus(order.status);
  // Ready/done tickets are waiting for hand-off, not aging in the kitchen, so
  // they are greyed out instead of turning amber/red.
  const styles = isBumped ? READY_STYLE : AGE_STYLES[ageLevel];
  const isRecalled = order.status === "recall";
  const handoff = handoffLabel(order, ticket.deliveryProvider);

  return (
    <article
      data-ticket=""
      aria-label={`Order ${order.order_number}, ${statusLabel(order.status)}, ${typeLabel ?? channelLabel(order.channel)}${customer ? `, ${customer}` : ""}`}
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border-2 bg-card shadow-sm",
        styles.card,
      )}
    >
      <header className={cn("px-3 py-2", styles.header)}>
        <div className="flex items-center justify-between">
          <span className="text-2xl font-bold tracking-tight">
            {order.order_number}
          </span>
          <span className="font-mono text-lg font-bold tabular-nums">
            {formatElapsed(elapsed)}
          </span>
        </div>
        <div className="flex items-center justify-between text-xs font-medium">
          {order.fulfillment?.marketplace ? (
            <MarketplaceBadge
              provider={order.fulfillment.marketplace.provider}
              displayId={order.fulfillment.marketplace.display_id}
            />
          ) : (
            <span>
              {typeLabel ?? channelLabel(order.channel)}
              {customer && <span className="ml-1 font-bold">· {customer}</span>}
            </span>
          )}
          <span
            className={cn(
              "rounded-full px-2 py-0.5",
              isRecalled
                ? "bg-purple-600 text-white"
                : isBumped
                  ? "bg-foreground/80 text-background"
                  : "bg-background/70",
            )}
          >
            {statusLabel(order.status)}
          </span>
        </div>
      </header>

      {order.fulfillment?.marketplace?.cancel_requested && (
        <div
          role="alert"
          className="bg-red-600 px-3 py-1 text-sm font-bold text-white"
        >
          CANCELLED BY PROVIDER: check with the front
        </div>
      )}

      <div className="flex-1 px-3 py-2">
        {noPrep && (
          <p className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            No prep needed
          </p>
        )}
        {noPrep ? (
          <ul className="text-lg font-medium">
            {order.items
              .filter((i) => !i.voided)
              .map((i) => (
                <li key={i.id}>
                  {i.quantity}× {i.item_name}
                  {i.size_name ? ` · ${i.size_name}` : ""}
                </li>
              ))}
          </ul>
        ) : (
          <TicketItems items={order.items} stationFilter={stationFilter} />
        )}
        {order.notes && (
          <p className="mt-2 rounded bg-amber-50 px-2 py-1 text-sm font-medium text-amber-800">
            Order note: {order.notes}
          </p>
        )}
      </div>

      <footer className="flex gap-2 border-t p-2">
        {noPrep && (
          <Button
            size="lg"
            className={cn("h-14 flex-1 text-lg", BUMP_DARK)}
            disabled={busy}
            aria-label={`No prep: hand off order ${order.order_number}`}
            onClick={() => onNoPrepHandoff(order.id)}
          >
            No prep: hand off
          </Button>
        )}
        {handoff && (
          <Button
            size="lg"
            className={cn("h-14 flex-1 text-lg", BUMP_DARK)}
            disabled={busy}
            aria-label={`${handoff}: hand off order ${order.order_number}`}
            onClick={() => onBump(order.id)}
          >
            {handoff}
          </Button>
        )}
        {noPrep ? null : isBumped ? (
          <Button
            variant="outline"
            size="lg"
            className={cn("h-14 text-lg", handoff ? "px-4" : "flex-1")}
            disabled={busy}
            aria-label={`Recall order ${order.order_number}`}
            onClick={() => onRecall(order.id)}
          >
            Recall
          </Button>
        ) : (
          <Button
            size="lg"
            className={cn("h-14 flex-1 text-lg", BUMP_DARK)}
            disabled={busy}
            aria-label={`Bump order ${order.order_number}`}
            onClick={() => onBump(order.id)}
          >
            Bump
          </Button>
        )}
        <Button asChild variant="ghost" size="lg" className="h-14 px-4 text-base">
          <a
            href={`/kitchen/ticket/${order.id}`}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Print ticket for order ${order.order_number} (opens in a new tab)`}
          >
            Print
          </a>
        </Button>
      </footer>
    </article>
  );
}

/**
 * Memoized so unchanged tickets don't re-render on every board poll. The live
 * elapsed clock is internal state (its own interval), so identical props between
 * snapshots can safely skip a re-render — keeping a busy KDS smooth.
 */
export const TicketCard = memo(TicketCardImpl);
