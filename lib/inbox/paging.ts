/**
 * Keyset paging for the inbox (D5): the conversation list and a thread's messages.
 * Pure: the cursor format, the PostgREST filters built from it, and how pages are merged
 * on the client. A cursor is opaque to the browser; it carries a timestamp and a row id only.
 *
 * Conversations are ordered by (last_message_at, id): newest first is "desc, nulls last",
 * oldest first is "asc, nulls first". Messages are ordered by (at, id) desc.
 */

export const CONVERSATION_PAGE_SIZE = 100;
export const MESSAGE_PAGE_SIZE = 200;

export type PageCursor = { at: string | null; id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * The exact timestamp text PostgREST returns (microseconds kept: rounding to milliseconds would
 * skip rows that share the millisecond). Strict, so the value is safe inside an `or` filter.
 */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)?$/;

export function isCursorTimestamp(v: string): boolean {
  if (!TIMESTAMP.test(v)) return false;
  // Date.parse wants "T" and a full "+hh:mm" offset; this only checks the date is real.
  const iso = v.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  return !Number.isNaN(Date.parse(iso));
}

/** `<timestamp>|<id>`; an empty timestamp stands for a conversation with no messages yet. */
export function encodeCursor(c: PageCursor): string {
  return `${c.at ?? ""}|${c.id}`;
}

/** Null for anything that is not a cursor this module wrote (never throws). */
export function decodeCursor(raw: unknown): PageCursor | null {
  if (typeof raw !== "string" || raw.length > 120) return null;
  const sep = raw.lastIndexOf("|");
  if (sep < 0) return null;
  const at = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  if (!UUID.test(id)) return null;
  if (at === "") return { at: null, id };
  return isCursorTimestamp(at) ? { at, id } : null;
}

/**
 * PostgREST `or` filter for the rows after `c` in the conversation list order.
 * Values are double-quoted (timestamps contain `.` and `:`); decodeCursor already rejected
 * anything else.
 */
export function conversationAfterFilter(c: PageCursor, sort: "newest" | "oldest"): string {
  if (sort === "newest") {
    // last_message_at desc nulls last, id desc
    if (c.at === null) return `and(last_message_at.is.null,id.lt.${c.id})`;
    return `last_message_at.lt."${c.at}",and(last_message_at.eq."${c.at}",id.lt.${c.id}),last_message_at.is.null`;
  }
  // last_message_at asc nulls first, id asc
  if (c.at === null)
    return `and(last_message_at.is.null,id.gt.${c.id}),last_message_at.not.is.null`;
  return `last_message_at.gt."${c.at}",and(last_message_at.eq."${c.at}",id.gt.${c.id})`;
}

/** PostgREST `or` filter for the messages before `c` (older), in (at, id) desc order. */
export function messagesBeforeFilter(c: PageCursor): string {
  if (c.at === null) throw new Error("messagesBeforeFilter: a message cursor needs a timestamp");
  return `at.lt."${c.at}",and(at.eq."${c.at}",id.lt.${c.id})`;
}

/**
 * Splits a `limit + 1` fetch into the page and the cursor of its last row (null when nothing
 * more exists).
 */
export function takePage<T>(
  rows: T[],
  limit: number,
  cursorOf: (row: T) => PageCursor,
): { rows: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { rows, nextCursor: null };
  const page = rows.slice(0, limit);
  return { rows: page, nextCursor: encodeCursor(cursorOf(page[page.length - 1])) };
}

/**
 * The conversation list shown: the live first page, then the older pages the person loaded.
 * A conversation in both (it got a new message) keeps its first-page copy, which is fresher.
 */
export function mergeConversationPages<T extends { id: string }>(firstPage: T[], older: T[]): T[] {
  const seen = new Set(firstPage.map((r) => r.id));
  const out = [...firstPage];
  for (const r of older) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

type MessageLike = { id: string; at: string };

function compareMessages(a: MessageLike, b: MessageLike): number {
  if (a.at !== b.at) {
    const ta = Date.parse(a.at);
    const tb = Date.parse(b.at);
    if (ta !== tb && !Number.isNaN(ta) && !Number.isNaN(tb)) return ta - tb;
    return a.at < b.at ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * A thread as shown: earlier pages the person loaded plus the live latest page, oldest first,
 * one copy per message (the live copy wins: it carries the latest delivery status).
 */
export function mergeMessagePages<T extends MessageLike>(earlier: T[], live: T[]): T[] {
  const byId = new Map<string, T>();
  for (const m of earlier) byId.set(m.id, m);
  for (const m of live) byId.set(m.id, m);
  return [...byId.values()].sort(compareMessages);
}

/**
 * When the live latest page moves on (new messages arrive), the oldest messages of the
 * previous live page fall out of it. Once earlier pages are loaded those messages must stay
 * on screen, so they are kept with the earlier pages. Returns the ones to keep.
 */
export function droppedFromLive<T extends MessageLike>(prevLive: T[], nextLive: T[]): T[] {
  if (prevLive.length === 0) return [];
  const nextIds = new Set(nextLive.map((m) => m.id));
  const oldestNext = nextLive.reduce<T | null>(
    (min, m) => (min === null || compareMessages(m, min) < 0 ? m : min),
    null,
  );
  return prevLive.filter(
    (m) => !nextIds.has(m.id) && (oldestNext === null || compareMessages(m, oldestNext) < 0),
  );
}
