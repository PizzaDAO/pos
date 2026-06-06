/**
 * A single KDS ticket.
 *
 * - Border + header color reflect AGE (green/yellow/red), recomputed live from
 *   the still-ticking elapsed clock against the location thresholds (so a ticket
 *   "warms up" between polls without waiting for the next snapshot).
 * - Shows order number, channel, status badge, live elapsed mm:ss, line items
 *   (with half-and-half), and order notes.
 * - Bump advances status; Recall re-opens a ready/completed ticket; Print opens
 *   the print-friendly ticket route.
 */
"use client";

import { memo, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { KdsThresholds } from "@/lib/db";
import { ageLevelFor } from "@/lib/kds/board";
import { statusLabel } from "@/lib/kds/status";
import { channelLabel, formatElapsed } from "@/lib/kds/format";
import type { AgeLevel, KitchenTicket, StationFilter } from "@/lib/kds/types";
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
  busy,
}: {
  ticket: KitchenTicket;
  thresholds: KdsThresholds;
  stationFilter: StationFilter;
  onBump: (orderId: string) => void;
  onRecall: (orderId: string) => void;
  busy: boolean;
}) {
  const { order } = ticket;
  const elapsed = useLiveElapsed(order.created_at);
  const ageLevel = ageLevelFor(elapsed, thresholds);
  const styles = AGE_STYLES[ageLevel];

  const isBumped = order.status === "ready" || order.status === "completed";
  const isRecalled = order.status === "recall";

  return (
    <article
      aria-label={`Order ${order.order_number}, ${statusLabel(order.status)}, ${channelLabel(order.channel)}`}
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border-2 bg-card shadow-sm",
        styles.card,
      )}
    >
      <header className={cn("px-3 py-2", styles.header)}>
        <div className="flex items-center justify-between">
          <span className="text-lg font-bold tracking-tight">
            {order.order_number}
          </span>
          <span className="font-mono text-lg font-bold tabular-nums">
            {formatElapsed(elapsed)}
          </span>
        </div>
        <div className="flex items-center justify-between text-xs font-medium">
          <span>{channelLabel(order.channel)}</span>
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

      <div className="flex-1 px-3 py-2">
        <TicketItems items={order.items} stationFilter={stationFilter} />
        {order.notes && (
          <p className="mt-2 rounded bg-amber-50 px-2 py-1 text-sm font-medium text-amber-800">
            Order note: {order.notes}
          </p>
        )}
      </div>

      <footer className="flex gap-2 border-t p-2">
        {isBumped ? (
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            disabled={busy}
            aria-label={`Recall order ${order.order_number}`}
            onClick={() => onRecall(order.id)}
          >
            Recall
          </Button>
        ) : (
          <Button
            size="sm"
            className="flex-1"
            disabled={busy}
            aria-label={`Bump order ${order.order_number}`}
            onClick={() => onBump(order.id)}
          >
            Bump
          </Button>
        )}
        <Button asChild variant="ghost" size="sm">
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
