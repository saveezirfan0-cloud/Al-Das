import "server-only";

import { recordAudit } from "@/lib/audit";
import { parseMentions } from "@/lib/inbox/mentions";
import { notify } from "@/lib/notify/dispatch-db";
import type { AdminClient } from "@/lib/supabase/admin";
import { taskAudience } from "@/lib/tasks/audience";
import type { TaskCtx } from "@/lib/tasks/service";
import { TaskError } from "@/lib/tasks/service";

/**
 * Tasks v2 parts of a task (Phase F): checklist lines, comments with @mentions and Media Library attachments. Callers
 * (server actions) have checked tasks.manage and that the task is in a branch the member works in. Service role.
 * Audit rows carry ids and counts only, never the text.
 */

export type ChecklistLine = {
  id: string;
  title: string;
  done: boolean;
  done_at: string | null;
  done_by: string | null;
  sort_order: number;
};

export type TaskComment = {
  id: string;
  author_id: string | null;
  body: string;
  created_at: string;
};

export type TaskAttachment = {
  id: string;
  media_asset_id: string;
  name: string;
  kind: string;
  mime_type: string;
  scan_status: string;
};

async function liveTask(admin: AdminClient, orgId: string, taskId: string) {
  const { data } = await admin
    .from("tasks")
    .select("id, subject, location_id")
    .eq("org_id", orgId)
    .eq("id", taskId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) throw new TaskError("Task not found.");
  return data;
}

export async function loadTaskParts(
  admin: AdminClient,
  orgId: string,
  taskId: string,
): Promise<{ checklist: ChecklistLine[]; comments: TaskComment[]; attachments: TaskAttachment[] }> {
  const [{ data: lines }, { data: comments }, { data: files }] = await Promise.all([
    admin
      .from("task_checklist_items")
      .select("id, title, done, done_at, done_by, sort_order")
      .eq("org_id", orgId)
      .eq("task_id", taskId)
      .order("sort_order")
      .order("created_at")
      .limit(200),
    admin
      .from("task_comments")
      .select("id, author_id, body, created_at")
      .eq("org_id", orgId)
      .eq("task_id", taskId)
      .order("created_at")
      .limit(200),
    admin
      .from("task_attachments")
      .select("id, media_asset_id, media_assets(name, kind, mime_type, scan_status, status)")
      .eq("org_id", orgId)
      .eq("task_id", taskId)
      .order("created_at")
      .limit(50),
  ]);
  return {
    checklist: lines ?? [],
    comments: comments ?? [],
    attachments: (files ?? [])
      .filter((f) => f.media_assets && f.media_assets.status === "ready")
      .map((f) => ({
        id: f.id,
        media_asset_id: f.media_asset_id,
        name: f.media_assets!.name,
        kind: f.media_assets!.kind,
        mime_type: f.media_assets!.mime_type,
        scan_status: f.media_assets!.scan_status,
      })),
  };
}

// ---------------------------------------------------------------------------
// Checklist lines
// ---------------------------------------------------------------------------

export async function addChecklistLine(ctx: TaskCtx, taskId: string, title: string): Promise<string> {
  await liveTask(ctx.admin, ctx.orgId, taskId);
  const { data: last } = await ctx.admin
    .from("task_checklist_items")
    .select("sort_order")
    .eq("task_id", taskId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { count } = await ctx.admin
    .from("task_checklist_items")
    .select("id", { count: "exact", head: true })
    .eq("task_id", taskId);
  if ((count ?? 0) >= 100) throw new TaskError("A task can have at most 100 checklist items.");
  const { data, error } = await ctx.admin
    .from("task_checklist_items")
    .insert({
      org_id: ctx.orgId,
      task_id: taskId,
      title,
      sort_order: Math.min((last?.sort_order ?? 0) + 10, 100000),
    })
    .select("id")
    .single();
  if (error || !data) throw new TaskError("Could not add the item.");
  await recordAudit(ctx.admin, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    action: "task.checklist_added",
    entity: "task",
    entityId: taskId,
  });
  return data.id;
}

export async function setChecklistLineDone(
  ctx: TaskCtx,
  taskId: string,
  lineId: string,
  done: boolean,
): Promise<void> {
  await liveTask(ctx.admin, ctx.orgId, taskId);
  const { error } = await ctx.admin
    .from("task_checklist_items")
    .update(
      done
        ? { done: true, done_at: new Date().toISOString(), done_by: ctx.userId }
        : { done: false, done_at: null, done_by: null },
    )
    .eq("org_id", ctx.orgId)
    .eq("task_id", taskId)
    .eq("id", lineId);
  if (error) throw new TaskError("Could not update the item.");
  await recordAudit(ctx.admin, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    action: done ? "task.checklist_ticked" : "task.checklist_unticked",
    entity: "task",
    entityId: taskId,
  });
}

export async function removeChecklistLine(ctx: TaskCtx, taskId: string, lineId: string): Promise<void> {
  await liveTask(ctx.admin, ctx.orgId, taskId);
  const { error } = await ctx.admin
    .from("task_checklist_items")
    .delete()
    .eq("org_id", ctx.orgId)
    .eq("task_id", taskId)
    .eq("id", lineId);
  if (error) throw new TaskError("Could not remove the item.");
  await recordAudit(ctx.admin, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    action: "task.checklist_removed",
    entity: "task",
    entityId: taskId,
  });
}

// ---------------------------------------------------------------------------
// Comments with @mentions
// ---------------------------------------------------------------------------

/**
 * Adds a comment. `@[Name](user id)` tokens become plain `@Name` text and a task.mentioned notification for each
 * mentioned colleague who could open the task (tasks.view and its branch). Push and e-mail carry the task id and a
 * fixed sentence only.
 */
export async function addTaskComment(
  ctx: TaskCtx,
  taskId: string,
  raw: string,
  authorName: string,
): Promise<{ id: string; mentioned: number }> {
  const task = await liveTask(ctx.admin, ctx.orgId, taskId);
  const { text, userIds } = parseMentions(raw);
  const body = text.trim();
  if (!body) throw new TaskError("Write a comment first.");
  const mentioned = (await taskAudience(ctx.admin, ctx.orgId, userIds, task.location_id))
    .filter((id) => id !== ctx.userId)
    .slice(0, 20);
  const { data, error } = await ctx.admin
    .from("task_comments")
    .insert({
      org_id: ctx.orgId,
      task_id: taskId,
      author_id: ctx.userId,
      body: body.slice(0, 2000),
      mentioned_user_ids: mentioned,
    })
    .select("id")
    .single();
  if (error || !data) throw new TaskError("Could not add the comment.");
  await recordAudit(ctx.admin, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    action: "task.commented",
    entity: "task",
    entityId: taskId,
    diff: { mentions: mentioned.length },
  });
  if (mentioned.length) {
    await notify(ctx.admin, {
      orgId: ctx.orgId,
      userIds: mentioned,
      event: "task.mentioned",
      type: "task.mentioned",
      title: `${authorName || "A colleague"} mentioned you on a task`,
      // In the bell only (private to the recipient); push and e-mail use the generic sentence.
      body: task.subject.slice(0, 140),
      payload: { task_id: taskId, comment_id: data.id },
      ids: { task_id: taskId },
    });
  }
  return { id: data.id, mentioned: mentioned.length };
}

// ---------------------------------------------------------------------------
// Attachments (Media Library references)
// ---------------------------------------------------------------------------

export async function attachLibraryFile(ctx: TaskCtx, taskId: string, assetId: string): Promise<void> {
  await liveTask(ctx.admin, ctx.orgId, taskId);
  const { data: asset } = await ctx.admin
    .from("media_assets")
    .select("id, status, scan_status")
    .eq("org_id", ctx.orgId)
    .eq("id", assetId)
    .maybeSingle();
  if (!asset || asset.status !== "ready") throw new TaskError("That library file no longer exists.");
  if (asset.scan_status === "infected") throw new TaskError("The malware scan blocked this file.");
  const { count } = await ctx.admin
    .from("task_attachments")
    .select("id", { count: "exact", head: true })
    .eq("task_id", taskId);
  if ((count ?? 0) >= 20) throw new TaskError("A task can have at most 20 files.");
  const { error } = await ctx.admin.from("task_attachments").upsert(
    { org_id: ctx.orgId, task_id: taskId, media_asset_id: assetId, added_by: ctx.userId },
    { onConflict: "task_id,media_asset_id", ignoreDuplicates: true },
  );
  if (error) throw new TaskError("Could not attach the file.");
  await recordAudit(ctx.admin, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    action: "task.file_attached",
    entity: "task",
    entityId: taskId,
    diff: { media_asset_id: assetId },
  });
}

export async function detachLibraryFile(ctx: TaskCtx, taskId: string, attachmentId: string): Promise<void> {
  await liveTask(ctx.admin, ctx.orgId, taskId);
  const { error } = await ctx.admin
    .from("task_attachments")
    .delete()
    .eq("org_id", ctx.orgId)
    .eq("task_id", taskId)
    .eq("id", attachmentId);
  if (error) throw new TaskError("Could not remove the file.");
  await recordAudit(ctx.admin, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    action: "task.file_removed",
    entity: "task",
    entityId: taskId,
  });
}
