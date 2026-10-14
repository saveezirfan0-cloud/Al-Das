/**
 * Staff records (Phase C): the input rules shared by the drawer and the server actions. Pure.
 * No pay fields exist here on purpose: pay stays in Finance (finance.costs.compensation).
 */
import { z } from "zod";

import { dayNumber } from "@/lib/documents/expiry";
import { normalizePhone } from "@/lib/phone";

export const EMPLOYMENT_TYPES = [
  "full_time",
  "part_time",
  "locum",
  "contractor",
  "intern",
] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const EMPLOYMENT_LABELS: Record<EmploymentType, string> = {
  full_time: "Full time",
  part_time: "Part time",
  locum: "Locum",
  contractor: "Contractor",
  intern: "Intern",
};

export const DUTY_FREQUENCIES = ["daily", "weekly", "monthly", "once"] as const;
export type DutyFrequency = (typeof DUTY_FREQUENCIES)[number];

export const DUTY_FREQUENCY_LABELS: Record<DutyFrequency, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  once: "Once",
};

const uuid = z.string().uuid();
const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => {
      const t = v?.trim();
      return t ? t : null;
    });
const optionalDate = z
  .string()
  .nullish()
  .transform((v) => (v && v.trim() ? v.trim() : null))
  .refine((v) => v === null || dayNumber(v) !== null, "Use a real date (YYYY-MM-DD).");

/** Normalises a work phone to E.164, or null when empty. Throws a readable message when it is not a phone. */
export function normaliseWorkPhone(raw: string | null | undefined): string | null {
  const t = raw?.trim();
  if (!t) return null;
  const n = normalizePhone(t);
  if (!n) throw new Error("The work phone is not a valid number.");
  return n.e164;
}

export const staffInputSchema = z
  .object({
    full_name: z
      .string()
      .transform((v) => v.trim())
      .pipe(z.string().min(1, "Enter the name.").max(120)),
    job_title: optionalText(100),
    department_id: uuid.nullish().transform((v) => v ?? null),
    home_location_id: uuid.nullish().transform((v) => v ?? null),
    manager_staff_id: uuid.nullish().transform((v) => v ?? null),
    profile_id: uuid.nullish().transform((v) => v ?? null),
    specialist_id: uuid.nullish().transform((v) => v ?? null),
    employment_type: z.enum(EMPLOYMENT_TYPES).default("full_time"),
    start_date: optionalDate,
    end_date: optionalDate,
    work_email: optionalText(254).refine(
      (v) => v === null || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v),
      "Enter a valid work e-mail.",
    ),
    work_phone: optionalText(40),
    visa_expires_on: optionalDate,
    licence_number: optionalText(60),
    licence_expires_on: optionalDate,
    notes: optionalText(2000),
  })
  .refine((v) => !v.start_date || !v.end_date || v.end_date >= v.start_date, {
    message: "The end date is before the start date.",
    path: ["end_date"],
  });

export type StaffInput = z.input<typeof staffInputSchema>;
export type StaffValues = z.output<typeof staffInputSchema>;

export const dutyInputSchema = z.object({
  title: z
    .string()
    .transform((v) => v.trim())
    .pipe(z.string().min(1, "Enter the duty.").max(200)),
  frequency: z.enum(DUTY_FREQUENCIES).default("daily"),
  location_id: uuid.nullish().transform((v) => v ?? null),
  active: z.boolean().default(true),
});
export type DutyInput = z.input<typeof dutyInputSchema>;

/** Would setting `managerId` as the manager of `staffId` create a loop (A manages B manages A)? */
export function managerLoop(
  staffId: string,
  managerId: string | null,
  managerOf: ReadonlyMap<string, string | null>,
): boolean {
  let cur = managerId;
  const seen = new Set<string>();
  while (cur) {
    if (cur === staffId) return true;
    if (seen.has(cur)) return false;
    seen.add(cur);
    cur = managerOf.get(cur) ?? null;
  }
  return false;
}
