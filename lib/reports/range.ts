import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

import type { ReportFilters } from "@/lib/reports/filters";

/**
 * Turns a period preset into calendar days in the ORG's timezone. Metrics are bucketed by org-local
 * day (see the metrics migration), so reports filter on those days directly; the UTC instants are
 * for anything that filters raw timestamps.
 */

export type ResolvedRange = {
  /** Inclusive local dates, YYYY-MM-DD. */
  fromDay: string;
  toDay: string;
  /** [fromUtc, toUtcExclusive) as instants. */
  fromUtc: Date;
  toUtcExclusive: Date;
  days: number;
  label: string;
};

/** Add whole days to a YYYY-MM-DD string (calendar arithmetic, no timezone involved). */
export function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function resolveRange(filters: Pick<ReportFilters, "period" | "from" | "to">, timezone: string, now: Date = new Date()): ResolvedRange {
  const today = formatInTimeZone(now, timezone, "yyyy-MM-dd");
  const monthStart = `${today.slice(0, 8)}01`;
  let fromDay = today;
  let toDay = today;
  switch (filters.period) {
    case "today":
      break;
    case "yesterday":
      fromDay = toDay = addDays(today, -1);
      break;
    case "last_7_days":
      fromDay = addDays(today, -6);
      break;
    case "last_30_days":
      fromDay = addDays(today, -29);
      break;
    case "this_month":
      fromDay = monthStart;
      break;
    case "last_month":
      toDay = addDays(monthStart, -1);
      fromDay = `${toDay.slice(0, 8)}01`;
      break;
    case "custom":
      fromDay = filters.from ?? today;
      toDay = filters.to ?? today;
      break;
  }
  return {
    fromDay,
    toDay,
    fromUtc: fromZonedTime(`${fromDay}T00:00:00`, timezone),
    toUtcExclusive: fromZonedTime(`${addDays(toDay, 1)}T00:00:00`, timezone),
    days: diffDays(fromDay, toDay) + 1,
    label: fromDay === toDay ? fromDay : `${fromDay} → ${toDay}`,
  };
}
