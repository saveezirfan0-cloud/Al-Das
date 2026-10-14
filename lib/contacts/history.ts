/**
 * Patient 360 History tab (Phase F): one timeline of a patient's messages, appointments, enquiries, tasks and notes,
 * newest first and paged. Pure: each source is read separately (with its own permission and RLS) and merged here.
 *
 * The cursor is the last item shown: `<iso time>|<kind>:<id>`. Items are ordered by time, then by that key, so two
 * items at the same instant never swap places or vanish between pages.
 */

export const HISTORY_KINDS = ["message", "appointment", "enquiry", "task", "note"] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];

export type HistoryItem = {
  kind: HistoryKind;
  id: string;
  at: string;
  title: string;
  detail?: string | null;
  /** Same-origin link to the record, built from ids only. */
  href?: string | null;
};

export const HISTORY_PAGE_SIZE = 30;

type Cursor = { at: number; key: string };

const keyOf = (i: Pick<HistoryItem, "kind" | "id">) => `${i.kind}:${i.id}`;

export function historyCursor(item: Pick<HistoryItem, "kind" | "id" | "at">): string {
  return `${new Date(item.at).toISOString()}|${keyOf(item)}`;
}

export function parseHistoryCursor(raw: string | null | undefined): Cursor | null {
  if (!raw) return null;
  const bar = raw.indexOf("|");
  if (bar < 0) return null;
  const at = new Date(raw.slice(0, bar)).getTime();
  const key = raw.slice(bar + 1);
  if (Number.isNaN(at) || !/^(message|appointment|enquiry|task|note):[0-9a-f-]{36}$/i.test(key)) return null;
  return { at, key };
}

/** Newest first; equal times by key, descending. */
export function compareHistory(a: HistoryItem, b: HistoryItem): number {
  const d = new Date(b.at).getTime() - new Date(a.at).getTime();
  if (d !== 0) return d;
  const ka = keyOf(a);
  const kb = keyOf(b);
  return ka < kb ? 1 : ka > kb ? -1 : 0;
}

/** Is the item strictly after the cursor in the (newest first) order, i.e. on a later page? */
export function afterCursor(item: HistoryItem, cursor: Cursor | null): boolean {
  if (!cursor) return true;
  const t = new Date(item.at).getTime();
  if (t !== cursor.at) return t < cursor.at;
  return keyOf(item) < cursor.key;
}

/**
 * Merges what the sources returned (each read with `at <= cursor time`, newest first, at most `perSource` rows) into
 * one page. `full` says a source may have more rows than it returned, so the page ends at the oldest item that every
 * full source still covers, and there is a next page.
 */
export function mergeHistory(
  sources: ReadonlyArray<{ items: readonly HistoryItem[]; full: boolean }>,
  limit: number,
  cursor: string | null | undefined,
): { items: HistoryItem[]; nextCursor: string | null } {
  const c = parseHistoryCursor(cursor);
  // A full source only covers down to its oldest returned item; nothing older from any source may be shown yet.
  let floor = -Infinity;
  for (const s of sources) {
    if (!s.full || s.items.length === 0) continue;
    const oldest = Math.min(...s.items.map((i) => new Date(i.at).getTime()));
    floor = Math.max(floor, oldest);
  }
  const all = sources
    .flatMap((s) => s.items)
    .filter((i) => afterCursor(i, c))
    .filter((i) => new Date(i.at).getTime() >= floor)
    .sort(compareHistory);
  const seen = new Set<string>();
  const unique = all.filter((i) => (seen.has(keyOf(i)) ? false : (seen.add(keyOf(i)), true)));
  const page = unique.slice(0, limit);
  const more = unique.length > limit || sources.some((s) => s.full);
  return { items: page, nextCursor: more && page.length ? historyCursor(page[page.length - 1]) : null };
}
