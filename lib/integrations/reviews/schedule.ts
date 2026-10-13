import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

import { isWithinOfficeHours, type OfficeHours } from "@/lib/flow-engine/office-hours";

/**
 * When a review request may go out (pure). The clinic's sending window is an office-hours schedule (the same function the flow
 * engine's Office Hours node uses) that applies every day of the week: a request that would fall outside it waits for the next
 * opening, in the clinic's time zone.
 */
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export function sendingHours(timezone: string, from: string, to: string): OfficeHours {
  const slot = [{ start: from, end: to }];
  return {
    timezone,
    schedule: Object.fromEntries(DAYS.map((d) => [d, slot])),
  };
}

/** The earliest moment at or after `base` that lies inside the sending window. */
export function nextSendTime(base: Date, o: { timezone: string; from: string; to: string }): Date {
  const hours = sendingHours(o.timezone, o.from, o.to);
  if (isWithinOfficeHours(hours, base)) return base;
  // Outside the window: today's opening if it is still ahead, otherwise tomorrow's.
  for (let i = 0; i <= 2; i++) {
    const day = formatInTimeZone(
      new Date(base.getTime() + i * 86_400_000),
      o.timezone,
      "yyyy-MM-dd",
    );
    const opening = fromZonedTime(`${day}T${o.from}:00`, o.timezone);
    if (opening.getTime() > base.getTime()) return opening;
  }
  return base; // unreachable for a valid window; never loop
}

/** When the visit ended, for the purpose of the delay. */
export function visitEnd(
  a: {
    checked_out_at: string | null;
    done_at: string | null;
    ends_at: string;
  },
  now: Date,
): Date {
  if (a.checked_out_at) return new Date(a.checked_out_at);
  if (a.done_at) return new Date(a.done_at);
  const ends = new Date(a.ends_at);
  return ends.getTime() <= now.getTime() ? ends : now;
}

/** The time to schedule the job for: the end of the visit plus the delay, pushed into the sending window, never in the past. */
export function reviewRunAt(
  end: Date,
  delayMinutes: number,
  hours: { timezone: string; from: string; to: string },
  now: Date,
): Date {
  const due = new Date(Math.max(end.getTime() + delayMinutes * 60_000, now.getTime()));
  return nextSendTime(due, hours);
}
