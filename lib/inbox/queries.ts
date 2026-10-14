import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { FOLDERS, type FolderKey, type InboxQuery } from "@/lib/inbox/folders";
import {
  CONVERSATION_PAGE_SIZE,
  MESSAGE_PAGE_SIZE,
  conversationAfterFilter,
  decodeCursor,
  messagesBeforeFilter,
  takePage,
} from "@/lib/inbox/paging";
import type { Database } from "@/lib/supabase/types";

/**
 * Inbox reads run through the signed-in user's client so RLS decides which
 * conversations they can see (inbox.view_all vs. own/team/unassigned).
 */
type UserClient = SupabaseClient<Database>;

export const CONVERSATION_LIST_SELECT = `
  id, org_id, channel_id, contact_id, status, assignee_user_id, assignee_team_id, bot_active,
  last_inbound_at, last_outbound_at, last_message_at, last_message_preview, last_message_direction,
  unread_count, category_id, summary, ai_tags, ad_referral, opened_at, closed_at,
  contacts!inner(id, first_name, last_name, wa_profile_name, phone_e164, wa_bsuid, stop_marketing),
  channels(id, name, display_phone),
  conversation_labels(tag_id, tags(id, name, color))
` as const;

export type ConversationListRow = {
  id: string;
  org_id: string;
  channel_id: string;
  contact_id: string;
  status: string;
  assignee_user_id: string | null;
  assignee_team_id: string | null;
  bot_active: boolean;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  last_message_direction: string | null;
  unread_count: number;
  category_id: string | null;
  summary: string | null;
  /** Labels the AI put on the conversation (booking, price, complaint, report_request, emergency). */
  ai_tags: string[];
  ad_referral: unknown;
  opened_at: string;
  closed_at: string | null;
  contacts: {
    id: string;
    first_name: string;
    last_name: string;
    wa_profile_name: string | null;
    phone_e164: string | null;
    wa_bsuid: string | null;
    stop_marketing: boolean;
  } | null;
  channels: { id: string; name: string; display_phone: string | null } | null;
  conversation_labels: Array<{
    tag_id: string;
    tags: { id: string; name: string; color: string } | null;
  }>;
};

export type QueryContext = { userId: string; orgId: string; teamIds: string[] };

export async function mentionConversationIds(
  supabase: UserClient,
  userId: string,
): Promise<string[]> {
  const { data } = await supabase
    .from("mentions")
    .select("conversation_id")
    .eq("user_id", userId)
    .is("read_at", null)
    .limit(500);
  return [
    ...new Set((data ?? []).map((m) => m.conversation_id).filter((id): id is string => !!id)),
  ];
}

/** The subset of PostgrestFilterBuilder we use; every method returns the builder itself. */
type Filterable<B> = {
  eq(column: string, value: unknown): B;
  neq(column: string, value: unknown): B;
  is(column: string, value: null): B;
  gt(column: string, value: number): B;
  in(column: string, values: string[]): B;
  or(filters: string, options?: { referencedTable?: string }): B;
};

function applyFolder<B extends Filterable<B>>(
  builder: B,
  folder: FolderKey,
  team: string | null,
  ctx: QueryContext,
  mentionIds: string[],
): B {
  // Campaign sends sit in a hidden conversation until the patient replies.
  let b = builder.eq("campaign_only", false) as B;
  if (team) return b.neq("status", "closed").eq("assignee_team_id", team) as B;
  switch (folder) {
    case "open":
      b = b.neq("status", "closed") as B;
      break;
    case "mine":
      b = b.neq("status", "closed") as B;
      b = (
        ctx.teamIds.length
          ? b.or(`assignee_user_id.eq.${ctx.userId},assignee_team_id.in.(${ctx.teamIds.join(",")})`)
          : b.eq("assignee_user_id", ctx.userId)
      ) as B;
      break;
    case "assigned_me":
      b = b.neq("status", "closed").eq("assignee_user_id", ctx.userId) as B;
      break;
    case "bot":
      b = b.neq("status", "closed").eq("bot_active", true) as B;
      break;
    case "unassigned":
      b = b.neq("status", "closed").is("assignee_user_id", null).is("assignee_team_id", null) as B;
      break;
    case "waiting":
      b = b.eq("status", "waiting") as B;
      break;
    case "unread":
      b = b.neq("status", "closed").gt("unread_count", 0) as B;
      break;
    case "mentions":
      b = b.in(
        "id",
        mentionIds.length ? mentionIds : ["00000000-0000-0000-0000-000000000000"],
      ) as B;
      break;
    case "closed":
      b = b.eq("status", "closed") as B;
      break;
  }
  return b;
}

function applyFilters<B extends Filterable<B>>(builder: B, q: InboxQuery): B {
  let b = builder;
  if (q.status !== "any") b = b.eq("status", q.status) as B;
  if (q.channel) b = b.eq("channel_id", q.channel) as B;
  if (q.assignee) b = b.eq("assignee_user_id", q.assignee) as B;
  if (q.q) {
    const term = q.q.replace(/[%,()]/g, " ").trim();
    if (term) {
      b = b.or(
        `first_name.ilike.%${term}%,last_name.ilike.%${term}%,wa_profile_name.ilike.%${term}%,phone_e164.ilike.%${term.replace(/\s/g, "")}%`,
        { referencedTable: "contacts" },
      ) as B;
    }
  }
  return b;
}

/**
 * The label filter is an inner join on a separate, aliased embed so it runs in the database
 * before paging (D5) while `conversation_labels` above still lists every label of the row.
 */
const LABEL_FILTER_EMBED = "label_filter:conversation_labels!inner(tag_id)";

export type ConversationPage = { rows: ConversationListRow[]; nextCursor: string | null };

/**
 * One page of the conversation list, keyset-paged on (last_message_at, id). `cursor` is the
 * `nextCursor` of the previous page; an unreadable cursor is refused rather than ignored.
 */
export async function listConversationsPage(
  supabase: UserClient,
  q: InboxQuery,
  ctx: QueryContext,
  opts: { limit?: number; cursor?: string | null } = {},
): Promise<ConversationPage> {
  const limit = Math.min(Math.max(opts.limit ?? CONVERSATION_PAGE_SIZE, 1), CONVERSATION_PAGE_SIZE);
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
  if (opts.cursor && !cursor) throw new Error("listConversations: invalid cursor");
  const mentionIds =
    q.folder === "mentions" && !q.team ? await mentionConversationIds(supabase, ctx.userId) : [];
  const select: string = q.label
    ? `${CONVERSATION_LIST_SELECT}, ${LABEL_FILTER_EMBED}`
    : CONVERSATION_LIST_SELECT;
  let b = supabase.from("conversations").select(select).eq("org_id", ctx.orgId);
  b = applyFolder(b, q.folder, q.team, ctx, mentionIds);
  b = applyFilters(b, q);
  if (q.label) b = b.eq("label_filter.tag_id", q.label);
  if (cursor) b = b.or(conversationAfterFilter(cursor, q.sort));
  const ascending = q.sort === "oldest";
  const { data, error } = await b
    .order("last_message_at", { ascending, nullsFirst: ascending })
    .order("id", { ascending })
    .limit(limit + 1);
  if (error) throw new Error(`listConversations: ${error.message}`);
  const rows = (data ?? []) as unknown as Array<ConversationListRow & { label_filter?: unknown }>;
  // The filter embed only narrows the rows; the list shows `conversation_labels`.
  for (const r of rows) delete r.label_filter;
  return takePage(rows, limit, (r) => ({ at: r.last_message_at, id: r.id }));
}

/** The first page only (rows), for callers that do not page. */
export async function listConversations(
  supabase: UserClient,
  q: InboxQuery,
  ctx: QueryContext,
  opts: { limit?: number } = {},
): Promise<ConversationListRow[]> {
  return (await listConversationsPage(supabase, q, ctx, opts)).rows;
}

export async function folderCounts(
  supabase: UserClient,
  ctx: QueryContext,
  teamIds: string[],
): Promise<{ folders: Record<FolderKey, number>; teams: Record<string, number> }> {
  const mentionIds = await mentionConversationIds(supabase, ctx.userId);
  const count = async (folder: FolderKey, team: string | null) => {
    let b = supabase
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .eq("org_id", ctx.orgId);
    b = applyFolder(b, folder, team, ctx, mentionIds);
    const { count: n } = await b;
    return n ?? 0;
  };
  const folderEntries = await Promise.all(
    FOLDERS.map(async (f) => [f.key, await count(f.key, null)] as const),
  );
  const teamEntries = await Promise.all(
    teamIds.map(async (t) => [t, await count("open", t)] as const),
  );
  return {
    folders: Object.fromEntries(folderEntries) as Record<FolderKey, number>,
    teams: Object.fromEntries(teamEntries),
  };
}

export const MESSAGE_SELECT = `
  id, conversation_id, direction, kind, body, payload, media_path, media_mime, media_filename,
  wa_message_id, reply_to_wa_message_id, status, error_code, error_message, sent_by_user_id, at,
  profiles:profiles!messages_sent_by_user_id_fkey(first_name, last_name)
` as const;

export type MessageRow = {
  id: string;
  conversation_id: string;
  direction: "in" | "out" | "note";
  kind: string;
  body: string | null;
  payload: unknown;
  media_path: string | null;
  media_mime: string | null;
  media_filename: string | null;
  wa_message_id: string | null;
  reply_to_wa_message_id: string | null;
  status: string;
  error_code: number | null;
  error_message: string | null;
  sent_by_user_id: string | null;
  at: string;
  profiles: { first_name: string; last_name: string } | null;
};

export type MessagePage = { messages: MessageRow[]; nextCursor: string | null };

/**
 * The latest messages of a conversation (or, with `before`, the page just older than that
 * cursor), returned oldest first. `nextCursor` points at still older messages.
 */
export async function listMessagesPage(
  supabase: UserClient,
  conversationId: string,
  opts: { limit?: number; before?: string | null } = {},
): Promise<MessagePage> {
  const limit = Math.min(Math.max(opts.limit ?? MESSAGE_PAGE_SIZE, 1), MESSAGE_PAGE_SIZE);
  const before = opts.before ? decodeCursor(opts.before) : null;
  if (opts.before && (!before || before.at === null))
    throw new Error("listMessages: invalid cursor");
  let b = supabase.from("messages").select(MESSAGE_SELECT).eq("conversation_id", conversationId);
  if (before) b = b.or(messagesBeforeFilter(before));
  const { data, error } = await b
    .order("at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (error) throw new Error(`listMessages: ${error.message}`);
  const page = takePage((data ?? []) as unknown as MessageRow[], limit, (m) => ({
    at: m.at,
    id: m.id,
  }));
  return { messages: page.rows.reverse(), nextCursor: page.nextCursor };
}

export async function listMessages(
  supabase: UserClient,
  conversationId: string,
  limit = MESSAGE_PAGE_SIZE,
): Promise<MessageRow[]> {
  return (await listMessagesPage(supabase, conversationId, { limit })).messages;
}
