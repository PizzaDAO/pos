/**
 * Offline-queue "needs attention" panel (terminal).
 *
 * Orders queued offline that the server later REFUSED during a background
 * flush are never dropped: they land here until staff act on them.
 *   - 401 (device signed out): retried automatically on every flush; also
 *     "Retry now" after signing back in.
 *   - 403 discount_forbidden: the staff session that authorized the discount
 *     is gone. Switch in an owner/manager by PIN and "Retry", or "Re-place
 *     without discount".
 *   - Anything else (e.g. 422 86'd item): "Retry" once fixed, or "Discard"
 *     (confirmed) — re-ring it from the menu if needed.
 */
"use client";

import { useState } from "react";
import type { QueuedOrder, QueuedStaff } from "@/lib/offline/queue";
import { formatMoney } from "@/lib/pricing";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

export interface OfflineQueuePanelProps {
  entries: QueuedOrder[];
  /** The staff now switched in (a retry is authorized by them). */
  activeStaff: QueuedStaff | null;
  onRetry: (id: string, queuedBy?: QueuedStaff | null) => Promise<void>;
  onRetryWithoutDiscount: (id: string) => Promise<void>;
  onDiscard: (id: string) => Promise<void>;
  onSwitchStaff: () => void;
  onClose: () => void;
}

/** A short staff-facing explanation of the refusal. */
export function attentionReason(e: QueuedOrder): string {
  if (e.httpStatus === 401) {
    return "The terminal was signed out. It will retry automatically once you sign back in.";
  }
  if (e.errorCode === "discount_forbidden") {
    return "The discount needs an owner or manager. Switch one in and retry, or re-place it without the discount.";
  }
  return e.lastError ?? `Refused by the server (HTTP ${e.httpStatus ?? "?"}).`;
}

export function OfflineQueuePanel({
  entries,
  activeStaff,
  onRetry,
  onRetryWithoutDiscount,
  onDiscard,
  onSwitchStaff,
  onClose,
}: OfflineQueuePanelProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState<string | null>(null);

  async function run(id: string, fn: () => Promise<void>) {
    setBusy(id);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog onClose={onClose} labelledBy="offline-queue-title">
      <div className="w-full max-w-lg rounded-lg bg-background p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="offline-queue-title" className="text-lg font-semibold">
            Orders needing attention
          </h2>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>

        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing needs attention.
          </p>
        ) : (
          <ul className="max-h-[60vh] space-y-3 overflow-y-auto">
            {entries.map((e) => {
              const p = e.payload;
              const isDiscount = e.errorCode === "discount_forbidden";
              return (
                <li key={e.id} className="rounded-md border p-3">
                  <div className="mb-1 flex items-center justify-between text-sm">
                    <span className="font-medium">
                      Order {p.order_number ?? e.id.slice(0, 8)}
                    </span>
                    <span>{formatMoney(p.totals.total_cents, p.currency)}</span>
                  </div>
                  <p className="mb-1 text-xs text-muted-foreground">
                    Queued {new Date(e.createdAt).toLocaleString()}
                    {e.queuedBy ? ` by ${e.queuedBy.role}` : ""}
                    {p.discount_cents > 0
                      ? ` · discount ${formatMoney(p.discount_cents, p.currency)}`
                      : ""}
                  </p>
                  <p role="status" className="mb-2 text-sm text-destructive">
                    {attentionReason(e)}
                  </p>
                  {confirmDiscard === e.id ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm">Discard this order for good?</span>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={busy === e.id}
                        onClick={() =>
                          void run(e.id, async () => {
                            await onDiscard(e.id);
                            setConfirmDiscard(null);
                          })
                        }
                      >
                        Discard
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setConfirmDiscard(null)}
                      >
                        Keep
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={busy === e.id}
                        onClick={() =>
                          void run(e.id, () =>
                            // A retry is authorized by whoever is switched in now.
                            onRetry(e.id, activeStaff ?? e.queuedBy ?? null),
                          )
                        }
                      >
                        Retry
                      </Button>
                      {isDiscount && (
                        <>
                          <Button size="sm" variant="outline" onClick={onSwitchStaff}>
                            Switch staff
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy === e.id}
                            onClick={() =>
                              void run(e.id, () => onRetryWithoutDiscount(e.id))
                            }
                          >
                            Re-place without discount
                          </Button>
                        </>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirmDiscard(e.id)}
                      >
                        Discard…
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
