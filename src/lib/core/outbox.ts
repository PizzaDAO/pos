/**
 * Transactional event outbox -> Open Pizza hub.
 *
 * WRITE SIDE. In Postgres, AFTER triggers (migration `20260620000000_core_v1`)
 * insert a `core_outbox` row in the SAME transaction as the change to orders,
 * payments, menu availability, locations, customers, staff, shifts, business
 * day closes and deliveries. In the zero-env mock, `withOutbox()` (mock-events)
 * appends the same rows to an in-memory store. Rows are thin: event type,
 * subject, POS-vocabulary `changes`, a row snapshot, and a per-tenant
 * `sequence`.
 *
 * DELIVERY SIDE ({@link deliverOutbox}). Claims due rows, HYDRATES each into the
 * full contract payload from current POS state (the same mappers `/api/v1`
 * uses, validated by the catalog schema in `createEvent`), signs it with
 * Standard Webhooks (`signEvent`) and POSTs it to `OPENPIZZA_HUB_INGEST_URL`.
 * 2xx = delivered; anything else retries on `RETRY_SCHEDULE_SECONDS` (10s, 1m,
 * 5m, 30m, 2h, 6h, 12h, 24h) and then dead-letters. At-least-once: the envelope
 * id is derived deterministically from the outbox row, so retries carry the
 * same `evt_` id and consumers dedupe on it.
 *
 * Note: the payload is a snapshot at DELIVERY time (state may be newer than the
 * transition that created the row). `subject.version` lets consumers discard
 * stale events; `changes` still records the original transition.
 */
import { createClient } from "@supabase/supabase-js";
import {
  createEvent,
  fromPosOrderStatus,
  retryDelaySeconds,
  signEvent,
  type AnyEvent,
  type EventType,
  type PosOrderStatus,
} from "@openpizza/core";
import { getPosDriver, type PosDriver } from "@/lib/db";
import { readSupabaseConfig } from "@/lib/db/supabase";
import {
  customerStats,
  loadDelivery,
  loadLocation,
  loadLocations,
  loadOrder,
  loadPayment,
  loadStaffList,
} from "./loaders";
import {
  toContractCustomer,
  toContractDailySales,
  toContractDrawerSession,
} from "./mappers";

export const EVENT_SOURCE = "openpizza_pos";

export interface OutboxRow {
  id: string;
  tenant_id: string;
  location_id: string | null;
  event_type: string;
  subject_type: string;
  subject_id: string;
  subject_version: number | null;
  sequence: number;
  /** POS vocabulary, e.g. `{ status: ["placed", "in_kitchen"] }`. */
  changes: Record<string, [unknown, unknown]> | null;
  row_snapshot: Record<string, unknown> | null;
  occurred_at: string;
  status: "pending" | "delivered" | "dead";
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  delivered_at: string | null;
}

export type NewOutboxEvent = Pick<
  OutboxRow,
  "tenant_id" | "location_id" | "event_type" | "subject_type" | "subject_id"
> &
  Partial<Pick<OutboxRow, "subject_version" | "changes" | "row_snapshot">>;

export interface OutboxStore {
  claim(limit: number, now: Date): Promise<OutboxRow[]>;
  markDelivered(id: string, at: Date): Promise<void>;
  markRetry(id: string, attempts: number, nextAt: Date, error: string): Promise<void>;
  markDead(id: string, attempts: number, error: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory store (mock driver / tests)
// ---------------------------------------------------------------------------

export class MemoryOutbox implements OutboxStore {
  rows: OutboxRow[] = [];
  private seq = new Map<string, number>();
  private counter = 0;

  append(e: NewOutboxEvent, now: Date = new Date()): OutboxRow {
    const sequence = (this.seq.get(e.tenant_id) ?? 0) + 1;
    this.seq.set(e.tenant_id, sequence);
    this.counter += 1;
    const row: OutboxRow = {
      id: deterministicUuid(this.counter),
      tenant_id: e.tenant_id,
      location_id: e.location_id,
      event_type: e.event_type,
      subject_type: e.subject_type,
      subject_id: e.subject_id,
      subject_version: e.subject_version ?? null,
      sequence,
      changes: e.changes ?? null,
      row_snapshot: e.row_snapshot ?? null,
      occurred_at: now.toISOString(),
      status: "pending",
      attempts: 0,
      next_attempt_at: now.toISOString(),
      last_error: null,
      delivered_at: null,
    };
    this.rows.push(row);
    return row;
  }

  pending(): OutboxRow[] {
    return this.rows.filter((r) => r.status === "pending");
  }

  clear(): void {
    this.rows = [];
    this.seq.clear();
  }

  async claim(limit: number, now: Date): Promise<OutboxRow[]> {
    const due = this.rows
      .filter((r) => r.status === "pending" && r.next_attempt_at <= now.toISOString())
      .slice(0, limit);
    // lease: hide from a concurrent claim for 2 minutes
    for (const r of due) r.next_attempt_at = new Date(now.getTime() + 120_000).toISOString();
    return due.map((r) => ({ ...r }));
  }
  private find(id: string): OutboxRow | undefined {
    return this.rows.find((r) => r.id === id);
  }
  async markDelivered(id: string, at: Date): Promise<void> {
    const r = this.find(id);
    if (r) Object.assign(r, { status: "delivered", delivered_at: at.toISOString(), last_error: null });
  }
  async markRetry(id: string, attempts: number, nextAt: Date, error: string): Promise<void> {
    const r = this.find(id);
    if (r) Object.assign(r, { attempts, next_attempt_at: nextAt.toISOString(), last_error: error });
  }
  async markDead(id: string, attempts: number, error: string): Promise<void> {
    const r = this.find(id);
    if (r) Object.assign(r, { status: "dead", attempts, last_error: error });
  }
}

function deterministicUuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/** Process-wide in-memory outbox used by the mock driver. */
export const memoryOutbox = new MemoryOutbox();

// ---------------------------------------------------------------------------
// Supabase store
// ---------------------------------------------------------------------------

export function createSupabaseOutbox(config: { url: string; key: string }): OutboxStore {
  const sb = createClient(config.url, config.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return {
    async claim(limit) {
      const { data, error } = await sb.rpc("core_outbox_claim", { p_limit: limit });
      if (error) throw new Error(`core_outbox_claim failed: ${error.message}`);
      return (data ?? []) as OutboxRow[];
    },
    async markDelivered(id, at) {
      const { error } = await sb
        .from("core_outbox")
        .update({ status: "delivered", delivered_at: at.toISOString(), last_error: null })
        .eq("id", id);
      if (error) throw new Error(error.message);
    },
    async markRetry(id, attempts, nextAt, err) {
      const { error } = await sb
        .from("core_outbox")
        .update({ attempts, next_attempt_at: nextAt.toISOString(), last_error: err })
        .eq("id", id);
      if (error) throw new Error(error.message);
    },
    async markDead(id, attempts, err) {
      const { error } = await sb
        .from("core_outbox")
        .update({ status: "dead", attempts, last_error: err })
        .eq("id", id);
      if (error) throw new Error(error.message);
    },
  };
}

/** Supabase-backed store when configured, else the in-memory mock store. */
export function getOutboxStore(): OutboxStore {
  const config = readSupabaseConfig();
  return config ? createSupabaseOutbox(config) : memoryOutbox;
}

// ---------------------------------------------------------------------------
// Event ids (deterministic per outbox row => stable across retries)
// ---------------------------------------------------------------------------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function crockford(value: bigint, length: number): string {
  let out = "";
  let v = value;
  for (let i = 0; i < length; i++) {
    out = CROCKFORD[Number(v & 31n)]! + out;
    v >>= 5n;
  }
  return out;
}

/** `evt_<ULID>`: 48-bit time from `occurred_at` + 80 bits of the row id. */
export function eventIdFor(row: Pick<OutboxRow, "id" | "occurred_at">): string {
  const time = BigInt(new Date(row.occurred_at).getTime());
  const hex = row.id.replace(/-/g, "").slice(-20);
  return `evt_${crockford(time, 10)}${crockford(BigInt(`0x${hex}`), 16)}`;
}

// ---------------------------------------------------------------------------
// Hydration: outbox row -> contract event
// ---------------------------------------------------------------------------

type Changes = Record<string, [unknown, unknown]>;

function mapChanges(row: OutboxRow): Changes | null {
  const raw = row.changes;
  if (!raw) return null;
  const out: Changes = {};
  const status = raw.status;
  if (status && row.subject_type === "order") {
    const [from, to] = status as [PosOrderStatus, PosOrderStatus];
    const a = fromPosOrderStatus(from);
    const b = fromPosOrderStatus(to, a.fulfillment_status);
    if (a.fulfillment_status !== b.fulfillment_status) {
      out.fulfillment_status = [a.fulfillment_status, b.fulfillment_status];
    }
    if (a.payment_status !== b.payment_status && b.payment_status) {
      out.payment_status = [a.payment_status ?? "unpaid", b.payment_status];
    }
  } else {
    for (const [k, v] of Object.entries(raw)) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** Build the contract event for an outbox row, or null when the subject is gone. */
export async function hydrateEvent(
  row: OutboxRow,
  driver: PosDriver = getPosDriver(),
): Promise<AnyEvent | null> {
  const t = row.event_type as EventType;
  const tenant = row.tenant_id;
  let data: unknown;
  let locationId = row.location_id;
  let subjectId = row.subject_id;

  if (t.startsWith("order.")) {
    data = await loadOrder(tenant, row.subject_id, driver);
  } else if (t.startsWith("payment.")) {
    data = await loadPayment(tenant, row.subject_id, driver);
  } else if (t === "menu.item.available" || t === "menu.item.unavailable") {
    const snap = row.row_snapshot ?? {};
    data = {
      location_id: row.location_id,
      target_type: snap.target_type,
      target_id: row.subject_id,
      reason: t === "menu.item.unavailable" ? "86" : null,
    };
  } else if (t === "menu.updated") {
    const snap = row.row_snapshot ?? {};
    const changedItem =
      (snap.changed_item_id as string | null | undefined) ??
      (snap.target_type === "item" ? (snap.target_id as string) : null);
    const locIds = row.location_id
      ? [row.location_id]
      : (await loadLocations(tenant, driver)).map((b) => b.location.id);
    data = {
      location_ids: locIds,
      changed_item_ids: changedItem ? [changedItem] : [],
    };
    subjectId = row.subject_id;
  } else if (t === "location.updated") {
    data = (await loadLocation(tenant, row.subject_id, driver))?.contract ?? null;
    locationId = row.subject_id;
  } else if (t === "customer.created" || t === "customer.updated") {
    const c = await driver.getCustomer(row.subject_id);
    if (c && c.tenant_id === tenant) {
      const stats = (await customerStats(tenant, undefined, driver)).get(c.id);
      data = toContractCustomer(
        c,
        stats ?? { order_count: 0, last_order_at: null, lifetime_spend_cents: 0 },
      );
    }
  } else if (t.startsWith("staff.")) {
    data = (await loadStaffList(tenant, driver)).find((s) => s.id === row.subject_id) ?? null;
  } else if (t.startsWith("drawer_session.")) {
    const shift = await driver.getShift(row.subject_id);
    if (shift && shift.tenant_id === tenant) {
      const loc = await loadLocation(tenant, shift.location_id, driver);
      if (loc) {
        data = toContractDrawerSession({
          shift,
          recon: await driver.getDrawerReconciliation(shift.id),
          currency: loc.settings.currency,
          timezone: loc.location.timezone,
        });
      }
    }
  } else if (t === "business_day.closed") {
    const snap = row.row_snapshot ?? {};
    const close = await driver.getBusinessDayClose(
      tenant,
      String(snap.location_id ?? row.location_id),
      String(snap.business_date),
    );
    const loc = close ? await loadLocation(tenant, close.location_id, driver) : null;
    data = close && loc ? toContractDailySales(close, loc.settings.currency) : null;
  } else if (t === "delivery.status_changed") {
    data = await loadDelivery(tenant, row.subject_id, driver);
  } else {
    return null;
  }
  if (data === null || data === undefined) return null;

  return createEvent({
    id: eventIdFor(row),
    type: t,
    tenant_id: tenant,
    location_id: locationId,
    source: EVENT_SOURCE,
    subject: { id: subjectId, version: row.subject_version },
    sequence: row.sequence,
    data: data as never,
    changes: mapChanges(row),
    occurred_at: row.occurred_at,
  }) as AnyEvent;
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export interface DeliverOptions {
  ingestUrl: string;
  /** `whsec_...`; several during rotation. */
  secret: string | readonly string[];
  store?: OutboxStore;
  driver?: PosDriver;
  fetch?: typeof fetch;
  now?: () => Date;
  limit?: number;
  timeoutMs?: number;
  random?: () => number;
}

export interface DeliverResult {
  claimed: number;
  delivered: number;
  retried: number;
  dead: number;
}

export async function deliverOutbox(opts: DeliverOptions): Promise<DeliverResult> {
  const store = opts.store ?? getOutboxStore();
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const now = opts.now ?? (() => new Date());
  const result: DeliverResult = { claimed: 0, delivered: 0, retried: 0, dead: 0 };

  const rows = await store.claim(opts.limit ?? 50, now());
  result.claimed = rows.length;

  for (const row of rows) {
    const attempts = row.attempts + 1;
    let error: string | null = null;
    try {
      const event = await hydrateEvent(row, opts.driver);
      if (!event) {
        // Subject deleted since the change: nothing to send.
        await store.markDead(row.id, attempts, "subject_gone");
        result.dead += 1;
        continue;
      }
      const { body, headers } = await signEvent(event, opts.secret, now());
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
      try {
        const res = await doFetch(opts.ingestUrl, {
          method: "POST",
          headers: { ...headers, "openpizza-source": EVENT_SOURCE },
          body,
          signal: ctrl.signal,
        });
        if (res.ok) {
          await store.markDelivered(row.id, now());
          result.delivered += 1;
          continue;
        }
        error = `HTTP ${res.status}`;
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    const delay = retryDelaySeconds(attempts, opts.random);
    if (delay === null) {
      await store.markDead(row.id, attempts, error ?? "unknown");
      result.dead += 1;
    } else {
      await store.markRetry(
        row.id,
        attempts,
        new Date(now().getTime() + delay * 1000),
        error ?? "unknown",
      );
      result.retried += 1;
    }
  }
  return result;
}

/** Delivery config from env; null when the hub is not configured. */
export function readHubEnv(
  env: Record<string, string | undefined> = process.env,
): { ingestUrl: string; secret: string[] } | null {
  const ingestUrl = env.OPENPIZZA_HUB_INGEST_URL;
  const secret = env.OPENPIZZA_HUB_WEBHOOK_SECRET;
  if (!ingestUrl || !secret) return null;
  return {
    ingestUrl,
    secret: secret
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
