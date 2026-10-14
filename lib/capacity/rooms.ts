import { z } from "zod";

/**
 * Rooms and the weekly room rota (M3): the shapes the server actions accept. The database repeats every rule that
 * matters (kind list, cost above 0, no double-booked room, doctor at the room's branch); these give a friendly message.
 */

export const ROOM_KINDS = ["consultation", "procedure", "dental", "other"] as const;
export type RoomKind = (typeof ROOM_KINDS)[number];
export const ROOM_KIND_LABEL: Record<RoomKind, string> = {
  consultation: "Consultation",
  procedure: "Procedure",
  dental: "Dental",
  other: "Other",
};

export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
/** ISO weekday 1..7 -> "Mon".."Sun". */
export const weekdayLabel = (w: number) => WEEKDAY_LABELS[w - 1] ?? "?";

/** "09:30" -> 570; "24:00" or an end of "00:00" -> 1440. Null when the text is not a time. */
export function parseTime(value: string, isEnd = false): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 24 || (h === 24 && min > 0)) return null;
  const total = h * 60 + min;
  if (isEnd && total === 0) return 1440;
  return total;
}

export function formatTime(minutes: number): string {
  const m = Math.min(Math.max(Math.round(minutes), 0), 1440);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

const uuid = z.string().uuid();

/** Empty text = unknown (null); a number must be above 0, so 0 is never stored as "unknown". */
const monthlyCost = z
  .string()
  .trim()
  .transform((v) => v.replace(/,/g, ""))
  .refine((v) => v === "" || /^\d+(\.\d{1,2})?$/.test(v), {
    message: "Monthly cost: a number with at most two decimals, or leave it empty if unknown.",
  })
  .transform((v) => (v === "" ? null : Number(v)))
  .refine((v) => v === null || (v > 0 && v <= 10_000_000), {
    message: "Monthly cost must be more than 0 (leave it empty if unknown).",
  });

export const roomSchema = z.object({
  id: uuid.optional().or(z.literal("").transform(() => undefined)),
  location_id: uuid.optional().or(z.literal("").transform(() => undefined)),
  name: z.string().trim().min(1, "Give the room a name.").max(80, "Name: at most 80 characters."),
  kind: z.enum(ROOM_KINDS, { message: "Choose the kind of room." }),
  monthly_cost: monthlyCost.optional().transform((v) => v ?? null),
  active: z
    .string()
    .optional()
    .transform((v) => v === "on" || v === "true"),
});

export const rotaSchema = z
  .object({
    room_id: uuid,
    specialist_id: z.string().uuid("Choose a doctor."),
    weekday: z.coerce.number().int().min(1, "Choose a day.").max(7, "Choose a day."),
    start: z.string(),
    end: z.string(),
  })
  .transform((v, ctx) => {
    const start = parseTime(v.start);
    const end = parseTime(v.end, true);
    if (start === null || end === null || start >= 1440) {
      ctx.addIssue({ code: "custom", message: "Use times like 09:00 and 13:30." });
      return z.NEVER;
    }
    if (end <= start) {
      ctx.addIssue({ code: "custom", message: "The end must be after the start." });
      return z.NEVER;
    }
    return {
      room_id: v.room_id,
      specialist_id: v.specialist_id,
      weekday: v.weekday,
      start_min: start,
      end_min: end,
    };
  });

/** The database's rota refusals as words a person can act on. */
export function rotaErrorMessage(err: { code?: string; message?: string } | null): string {
  const msg = err?.message ?? "";
  if (msg.includes("room_double_booked"))
    return "The room is already on the rota at that time on that day.";
  if (msg.includes("specialist_not_at_room_location"))
    return "That doctor does not work at this room's branch. Add the branch to the doctor under Settings, Appointment rules first.";
  return "Could not save the rota. Please try again.";
}
