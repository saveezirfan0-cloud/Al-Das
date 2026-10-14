"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import {
  DENIED,
  dbMessage,
  fail,
  firstIssue,
  optionalDate,
  todayIn,
  uuid,
  type ActionResult,
} from "@/lib/finance/action-support";
import {
  daysBetween,
  FOLLOWUP_NOTE_MAX,
  FOLLOWUP_OUTCOMES,
  stageReached,
} from "@/lib/finance/followup";
import { loadFollowupSettings } from "@/lib/finance/followup-settings";
import { redactText } from "@/lib/redact";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Insurance follow-up (Phase 20I). Recording what was done about an unpaid claim needs finance.followup.manage. The note is
 * free text: it is passed through redactText (numbers and e-mail addresses masked) and capped, the form asks for no
 * patient names, and the audit row records THAT a note was written, never its text. Diligence stays the source of the
 * claim's figures: nothing here changes a claim, an amount or a status.
 */

const PERM = "finance.followup.manage";
async function gate() {
  const member = await requireMember();
  return can(member, PERM) ? member : null;
}

const schema = z.object({
  claim_id: uuid,
  outcome: z.enum(FOLLOWUP_OUTCOMES),
  note: z
    .string()
    .trim()
    .max(FOLLOWUP_NOTE_MAX, `Keep the note under ${FOLLOWUP_NOTE_MAX} characters.`)
    .default(""),
  next_action_date: optionalDate.default(""),
  close_task: z
    .string()
    .optional()
    .transform((v) => v === "on" || v === "true"),
});

export async function addFollowup(raw: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = schema.safeParse(raw);
  if (!p.success) return fail(firstIssue(p.error, "Choose an outcome."));
  const d = p.data;
  const today = todayIn(member.org.timezone);
  if (d.next_action_date && d.next_action_date < today)
    return fail("The next action date cannot be in the past.");

  const admin = createAdminClient(member.userId);
  const { data: claim } = await admin
    .from("ins_claim_activities")
    .select("id, transaction_date")
    .eq("id", d.claim_id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!claim) return fail("That claim was not found.");
  const settings = await loadFollowupSettings(admin, member.orgId);
  const stage = stageReached(daysBetween(claim.transaction_date, today), settings.stageDays);
  const note = d.note ? redactText(d.note, FOLLOWUP_NOTE_MAX).trim() : "";

  const { error } = await admin.from("ins_claim_followups").insert({
    org_id: member.orgId,
    claim_activity_id: d.claim_id,
    stage,
    outcome: d.outcome,
    note: note || null,
    next_action_date: d.next_action_date,
    created_by: member.userId,
  });
  if (error) return fail(dbMessage(error, "Could not save the follow-up."));

  let closed = 0;
  if (d.close_task) {
    const { data: stages } = await admin
      .from("ins_claim_followup_stages")
      .select("task_id")
      .eq("org_id", member.orgId)
      .eq("claim_activity_id", d.claim_id)
      .not("task_id", "is", null);
    const ids = (stages ?? []).map((s) => s.task_id).filter((t): t is string => !!t);
    if (ids.length > 0) {
      const { data: done } = await admin
        .from("tasks")
        .update({
          done: true,
          done_at: new Date().toISOString(),
          completed_by: member.userId,
        })
        .eq("org_id", member.orgId)
        .in("id", ids)
        .is("deleted_at", null)
        .eq("done", false)
        .select("id");
      closed = done?.length ?? 0;
    }
  }

  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.followup.recorded",
    entity: "ins_claim_activities",
    entityId: d.claim_id,
    diff: {
      outcome: d.outcome,
      stage,
      note: note.length > 0,
      next_action: d.next_action_date !== null,
      tasks_closed: closed,
    },
  });
  revalidatePath("/finance/followup");
  return {
    ok: true,
    message: closed > 0 ? `Follow-up saved; ${closed} task(s) closed.` : "Follow-up saved.",
  };
}
