import { z } from "zod";

import { TASK_TYPES } from "@/lib/tasks/due";

const uuid = z.string().uuid();

export const taskFieldsSchema = z.object({
  type: z.enum(TASK_TYPES),
  subject: z.string().trim().min(1, "Give the task a subject.").max(200),
  notes: z
    .string()
    .trim()
    .max(4000)
    .transform((v) => (v === "" ? null : v))
    .nullable(),
  due_at: z.string().datetime({ offset: true }).nullable(),
  assignee_id: uuid.nullable(),
  contact_id: uuid.nullable(),
  enquiry_id: uuid.nullable(),
});

export const createTaskSchema = taskFieldsSchema.partial({
  type: true,
  notes: true,
  due_at: true,
  assignee_id: true,
  contact_id: true,
  enquiry_id: true,
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const updateTaskSchema = taskFieldsSchema.partial();
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const taskFilterSchema = z.object({
  /** mine: assigned to the caller; all: everyone's. */
  scope: z.enum(["mine", "all"]).default("mine"),
  state: z.enum(["open", "overdue", "done", "all"]).default("open"),
  type: z.enum(TASK_TYPES).optional(),
  assignee_id: z.union([uuid, z.literal("unassigned")]).optional(),
  due_from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  due_to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  contact_id: uuid.optional(),
  enquiry_id: uuid.optional(),
  search: z.string().trim().max(100).optional(),
});
export type TaskFilter = z.infer<typeof taskFilterSchema>;
