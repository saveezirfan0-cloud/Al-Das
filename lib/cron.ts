/**
 * Minimal 5-field cron matcher (minute hour day-of-month month day-of-week) evaluated in a timezone.
 * Supports `*`, lists (1,5), ranges (1-5) and steps (*\/15, 10-30/5). Day-of-week: 0 or 7 = Sunday.
 * Like Vixie cron, when both day-of-month and day-of-week are restricted either may match.
 * Used by the recall_run / flow_recurring tasks, which pg_cron pings every minute.
 */
import { formatInTimeZone } from "date-fns-tz";

type Field = { values: Set<number>; star: boolean };

const RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
] as const;

function parseField(src: string, [min, max]: readonly [number, number]): Field | null {
  const values = new Set<number>();
  let star = false;
  for (const part of src.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) return null;
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
      if (stepPart === undefined) star = true;
    } else if (rangePart!.includes("-")) {
      const [a, b] = rangePart!.split("-").map(Number);
      lo = a!;
      hi = b!;
    } else {
      lo = Number(rangePart);
      hi = stepPart === undefined ? lo : max;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { values, star };
}

export function parseCron(expr: string): Field[] | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const fields = parts.map((p, i) => parseField(p, RANGES[i]!));
  return fields.every(Boolean) ? (fields as Field[]) : null;
}

export function isValidCron(expr: string): boolean {
  return parseCron(expr) !== null;
}

/** Does `expr` fire in the minute containing `at`, as seen in `timezone`? Invalid expressions never match. */
export function cronMatches(expr: string, at: Date, timezone = "Asia/Dubai"): boolean {
  const f = parseCron(expr);
  if (!f) return false;
  const [minute, hour, dom, month, dow] = f as [Field, Field, Field, Field, Field];
  const p = (fmt: string) => Number(formatInTimeZone(at, timezone, fmt));
  const m = p("m");
  const h = p("H");
  const d = p("d");
  const mo = p("M");
  const wd = p("i") % 7; // ISO 1..7 → 0 = Sunday
  if (!minute.values.has(m) || !hour.values.has(h) || !month.values.has(mo)) return false;
  const domOk = dom.values.has(d);
  const dowOk = dow.values.has(wd) || (wd === 0 && dow.values.has(7));
  if (dom.star && dow.star) return true;
  if (dom.star) return dowOk;
  if (dow.star) return domOk;
  return domOk || dowOk;
}
