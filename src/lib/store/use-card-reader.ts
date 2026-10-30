/**
 * In-store card reader hook (client) -- the server-driven Stripe Terminal flow.
 *
 * Two jobs:
 *  - the READER LIST for a location (`GET /api/terminal/readers`): which readers
 *    exist, whether they're online, whether card is ready at all, the tip mode,
 *    and which reader this device uses (remembered in localStorage per location);
 *  - the CARD TENDER on an order (`/api/terminal/payments*`): start it on the
 *    selected reader, poll it every ~1.5s, then retry / cancel / reset / simulate.
 *
 * The in-flight tender id is kept in sessionStorage per order, so a reload (or a
 * remount) resumes polling the SAME tender instead of minting a second one.
 * Card needs the internet (a web POS can't take offline card payments): while the
 * device is offline nothing here starts a tender.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Payment } from "@/lib/db";
import { createPendingTenderIds, tenderSignature } from "./pending-tender";

export type CardReaderMode = "simulated" | "stripe_test" | "stripe_live";
export type TipMode = "reader" | "pos" | "none";

export interface ReaderInfo {
  id: string;
  label: string;
  deviceType: string | null;
  status: "online" | "offline" | "unknown";
  simulated: boolean;
}

export interface ReaderList {
  mode: CardReaderMode;
  ready: boolean;
  notReadyReason: "connect_not_ready" | "no_reader" | null;
  tipMode: TipMode;
  readers: ReaderInfo[];
}

/** What the card panel shows for the order's card tender. */
export type CardPhase = "idle" | "present" | "declined" | "approved";

export interface CardLastError {
  code?: string | null;
  declineCode?: string | null;
  message?: string;
}

export const POLL_MS = 1_500;
const READER_REFRESH_MS = 30_000;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

export function readerStorageKey(locationId: string): string {
  return `pos.reader.${locationId}`;
}

export function tenderStorageKey(orderId: string): string {
  return `pos.cardTender.${orderId}`;
}

/**
 * The reader this device should use: its remembered one if it still exists,
 * otherwise the only reader (auto-pick), otherwise none (the cashier chooses).
 */
export function pickReader(
  readers: ReaderInfo[],
  savedId: string | null,
): string | null {
  if (savedId && readers.some((r) => r.id === savedId)) return savedId;
  if (readers.length === 1) return readers[0]!.id;
  return null;
}

/** True while a card tender still needs the customer (or the cashier) to act. */
export function isLiveCardTender(p: Payment | null): boolean {
  return !!p && (p.status === "requires_action" || p.status === "pending");
}

export function lastErrorOf(p: Payment | null): CardLastError | null {
  const e = p?.raw?.last_error;
  return e && typeof e === "object" ? (e as CardLastError) : null;
}

/** Map the tender to the panel state. A decline leaves the tender open + `last_error`. */
export function cardPhase(p: Payment | null): CardPhase {
  if (!p) return "idle";
  if (p.status === "captured") return "approved";
  if (p.status === "requires_action" || p.status === "pending") {
    return lastErrorOf(p) ? "declined" : "present";
  }
  return "idle"; // canceled / failed / refunded: nothing for the till to drive
}

export const SLOW_POLL_MS = 5_000;

/**
 * How often to re-read the tender, or null to stop. Fast while the customer can
 * still tap; slow while declined (a reader timeout can be a false negative, so a
 * late approval still shows up) until it is canceled or captured.
 */
export function pollIntervalMs(p: Payment | null): number | null {
  const phase = cardPhase(p);
  if (phase === "present") return POLL_MS;
  if (phase === "declined") return SLOW_POLL_MS;
  return null;
}

/** The reader a tender was last sent to (public `raw.reader_id`), if known. */
export function tenderReaderId(p: Payment | null): string | null {
  const id = p?.raw?.reader_id;
  return typeof id === "string" && id ? id : null;
}

function safeStorage(kind: "local" | "session"): Storage | null {
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

function newUuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `pay-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface TenderBody {
  payment?: Payment;
  balanceCents?: number;
  outcome?: string;
  error?: string;
  code?: string;
}

export interface UseCardReader {
  online: boolean;
  /** Reader list + gate; null until the first load (or while offline at start). */
  list: ReaderList | null;
  selectedReaderId: string | null;
  selectReader: (id: string) => void;
  reloadReaders: () => Promise<void>;
  /** The order's card tender (live, declined or approved), if any. */
  tender: Payment | null;
  phase: CardPhase;
  lastError: CardLastError | null;
  busy: boolean;
  error: string | null;
  /** Resolves to the started (live/captured) tender, or null if it didn't start. */
  start: (input: { amountCents: number; tipCents: number }) => Promise<Payment | null>;
  clearError: () => void;
  retry: () => Promise<void>;
  cancel: () => Promise<void>;
  resetReader: () => Promise<void>;
  simulate: (outcome: "approve" | "decline") => Promise<void>;
}

export function useCardReader(opts: {
  tenantId: string;
  locationId: string;
  /** Null: reader list only (status bar). Set: also drive this order's tender. */
  orderId: string | null;
  /** Called when the tender changes the order (approved / canceled): reload the balance. */
  onSettled?: () => void | Promise<void>;
}): UseCardReader {
  const { tenantId, locationId, orderId, onSettled } = opts;
  const [online, setOnline] = useState(true);
  const [list, setList] = useState<ReaderList | null>(null);
  const [selectedReaderId, setSelectedReaderId] = useState<string | null>(null);
  const [tender, setTender] = useState<Payment | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Latest tender, readable from callbacks without re-creating them. */
  const tenderRef = useRef<Payment | null>(null);
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  /** One id per tender attempt; kept until the server accepts it (lost-response safe). */
  const pendingIds = useRef(createPendingTenderIds(newUuid));

  // Online/offline: card is disabled offline (cash only).
  useEffect(() => {
    setOnline(navigator.onLine);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  // --- Reader list -------------------------------------------------------

  const reloadReaders = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/terminal/readers?tenantId=${encodeURIComponent(tenantId)}&locationId=${encodeURIComponent(locationId)}`,
      );
      if (!res.ok) return;
      const data = (await res.json()) as ReaderList;
      setList(data);
      const saved = safeStorage("local")?.getItem(readerStorageKey(locationId)) ?? null;
      setSelectedReaderId(pickReader(data.readers, saved));
    } catch {
      // Offline / transient: keep what we have.
    }
  }, [tenantId, locationId]);

  useEffect(() => {
    if (!online) return;
    void reloadReaders();
    const t = window.setInterval(() => void reloadReaders(), READER_REFRESH_MS);
    return () => window.clearInterval(t);
  }, [online, reloadReaders]);

  const selectReader = useCallback(
    (id: string) => {
      setSelectedReaderId(id);
      try {
        safeStorage("local")?.setItem(readerStorageKey(locationId), id);
      } catch {
        // Storage full / blocked: the choice just isn't remembered.
      }
    },
    [locationId],
  );

  // --- Tender ------------------------------------------------------------

  const remember = useCallback(
    (p: Payment | null) => {
      if (!orderId) return;
      try {
        const s = safeStorage("session");
        if (p && isLiveCardTender(p)) s?.setItem(tenderStorageKey(orderId), p.id);
        else s?.removeItem(tenderStorageKey(orderId));
      } catch {
        // Not remembered: a reload will start fresh.
      }
    },
    [orderId],
  );

  /** Apply a server tender: store it, remember/forget its id, tell the order. */
  const adopt = useCallback(
    (p: Payment) => {
      const wasLive = isLiveCardTender(tenderRef.current);
      tenderRef.current = p;
      setTender(p);
      remember(p);
      if (cardPhase(p) === "approved" || (wasLive && !isLiveCardTender(p))) {
        void onSettledRef.current?.();
      }
    },
    [remember],
  );

  /** POST/GET helper: parses the JSON body even on error statuses. */
  const call = useCallback(
    async (url: string, init?: RequestInit): Promise<{ status: number; body: TenderBody }> => {
      const res = await fetch(url, init);
      const body = (await res.json().catch(() => ({}))) as TenderBody;
      return { status: res.status, body };
    },
    [],
  );

  const post = useCallback(
    (url: string, json?: unknown) =>
      call(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(json ?? {}),
      }),
    [call],
  );

  const sync = useCallback(async () => {
    const id = tenderRef.current?.id;
    if (!id) return;
    try {
      const { status, body } = await call(`/api/terminal/payments/${id}`);
      if (status === 404) {
        tenderRef.current = null;
        setTender(null);
        remember(null);
      } else if (body.payment) {
        adopt(body.payment);
      }
    } catch {
      // Offline / transient: keep the tender and try again next tick.
    }
  }, [call, adopt, remember]);

  // Resume the in-flight tender for this order after a reload / remount.
  useEffect(() => {
    tenderRef.current = null;
    setTender(null);
    pendingIds.current.clear();
    if (!orderId) return;
    const saved = safeStorage("session")?.getItem(tenderStorageKey(orderId));
    if (!saved) return;
    let cancelled = false;
    void (async () => {
      try {
        const { status, body } = await call(`/api/terminal/payments/${saved}`);
        if (cancelled) return;
        if (status === 404 || !body.payment || !isLiveCardTender(body.payment)) {
          safeStorage("session")?.removeItem(tenderStorageKey(orderId));
          if (body.payment) void onSettledRef.current?.();
          return;
        }
        adopt(body.payment);
      } catch {
        // Offline: leave the saved id; the next mount tries again.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orderId, call, adopt]);

  // Poll while the customer can still tap.
  useEffect(() => {
    const every = pollIntervalMs(tender);
    if (!online || every === null) return;
    const t = window.setInterval(() => void sync(), every);
    return () => window.clearInterval(t);
  }, [tender, online, sync]);

  /** Run a tender action with busy/error handling. */
  const act = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Card payment failed.");
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  /** Resolves to the live/captured tender, or null when nothing was started. */
  const start = useCallback(
    async (input: { amountCents: number; tipCents: number }): Promise<Payment | null> => {
      let started: Payment | null = null;
      await act(async () => {
        if (!orderId) return;
        if (!selectedReaderId) throw new Error("Pick a card reader first.");
        if (!navigator.onLine) throw new Error("Card needs internet: take cash.");
        // Same id until the server accepts it, so a lost response can't double
        // charge. At most ONE fresh-id retry (below), never a loop.
        for (let attempt = 0; attempt < 2; attempt++) {
          const paymentId = pendingIds.current.get(
            tenderSignature({
              orderId,
              rail: "stripe_terminal",
              amountCents: input.amountCents,
              tipCents: input.tipCents,
            }),
          );
          const { status, body } = await post("/api/terminal/payments", {
            paymentId,
            orderId,
            readerId: selectedReaderId,
            amountCents: input.amountCents,
            tipCents: input.tipCents,
          });
          if (body.payment && (status === 201 || status === 200)) {
            pendingIds.current.clear();
            const p = body.payment;
            // The server handed back a dead tender (canceled/failed) for this id:
            // it can't take a card, so start once more under a fresh id.
            if (!isLiveCardTender(p) && p.status !== "captured") {
              if (attempt === 0) continue;
              throw new Error("Could not start the card payment. Try again.");
            }
            adopt(p);
            started = p;
            return;
          }
          // The balance moved under us (or a tender already exists): reload it.
          if (body.code === "amount_exceeds_balance" || status === 409) {
            pendingIds.current.clear();
            void onSettledRef.current?.();
          }
          if (body.payment) adopt(body.payment);
          throw new Error(body.error ?? `HTTP ${status}`);
        }
      });
      return started;
    },
    [act, orderId, selectedReaderId, post, adopt],
  );

  const clearError = useCallback(() => setError(null), []);

  const retry = useCallback(
    () =>
      act(async () => {
        const id = tenderRef.current?.id;
        if (!id) return;
        const { status, body } = await post(`/api/terminal/payments/${id}/retry`, {
          readerId: selectedReaderId ?? undefined,
        });
        if (body.payment) adopt(body.payment);
        if (status >= 400) throw new Error(body.error ?? `HTTP ${status}`);
      }),
    [act, post, selectedReaderId, adopt],
  );

  const cancel = useCallback(
    () =>
      act(async () => {
        const id = tenderRef.current?.id;
        if (!id) return;
        const { status, body } = await post(`/api/terminal/payments/${id}/cancel`);
        if (body.payment) adopt(body.payment);
        if (body.outcome === "in_flight") {
          throw new Error("The customer is paying on the reader. Wait for it to finish.");
        }
        if (body.outcome === "needs_review") {
          throw new Error("This card payment needs manager review before it can be canceled.");
        }
        if (status >= 400) throw new Error(body.error ?? `HTTP ${status}`);
        if (body.outcome === "canceled") {
          tenderRef.current = null;
          setTender(null);
          remember(null);
          await onSettledRef.current?.();
        }
      }),
    [act, post, adopt, remember],
  );

  const resetReader = useCallback(
    () =>
      act(async () => {
        const id = tenderRef.current
          ? (tenderRef.current.raw?.reader_id as string | undefined)
          : undefined;
        const readerId = id ?? selectedReaderId;
        if (!readerId) return;
        const { status, body } = await post(
          `/api/terminal/readers/${encodeURIComponent(readerId)}/reset`,
          { tenantId, locationId },
        );
        if (status >= 400) throw new Error(body.error ?? `HTTP ${status}`);
        // Re-sync: the PaymentIntent is the source of truth.
        await sync();
      }),
    [act, post, selectedReaderId, tenantId, locationId, sync],
  );

  const simulate = useCallback(
    (outcome: "approve" | "decline") =>
      act(async () => {
        const id = tenderRef.current?.id;
        if (!id) return;
        const { status, body } = await post(`/api/terminal/payments/${id}/simulate`, {
          outcome,
        });
        if (body.payment) adopt(body.payment);
        if (status >= 400) throw new Error(body.error ?? `HTTP ${status}`);
      }),
    [act, post, adopt],
  );

  return {
    online,
    list,
    selectedReaderId,
    selectReader,
    reloadReaders,
    tender,
    phase: cardPhase(tender),
    lastError: lastErrorOf(tender),
    busy,
    error,
    start,
    clearError,
    retry,
    cancel,
    resetReader,
    simulate,
  };
}
