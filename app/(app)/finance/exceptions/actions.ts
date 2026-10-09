"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { runRulesForOrg } from "@/lib/finance/rules-db";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

const PERM = "finance.exceptions.manage";
const uuid = z.string().uuid();

function refresh(id?: string) {
  revalidatePath("/finance/exceptions");
  if (id) revalidatePath(`/finance/exceptions/${id}`);
}

// Writes use the member's own client: RLS requires finance.exceptions.manage AND access to the
// rule's owner queue, so a Billing user cannot touch an Insurance exception even by guessing its id.

const assignSchema = z.object({ id: uuid, assignee: z.union([uuid, z.literal("")]) });
export async function assignException(formData: FormData): Promise<ActionResult> {
  const member = await requirePerm(PERM);
  const p = assignSchema.safeParse(Object.fromEntries(formData));
  if (!p.success) return { ok: false, error: "Choose a person." };
  const { data, error } = await (
    await createClient()
  )
    .from("ops_exceptions")
    .update({ assignee_user_id: p.data.assignee || null })
    .eq("id", p.data.id)
    .in("status", ["open", "in_progress"])
    .select("id");
  if (error || !data?.length) return { ok: false, error: "Could not assign this exception." };
  await recordAudit(createAdminClient(), {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.exception.assigned",
    entity: "ops_exceptions",
    entityId: p.data.id,
    diff: { assignee: p.data.assignee || null },
  });
  refresh(p.data.id);
  return { ok: true, message: p.data.assignee ? "Assigned." : "Unassigned." };
}

export async function startException(id: string): Promise<ActionResult> {
  const member = await requirePerm(PERM);
  if (!uuid.safeParse(id).success) return { ok: false, error: "Invalid exception." };
  const { data, error } = await (
    await createClient()
  )
    .from("ops_exceptions")
    .update({ status: "in_progress", assignee_user_id: member.userId })
    .eq("id", id)
    .eq("status", "open")
    .select("id");
  if (error || !data?.length) return { ok: false, error: "Could not start this exception." };
  await recordAudit(createAdminClient(), {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.exception.started",
    entity: "ops_exceptions",
    entityId: id,
  });
  refresh(id);
  return { ok: true, message: "Marked in progress and assigned to you." };
}

const commentSchema = z.object({
  id: uuid,
  comment: z.string().trim().min(1, "Write a comment.").max(2000),
});
export async function commentException(formData: FormData): Promise<ActionResult> {
  const member = await requirePerm(PERM);
  const p = commentSchema.safeParse(Object.fromEntries(formData));
  if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "Invalid comment." };
  const { error } = await (
    await createClient()
  )
    .from("ops_exception_comments")
    .insert({
      org_id: member.orgId,
      exception_id: p.data.id,
      user_id: member.userId,
      comment: p.data.comment,
    });
  if (error) return { ok: false, error: "Could not add the comment." };
  await recordAudit(createAdminClient(), {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.exception.commented",
    entity: "ops_exceptions",
    entityId: p.data.id,
  });
  refresh(p.data.id);
  return { ok: true, message: "Comment added." };
}

const closeSchema = z.object({
  id: uuid,
  note: z.string().trim().min(3, "A closing note is required.").max(2000),
});
export async function closeException(formData: FormData): Promise<ActionResult> {
  const member = await requirePerm(PERM);
  const p = closeSchema.safeParse(Object.fromEntries(formData));
  if (!p.success)
    return { ok: false, error: p.error.issues[0]?.message ?? "A closing note is required." };
  const { data, error } = await (
    await createClient()
  )
    .from("ops_exceptions")
    .update({
      status: "closed",
      closed_at: new Date().toISOString(),
      closed_by: member.userId,
      closure_note: p.data.note,
    })
    .eq("id", p.data.id)
    .in("status", ["open", "in_progress"])
    .select("id");
  if (error || !data?.length) return { ok: false, error: "Could not close this exception." };
  await recordAudit(createAdminClient(), {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.exception.closed",
    entity: "ops_exceptions",
    entityId: p.data.id,
    diff: { note_length: p.data.note.length },
  });
  refresh(p.data.id);
  return { ok: true, message: "Closed." };
}

/** Re-evaluates every rule now. Idempotent; needs the admin permission because it can open many items. */
export async function runRulesNow(): Promise<ActionResult> {
  const member = await requirePerm("finance.capture.manage");
  const result = await runRulesForOrg(createAdminClient(), member.orgId);
  const opened = Object.values(result).reduce((n, r) => n + (r.opened ?? 0), 0);
  const closed = Object.values(result).reduce((n, r) => n + (r.closed ?? 0), 0);
  await recordAudit(createAdminClient(), {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.rules.run",
    entity: "ops_exceptions",
    diff: { opened, closed },
  });
  refresh();
  return { ok: true, message: `${opened} opened, ${closed} cleared.` };
}
