"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can, canAny } from "@/lib/auth/can";
import { requireMember, requirePerm } from "@/lib/auth/session";
import { BRANCH_DENIED, branchAllowed } from "@/lib/branches/guard";
import { assignConversationRecord } from "@/lib/inbox/assign";
import { closeConversationRecord } from "@/lib/inbox/close";
import { contactDisplayName } from "@/lib/inbox/contact-name";
import { readInboxSettings, writeInboxSettings } from "@/lib/inbox/settings";
import { normaliseThresholds } from "@/lib/inbox/sla";
import { SNOOZE_PRESETS, snoozePresetTime, snoozeProblem } from "@/lib/inbox/snooze";
import { clearSnooze, setSnooze } from "@/lib/inbox/snooze-server";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/supabase/types";
import { TASK_TYPES } from "@/lib/tasks/constants";
import { createTask, TaskError } from "@/lib/tasks/service";
import { TASK_PRIORITIES } from "@/lib/tasks/status";

/**
 * Phase F inbox work: snooze, bulk assign / close, message-text search, a task from a chat, and the first-response
 * colours. Every action needs inbox rights and only touches conversations the member can see through RLS (the user's
 * own client decides); writes use the service role afterwards and are audited (ids and counts only).
 */

export type WorkResult<T = undefined> =
  | { ok: true; message?: string; data: T }
  | { ok: false; error: string };

const uuid = z.string().uuid();
const MAX_BULK = 100;

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/** The conversations among `ids` this member may see (RLS through their own client), with the patient's name. */
async function visibleConversations(orgId: string, ids: string[]) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("conversations")
    .select("id, status, contact_id, location_id, contacts(first_name, last_name, wa_profile_name, phone_e164)")
    .eq("org_id", orgId)
    .in("id", ids);
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Snooze
// ---------------------------------------------------------------------------

const snoozeSchema = z.object({
  conversation_id: uuid,
  preset: z.enum(SNOOZE_PRESETS).nullish(),
  until: z.string().max(40).nullish(),
});

export async function snoozeConversation(
  input: z.input<typeof snoozeSchema>,
): Promise<WorkResult<{ until: string }>> {
  const member = await requirePerm("inbox.send");
  const parsed = snoozeSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input");
  const [conversation] = await visibleConversations(member.orgId, [parsed.data.conversation_id]);
  if (!conversation) return fail("Conversation not found.");
  if (conversation.status === "closed") return fail("A closed conversation cannot be snoozed.");
  const now = new Date();
  const until = parsed.data.preset
    ? snoozePresetTime(parsed.data.preset, now, member.org.timezone || "Asia/Dubai")
    : new Date(parsed.data.until ?? "");
  const problem = snoozeProblem(until, now);
  if (problem) return fail(problem);
  const admin = createAdminClient(member.userId);
  const ok = await setSnooze(admin, {
    orgId: member.orgId,
    userId: member.userId,
    conversationId: conversation.id,
    until,
  }).catch(() => false);
  if (!ok) return fail("Could not snooze the conversation.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "conversation.snoozed",
    entity: "conversation",
    entityId: conversation.id,
    diff: { until: until.toISOString() },
  });
  revalidatePath("/inbox");
  return { ok: true, message: "Snoozed. It comes back on its own.", data: { until: until.toISOString() } };
}

export async function unsnoozeConversation(conversationId: string): Promise<WorkResult> {
  const member = await requirePerm("inbox.send");
  if (!uuid.safeParse(conversationId).success) return fail("Invalid input");
  const [conversation] = await visibleConversations(member.orgId, [conversationId]);
  if (!conversation) return fail("Conversation not found.");
  const admin = createAdminClient(member.userId);
  const cleared = await clearSnooze(admin, { orgId: member.orgId, conversationId });
  if (!cleared) return fail("This conversation is not snoozed.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "conversation.unsnoozed",
    entity: "conversation",
    entityId: conversationId,
  });
  revalidatePath("/inbox");
  return { ok: true, message: "Back in the inbox.", data: undefined };
}

// ---------------------------------------------------------------------------
// Bulk assign / close (each conversation through the same path as the single action)
// ---------------------------------------------------------------------------

const bulkIds = z.array(uuid).min(1).max(MAX_BULK);

const bulkAssignSchema = z.object({
  ids: bulkIds,
  user_id: uuid.nullable(),
  team_id: uuid.nullable(),
});

export async function bulkAssignConversations(
  input: z.input<typeof bulkAssignSchema>,
): Promise<WorkResult<{ done: number; skipped: number }>> {
  const member = await requirePerm("inbox.send");
  const parsed = bulkAssignSchema.safeParse(input);
  if (!parsed.success) return fail(`Choose between 1 and ${MAX_BULK} conversations.`);
  const ids = [...new Set(parsed.data.ids)];
  const visible = await visibleConversations(member.orgId, ids);
  const admin = createAdminClient(member.userId);
  let done = 0;
  for (const c of visible) {
    const ok = await assignConversationRecord(admin, {
      orgId: member.orgId,
      actorId: member.userId,
      conversationId: c.id,
      contact: c.contacts,
      userId: parsed.data.user_id,
      teamId: parsed.data.team_id,
    });
    if (ok) done++;
  }
  const skipped = ids.length - done;
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "conversation.bulk_assigned",
    entity: "conversation",
    diff: {
      requested: ids.length,
      assigned: done,
      skipped,
      user_id: parsed.data.user_id,
      team_id: parsed.data.team_id,
    },
  });
  revalidatePath("/inbox");
  if (done === 0) return fail("None of those conversations could be assigned.");
  return {
    ok: true,
    message: `${done} conversation${done === 1 ? "" : "s"} assigned${skipped ? `, ${skipped} skipped` : ""}.`,
    data: { done, skipped },
  };
}

const bulkCloseSchema = z.object({ ids: bulkIds });

/**
 * Closes several conversations without a category or summary. Refused when the workspace asks for either on close
 * (those need the close dialog, one at a time), and close-with-enquiry stays a single-conversation step.
 */
export async function bulkCloseConversations(
  input: z.input<typeof bulkCloseSchema>,
): Promise<WorkResult<{ done: number; skipped: number }>> {
  const member = await requirePerm("inbox.send");
  const parsed = bulkCloseSchema.safeParse(input);
  if (!parsed.success) return fail(`Choose between 1 and ${MAX_BULK} conversations.`);
  const admin = createAdminClient(member.userId);
  const { data: org } = await admin.from("orgs").select("settings").eq("id", member.orgId).single();
  const settings = readInboxSettings(org?.settings);
  if (settings.require_category_on_close || settings.require_summary_on_close)
    return fail("Your workspace asks for a category or summary on close: close these one at a time.");
  const ids = [...new Set(parsed.data.ids)];
  const visible = (await visibleConversations(member.orgId, ids)).filter((c) => c.status !== "closed");
  let done = 0;
  for (const c of visible) {
    const ok = await closeConversationRecord(admin, {
      orgId: member.orgId,
      userId: member.userId,
      conversationId: c.id,
      contactId: c.contact_id,
      categoryId: null,
      summary: null,
    });
    if (ok) done++;
  }
  const skipped = ids.length - done;
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "conversation.bulk_closed",
    entity: "conversation",
    diff: { requested: ids.length, closed: done, skipped },
  });
  revalidatePath("/inbox");
  if (done === 0) return fail("None of those conversations could be closed.");
  return {
    ok: true,
    message: `${done} conversation${done === 1 ? "" : "s"} closed${skipped ? `, ${skipped} skipped` : ""}.`,
    data: { done, skipped },
  };
}

// ---------------------------------------------------------------------------
// Message-text search
// ---------------------------------------------------------------------------

export type MessageHit = {
  message_id: string;
  conversation_id: string;
  at: string;
  direction: string;
  snippet: string;
  contact_name: string;
};

const searchSchema = z.object({ q: z.string().trim().min(3).max(100) });

/**
 * Searches message text inside this workspace. RLS on messages and conversations decides what the member finds (the
 * SQL function runs with their rights); at most 30 hits with a short snippet each. The query text is never logged or
 * stored: the access log records that a search ran and how many hits it had.
 */
export async function searchMessageText(
  input: z.input<typeof searchSchema>,
): Promise<WorkResult<{ hits: MessageHit[] }>> {
  const member = await requireMember();
  if (!canAny(member, ["inbox.send", "inbox.view_all"])) return fail("You don't have inbox access.");
  const parsed = searchSchema.safeParse(input);
  if (!parsed.success) return fail("Type at least 3 characters.");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("search_messages", {
    p_org_id: member.orgId,
    p_query: parsed.data.q,
    p_limit: 30,
  });
  if (error) return fail("Search failed.");
  const rows = data ?? [];
  const convIds = [...new Set(rows.map((r) => r.conversation_id))];
  const conversations = convIds.length ? await visibleConversations(member.orgId, convIds) : [];
  const names = new Map(
    conversations.map((c) => [c.id, c.contacts ? contactDisplayName(c.contacts) : "Unknown"]),
  );
  const hits = rows
    .filter((r) => names.has(r.conversation_id))
    .map((r) => ({
      message_id: r.message_id,
      conversation_id: r.conversation_id,
      at: r.at,
      direction: r.direction,
      snippet: r.snippet,
      contact_name: names.get(r.conversation_id) ?? "Unknown",
    }));
  await recordAccess(createAdminClient(), member, {
    entity: "conversation",
    action: "search",
    detail: { search: "message_text", rows: hits.length },
  });
  return { ok: true, data: { hits } };
}

// ---------------------------------------------------------------------------
// Create a task from a chat
// ---------------------------------------------------------------------------

const chatTaskSchema = z.object({
  conversation_id: uuid,
  subject: z.string().trim().min(1, "Subject is required").max(200),
  due_at: z
    .string()
    .refine((v) => !Number.isNaN(new Date(v).getTime()), "Choose a date and time")
    .transform((v) => new Date(v).toISOString()),
  assignee_id: uuid.nullable(),
  type: z.enum(TASK_TYPES).default("follow_up"),
  priority: z.enum(TASK_PRIORITIES).default("normal"),
  notes: z.string().trim().max(2000).optional(),
});

/**
 * A task linked to the chat's patient and the chat itself, in the chat's branch (the branch of its number). Needs
 * tasks.manage and a conversation the member can see; the branch must be one the member works in.
 */
export async function createTaskFromConversation(
  input: z.input<typeof chatTaskSchema>,
): Promise<WorkResult<{ id: string }>> {
  const member = await requirePerm("tasks.manage");
  if (!canAny(member, ["inbox.send", "inbox.view_all"])) return fail("You don't have inbox access.");
  const parsed = chatTaskSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid task");
  const d = parsed.data;
  const [conversation] = await visibleConversations(member.orgId, [d.conversation_id]);
  if (!conversation) return fail("Conversation not found.");
  if (!branchAllowed(member, conversation.location_id)) return fail(BRANCH_DENIED);
  const admin = createAdminClient(member.userId);
  try {
    const created = await createTask(
      { admin, orgId: member.orgId, userId: member.userId },
      {
        type: d.type,
        subject: d.subject,
        notes: d.notes || null,
        dueAt: d.due_at,
        assigneeId: d.assignee_id,
        // The patient link needs contacts.view, like the Tasks page.
        contactId: can(member, "contacts.view") ? conversation.contact_id : null,
        conversationId: conversation.id,
        locationId: conversation.location_id,
        priority: d.priority,
      },
    );
    revalidatePath("/tasks");
    return { ok: true, message: "Task created.", data: created };
  } catch (e) {
    return fail(e instanceof TaskError ? e.message : "Could not create the task.");
  }
}

// ---------------------------------------------------------------------------
// First-response colours (Settings, Inbox; also set from the list's filter menu)
// ---------------------------------------------------------------------------

const slaSchema = z.object({
  amber: z.number().int().min(1).max(10080),
  red: z.number().int().min(2).max(10080),
});

export async function saveFirstResponseTargets(
  input: z.input<typeof slaSchema>,
): Promise<WorkResult> {
  const member = await requirePerm("settings.manage");
  const parsed = slaSchema.safeParse(input);
  if (!parsed.success) return fail("Use whole minutes.");
  if (parsed.data.red <= parsed.data.amber) return fail("Red must come after amber.");
  const t = normaliseThresholds({ amberMinutes: parsed.data.amber, redMinutes: parsed.data.red });
  const admin = createAdminClient(member.userId);
  const { data: org } = await admin.from("orgs").select("settings").eq("id", member.orgId).single();
  const current = readInboxSettings(org?.settings);
  const next = writeInboxSettings(org?.settings, {
    ...current,
    first_response_amber_minutes: t.amberMinutes,
    first_response_red_minutes: t.redMinutes,
  });
  const { error } = await admin
    .from("orgs")
    .update({ settings: next as NonNullable<Json> })
    .eq("id", member.orgId);
  if (error) return fail("Could not save.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "inbox.settings_updated",
    entity: "org",
    entityId: member.orgId,
    diff: { first_response_amber_minutes: t.amberMinutes, first_response_red_minutes: t.redMinutes },
  });
  revalidatePath("/inbox");
  revalidatePath("/settings/inbox");
  return { ok: true, message: "Response-time colours saved.", data: undefined };
}
