/**
 * KDS board client (Phase 3).
 *
 * Subscribes to the active-orders feed via the realtime abstraction (polling
 * today), renders each order as an age-colored ticket, supports bump/recall, and
 * filters by station. The station filter narrows both the visible tickets and
 * the lines within each ticket.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChefHat, Volume2, VolumeX } from "lucide-react";
import {
  DEFAULT_KDS_THRESHOLDS,
  hasKitchenWork,
  lineMatchesStation,
} from "@/lib/kds/board";
import {
  newTickets,
  playChime,
  primeAudio,
  readMuted,
  writeMuted,
} from "@/lib/kds/alert";
import { DEMO_LOCATION_DOWNTOWN_ID, DEMO_TENANT_ID } from "@/lib/db";
import { useKitchenBoard } from "@/lib/kds/use-kitchen-board";
import { isHandoffStatus as isHandoff } from "@/lib/kds/status";
import type { StationFilter } from "@/lib/kds/types";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { StationFilterBar } from "./station-filter";
import { PrinterBanner } from "@/components/printer-banner";
import { TicketCard } from "./ticket-card";
import { displayOrderNumber } from "@/lib/till/order-meta";

/** Columns: 4 on a laptop, 5-6 on a wall-mounted 1080p display (compact tickets). */
const GRID =
  "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 min-[1800px]:grid-cols-6";


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
  locationName = "Kitchen",
}: {
  locationName?: string;
  initialTenantId?: string;
  initialLocationId?: string;
} = {}) {
  const { board, loading, source, lastUpdated, bump, recall } = useKitchenBoard(
    initialTenantId,
    initialLocationId,
  );
  const [station, setStation] = useState<StationFilter>("all");
  const [busyId, setBusyId] = useState<string | null>(null);

  // Orders with nothing for any station (drink-only) never need a bump.
  const tickets = useMemo(
    () => (board?.tickets ?? []).filter((t) => hasKitchenWork(t.order)),
    [board?.tickets],
  );
  const defaultModifierIds = useMemo(
    () => new Set(board?.defaultModifierIds ?? []),
    [board?.defaultModifierIds],
  );
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

  // Live tickets (oldest first) stay in the main grid; Ready/Done tickets are
  // waiting for hand-off, so they move to their own lane below and stop
  // pushing live tickets down the board. "Picked up" bumps a Ready ticket to
  // `completed`, which is not a KDS-active status, so it leaves the feed.
  const liveTickets = useMemo(
    () => visibleTickets.filter((t) => !isHandoff(t.order.status)),
    [visibleTickets],
  );
  const readyTickets = useMemo(
    () => visibleTickets.filter((t) => isHandoff(t.order.status)),
    [visibleTickets],
  );

  // Announce newly-arrived tickets to assistive tech via a polite live region.
  // Track known order ids across snapshots; when an id appears that wasn't there
  // before (and it isn't the very first load), announce the order number.
  const knownIds = useRef<Set<string> | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    const m = readMuted();
    mutedRef.current = m;
    setMuted(m);
  }, []);
  useEffect(() => {
    const fresh = newTickets(knownIds.current, tickets);
    knownIds.current = new Set(tickets.map((t) => t.order.id));
    if (fresh.length === 1) {
      setAnnouncement(`New order ${displayOrderNumber(fresh[0]!.order.order_number)} received.`);
    } else if (fresh.length > 1) {
      setAnnouncement(`${fresh.length} new orders received.`);
    }
    if (fresh.length > 0) {
      // Sound + a brief screen flash (the flash stays on when muted).
      if (!mutedRef.current) playChime();
      setFlash(true);
    }
  }, [tickets]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(false), 1400);
    return () => clearTimeout(t);
  }, [flash]);

  function toggleMute() {
    const next = !muted;
    mutedRef.current = next;
    setMuted(next);
    writeMuted(next);
    if (!next) {
      primeAudio(); // this tap is the gesture that lets later chimes play
      playChime();
    }
  }

  // "N more below": tickets whose top edge is under the visible screen.
  const gridRef = useRef<HTMLElement | null>(null);
  const [below, setBelow] = useState(0);
  const measureBelow = useCallback(() => {
    const root = gridRef.current;
    if (!root) return;
    let n = 0;
    root.querySelectorAll("[data-ticket]").forEach((el) => {
      if (el.getBoundingClientRect().top >= window.innerHeight - 8) n++;
    });
    setBelow(n);
  }, []);
  useEffect(() => {
    measureBelow();
    window.addEventListener("scroll", measureBelow, { passive: true });
    window.addEventListener("resize", measureBelow);
    return () => {
      window.removeEventListener("scroll", measureBelow);
      window.removeEventListener("resize", measureBelow);
    };
  }, [measureBelow, tickets, station]);

  async function withBusy(id: string, fn: () => Promise<void>) {
    setBusyId(id);
    try {
      await fn();
    } finally {
      setBusyId(null);
    }
  }

  const renderTicket = (ticket: (typeof tickets)[number]) => (
    <TicketCard
      key={ticket.order.id}
      ticket={ticket}
      thresholds={thresholds}
      stationFilter={station}
      defaultModifierIds={defaultModifierIds}
      busy={busyId === ticket.order.id}
      onBump={(id) => void withBusy(id, () => bump(id))}
      onRecall={(id) => void withBusy(id, () => recall(id))}
    />
  );

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
            <p className="text-sm text-foreground/80">
              {locationName} ·{" "}
              <span className="inline-flex items-center gap-1 font-medium">
                <span
                  aria-hidden="true"
                  className={`inline-block h-2 w-2 rounded-full ${source ? "bg-emerald-500" : "bg-amber-500"}`}
                />
                {source ? "Live" : "Connecting"}
              </span>
              {" · "}
              <span data-testid="ticket-count" className="font-semibold">
                {liveTickets.length} live
                {readyTickets.length > 0 ? `, ${readyTickets.length} ready` : ""}
              </span>
              {lastUpdated
                ? ` · updated ${new Date(lastUpdated).toLocaleTimeString()}`
                : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StationFilterBar
              value={station}
              counts={counts}
              onChange={setStation}
            />
            <button
              type="button"
              aria-pressed={muted}
              aria-label={muted ? "Unmute new-ticket sound" : "Mute new-ticket sound"}
              onClick={toggleMute}
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full border border-input bg-background px-3 hover:bg-accent touch-manipulation"
            >
              {muted ? (
                <VolumeX className="h-5 w-5" aria-hidden="true" />
              ) : (
                <Volume2 className="h-5 w-5" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
      </header>
      <PrinterBanner
        tenantId={initialTenantId ?? DEMO_TENANT_ID}
        locationId={initialLocationId ?? DEMO_LOCATION_DOWNTOWN_ID}
      />

      {(board?.voided?.length ?? 0) > 0 && (
        <section
          aria-label="Voided orders"
          role="alert"
          data-testid="void-notices"
          className="space-y-2 border-b bg-destructive/10 px-4 py-3"
        >
          {board!.voided!.map((v) => (
            <div
              key={`${v.orderId}-${v.at}`}
              className="flex flex-wrap items-baseline gap-2 text-destructive"
            >
              <span className="rounded bg-destructive px-2 py-0.5 text-sm font-bold uppercase text-destructive-foreground">
                {v.scope === "order" ? "Stop: order voided" : "Stop: item voided"}
              </span>
              <span className="font-semibold">#{v.orderNumber}</span>
              <span className="text-sm">{v.items.join(", ")}</span>
              <span className="text-xs text-muted-foreground">
                {new Date(v.at).toLocaleTimeString()}
              </span>
            </div>
          ))}
        </section>
      )}

      {flash && (
        <div
          aria-hidden="true"
          data-testid="new-ticket-flash"
          className="pointer-events-none fixed inset-0 z-30 ring-8 ring-inset ring-amber-400/80"
        />
      )}
      {below > 0 && (
        <div
          role="status"
          data-testid="more-below"
          className="pointer-events-none fixed inset-x-0 bottom-3 z-20 flex justify-center"
        >
          <span className="rounded-full bg-foreground px-5 py-2 text-lg font-bold text-background shadow-lg">
            {below} more below ↓
          </span>
        </div>
      )}

      <section
        ref={gridRef}
        className="flex-1 p-4"
        aria-busy={loading && !board}
      >
        {loading && !board ? (
          <div
            className={GRID}
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
          <div className="space-y-6">
            {liveTickets.length === 0 ? (
              <p className="rounded-lg border border-dashed p-6 text-center text-muted-foreground">
                No live tickets. New orders will appear here automatically.
              </p>
            ) : (
              <div className={GRID}>
                {liveTickets.map(renderTicket)}
              </div>
            )}
            {readyTickets.length > 0 && (
              <section aria-labelledby="ready-lane-title">
                <h2
                  id="ready-lane-title"
                  className="mb-3 text-lg font-semibold text-muted-foreground"
                >
                  Ready for hand-off ({readyTickets.length})
                </h2>
                <div className={GRID}>
                  {readyTickets.map(renderTicket)}
                </div>
              </section>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
