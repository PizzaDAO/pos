/**
 * Paging helpers shared by the Supabase driver and the /v1 layer.
 *
 * PostgREST silently truncates any response at the project's `max_rows`
 * (default 1000), so "select everything for these ids" must page explicitly with
 * `.range()` over a STABLE order until a short page comes back.
 */

/** Rows requested per round trip (must be <= the server's max_rows). */
export const PAGE_SIZE = 500;

/**
 * Fetch every row of a query by paging. `fetchPage(from, to)` must run the SAME
 * query with a stable total order and `.range(from, to)` (inclusive).
 */
export async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => PromiseLike<T[]>,
  pageSize: number = PAGE_SIZE,
  maxRows = 200_000,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; out.length < maxRows; from += pageSize) {
    const rows = await fetchPage(from, from + pageSize - 1);
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isIsoTimestamp(v: unknown): v is string {
  return typeof v === "string" && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));
}

export function isGuid(v: unknown): v is string {
  return typeof v === "string" && GUID_RE.test(v);
}

/**
 * Validate + normalize a keyset cursor before it is interpolated into a
 * PostgREST `or()` filter. Throws on anything but ISO timestamp + GUID, and
 * emits the timestamp in `Z` form (a literal `+` in a filter value is unsafe).
 */
export function safeKeyset(after: { created_at: string; id: string }): {
  created_at: string;
  id: string;
} {
  if (!isIsoTimestamp(after.created_at) || !isGuid(after.id)) {
    throw new Error("invalid keyset cursor");
  }
  return { created_at: new Date(after.created_at).toISOString(), id: after.id };
}
