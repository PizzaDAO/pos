/**
 * "Kitchen printer" health banner (KDS + Admin > Printers). Polls
 * /api/kitchen/printers; shows nothing when no printer is configured or all is
 * well. Failed tickets get a Retry button (puts them back in the queue).
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

interface Health {
  configured: boolean;
  failedCount: number;
  lastError: string | null;
  offlinePrinters: string[];
}

/** Star `code` / Epson `epson:<code>` -> something a cook can act on. */
export function friendlyPrintError(err: string | null): string {
  if (!err) return "";
  const e = err.toLowerCase();
  if (e.includes("paper") || /^\s*5[23]\b/.test(e)) return "paper out";
  if (e.includes("cover")) return "cover open";
  if (e.includes("offline")) return "printer offline";
  return err.replace(/^epson:/, "");
}

export function PrinterBanner({
  tenantId,
  locationId,
  refreshKey,
}: {
  tenantId: string;
  locationId: string;
  /** Bump to refetch immediately (e.g. after the admin queued a test ticket). */
  refreshKey?: number;
}) {
  const [h, setH] = useState<Health | null>(null);
  const [busy, setBusy] = useState(false);
  const body = JSON.stringify({ tenantId, locationId });

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/kitchen/printers?tenantId=${encodeURIComponent(tenantId)}&locationId=${encodeURIComponent(locationId)}`,
      );
      if (res.ok) setH((await res.json()) as Health);
    } catch {
      /* banner is best-effort */
    }
  }, [tenantId, locationId]);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 20_000);
    return () => window.clearInterval(t);
  }, [load, refreshKey]);

  async function retry() {
    setBusy(true);
    try {
      await fetch("/api/kitchen/printers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!h?.configured || (h.failedCount === 0 && h.offlinePrinters.length === 0)) return null;
  const parts: string[] = [];
  if (h.failedCount > 0) {
    const why = friendlyPrintError(h.lastError);
    parts.push(
      `${h.failedCount} ticket${h.failedCount === 1 ? "" : "s"} not printed${why ? ` (${why})` : ""}`,
    );
  }
  if (h.offlinePrinters.length > 0) parts.push(`${h.offlinePrinters.join(", ")} offline`);
  return (
    <div
      role="alert"
      data-testid="printer-banner"
      className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/50 bg-amber-500/15 px-4 py-2 text-sm text-amber-900 dark:text-amber-200"
    >
      <span>Kitchen printer: {parts.join(" · ")}</span>
      {h.failedCount > 0 && (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void retry()}>
          {busy ? "Retrying…" : "Retry"}
        </Button>
      )}
    </div>
  );
}
