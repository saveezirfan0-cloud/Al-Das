/** Office Hours node: is `now` inside the configured weekly schedule (in the schedule's timezone)? */
import { formatInTimeZone } from "date-fns-tz";
import { z } from "zod";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export const officeHoursSchema = z.object({
  timezone: z.string().default("Asia/Dubai"),
  schedule: z
    .partialRecord(z.enum(DAYS), z.array(z.object({ start: hhmm, end: hhmm })).max(4))
    .default({}),
});
export type OfficeHours = z.infer<typeof officeHoursSchema>;

export function isWithinOfficeHours(cfg: OfficeHours, now: Date): boolean {
  const day = formatInTimeZone(now, cfg.timezone, "EEE").toLowerCase().slice(0, 3) as (typeof DAYS)[number];
  const time = formatInTimeZone(now, cfg.timezone, "HH:mm");
  const slots = cfg.schedule[day] ?? [];
  // end is exclusive; a slot where end <= start is ignored (misconfigured → closed).
  return slots.some((s) => s.end > s.start && time >= s.start && time < s.end);
}
