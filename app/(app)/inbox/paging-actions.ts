"use server";

import { z } from "zod";

import { canAny } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { parseInboxQuery } from "@/lib/inbox/folders";
import {
  listConversationsPage,
  listMessagesPage,
  type ConversationPage,
  type MessagePage,
} from "@/lib/inbox/queries";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import type { ActionResult } from "./actions";

/**
 * "Load older" for the inbox (D5). Both reads go through the signed-in user's client, so RLS
 * decides exactly as it does for the first page. The gate mirrors what makes a conversation
 * row readable at all: the list inner-joins the patient, whose policy needs one of these.
 */
const INBOX_READ_PERMS = ["inbox.send", "inbox.view_all", "contacts.view"] as const;
const NO_PERMISSION = "You don't have permission for that.";

const uuid = z.string().uuid();
const optionalId = uuid.nullish();
const cursor = z.string().min(1).max(120);

const olderConversationsSchema = z.object({
  query: z.object({
    folder: z.string().max(40),
    team: optionalId,
    q: z.string().max(80).nullish(),
    status: z.string().max(20).nullish(),
    sort: z.string().max(20).nullish(),
    label: optionalId,
    channel: optionalId,
    assignee: optionalId,
  }),
  cursor,
});

export async function loadOlderConversations(
  input: z.input<typeof olderConversationsSchema>,
): Promise<ActionResult<ConversationPage>> {
  const member = await requireMember();
  if (!canAny(member, [...INBOX_READ_PERMS])) return { ok: false, error: NO_PERMISSION };
  const parsed = olderConversationsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  const { query: raw } = parsed.data;
  // The same parser as the page, so an older page uses exactly the filters of the first one.
  const query = parseInboxQuery({
    folder: raw.folder,
    team: raw.team ?? undefined,
    q: raw.q ?? undefined,
    status: raw.status ?? undefined,
    sort: raw.sort ?? undefined,
    label: raw.label ?? undefined,
    channel: raw.channel ?? undefined,
    assignee: raw.assignee ?? undefined,
  });
  const supabase = await createClient();
  const { data: myTeams } = await supabase
    .from("team_members")
    .select("team_id")
    .eq("org_id", member.orgId)
    .eq("user_id", member.userId);
  const ctx = {
    userId: member.userId,
    orgId: member.orgId,
    teamIds: (myTeams ?? []).map((t) => t.team_id),
  };
  let page: ConversationPage;
  try {
    page = await listConversationsPage(supabase, query, ctx, { cursor: parsed.data.cursor });
  } catch {
    return { ok: false, error: "Could not load older conversations." };
  }
  // A patient list like the first page: sampled, ids and counts only.
  await recordAccess(createAdminClient(), member, {
    entity: "conversation",
    action: "list",
    detail: { rows: page.rows.length, page: "older" },
  });
  return { ok: true, data: page };
}

const earlierMessagesSchema = z.object({ conversation_id: uuid, before: cursor });

export async function loadEarlierMessages(
  input: z.input<typeof earlierMessagesSchema>,
): Promise<ActionResult<MessagePage>> {
  const member = await requireMember();
  if (!canAny(member, [...INBOX_READ_PERMS])) return { ok: false, error: NO_PERMISSION };
  const parsed = earlierMessagesSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  const supabase = await createClient();
  // The conversation must be visible to the caller (RLS); messages are filtered by RLS too.
  const { data: visible } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", parsed.data.conversation_id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!visible) return { ok: false, error: "Conversation not found." };
  let page: MessagePage;
  try {
    page = await listMessagesPage(supabase, visible.id, { before: parsed.data.before });
  } catch {
    return { ok: false, error: "Could not load earlier messages." };
  }
  // Reading more of an open conversation is a view of it (repeats within minutes merge).
  await recordAccess(createAdminClient(), member, {
    entity: "conversation",
    entityId: visible.id,
    action: "view",
  });
  return { ok: true, data: page };
}
