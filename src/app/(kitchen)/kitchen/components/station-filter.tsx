/**
 * Per-station view selector. Picking a station narrows BOTH which tickets show
 * (only orders with an item for that station) AND which lines render inside each
 * ticket (only that station's items) — so e.g. the fryer cook sees just the
 * fried items across the open orders.
 */
"use client";

import { cn } from "@/lib/utils";
import type { StationFilter } from "@/lib/kds/types";

const STATIONS: { value: StationFilter; label: string }[] = [
  { value: "all", label: "All stations" },
  { value: "oven", label: "Oven" },
  { value: "cold", label: "Cold" },
  { value: "fryer", label: "Fryer" },
  { value: "expo", label: "Expo" },
];

export function StationFilterBar({
  value,
  counts,
  onChange,
}: {
  value: StationFilter;
  /** Ticket count per station (for the badge); keyed by station or "all". */
  counts: Record<StationFilter, number>;
  onChange: (next: StationFilter) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {STATIONS.map((s) => {
        const active = s.value === value;
        const count = counts[s.value] ?? 0;
        return (
          <button
            key={s.value}
            type="button"
            onClick={() => onChange(s.value)}
            className={cn(
              "rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
              active
                ? "border-foreground bg-foreground text-background"
                : "border-input bg-background hover:bg-accent",
            )}
          >
            {s.label}
            <span
              className={cn(
                "ml-2 rounded-full px-1.5 text-xs tabular-nums",
                active ? "bg-background/20" : "bg-muted text-muted-foreground",
              )}
            >
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
