"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { canAny } from "@/lib/auth/can";
import { requirePerm, type CurrentMember } from "@/lib/auth/session";
import { BRANCH_DENIED, branchAllowed, rowOutsideBranches } from "@/lib/branches/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  addChecklistLine,
  addTaskComment,
  attachLibraryFile,
  detachLibraryFile,
  loadTaskParts,
  removeChecklistLine,
  setChecklistLineDone,
  type ChecklistLine,
  type TaskAttachment,
} from "@/lib/tasks/extras";
import {
  CHECKLIST_KINDS,
  checklistLinesProblem,
  normaliseTime,
  parseChecklistLines,
  templateTimesProblem,
} from "@/lib/tasks/checklist";
import { TaskError, type TaskCtx } from "@/lib/tasks/service";

/**
 * Tasks v2 (Phase F): a task's checklist, comments and files, and the per-branch daily checklist templates. Reads need
 * tasks.view, changes tasks.manage (templates: settings.manage); every task must be in a branch the member works in.
 */

export type PartsResult<T = undefined> =
  | { ok: true; message?: string; data: T }
  | { ok: false; error: string };

const uuid = z.string().uuid();

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function describe(e: unknown, fallback: string): string {
  if (e instanceof TaskError) return e.message;
  console.error("[tasks] parts action failed", e instanceof Error ? e.name : "unknown");
  return fallback;
}

async function gate(
  perm: "tasks.view" | "tasks.manage",
  taskId: string,
): Promise<{ ctx: TaskCtx; member: CurrentMember } | { error: string }> {
  const member = await requirePerm(perm);
  if (!uuid.safeParse(taskId).success) return { error: "Invalid task." };
  const admin = createAdminClient(member.userId);
  if (await rowOutsideBranches(admin, member, "tasks", taskId)) return { error: BRANCH_DENIED };
  return { ctx: { admin, orgId: member.orgId, userId: member.userId }, member };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export type TaskParts = {
  checklist: ChecklistLine[];
  comments: Array<{ id: string; author: string; author_id: string | null; body: string; created_at: string }>;
  attachments: TaskAttachment[];
};

export async function loadTaskPartsAction(taskId: string): Promise<PartsResult<TaskParts>> {
  const g = await gate("tasks.view", taskId);
  if ("error" in g) return fail(g.error);
  const { data: task } = await g.ctx.admin
    .from("tasks")
    .select("id")
    .eq("org_id", g.ctx.orgId)
    .eq("id", taskId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!task) return fail("This task no longer exists.");
  const parts = await loadTaskParts(g.ctx.admin, g.ctx.orgId, taskId);
  const authorIds = [...new Set(parts.comments.map((c) => c.author_id).filter((x): x is string => !!x))];
  const { data: profiles } = authorIds.length
    ? await g.ctx.admin.from("profiles").select("id, first_name, last_name").in("id", authorIds)
    : { data: [] as Array<{ id: string; first_name: string; last_name: string }> };
  const names = new Map(
    (profiles ?? []).map((p) => [p.id, `${p.first_name} ${p.last_name}`.trim() || "Colleague"]),
  );
  // File names are shown only to people who may open the Media Library.
  const media = canAny(g.member, ["media.view", "media.manage"]);
  return {
    ok: true,
    data: {
      checklist: parts.checklist,
      comments: parts.comments.map((c) => ({
        ...c,
        author: c.author_id ? (names.get(c.author_id) ?? "Former member") : "Pulse",
      })),
      attachments: media ? parts.attachments : [],
    },
  };
}

// ---------------------------------------------------------------------------
// Checklist lines
// ---------------------------------------------------------------------------

const lineTitle = z.string().trim().min(1, "Write the item first").max(200);

export async function addChecklistItemAction(taskId: string, title: string): Promise<PartsResult> {
  const g = await gate("tasks.manage", taskId);
  if ("error" in g) return fail(g.error);
  const parsed = lineTitle.safeParse(title);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid item");
  try {
    await addChecklistLine(g.ctx, taskId, parsed.data);
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(describe(e, "Could not add the item."));
  }
}

export async function setChecklistItemDoneAction(
  taskId: string,
  itemId: string,
  done: boolean,
): Promise<PartsResult> {
  const g = await gate("tasks.manage", taskId);
  if ("error" in g) return fail(g.error);
  if (!uuid.safeParse(itemId).success) return fail("Invalid item.");
  try {
    await setChecklistLineDone(g.ctx, taskId, itemId, done === true);
    revalidatePath("/tasks");
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(describe(e, "Could not update the item."));
  }
}

export async function removeChecklistItemAction(taskId: string, itemId: string): Promise<PartsResult> {
  const g = await gate("tasks.manage", taskId);
  if ("error" in g) return fail(g.error);
  if (!uuid.safeParse(itemId).success) return fail("Invalid item.");
  try {
    await removeChecklistLine(g.ctx, taskId, itemId);
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(describe(e, "Could not remove the item."));
  }
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

const commentText = z.string().trim().min(1, "Write a comment first").max(2400);

export async function addTaskCommentAction(
  taskId: string,
  text: string,
): Promise<PartsResult<{ mentioned: number }>> {
  const g = await gate("tasks.manage", taskId);
  if ("error" in g) return fail(g.error);
  const parsed = commentText.safeParse(text);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid comment");
  try {
    const author = `${g.member.profile.first_name} ${g.member.profile.last_name}`.trim();
    const r = await addTaskComment(g.ctx, taskId, parsed.data, author);
    return {
      ok: true,
      message: r.mentioned ? `Comment added; ${r.mentioned} notified.` : "Comment added.",
      data: { mentioned: r.mentioned },
    };
  } catch (e) {
    return fail(describe(e, "Could not add the comment."));
  }
}

// ---------------------------------------------------------------------------
// Files from the Media Library
// ---------------------------------------------------------------------------

export async function attachTaskFileAction(taskId: string, assetId: string): Promise<PartsResult> {
  const g = await gate("tasks.manage", taskId);
  if ("error" in g) return fail(g.error);
  if (!canAny(g.member, ["media.view", "media.manage"]))
    return fail("You don't have access to the Media Library.");
  if (!uuid.safeParse(assetId).success) return fail("Invalid file.");
  try {
    await attachLibraryFile(g.ctx, taskId, assetId);
    return { ok: true, message: "File attached.", data: undefined };
  } catch (e) {
    return fail(describe(e, "Could not attach the file."));
  }
}

export async function detachTaskFileAction(taskId: string, attachmentId: string): Promise<PartsResult> {
  const g = await gate("tasks.manage", taskId);
  if ("error" in g) return fail(g.error);
  if (!uuid.safeParse(attachmentId).success) return fail("Invalid file.");
  try {
    await detachLibraryFile(g.ctx, taskId, attachmentId);
    return { ok: true, message: "File removed from the task.", data: undefined };
  } catch (e) {
    return fail(describe(e, "Could not remove the file."));
  }
}

// ---------------------------------------------------------------------------
// Daily checklist templates (per branch; administrators)
// ---------------------------------------------------------------------------

export type ChecklistTemplateRow = {
  id: string;
  location_id: string;
  name: string;
  kind: string;
  items: string[];
  generate_at: string;
  due_time: string;
  assignee_id: string | null;
  team_id: string | null;
  active: boolean;
};

export async function listChecklistTemplates(): Promise<PartsResult<ChecklistTemplateRow[]>> {
  const member = await requirePerm("tasks.view");
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("task_checklist_templates")
    .select("id, location_id, name, kind, items, generate_at, due_time, assignee_id, team_id, active")
    .eq("org_id", member.orgId)
    .order("name")
    .limit(200);
  if (error) return fail("Could not load the checklists.");
  return {
    ok: true,
    data: (data ?? [])
      // Branch rule (RLS twin): only templates of branches this member works in.
      .filter((t) => branchAllowed(member, t.location_id))
      .map((t) => ({
        ...t,
        items: Array.isArray(t.items) ? t.items.filter((i): i is string => typeof i === "string") : [],
        generate_at: normaliseTime(t.generate_at) ?? "06:00",
        due_time: normaliseTime(t.due_time) ?? "09:00",
      })),
  };
}

const templateSchema = z.object({
  id: uuid.nullish(),
  location_id: uuid,
  name: z.string().trim().min(1, "Name the checklist").max(120),
  kind: z.enum(CHECKLIST_KINDS),
  lines: z.string().max(20_000),
  generate_at: z.string(),
  due_time: z.string(),
  assignee_id: uuid.nullable(),
  team_id: uuid.nullable(),
  active: z.boolean(),
});

export async function saveChecklistTemplate(
  input: z.input<typeof templateSchema>,
): Promise<PartsResult<{ id: string }>> {
  const member = await requirePerm("settings.manage");
  const parsed = templateSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid checklist");
  const d = parsed.data;
  if (!branchAllowed(member, d.location_id)) return fail(BRANCH_DENIED);
  const items = parseChecklistLines(d.lines);
  const problem = checklistLinesProblem(items) ?? templateTimesProblem(d.generate_at, d.due_time);
  if (problem) return fail(problem);
  const admin = createAdminClient(member.userId);
  const row = {
    org_id: member.orgId,
    location_id: d.location_id,
    name: d.name,
    kind: d.kind,
    items,
    generate_at: normaliseTime(d.generate_at)!,
    due_time: normaliseTime(d.due_time)!,
    assignee_id: d.assignee_id,
    team_id: d.team_id,
    active: d.active,
  };
  const res = d.id
    ? await admin
        .from("task_checklist_templates")
        .update(row)
        .eq("org_id", member.orgId)
        .eq("id", d.id)
        .select("id")
        .single()
    : await admin
        .from("task_checklist_templates")
        .insert({ ...row, created_by: member.userId })
        .select("id")
        .single();
  if (res.error || !res.data)
    return fail(
      res.error?.code === "23514"
        ? "One of the selected values is not valid for this workspace."
        : "Could not save the checklist.",
    );
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: d.id ? "task.checklist_template_updated" : "task.checklist_template_created",
    entity: "task_checklist_template",
    entityId: res.data.id,
    diff: { items: items.length, active: d.active },
  });
  revalidatePath("/tasks");
  return { ok: true, message: "Checklist saved.", data: { id: res.data.id } };
}

export async function deleteChecklistTemplate(id: string): Promise<PartsResult> {
  const member = await requirePerm("settings.manage");
  if (!uuid.safeParse(id).success) return fail("Invalid checklist.");
  const admin = createAdminClient(member.userId);
  const { data: row } = await admin
    .from("task_checklist_templates")
    .select("id, location_id")
    .eq("org_id", member.orgId)
    .eq("id", id)
    .maybeSingle();
  if (!row) return fail("Checklist not found.");
  if (!branchAllowed(member, row.location_id)) return fail(BRANCH_DENIED);
  // Tasks already made from it keep their lines (checklist_template_id is set to null).
  const { error } = await admin
    .from("task_checklist_templates")
    .delete()
    .eq("org_id", member.orgId)
    .eq("id", id);
  if (error) return fail("Could not delete the checklist.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "task.checklist_template_deleted",
    entity: "task_checklist_template",
    entityId: id,
  });
  revalidatePath("/tasks");
  return { ok: true, message: "Checklist deleted. Lists already made today stay.", data: undefined };
}
