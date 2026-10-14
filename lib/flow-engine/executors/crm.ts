import { z } from "zod";

import {
  fail,
  parseConfig,
  text,
  type ExecCtx,
  type Executor,
} from "@/lib/flow-engine/executors/common";
import type { Outcome } from "@/lib/flow-engine/types";

/** Phone is the contact's identity (E.164 match key), so flows may not rewrite it. */
export const CONTACT_FIELD_PATTERN =
  /^(first_name|last_name|email|gender|language|label|custom\.[A-Za-z][A-Za-z0-9_]{0,63})$/;

export const updateFieldSchema = z.object({
  field: z.string().regex(CONTACT_FIELD_PATTERN, "unsupported field"),
  value: z.string().max(1000),
});

export const update_contact_field: Executor = async (ctx) => {
  const cfg = parseConfig(ctx, updateFieldSchema);
  if (!cfg.ok) return cfg.outcome;
  if (!ctx.contact) return fail("This step needs a contact");
  const value = text(ctx, cfg.data.value).trim();
  if (cfg.data.field === "gender" && !["female", "male", "other", "unknown"].includes(value)) {
    return fail("Gender must be female, male, other or unknown");
  }
  if (cfg.data.field === "email" && value !== "" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
    return fail("That is not a valid email address");
  }
  await ctx.deps.actions.updateContactField(ctx.run, cfg.data.field, value);
  return { kind: "next", output: { field: cfg.data.field } };
};

// ---------------------------------------------------------------------------
// Module nodes (enquiries, tasks, portal, appointments, labels). Each calls a CrmPort method with a typed, interpolated
// input; the production adapters (lib/flow-engine/crm-adapters.ts) go through the module's own service so permissions,
// audit, timeline and domain events cannot be skipped. A missing port method fails closed.
// ---------------------------------------------------------------------------

/** The builder stores "" for "not chosen"; treat it as absent. */
const optUuid = z
  .union([z.literal(""), z.string().uuid()])
  .optional()
  .transform((v) => (v ? v : undefined));

export const ENQUIRY_STATUSES_FOR_FLOWS = ["open", "won", "lost", "disqualified"] as const;
export const TASK_TYPES_FOR_FLOWS = ["call", "follow_up", "email", "meeting", "other"] as const;
/** Enquiry fields a flow may set: a few plain columns and custom fields. Owner, contact and pipeline have their own paths. */
export const ENQUIRY_FIELD_PATTERN =
  /^(title|source|est_value|appt_date|custom\.[A-Za-z][A-Za-z0-9_]{0,63})$/;

export const createEnquirySchema = z.object({
  title: z.string().trim().min(1).max(200),
  /** Empty = the workspace's default pipeline. */
  pipeline_id: optUuid,
  /** Empty = the pipeline's first stage. */
  stage_id: optUuid,
  source: z.string().max(100).optional(),
  /** When the patient already has an open enquiry in that pipeline: "update" moves it (no duplicate), "create" adds another. */
  if_open: z.enum(["update", "create"]).default("update"),
});

export const updateEnquirySchema = z
  .object({
    action: z.enum(["stage", "status", "pipeline", "field"]),
    stage_id: optUuid,
    status: z.enum(ENQUIRY_STATUSES_FOR_FLOWS).optional(),
    lost_reason: z.string().max(300).optional(),
    pipeline_id: optUuid,
    field: z.string().regex(ENQUIRY_FIELD_PATTERN, "unsupported field").optional(),
    value: z.string().max(1000).optional(),
  })
  .superRefine((v, c) => {
    const need = (ok: boolean, path: string, message: string) => {
      if (!ok) c.addIssue({ code: "custom", path: [path], message });
    };
    if (v.action === "stage") need(!!v.stage_id, "stage_id", "choose the stage");
    if (v.action === "pipeline") need(!!v.pipeline_id, "pipeline_id", "choose the pipeline");
    if (v.action === "status") need(!!v.status, "status", "choose the status");
    if (v.action === "field") need(!!v.field, "field", "choose the field");
  });

export const addTaskSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  type: z.enum(TASK_TYPES_FOR_FLOWS).default("follow_up"),
  /** Due this many hours after the step runs. */
  due_in_hours: z
    .number()
    .min(0)
    .max(24 * 90)
    .default(24),
  /** Empty = unassigned (the task lands in the team's list). */
  assignee_id: optUuid,
  notes: z.string().max(2000).optional(),
});

export const portalRecordSchema = z.object({
  object: z.string().trim().min(1).max(60),
  mode: z.enum(["create", "update"]).default("create"),
  /** For "update": the record id (usually a {variable}). */
  record_id: z.string().max(200).optional(),
  /** Column key → text with {variables}; columns are validated by the object's own definition. */
  values: z.record(z.string().max(63), z.string().max(2000)).default({}),
});

export const bookAppointmentSchema = z.object({
  service_id: z.string().uuid(),
  specialist_id: z.string().uuid(),
  location_id: z.string().uuid(),
  /** ISO date-time, usually from a variable (e.g. {vars.slot}); must be a free slot in the future. */
  starts_at: z.string().trim().min(1).max(100),
  /** Send the "confirmed" template after booking. */
  notify: z.boolean().default(false),
});

export const setLabelSchema = z.object({
  tag_id: z.string().uuid(),
  action: z.enum(["add", "remove"]).default("add"),
});

/** The enquiry a node acts on: one created earlier in this run, else the enquiry the run started from. */
export function runEnquiryId(ctx: ExecCtx): string | null {
  const v = ctx.run.context.vars.enquiry_id;
  return typeof v === "string" && v ? v : ctx.run.enquiry_id;
}

function missing(label: string): Outcome {
  return fail(`${label} is not available in this workspace`);
}

export const create_enquiry: Executor = async (ctx) => {
  const cfg = parseConfig(ctx, createEnquirySchema);
  if (!cfg.ok) return cfg.outcome;
  const port = ctx.deps.crm.createEnquiry;
  if (!port) return missing("Create enquiry");
  const title = text(ctx, cfg.data.title).trim().slice(0, 200);
  if (!title) return fail("The enquiry title is empty after filling in variables");
  const res = await port.call(ctx.deps.crm, ctx.run, {
    ...cfg.data,
    title,
    source: cfg.data.source ? text(ctx, cfg.data.source).trim().slice(0, 100) : undefined,
  });
  return {
    kind: "next",
    output: { id: res.id, created: res.created ?? true },
    vars: { enquiry_id: res.id },
  };
};

export const update_enquiry: Executor = async (ctx) => {
  const cfg = parseConfig(ctx, updateEnquirySchema);
  if (!cfg.ok) return cfg.outcome;
  const port = ctx.deps.crm.updateEnquiry;
  if (!port) return missing("Update enquiry");
  const enquiryId = runEnquiryId(ctx);
  if (!enquiryId)
    return fail(
      "No enquiry to update: add a Create enquiry step first, or start from an enquiry trigger",
    );
  const c = cfg.data;
  const input: Record<string, unknown> = { enquiry_id: enquiryId, action: c.action };
  if (c.action === "stage") input.stage_id = c.stage_id;
  if (c.action === "pipeline") {
    input.pipeline_id = c.pipeline_id;
    input.stage_id = c.stage_id;
  }
  if (c.action === "status") {
    input.status = c.status;
    input.lost_reason = c.lost_reason ? text(ctx, c.lost_reason).trim().slice(0, 300) : null;
  }
  if (c.action === "field") {
    input.field = c.field;
    input.value = text(ctx, c.value ?? "").trim();
  }
  const res = await port.call(ctx.deps.crm, ctx.run, input);
  return { kind: "next", output: { id: res.id, action: c.action } };
};

export const add_task: Executor = async (ctx) => {
  const cfg = parseConfig(ctx, addTaskSchema);
  if (!cfg.ok) return cfg.outcome;
  const port = ctx.deps.crm.addTask;
  if (!port) return missing("Add task");
  const subject = text(ctx, cfg.data.subject).trim().slice(0, 200);
  if (!subject) return fail("The task subject is empty after filling in variables");
  const due = new Date(ctx.deps.now().getTime() + cfg.data.due_in_hours * 3_600_000);
  const res = await port.call(ctx.deps.crm, ctx.run, {
    subject,
    type: cfg.data.type,
    due_at: due.toISOString(),
    assignee_id: cfg.data.assignee_id ?? null,
    notes: cfg.data.notes ? text(ctx, cfg.data.notes).trim().slice(0, 2000) : null,
    enquiry_id: runEnquiryId(ctx),
  });
  return { kind: "next", output: { id: res.id } };
};

export const portal_record: Executor = async (ctx) => {
  const cfg = parseConfig(ctx, portalRecordSchema);
  if (!cfg.ok) return cfg.outcome;
  const port = ctx.deps.crm.upsertPortalRecord;
  if (!port) return missing("Portal record");
  const recordId = cfg.data.record_id ? text(ctx, cfg.data.record_id).trim() : "";
  if (cfg.data.mode === "update" && !recordId) return fail("Updating a portal record needs its id");
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(cfg.data.values)) values[k] = text(ctx, v);
  const res = await port.call(ctx.deps.crm, ctx.run, {
    object: cfg.data.object,
    mode: cfg.data.mode,
    record_id: recordId || null,
    values,
  });
  return {
    kind: "next",
    output: { id: res.id, created: res.created ?? cfg.data.mode === "create" },
  };
};

export const book_appointment: Executor = async (ctx) => {
  const cfg = parseConfig(ctx, bookAppointmentSchema);
  if (!cfg.ok) return cfg.outcome;
  const port = ctx.deps.crm.bookAppointment;
  if (!port) return missing("Book appointment");
  if (!ctx.contact) return fail("This step needs a contact");
  const raw = text(ctx, cfg.data.starts_at).trim();
  const startsAt = Date.parse(raw);
  if (!Number.isFinite(startsAt)) return fail("The appointment time is not a date and time");
  if (startsAt <= ctx.deps.now().getTime()) return fail("The appointment time is in the past");
  const res = await port.call(
    ctx.deps.crm,
    ctx.run,
    {
      service_id: cfg.data.service_id,
      specialist_id: cfg.data.specialist_id,
      location_id: cfg.data.location_id,
      starts_at: new Date(startsAt).toISOString(),
      notify: cfg.data.notify,
    },
    // The step key: a replay after a crash gets this step's booking back instead of a second one.
    { stepKey: ctx.stepKey },
  );
  return { kind: "next", output: { id: res.id }, vars: { appointment_id: res.id } };
};

export const set_label: Executor = async (ctx) => {
  const cfg = parseConfig(ctx, setLabelSchema);
  if (!cfg.ok) return cfg.outcome;
  const port = ctx.deps.crm.setConversationLabel;
  if (!port) return missing("Set label");
  if (!ctx.conversation) return fail("This step needs a conversation");
  const res = await port.call(ctx.deps.crm, ctx.run, {
    tag_id: cfg.data.tag_id,
    on: cfg.data.action === "add",
  });
  return { kind: "next", output: { action: cfg.data.action, changed: res.changed } };
};
