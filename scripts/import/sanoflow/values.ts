/**
 * Pure value parsing for the Sanoflow importers: local dates and times, money, statuses, quick-reply
 * shortcuts and stable ids for rows that have none. No I/O; unit-tested.
 */
import { createHash } from "node:crypto";
import { fromZonedTime } from "date-fns-tz";

import { MAX_REASON_LENGTH, type EnquiryStatus } from "@/lib/enquiries/constants";

import { DEFAULT_STATUS_WORDS, type SanoflowConfig } from "./config";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number) => String(n).padStart(2, "0");

function validYmd(y: number, m: number, d: number): boolean {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** "2026-03-04", "04/03/2026", "4-3-26", "04 Mar 2026", "Mar 4, 2026" → "2026-03-04" (or null). */
export function parseDay(raw: string, order: "dmy" | "mdy" = "dmy"): string | null {
  const s = raw.trim();
  if (!s) return null;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) {
    const [y, mo, d] = [+m[1], +m[2], +m[3]];
    return validYmd(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
  }
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    const [d, mo] = order === "dmy" ? [a, b] : [b, a];
    return validYmd(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
  }
  m = /^(\d{1,2})[\s-]+([a-z]{3})[a-z]*\.?[\s-]+(\d{4})$/i.exec(s);
  if (m) {
    const mo = MONTHS.indexOf(m[2].toLowerCase()) + 1;
    return mo && validYmd(+m[3], mo, +m[1]) ? `${m[3]}-${pad(mo)}-${pad(+m[1])}` : null;
  }
  m = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/i.exec(s);
  if (m) {
    const mo = MONTHS.indexOf(m[1].toLowerCase()) + 1;
    return mo && validYmd(+m[3], mo, +m[2]) ? `${m[3]}-${pad(mo)}-${pad(+m[2])}` : null;
  }
  return null;
}

/** "14:05", "2:05 PM", "14:05:30", "2pm" → "14:05:00" (or null). */
export function parseClock(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return null;
  const m = /^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?$/.exec(s);
  if (!m) return null;
  let h = +m[1];
  const min = m[2] ? +m[2] : 0;
  const sec = m[3] ? +m[3] : 0;
  if (m[4]) {
    if (h < 1 || h > 12) return null;
    if (m[4] === "pm" && h !== 12) h += 12;
    if (m[4] === "am" && h === 12) h = 0;
  } else if (!m[2]) return null; // a bare number is not a time
  if (h > 23 || min > 59 || sec > 59) return null;
  return `${pad(h)}:${pad(min)}:${pad(sec)}`;
}

/**
 * A date (and optional separate time) written in the clinic's local time → UTC instant.
 * A value with an explicit offset or Z is taken as is. Returns null when it cannot be read.
 */
export function parseLocalDateTime(
  dateRaw: string,
  timeRaw: string | null,
  timezone: string,
  order: "dmy" | "mdy" = "dmy",
): Date | null {
  const s = dateRaw.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // "2026-03-04 14:05", "04/03/2026 2:05 PM", "2026-03-04T14:05"
  const split = /^(\S+?)(?:[T\s]+(\d{1,2}(?::\d{2}){0,2}\s*(?:[ap]m)?))?$/i.exec(s);
  let day: string | null = null;
  let clock: string | null = null;
  if (split) {
    day = parseDay(split[1], order);
    if (split[2]) clock = parseClock(split[2]);
    if (split[2] && !clock) return null;
  }
  if (!day) day = parseDay(s, order);
  if (!day) return null;
  if (timeRaw && timeRaw.trim()) {
    clock = parseClock(timeRaw);
    if (!clock) return null;
  }
  const d = fromZonedTime(`${day}T${clock ?? "00:00:00"}`, timezone);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "AED 1,250.50", "1250", "" → 1250.5 / 1250 / null. Negative or unreadable → undefined (invalid). */
export function parseMoney(raw: string): number | null | undefined {
  const s = raw.replace(/[^\d.,-]/g, "").replace(/,/g, "");
  if (!raw.trim()) return null;
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return undefined;
  const n = Number(s);
  return n < 0 || n > 9_999_999_999 ? undefined : Math.round(n * 100) / 100;
}

/** Minutes from "30", "30 min", "1h", "1:30" (h:mm). */
export function parseDurationMin(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  let m = /^(\d{1,3})\s*(m|min|mins|minutes)?$/.exec(s);
  if (m) return +m[1] || null;
  m = /^(\d{1,2})\s*(h|hr|hrs|hours)$/.exec(s);
  if (m) return +m[1] * 60 || null;
  m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m) return +m[1] * 60 + +m[2] || null;
  return null;
}

const statusKey = (s: string) => s.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");

/** Sanoflow status text → Pulse status; config first, then the built-in words. Blank → open. */
export function mapStatus(
  raw: string,
  config: Pick<SanoflowConfig, "statuses">,
): EnquiryStatus | null {
  const k = statusKey(raw);
  if (!k) return "open";
  for (const [from, to] of Object.entries(config.statuses)) if (statusKey(from) === k) return to;
  return DEFAULT_STATUS_WORDS[k] ?? null;
}

/** The reason Pulse stores for a lost / disqualified enquiry (never blank, never over the limit). */
export function mapLostReason(
  raw: string,
  config: Pick<SanoflowConfig, "lost_reasons" | "default_lost_reason">,
): string {
  const r = raw.trim();
  if (!r) return config.default_lost_reason;
  for (const [from, to] of Object.entries(config.lost_reasons))
    if (from.trim().toLowerCase() === r.toLowerCase()) return to.slice(0, MAX_REASON_LENGTH);
  return r.slice(0, MAX_REASON_LENGTH);
}

export type ApptStatusDecision = "awaiting" | "confirmed" | "skip_cancelled" | "skip_done" | null;

/** Sanoflow appointment status → what the importer does with a FUTURE appointment. */
export function mapAppointmentStatus(raw: string): ApptStatusDecision {
  const k = statusKey(raw);
  if (
    !k ||
    ["booked", "scheduled", "pending", "awaiting", "new", "requested", "rescheduled"].includes(k)
  )
    return "awaiting";
  if (["confirmed", "confirm", "checked in", "arrived"].includes(k)) return "confirmed";
  if (k.startsWith("cancel") || ["deleted", "rejected", "declined"].includes(k))
    return "skip_cancelled";
  if (["completed", "done", "no show", "noshow", "visited", "checked out"].includes(k))
    return "skip_done";
  return null;
}

/** A quick-reply shortcut Pulse accepts (^[a-z0-9_-]{1,40}$), or null if nothing usable is left. */
export function toShortcut(raw: string): string | null {
  const s = raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/^\//, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/-$/, "");
  return s || null;
}

/** Deterministic id for an export row that has no id of its own (activity lines). */
export function stableId(parts: readonly string[]): string {
  return createHash("sha256")
    .update(parts.map((p) => p.trim()).join("\u001f"))
    .digest("hex")
    .slice(0, 32);
}

/** Lower-cased trimmed key for name-keyed refs. */
export const nameKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
