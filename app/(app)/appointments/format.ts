import { formatInTimeZone } from "date-fns-tz";

import type { AppointmentStatus } from "@/lib/appointments/status";

export const STATUS_STYLES: Record<AppointmentStatus, string> = {
  awaiting: "border-amber-300 dark:border-amber-500/30 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100",
  confirmed:
    "border-emerald-300 dark:border-emerald-500/30 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100",
  cancelled: "border-zinc-300 dark:border-zinc-700 bg-zinc-100 text-zinc-500 line-through dark:bg-zinc-900",
  completed: "border-sky-300 dark:border-sky-500/30 bg-sky-50 text-sky-900 dark:bg-sky-950/40 dark:text-sky-100",
  no_show: "border-rose-300 dark:border-rose-500/30 bg-rose-50 text-rose-900 dark:bg-rose-950/40 dark:text-rose-100",
};

export const REMINDER_LABELS: Record<string, string> = {
  scheduled: "Scheduled",
  sent: "Sent",
  failed: "Failed",
  excluded: "Excluded",
  cancelled: "Cancelled",
};

export function timeLabel(iso: string, tz: string): string {
  return formatInTimeZone(new Date(iso), tz, "HH:mm");
}

export function dateTimeLabel(iso: string, tz: string): string {
  return formatInTimeZone(new Date(iso), tz, "EEE d MMM yyyy, HH:mm");
}

/** Minutes after local midnight (0–1440) of an instant in a timezone. */
export function localMinutes(iso: string | Date, tz: string): number {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return Number(formatInTimeZone(d, tz, "H")) * 60 + Number(formatInTimeZone(d, tz, "m"));
}

export function dayLabel(date: string): string {
  // A fixed pattern, not toLocaleDateString: Node and the browser ship different ICU data ("Wednesday, 14 …" vs
  // "Wednesday 14 …"), which made the server and client render different text (hydration mismatch).
  const [y, m, d] = date.split("-").map(Number);
  return formatInTimeZone(new Date(Date.UTC(y, m - 1, d)), "UTC", "EEEE d MMMM yyyy");
}

export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
