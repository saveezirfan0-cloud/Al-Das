import { z } from "zod";

/**
 * Rooms (M3): the shape the server actions accept. The database repeats every rule that matters (kind list, cost above
 * 0, name unique per branch); this gives a friendly message.
 */

export const ROOM_KINDS = ["consultation", "procedure", "dental", "other"] as const;
export type RoomKind = (typeof ROOM_KINDS)[number];
export const ROOM_KIND_LABEL: Record<RoomKind, string> = {
  consultation: "Consultation",
  procedure: "Procedure",
  dental: "Dental",
  other: "Other",
};

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
