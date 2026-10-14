/**
 * Reads every row of a query, page by page.
 *
 * PostgREST caps each response at `max_rows` (1,000 in supabase/config.toml and on hosted projects), so
 * a limit of 5,000 silently returns 1,000 rows. Anything that must see every row (erasure, exports, sums, job
 * sweeps) pages with `.range()` through this helper instead.
 *
 * The builder is called once per page with an inclusive `[from, to]` range and must return a FRESH query
 * ending in `.range(from, to)`, ordered by a unique column (e.g. `.order("id")`), or rows can repeat or go
 * missing between pages. Paging stops at the first short page, or at `max` rows (then `truncated` is true).
 *
 * The result has the same `{ data, error }` shape as a single supabase-js call, so a caller can swap it in:
 * on an error `data` is null and the rows read so far are dropped (never act on half a list).
 */

/** The largest page PostgREST will return (supabase/config.toml `max_rows`). */
export const POSTGREST_MAX_ROWS = 1000;

/** Default ceiling for one fetchAll call; callers that may legitimately need more pass their own `max`. */
export const FETCH_ALL_DEFAULT_MAX = 100_000;

type PageResponse<T> = { data: T[] | null; error: { message: string } | null };

export type FetchAllOptions = {
  /** Rows per request, clamped to 1..1000. Default 1000. */
  pageSize?: number;
  /** Hard ceiling on rows returned (stops runaway loops). Default 100,000. */
  max?: number;
};

export type FetchAllResult<T> =
  | { data: T[]; error: null; truncated: boolean }
  | { data: null; error: { message: string }; truncated: false };

export async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<PageResponse<T>>,
  opts: FetchAllOptions = {},
): Promise<FetchAllResult<T>> {
  const pageSize = Math.max(
    1,
    Math.min(POSTGREST_MAX_ROWS, Math.floor(opts.pageSize ?? POSTGREST_MAX_ROWS)),
  );
  const max = Math.max(0, Math.floor(opts.max ?? FETCH_ALL_DEFAULT_MAX));
  const rows: T[] = [];
  for (let from = 0; from < max; from += pageSize) {
    const to = Math.min(from + pageSize, max) - 1;
    const { data, error } = await build(from, to);
    if (error) return { data: null, error, truncated: false };
    const page = data ?? [];
    rows.push(...page);
    // A page shorter than asked for is the last one. (A server cap below pageSize also lands here, which is
    // why pageSize never exceeds max_rows.)
    if (page.length < to - from + 1) return { data: rows, error: null, truncated: false };
  }
  // Reached the ceiling with full pages: there may be more rows than we read.
  return { data: rows.slice(0, max), error: null, truncated: true };
}
