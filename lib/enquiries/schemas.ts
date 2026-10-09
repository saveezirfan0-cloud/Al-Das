/** Zod input schemas shared by the enquiry server actions and the service. */
import { z } from "zod";

import { ENQUIRY_STATUSES } from "@/lib/enquiries/status";

const uuid = z.string().uuid();
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable();

/** Fields editable in the drawer. Everything is optional so the same schema serves patch updates. */
export const enquiryDetailsSchema = z.object({
  title: z.string().trim().max(200),
  source: optionalText(80),
  channel_id: uuid.nullable(),
  location_id: uuid.nullable(),
  department_id: uuid.nullable(),
  specialist_id: uuid.nullable(),
  service_id: uuid.nullable(),
  appointment_at: z.string().datetime({ offset: true }).nullable(),
  assignee_id: uuid.nullable(),
  est_value: z.number().min(0).max(1_000_000_000).nullable(),
  custom: z.record(z.string(), z.unknown()),
});

export const updateEnquirySchema = enquiryDetailsSchema.partial();
export type UpdateEnquiryInput = z.infer<typeof updateEnquirySchema>;

export const createEnquirySchema = enquiryDetailsSchema.partial().extend({
  contact_id: uuid,
  pipeline_id: uuid,
  stage_id: uuid.optional(),
});
export type CreateEnquiryInput = z.infer<typeof createEnquirySchema>;

export const statusChangeSchema = z.object({
  status: z.enum(ENQUIRY_STATUSES),
  reason: z.string().trim().max(300).nullable().optional(),
});

/** Bulk operations are capped so one request cannot run for minutes. */
export const BULK_LIMIT = 100;
export const idListSchema = z.array(uuid).min(1).max(BULK_LIMIT);

export const bulkPatchSchema = z
  .object({
    stage_id: uuid.optional(),
    assignee_id: uuid.nullable().optional(),
    status: z.enum(ENQUIRY_STATUSES).optional(),
    reason: z.string().trim().max(300).nullable().optional(),
  })
  .refine(
    (v) => v.stage_id !== undefined || v.assignee_id !== undefined || v.status !== undefined,
    {
      message: "Choose something to change.",
    },
  );
export type BulkPatch = z.infer<typeof bulkPatchSchema>;
