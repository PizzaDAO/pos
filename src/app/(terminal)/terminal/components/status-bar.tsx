/**
 * Terminal status bar — location label + online/offline + pending-sync count.
 */
"use client";

import { Cloud, CloudOff, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

export interface StatusBarProps {
  locationName: string;
  online: boolean;
  pendingCount: number;
  driverName?: string;
  onFlush: () => void;
}

export function StatusBar({
  locationName,
  online,
  pendingCount,
  driverName,
  onFlush,
}: StatusBarProps) {
  return (
    <header className="flex items-center justify-between gap-3 border-b bg-background px-4 py-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold">{locationName}</span>
        {driverName && (
          <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-secondary-foreground">
            {driverName} data
          </span>
        )}
      </div>

      <div className="flex items-center gap-3">
        {pendingCount > 0 && (
          <button
            type="button"
            onClick={onFlush}
            className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-1 text-xs font-medium text-amber-800"
            title="Pending orders waiting to sync — tap to retry"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {pendingCount} pending
          </button>
        )}
        <span
          className={cn(
            "flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium",
            online
              ? "bg-emerald-100 text-emerald-800"
              : "bg-red-100 text-red-800",
          )}
        >
          {online ? (
            <Cloud className="h-3.5 w-3.5" />
          ) : (
            <CloudOff className="h-3.5 w-3.5" />
          )}
          {online ? "Online" : "Offline"}
        </span>
      </div>
    </header>
  );
}
