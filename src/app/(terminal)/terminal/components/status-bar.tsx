/**
 * Terminal status bar — location label + online/offline + pending-sync count.
 */
"use client";

import {
  AlertTriangle,
  Cloud,
  CloudOff,
  CreditCard,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useCardReader } from "@/lib/store/use-card-reader";

/**
 * This device's card reader: online / offline, or "Card: cash only" when the
 * device itself is offline (card needs internet). Hidden when no reader is set up.
 */
function ReaderChip({
  tenantId,
  locationId,
}: {
  tenantId: string;
  locationId: string;
}) {
  const { online, list, selectedReaderId } = useCardReader({
    tenantId,
    locationId,
    orderId: null,
  });
  if (!online) {
    return (
      <span
        data-testid="reader-chip"
        className="hidden items-center gap-1 rounded-full bg-amber-100 px-2 py-1 text-xs font-medium text-amber-800 sm:flex"
        title="Card needs internet: take cash"
      >
        <CreditCard className="h-3.5 w-3.5" />
        Cash only
      </span>
    );
  }
  const reader = list?.readers.find((r) => r.id === selectedReaderId);
  if (!list?.ready || !reader) return null;
  const up = reader.status === "online";
  return (
    <span
      data-testid="reader-chip"
      className={cn(
        "hidden items-center gap-1 rounded-full px-2 py-1 text-xs font-medium sm:flex",
        up ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800",
      )}
      title={`Card reader ${reader.label}: ${reader.status}`}
    >
      <CreditCard className="h-3.5 w-3.5" />
      {reader.label} {up ? "online" : "offline"}
    </span>
  );
}

export interface StatusBarProps {
  locationName: string;
  online: boolean;
  /** Every unsynced order, including those needing attention. */
  pendingCount: number;
  /** Orders refused in the background, waiting on staff. */
  attentionCount?: number;
  /** Open the needs-attention queue panel. */
  onOpenQueue?: () => void;
  driverName?: string;
  onFlush: () => void;
  /** Active staff name (PIN quick-switch), or null when none. */
  activeStaffName?: string | null;
  /** Open the staff PIN switcher. */
  onSwitchStaff?: () => void;
  /** Unpaid in-store orders (opens the open-orders list). */
  openOrdersCount?: number;
  onOpenOrders?: () => void;
  /** Show the card-reader chip for this tenant + location. */
  readerScope?: { tenantId: string; locationId: string };
}

export function StatusBar({
  locationName,
  online,
  pendingCount,
  attentionCount = 0,
  onOpenQueue,
  driverName,
  onFlush,
  activeStaffName,
  onSwitchStaff,
  readerScope,
  openOrdersCount = 0,
  onOpenOrders,
}: StatusBarProps) {
  return (
    <>
    <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b bg-background px-4 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{locationName}</span>
        {driverName === "mock" && (
          <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-secondary-foreground">
            {driverName} data
          </span>
        )}
        {onSwitchStaff && (
          <button
            type="button"
            onClick={onSwitchStaff}
            className="h-11 rounded-full border px-4 text-sm font-medium hover:bg-secondary touch-manipulation"
            title="Switch the active staff member (PIN)"
          >
            {activeStaffName ? `Staff: ${activeStaffName}` : "Sign in staff"}
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {onOpenOrders && (
          <button
            type="button"
            onClick={onOpenOrders}
            className={cn(
              "h-11 rounded-full border px-4 text-sm font-medium touch-manipulation hover:bg-secondary",
              openOrdersCount > 0 && "border-amber-500 bg-amber-100 text-amber-900",
            )}
          >
            Open orders ({openOrdersCount})
          </button>
        )}
        {readerScope && <ReaderChip {...readerScope} />}
        {attentionCount > 0 && (
          <button
            type="button"
            onClick={onOpenQueue ?? onFlush}
            className="flex items-center gap-1 rounded-full bg-red-100 px-2 py-1 text-xs font-medium text-red-800"
            title="Orders the server refused — tap to review"
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            {attentionCount} need{attentionCount === 1 ? "s" : ""} attention
          </button>
        )}
        {pendingCount > 0 && (
          <button
            type="button"
            onClick={onFlush}
            className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-1 text-xs font-medium text-amber-800"
            title="Unsynced orders (incl. any needing attention) — tap to retry"
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
          <span className="sr-only sm:not-sr-only">
            {online ? "Online" : "Offline"}
          </span>
        </span>
      </div>
    </header>
    {!online && (
      <div
        role="alert"
        className="bg-red-600 px-4 py-2 text-center text-sm font-semibold text-white"
      >
        Offline: orders are queued, card payments unavailable
      </div>
    )}
    </>
  );
}
