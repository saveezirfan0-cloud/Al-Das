/**
 * Ctrl+K record search (Phase D), the pure half: how a typed query becomes search terms, and where each result opens.
 * Framework-free so it can be unit-tested. The server half is lib/shell/record-search-server.ts.
 *
 * The query text is patient data (a name or a phone number): it is never logged, stored or sent anywhere but the
 * member's own search.
 */
import { DEFAULT_COUNTRY, normalizePhone } from "@/lib/phone";

/** At most this many results per kind. */
export const RECORD_SEARCH_LIMIT = 5;
/** Shorter queries search pages only. */
export const RECORD_SEARCH_MIN_LENGTH = 2;
/** Longer input is cut, never rejected. */
export const RECORD_SEARCH_MAX_LENGTH = 80;
/** How long the palette waits after the last key before it asks the server. */
export const RECORD_SEARCH_DEBOUNCE_MS = 250;

export type RecordKind = "contact" | "enquiry" | "task";

export type RecordResult = {
  kind: RecordKind;
  id: string;
  label: string;
  /** Second line on the right (e.g. a masked phone, "Enquiry #123", a due date). */
  hint?: string;
  href: string;
};

export type RecordQuery = {
  /** Trimmed, single-spaced, at most RECORD_SEARCH_MAX_LENGTH characters. */
  text: string;
  /** ILIKE pattern with \, % and _ escaped. */
  like: string;
  /** The query's digits when it looks like (part of) a phone number, at least 3 of them. */
  digits: string | null;
  /** The full number in E.164 when the query is a possible phone number (local "050..." numbers too). */
  e164: string | null;
  /** An enquiry number ("123" or "#123"). */
  enquiryNumber: number | null;
};

const PHONEISH = /^[+\d\s().-]+$/;

/** Turns what was typed into search terms, or null when it is too short to search records. */
export function parseRecordQuery(raw: string, country = DEFAULT_COUNTRY): RecordQuery | null {
  const text = raw.replace(/\s+/g, " ").trim().slice(0, RECORD_SEARCH_MAX_LENGTH);
  if (text.length < RECORD_SEARCH_MIN_LENGTH) return null;
  const like = `%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const numberMatch = /^#?(\d{1,9})$/.exec(text);
  const enquiryNumber = numberMatch ? Number(numberMatch[1]) : null;
  let digits: string | null = null;
  let e164: string | null = null;
  if (PHONEISH.test(text)) {
    const d = text.replace(/\D/g, "");
    if (d.length >= 3) digits = d;
    if (d.length >= 7) e164 = normalizePhone(text, country)?.e164 ?? null;
  }
  return { text, like, digits, e164, enquiryNumber };
}

/**
 * Where a result opens: a patient opens the full record page (Patient 360, which needs contacts.view like the search);
 * enquiries and tasks open their drawer through the list page's deep link.
 */
export function recordHref(kind: RecordKind, id: string): string {
  const q = encodeURIComponent(id);
  if (kind === "contact") return `/contacts/${q}`;
  if (kind === "enquiry") return `/enquiries?enquiry=${q}`;
  return `/tasks?task=${q}`;
}

/** The heading each kind's results sit under in the palette. */
export const RECORD_KIND_LABELS: Record<RecordKind, string> = {
  contact: "Patients",
  enquiry: "Enquiries",
  task: "Tasks",
};

/** Merges result lists of one kind: first-seen order, no repeated id, at most `limit`. */
export function mergeResults<T extends { id: string }>(
  lists: ReadonlyArray<readonly T[]>,
  limit = RECORD_SEARCH_LIMIT,
): T[] {
  const seen = new Map<string, T>();
  for (const list of lists) for (const r of list) if (!seen.has(r.id)) seen.set(r.id, r);
  return [...seen.values()].slice(0, limit);
}

/** A phone shown in the palette: the last four digits only (the drawer shows the rest). */
export function phoneHint(e164: string | null | undefined): string | undefined {
  if (!e164) return undefined;
  const d = e164.replace(/\D/g, "");
  return d.length >= 4 ? `ends ${d.slice(-4)}` : undefined;
}
