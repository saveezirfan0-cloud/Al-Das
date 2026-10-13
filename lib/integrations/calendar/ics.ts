import { createHash } from "node:crypto";

/**
 * iCalendar (RFC 5545) rendering for the doctor calendar feeds (pure).
 *
 * What an event may contain, and nothing else: a stable id derived from the appointment id, the start and end (UTC), the generic
 * title "Appointment" and the clinic location's NAME. No patient name, phone, note, service or department. A cancelled
 * appointment stays in the feed as STATUS:CANCELLED with a higher SEQUENCE so a calendar app removes it.
 *
 * Wire format: CRLF line endings, TEXT values escaped (backslash, semicolon, comma, newline), content lines folded at 75 octets
 * without splitting a UTF-8 character, all times in UTC ("Z").
 */

export const ICS_PRODID = "-//Pulse//Doctor calendar feed//EN";
export const FEED_PAST_DAYS = 7;
export const FEED_FUTURE_DAYS = 60;
export const GENERIC_SUMMARY = "Appointment";

export type IcsAppointment = {
  id: string;
  startsAt: string;
  endsAt: string;
  /** awaiting | confirmed | cancelled | completed | no_show */
  status: string;
  /** Last change of the appointment row; drives DTSTAMP and SEQUENCE. */
  updatedAt: string;
  locationName: string | null;
};

/** TEXT escaping per RFC 5545 section 3.3.11. Control characters other than newline are dropped. */
export function escapeText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** Folds one content line to at most 75 octets per physical line (continuation lines start with one space). */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > limit) {
      parts.push(current);
      current = "";
      bytes = 0;
      limit = 74; // the leading space of a continuation line counts as one octet
    }
    current += ch;
    bytes += n;
  }
  if (current) parts.push(current);
  return parts.join("\r\n ");
}

/** 20261012T143000Z */
export function formatUtc(date: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${p(date.getUTCFullYear(), 4)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `T${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`
  );
}

/** Stable per appointment, never changes when the appointment moves, reveals nothing but a hash. */
export function eventUid(appointmentId: string): string {
  return `${createHash("sha256").update(`pulse-ics:${appointmentId}`).digest("hex").slice(0, 32)}@pulse.calendar`;
}

const SEQUENCE_EPOCH_MS = Date.UTC(2020, 0, 1);

/** Whole minutes since 2020-01-01 of the last change: grows with every edit and fits a 32-bit integer for decades. */
export function sequenceOf(updatedAt: string): number {
  const t = Date.parse(updatedAt);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((t - SEQUENCE_EPOCH_MS) / 60_000));
}

export function icsStatus(status: string): "CONFIRMED" | "TENTATIVE" | "CANCELLED" {
  if (status === "cancelled") return "CANCELLED";
  if (status === "awaiting") return "TENTATIVE";
  return "CONFIRMED";
}

export function renderEvent(a: IcsAppointment): string[] {
  const start = new Date(a.startsAt);
  const end = new Date(a.endsAt);
  const stamp = new Date(a.updatedAt);
  const status = icsStatus(a.status);
  const lines = [
    "BEGIN:VEVENT",
    `UID:${eventUid(a.id)}`,
    `DTSTAMP:${formatUtc(Number.isNaN(stamp.getTime()) ? start : stamp)}`,
    `DTSTART:${formatUtc(start)}`,
    `DTEND:${formatUtc(end)}`,
    `SUMMARY:${escapeText(GENERIC_SUMMARY)}`,
  ];
  if (a.locationName?.trim()) lines.push(`LOCATION:${escapeText(a.locationName.trim())}`);
  lines.push(
    `STATUS:${status}`,
    `SEQUENCE:${sequenceOf(a.updatedAt)}`,
    `TRANSP:${status === "CANCELLED" ? "TRANSPARENT" : "OPAQUE"}`,
    "CLASS:PRIVATE",
    "END:VEVENT",
  );
  return lines;
}

/** The whole calendar as one string with CRLF line endings. Events are sorted by start (then id) so output is deterministic. */
export function renderCalendar(input: {
  name: string;
  appointments: readonly IcsAppointment[];
}): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${ICS_PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(input.name)}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];
  const sorted = [...input.appointments].sort(
    (x, y) => Date.parse(x.startsAt) - Date.parse(y.startsAt) || x.id.localeCompare(y.id),
  );
  for (const a of sorted) lines.push(...renderEvent(a));
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/** The window a feed covers: the last 7 days and the next 60. */
export function feedWindow(now: Date): { from: Date; to: Date } {
  const day = 86_400_000;
  return {
    from: new Date(now.getTime() - FEED_PAST_DAYS * day),
    to: new Date(now.getTime() + FEED_FUTURE_DAYS * day),
  };
}
