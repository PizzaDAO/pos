/**
 * KDS board client (Phase 3).
 *
 * Subscribes to the active-orders feed via the realtime abstraction (polling
 * today), renders each order as an age-colored ticket, supports bump/recall, and
 * filters by station. The station filter narrows both the visible tickets and
 * the lines within each ticket.
 */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChefHat } from "lucide-react";
import { DEFAULT_KDS_THRESHOLDS, lineMatchesStation } from "@/lib/kds/board";
import { useKitchenBoard } from "@/lib/kds/use-kitchen-board";
import type { StationFilter } from "@/lib/kds/types";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { StationFilterBar } from "./station-filter";
import { TicketCard } from "./ticket-card";

const STATION_VALUES: StationFilter[] = [
  "all",
  "oven",
  "cold",
  "fryer",
  "expo",
];

/**
 * `initialTenantId`/`initialLocationId` come from the server guard
 * (requireLocationSurface) — the session-derived active location — replacing the
 * old hardcoded demo context. They default to the demo context for the
 * simulated/zero-env path.
 */
export function KitchenBoard({
  initialTenantId,
  initialLocationId,
}: {
  initialTenantId?: string;
  initialLocationId?: string;
} = {}) {
  const { board, loading, source, lastUpdated, bump, recall } = useKitchenBoard(
    initialTenantId,
    initialLocationId,
  );
  const [station, setStation] = useState<StationFilter>("all");
  const [busyId, setBusyId] = useState<string | null>(null);

  const tickets = useMemo(() => board?.tickets ?? [], [board?.tickets]);
  const thresholds = board?.thresholds ?? DEFAULT_KDS_THRESHOLDS;

  // Per-station ticket counts for the filter badges.
  const counts = useMemo(() => {
    const out = {} as Record<StationFilter, number>;
    for (const value of STATION_VALUES) {
      out[value] = tickets.filter((t) =>
        value === "all"
          ? true
          : t.order.items.some(
              (i) => !i.voided && lineMatchesStation(i, value),
            ),
      ).length;
    }
    return out;
  }, [tickets]);

  const visibleTickets = useMemo(() => {
    if (station === "all") return tickets;
    return tickets.filter((t) =>
      t.order.items.some((i) => !i.voided && lineMatchesStation(i, station)),
    );
  }, [tickets, station]);

  // Announce newly-arrived tickets to assistive tech via a polite live region.
  // Track known order ids across snapshots; when an id appears that wasn't there
  // before (and it isn't the very first load), announce the order number.
  const knownIds = useRef<Set<string> | null>(null);
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    const currentIds = new Set(tickets.map((t) => t.order.id));
    if (knownIds.current === null) {
      knownIds.current = currentIds;
      return;
    }
    const fresh = tickets.filter((t) => !knownIds.current!.has(t.order.id));
    knownIds.current = currentIds;
    if (fresh.length === 1) {
      setAnnouncement(`New order ${fresh[0]!.order.order_number} received.`);
    } else if (fresh.length > 1) {
      setAnnouncement(`${fresh.length} new orders received.`);
    }
  }, [tickets]);

  async function withBusy(id: string, fn: () => Promise<void>) {
    setBusyId(id);
    try {
      await fn();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <main
      id="main-content"
      className="flex min-h-screen flex-col bg-muted/30"
      aria-label="Kitchen display"
    >
      {/* Polite live region: announces new tickets to screen readers. */}
      <div aria-live="polite" role="status" className="sr-only">
        {announcement}
      </div>
      <header className="sticky top-0 z-10 border-b bg-background/95 px-4 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight">
              Kitchen Display
            </h1>
            <p className="text-xs text-muted-foreground">
              Tony&apos;s Downtown ·{" "}
              <span className="font-medium">
                {source === "poll"
                  ? "Live (polling)"
                  : (source ?? "connecting")}
              </span>
              {board ? ` · ${board.driver} driver` : ""}
              {lastUpdated
                ? ` · updated ${new Date(lastUpdated).toLocaleTimeString()}`
                : ""}
            </p>
          </div>
          <StationFilterBar
            value={station}
            counts={counts}
            onChange={setStation}
          />
        </div>
      </header>

      <section className="flex-1 p-4" aria-busy={loading && !board}>
        {loading && !board ? (
          <div
            className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
            aria-hidden="true"
          >
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-48 w-full rounded-lg" />
            ))}
          </div>
        ) : visibleTickets.length === 0 ? (
          <EmptyState
            icon={ChefHat}
            title={
              station === "all"
                ? "No active tickets"
                : "No tickets for this station"
            }
            description="New orders will appear here automatically as they come in."
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {visibleTickets.map((ticket) => (
              <TicketCard
                key={ticket.order.id}
                ticket={ticket}
                thresholds={thresholds}
                stationFilter={station}
                busy={busyId === ticket.order.id}
                onBump={(id) => void withBusy(id, () => bump(id))}
                onRecall={(id) => void withBusy(id, () => recall(id))}
              />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
