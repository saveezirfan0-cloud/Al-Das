/**
 * Close-with-enquiry (Phase 20d, G10; pure apart from the injected service calls; unit-tested).
 *
 * The inbox close dialog can, in the same step, create an enquiry for the conversation's patient or update one of
 * their open enquiries: stage, status (lost / disqualified need a reason, from the Settings, Enquiries pick-list or
 * free text) and the requested appointment date. Every change goes through the existing enquiry service
 * (lib/enquiries/service.ts), which validates, writes the history, the audit row and the domain event, so a change
 * made here is indistinguishable from one made on the Enquiries page.
 */
import { z } from "zod";

import { ENQUIRY_STATUSES, type EnquiryStatus } from "@/lib/enquiries/constants";
import { resolveStatusChange } from "@/lib/enquiries/status";

const uuid = z.string().uuid();
const reason = z.string().trim().max(500).nullable().optional();
/** YYYY-MM-DD (date input) or a full ISO time; blank = leave as it is (update) / none (create). */
const apptDate = z
  .string()
  .trim()
  .max(40)
  .nullable()
  .optional()
  .refine((v) => !v || !Number.isNaN(new Date(v).getTime()), "The appointment date is not valid.");

export const closeEnquiryPartSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("create"),
    pipeline_id: uuid,
    stage_id: uuid.nullable().optional(),
    title: z.string().trim().min(1, "Give the enquiry a title.").max(200),
    status: z.enum(ENQUIRY_STATUSES).default("open"),
    reason,
    appt_date: apptDate,
  }),
  z.object({
    mode: z.literal("update"),
    enquiry_id: uuid,
    stage_id: uuid.nullable().optional(),
    status: z.enum(ENQUIRY_STATUSES).optional(),
    reason,
    appt_date: apptDate,
  }),
]);
export type CloseEnquiryPart = z.infer<typeof closeEnquiryPartSchema>;

export type CloseEnquiryTarget = {
  id: string;
  status: EnquiryStatus;
  stage_id: string;
  pipeline_id: string;
  contact_id: string | null;
};

/**
 * Checks that can be made before anything is written, so a bad reason or a foreign enquiry never leaves the
 * conversation half-closed. Returns an error to show, or null.
 */
export function validateCloseEnquiry(
  part: CloseEnquiryPart,
  ctx: {
    contactId: string;
    target: CloseEnquiryTarget | null;
    /** Stage ids of the chosen (create) or current (update) pipeline. */
    pipelineStageIds: readonly string[];
  },
): string | null {
  if (part.mode === "update") {
    if (!ctx.target) return "That enquiry no longer exists.";
    if (ctx.target.contact_id !== ctx.contactId)
      return "That enquiry belongs to another patient. Pick one of this patient's enquiries.";
  }
  if (part.stage_id && !ctx.pipelineStageIds.includes(part.stage_id))
    return "That stage is not in the enquiry's pipeline.";
  const from: EnquiryStatus = part.mode === "update" ? ctx.target!.status : "open";
  const to = part.status;
  if (to && to !== from) {
    const change = resolveStatusChange({ from, to, reason: part.reason });
    if (!change.ok) return change.error;
  }
  return null;
}

/** The ISO time stored on enquiries.appt_date for a date input ("2026-11-02" becomes that day at 00:00 UTC). */
export function apptDateValue(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v.trim() === "") return null;
  return new Date(v).toISOString();
}

export type CloseEnquiryDeps = {
  create(input: {
    title: string;
    pipelineId: string;
    stageId: string | null;
    contactId: string;
    channelId: string | null;
    apptDate: string | null;
  }): Promise<{ id: string; number: number }>;
  moveStage(id: string, stageId: string): Promise<void>;
  setStatus(id: string, status: EnquiryStatus, reason: string | null): Promise<void>;
  setApptDate(id: string, apptDate: string | null): Promise<void>;
};

export type CloseEnquiryResult = {
  enquiryId: string;
  number: number | null;
  created: boolean;
  /** What was changed, in order (ids and field names only; goes into the audit row). */
  steps: string[];
};

/**
 * Applies the enquiry part through the service. Order: create (or stage), appointment date, then status, so a
 * won / lost status is always the last word on the enquiry.
 */
export async function applyCloseEnquiry(
  deps: CloseEnquiryDeps,
  part: CloseEnquiryPart,
  link: { contactId: string; channelId: string | null; target: CloseEnquiryTarget | null },
): Promise<CloseEnquiryResult> {
  const steps: string[] = [];
  if (part.mode === "create") {
    const created = await deps.create({
      title: part.title,
      pipelineId: part.pipeline_id,
      stageId: part.stage_id ?? null,
      contactId: link.contactId,
      channelId: link.channelId,
      apptDate: apptDateValue(part.appt_date) ?? null,
    });
    steps.push("created");
    if (part.status !== "open") {
      await deps.setStatus(created.id, part.status, part.reason?.trim() || null);
      steps.push(`status:${part.status}`);
    }
    return { enquiryId: created.id, number: created.number, created: true, steps };
  }

  const target = link.target!;
  if (part.stage_id && part.stage_id !== target.stage_id) {
    await deps.moveStage(target.id, part.stage_id);
    steps.push("stage");
  }
  const appt = apptDateValue(part.appt_date);
  if (appt !== undefined && part.appt_date !== undefined && part.appt_date !== "") {
    await deps.setApptDate(target.id, appt);
    steps.push("appt_date");
  }
  if (part.status && part.status !== target.status) {
    await deps.setStatus(target.id, part.status, part.reason?.trim() || null);
    steps.push(`status:${part.status}`);
  }
  return { enquiryId: target.id, number: null, created: false, steps };
}
