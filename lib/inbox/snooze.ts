/**
 * Snoozing a conversation (Phase F). Pure: the time a preset means, the bounds on a chosen time and the job's dedupe
 * key. The snooze itself is a column on the conversation plus a scheduled_jobs row (inbox.unsnooze) that brings it
 * back; a new patient message or closing the chat clears it in the database (conversations_snooze_reset).
 */
import { addDays, nextMonday } from "date-fns";
import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";

export const SNOOZE_PRESETS = ["1h", "3h", "tomorrow", "next_week"] as const;
export type SnoozePreset = (typeof SNOOZE_PRESETS)[number];

export const SNOOZE_PRESET_LABELS: Record<SnoozePreset, string> = {
  "1h": "1 hour",
  "3h": "3 hours",
  tomorrow: "Tomorrow 9:00",
  next_week: "Next Monday 9:00",
};

/** The furthest a conversation can be snoozed. */
export const MAX_SNOOZE_DAYS = 90;
const MIN_SNOOZE_MS = 60_000;

/** The moment a preset means, in the organisation's timezone (mornings are 09:00 local). */
export function snoozePresetTime(preset: SnoozePreset, now: Date, timezone: string): Date {
  switch (preset) {
    case "1h":
      return new Date(now.getTime() + 3600_000);
    case "3h":
      return new Date(now.getTime() + 3 * 3600_000);
    case "tomorrow": {
      const local = toZonedTime(now, timezone);
      const day = formatInTimeZone(addDays(local, 1), "UTC", "yyyy-MM-dd");
      return fromZonedTime(`${day}T09:00:00`, timezone);
    }
    case "next_week": {
      const local = toZonedTime(now, timezone);
      const day = formatInTimeZone(nextMonday(local), "UTC", "yyyy-MM-dd");
      return fromZonedTime(`${day}T09:00:00`, timezone);
    }
  }
}

/** A chosen snooze time must be at least a minute ahead and at most 90 days away. */
export function snoozeProblem(until: Date, now: Date): string | null {
  if (Number.isNaN(until.getTime())) return "Choose a date and time.";
  if (until.getTime() < now.getTime() + MIN_SNOOZE_MS) return "Choose a time in the future.";
  if (until.getTime() > now.getTime() + MAX_SNOOZE_DAYS * 86_400_000)
    return `Snooze for at most ${MAX_SNOOZE_DAYS} days.`;
  return null;
}

/** One pending job per conversation and wake-up time: snoozing again to another time gets a new job. */
export function unsnoozeDedupeKey(conversationId: string, until: Date): string {
  return `inbox_unsnooze:${conversationId}:${until.getTime()}`;
}

/** Is a conversation snoozed right now? (A past time means the job is about to run.) */
export function isSnoozed(c: { snoozed_until: string | null }, now: Date): boolean {
  return !!c.snoozed_until && new Date(c.snoozed_until).getTime() > now.getTime();
}
