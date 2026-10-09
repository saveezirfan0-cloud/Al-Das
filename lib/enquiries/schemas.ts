import { z } from "zod";

import { ENQUIRY_STATUSES } from "@/lib/enquiries/constants";

const uuid = z.string().uuid();
const optionalUuid = uuid.nullable().optional();

/** Blank strings from forms become null. */
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

const estValue = z
  .union([z.number(), z.string()])
  .nullable()
  .optional()
  .transform((v, ctx) => {
    if (v === null || v === undefined || v === "") return null;
    const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, "").trim());
    if (!Number.isFinite(n) || n < 0 || n > 1e9) {
      ctx.addIssue({ code: "custom", message: "Estimated value must be a positive number" });
      return z.NEVER;
    }
    return Math.round(n * 100) / 100;
  });

const apptDate = z
  .string()
  .nullable()
  .optional()
  .transform((v, ctx) => {
    if (!v) return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: "custom", message: "Appointment date is not a valid date" });
      return z.NEVER;
    }
    return d.toISOString();
  });

export const enquiryDetailsSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  contact_id: optionalUuid,
  channel_id: optionalUuid,
  source: text(80),
  assignee_id: optionalUuid,
  est_value: estValue,
  location_id: optionalUuid,
  department_id: optionalUuid,
  specialist_id: optionalUuid,
  service_id: optionalUuid,
  appt_date: apptDate,
  custom: z.record(z.string(), z.unknown()).optional(),
});
export type EnquiryDetailsInput = z.input<typeof enquiryDetailsSchema>;

export const newEnquirySchema = enquiryDetailsSchema.extend({
  pipeline_id: uuid,
  stage_id: optionalUuid,
  /** true = run the assignment rules; false = leave exactly as given (assignee_id may be null). */
  auto_assign: z.boolean().default(false),
});
export type NewEnquiryInput = z.input<typeof newEnquirySchema>;

export const statusSchema = z.object({
  status: z.enum(ENQUIRY_STATUSES),
  reason: z.string().trim().max(500).nullable().optional(),
});

export const bulkOpSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("assign"), assignee_id: uuid.nullable() }),
  z.object({ type: z.literal("stage"), stage_id: uuid }),
  z.object({
    type: z.literal("status"),
    status: z.enum(ENQUIRY_STATUSES),
    reason: z.string().trim().max(500).nullable().optional(),
  }),
  z.object({ type: z.literal("pipeline"), pipeline_id: uuid, stage_id: optionalUuid }),
  z.object({
    type: z.literal("edit"),
    source: text(80),
    channel_id: optionalUuid,
    location_id: optionalUuid,
    department_id: optionalUuid,
    specialist_id: optionalUuid,
    service_id: optionalUuid,
    est_value: estValue,
    fields: z
      .array(
        z.enum([
          "source",
          "channel_id",
          "location_id",
          "department_id",
          "specialist_id",
          "service_id",
          "est_value",
        ]),
      )
      .min(1),
  }),
]);
export type BulkOpInput = z.input<typeof bulkOpSchema>;

export const viewSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(60),
  pipeline_id: optionalUuid,
  mode: z.enum(["kanban", "table"]).default("kanban"),
  filter: z.record(z.string(), z.unknown()),
  columns: z.array(z.string().max(60)).max(60).default([]),
  shared_team_ids: z.array(uuid).max(50).default([]),
  shared_all: z.boolean().default(false),
});
export type ViewInput = z.input<typeof viewSchema>;
