/**
 * KDS board client (Phase 3).
 *
 * Subscribes to the active-orders feed via the realtime abstraction (polling
 * today), renders each order as an age-colored ticket, supports bump/recall, and
 * filters by station. The station filter narrows both the visible tickets and
 * the lines within each ticket.
 */
"use client";

import { useMemo, useState } from "react";
import {
  DEFAULT_KDS_THRESHOLDS,
  lineMatchesStation,
} from "@/lib/kds/board";
import { useKitchenBoard } from "@/lib/kds/use-kitchen-board";
import type { StationFilter } from "@/lib/kds/types";
import { StationFilterBar } from "./station-filter";
import { TicketCard } from "./ticket-card";

const STATION_VALUES: StationFilter[] = ["all", "oven", "cold", "fryer", "expo"];

export function KitchenBoard() {
  const { board, loading, source, lastUpdated, bump, recall } =
    useKitchenBoard();
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

  async function withBusy(id: string, fn: () => Promise<void>) {
    setBusyId(id);
    try {
      await fn();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <main className="flex min-h-screen flex-col bg-muted/30">
      <header className="sticky top-0 z-10 border-b bg-background/95 px-4 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Kitchen Display</h1>
            <p className="text-xs text-muted-foreground">
              Tony&apos;s Downtown ·{" "}
              <span className="font-medium">
                {source === "poll" ? "Live (polling)" : source ?? "connecting"}
              </span>
              {board ? ` · ${board.driver} driver` : ""}
              {lastUpdated
                ? ` · updated ${new Date(lastUpdated).toLocaleTimeString()}`
                : ""}
            </p>
          </div>
          <StationFilterBar value={station} counts={counts} onChange={setStation} />
        </div>
      </header>

      <section className="flex-1 p-4">
        {loading && !board ? (
          <p className="py-16 text-center text-muted-foreground">
            Loading kitchen board…
          </p>
        ) : visibleTickets.length === 0 ? (
          <p className="py-16 text-center text-muted-foreground">
            No active tickets{station !== "all" ? " for this station" : ""}.
          </p>
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
