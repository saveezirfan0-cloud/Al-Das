/**
 * Minimal 5-field cron matcher for recurring flow triggers (minute hour day-of-month month
 * day-of-week), evaluated in a time zone. Supports `*`, lists, ranges and steps; day-of-week
 * 0 and 7 are Sunday. As in cron, when both day fields are restricted either may match.
 */
import { formatInTimeZone } from "date-fns-tz";

type Field = { min: number; max: number };
const FIELDS: Field[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 7 },
];

export class CronError extends Error {}

function parseField(src: string, f: Field): Set<number> {
  const out = new Set<number>();
  for (const part of src.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new CronError(`Invalid cron field "${src}"`);
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) throw new CronError(`Invalid cron step in "${src}"`);
    let lo: number;
    let hi: number;
    if (m[1] === "*") {
      lo = f.min;
      hi = f.max;
    } else if (m[1].includes("-")) {
      [lo, hi] = m[1].split("-").map(Number);
    } else {
      lo = Number(m[1]);
      hi = m[2] ? f.max : lo;
    }
    if (lo < f.min || hi > f.max || lo > hi)
      throw new CronError(`Cron value out of range in "${src}"`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export type ParsedCron = { sets: Set<number>[]; domStar: boolean; dowStar: boolean };

export function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5)
    throw new CronError("A schedule has five fields: minute hour day month weekday");
  const sets = parts.map((p, i) => parseField(p, FIELDS[i]));
  if (sets[4].has(7)) sets[4].add(0);
  return { sets, domStar: parts[2] === "*", dowStar: parts[4] === "*" };
}

export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}

export function cronMatches(expr: string | ParsedCron, at: Date, timezone = "Asia/Dubai"): boolean {
  const c = typeof expr === "string" ? parseCron(expr) : expr;
  const p = formatInTimeZone(at, timezone, "m H d M i").split(" ").map(Number); // i = ISO day 1..7 (Mon..Sun)
  const [minute, hour, dom, month, isoDow] = p;
  const dow = isoDow % 7;
  if (!c.sets[0].has(minute) || !c.sets[1].has(hour) || !c.sets[3].has(month)) return false;
  const domOk = c.sets[2].has(dom);
  const dowOk = c.sets[4].has(dow);
  if (!c.domStar && !c.dowStar) return domOk || dowOk;
  return domOk && dowOk;
}

/** Idempotency key for "this schedule at this minute". */
export function minuteKey(at: Date, timezone = "Asia/Dubai"): string {
  return formatInTimeZone(at, timezone, "yyyyMMddHHmm");
}
