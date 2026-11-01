/**
 * Cheap, bounded range reads for the Phase 3 read models: header-only order rows
 * (one query per 500 orders, no item graph, no contract mapping) and, for tips,
 * the tenders of just those orders plus refunded tenders. Aborts EARLY (a
 * {@link RangeTooLarge} after at most `cap` + 1 rows) instead of paging the
 * whole range and answering 422 at the end.
 */
import { businessDate } from "@openpizza/core";
import type { OrderHead, Payment, PosDriver } from "@/lib/db";
import { sortTipFacts, tipFactsForOrder } from "./tips";
import type { TipFact } from "@openpizza/core";

export class RangeTooLarge extends Error {
  constructor(message = "That range holds too many orders; narrow from..to or pass location_id.") {
    super(message);
  }
}

export const HEAD_PAGE = 500;
export const RANGE_ORDER_CAP = 10_000;
const DAY = 86_400_000;

const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** business_date is location-local: pad the UTC created_at window a day before, two after. */
export const paddedWindow = (from: string, to: string) => ({
  createdFrom: new Date(dayMs(from) - DAY).toISOString(),
  createdTo: new Date(dayMs(to) + 2 * DAY).toISOString(),
});

export interface HeadInRange extends OrderHead {
  business_date: string;
  timezone: string;
}

/** Headers of the orders whose business date is in [from, to]. Throws {@link RangeTooLarge}. */
export async function loadHeadsInRange(
  driver: PosDriver,
  tenantId: string,
  opts: {
    locationIds: string[] | null;
    from: string;
    to: string;
    timezones: Map<string, string>;
    cap?: number;
  },
): Promise<HeadInRange[]> {
  const cap = opts.cap ?? RANGE_ORDER_CAP;
  const win = paddedWindow(opts.from, opts.to);
  const out: HeadInRange[] = [];
  let scanned = 0;
  let after: { created_at: string; id: string } | undefined;
  for (;;) {
    const page = await driver.listOrderHeads(tenantId, {
      locationIds: opts.locationIds,
      ...win,
      after,
      limit: HEAD_PAGE,
    });
    scanned += page.length;
    if (scanned > cap) throw new RangeTooLarge();
    for (const h of page) {
      const timezone = opts.timezones.get(h.location_id) ?? "UTC";
      const bd = businessDate(h.created_at, timezone);
      if (bd >= opts.from && bd <= opts.to) out.push({ ...h, business_date: bd, timezone });
    }
    if (page.length < HEAD_PAGE) return out;
    const last = page[page.length - 1]!;
    after = { created_at: last.created_at, id: last.id };
  }
}

/** Tenders for many orders in id chunks. */
export async function paymentsForOrders(
  driver: PosDriver,
  orderIds: string[],
): Promise<Map<string, Payment[]>> {
  const out = new Map<string, Payment[]>();
  for (let i = 0; i < orderIds.length; i += 200) {
    for (const [k, v] of await driver.listPaymentsForOrders(orderIds.slice(i, i + 200))) {
      out.set(k, v);
    }
  }
  return out;
}

export interface TipCursor {
  business_date: string;
  occurred_at: string;
  id: string;
}

const cmp = (f: TipFact, c: TipCursor) =>
  f.business_date.localeCompare(c.business_date) ||
  f.occurred_at.localeCompare(c.occurred_at) ||
  f.id.localeCompare(c.id);

/**
 * Up to `need` + 1 tip facts with business_date in [from, to], after `cursor`,
 * in (business_date, occurred_at, id) order. Scans the range in 7-day chunks and
 * stops as soon as a finished chunk has enough, so a first page over a long range
 * is cheap and a later page starts at its cursor's date, not at `from`.
 *
 * Adjustments are dated by when the refund happened, so they can belong to an
 * order created long before the chunk: refunded tenders changed since the start
 * of the range are read once (bounded, aborts on overflow) and their orders
 * built whole.
 */
export async function loadTipFacts(
  driver: PosDriver,
  tenantId: string,
  opts: {
    locationIds: string[] | null;
    from: string;
    to: string;
    timezones: Map<string, string>;
    cursor?: TipCursor;
    need: number;
  },
): Promise<TipFact[]> {
  const from = opts.cursor && opts.cursor.business_date > opts.from ? opts.cursor.business_date : opts.from;
  if (from > opts.to) return [];
  const pool: TipFact[] = [];
  const done = new Set<string>();

  // 1. Orders touched by a refund since the range began.
  const REFUND_CAP = 1000;
  const refunded = await driver.listRefundedPayments(tenantId, {
    locationIds: opts.locationIds,
    since: new Date(dayMs(from) - DAY).toISOString(),
    limit: REFUND_CAP,
  });
  if (refunded.length >= REFUND_CAP) throw new RangeTooLarge("Too many refunds in that range; narrow from..to.");
  const refundOrderIds = [...new Set(refunded.map((p) => p.order_id))];
  if (refundOrderIds.length) {
    const orders = await driver.getOrdersByIds(refundOrderIds);
    const pays = await paymentsForOrders(driver, orders.map((o) => o.id));
    for (const o of orders) {
      done.add(o.id);
      const tz = opts.timezones.get(o.location_id) ?? "UTC";
      pool.push(
        ...tipFactsForOrder(
          {
            id: o.id,
            tenant_id: o.tenant_id,
            location_id: o.location_id,
            business_date: businessDate(o.created_at, tz),
            currency: o.currency,
            staff_id: o.staff_id ?? null,
            status: o.status,
            tip_cents: o.totals.tip_cents,
            timezone: tz,
          },
          pays.get(o.id) ?? [],
        ),
      );
    }
  }

  // 2. Orders created in the range, a chunk at a time.
  let scanned = 0;
  for (let cf = from; cf <= opts.to; ) {
    const ct = isoDay(Math.min(dayMs(cf) + 6 * DAY, dayMs(opts.to)));
    const heads = await loadHeadsInRange(driver, tenantId, {
      locationIds: opts.locationIds,
      from: cf,
      to: ct,
      timezones: opts.timezones,
      cap: RANGE_ORDER_CAP - scanned,
    });
    scanned += heads.length;
    const fresh = heads.filter((h) => !done.has(h.id));
    const pays = await paymentsForOrders(driver, fresh.map((h) => h.id));
    for (const h of fresh) {
      pool.push(
        ...tipFactsForOrder(
          {
            id: h.id,
            tenant_id: h.tenant_id,
            location_id: h.location_id,
            business_date: h.business_date,
            currency: h.currency,
            staff_id: h.staff_id,
            status: h.status,
            tip_cents: h.totals.tip_cents,
            timezone: h.timezone,
          },
          pays.get(h.id) ?? [],
        ),
      );
    }
    const ready = sortTipFacts(
      pool.filter(
        (f) =>
          f.business_date >= from &&
          f.business_date <= ct &&
          f.business_date <= opts.to &&
          (!opts.cursor || cmp(f, opts.cursor) > 0),
      ),
    );
    if (ready.length > opts.need || ct >= opts.to) {
      return sortTipFacts(
        pool.filter(
          (f) =>
            f.business_date >= from &&
            f.business_date <= opts.to &&
            f.business_date <= ct &&
            (!opts.cursor || cmp(f, opts.cursor) > 0),
        ),
      ).slice(0, opts.need + 1);
    }
    cf = isoDay(dayMs(ct) + DAY);
  }
  return [];
}
