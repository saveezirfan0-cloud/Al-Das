/**
 * Inbox folders, filters and sorting. Pure: shared by the server query layer,
 * saved views and the client (to decide whether a realtime change affects the
 * visible list).
 */
export const FOLDERS = [
  { key: "open", label: "Open" },
  { key: "mine", label: "My inbox" },
  { key: "assigned_me", label: "Assigned to me" },
  { key: "bot", label: "Assigned to bot" },
  { key: "unassigned", label: "Unassigned" },
  { key: "waiting", label: "Waiting" },
  { key: "unread", label: "Unread" },
  { key: "mentions", label: "Mentions" },
  { key: "closed", label: "Closed" },
] as const;

export type FolderKey = (typeof FOLDERS)[number]["key"];

export function isFolderKey(v: string | null | undefined): v is FolderKey {
  return !!v && FOLDERS.some((f) => f.key === v);
}

export type InboxQuery = {
  folder: FolderKey;
  /** Team queue (overrides folder scoping to that team's open conversations). */
  team: string | null;
  /** Saved view id. */
  view: string | null;
  q: string;
  status: "any" | "open" | "waiting" | "closed";
  sort: "newest" | "oldest";
  label: string | null;
  channel: string | null;
  assignee: string | null;
};

export const DEFAULT_QUERY: InboxQuery = {
  folder: "open",
  team: null,
  view: null,
  q: "",
  status: "any",
  sort: "newest",
  label: null,
  channel: null,
  assignee: null,
};

type ParamsLike = Record<string, string | string[] | undefined>;

function str(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.length ? s : null;
}

export function parseInboxQuery(params: ParamsLike): InboxQuery {
  const folder = str(params.folder);
  const status = str(params.status);
  const sort = str(params.sort);
  return {
    folder: isFolderKey(folder) ? folder : "open",
    team: str(params.team),
    view: str(params.view),
    q: (str(params.q) ?? "").slice(0, 80),
    status: status === "open" || status === "waiting" || status === "closed" ? status : "any",
    sort: sort === "oldest" ? "oldest" : "newest",
    label: str(params.label),
    channel: str(params.channel),
    assignee: str(params.assignee),
  };
}

export function toSearchParams(q: Partial<InboxQuery>, conversationId?: string | null): string {
  const p = new URLSearchParams();
  if (q.folder && q.folder !== "open") p.set("folder", q.folder);
  if (q.team) p.set("team", q.team);
  if (q.view) p.set("view", q.view);
  if (q.q) p.set("q", q.q);
  if (q.status && q.status !== "any") p.set("status", q.status);
  if (q.sort && q.sort !== "newest") p.set("sort", q.sort);
  if (q.label) p.set("label", q.label);
  if (q.channel) p.set("channel", q.channel);
  if (q.assignee) p.set("assignee", q.assignee);
  if (conversationId) p.set("c", conversationId);
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** Saved views store the filter part of a query (never the selected conversation). */
export function queryToViewFilter(q: InboxQuery): Record<string, unknown> {
  const { folder, team, status, sort, label, channel, assignee, q: text } = q;
  return { folder, team, status, sort, label, channel, assignee, q: text };
}

export function viewFilterToQuery(filter: unknown): InboxQuery {
  if (!filter || typeof filter !== "object") return DEFAULT_QUERY;
  const f = filter as Record<string, unknown>;
  const asStr = (v: unknown) => (typeof v === "string" && v ? v : null);
  return parseInboxQuery({
    folder: asStr(f.folder) ?? undefined,
    team: asStr(f.team) ?? undefined,
    status: asStr(f.status) ?? undefined,
    sort: asStr(f.sort) ?? undefined,
    label: asStr(f.label) ?? undefined,
    channel: asStr(f.channel) ?? undefined,
    assignee: asStr(f.assignee) ?? undefined,
    q: asStr(f.q) ?? undefined,
  });
}

export type ConversationLike = {
  status: "open" | "waiting" | "closed" | string;
  assignee_user_id: string | null;
  assignee_team_id: string | null;
  bot_active: boolean;
  unread_count: number;
  channel_id: string;
};

export type FolderContext = {
  userId: string;
  teamIds: readonly string[];
  /** Conversations with unread mentions for this user. */
  mentionConversationIds?: ReadonlySet<string>;
};

/** Does a conversation belong in a folder? Mirrors the SQL in lib/inbox/queries.ts. */
export function matchesFolder(
  c: ConversationLike & { id?: string },
  folder: FolderKey,
  team: string | null,
  ctx: FolderContext,
): boolean {
  const live = c.status !== "closed";
  if (team) return live && c.assignee_team_id === team;
  switch (folder) {
    case "open":
      return live;
    case "mine":
      return (
        live &&
        (c.assignee_user_id === ctx.userId ||
          (!!c.assignee_team_id && ctx.teamIds.includes(c.assignee_team_id)))
      );
    case "assigned_me":
      return live && c.assignee_user_id === ctx.userId;
    case "bot":
      return live && c.bot_active;
    case "unassigned":
      return live && !c.assignee_user_id && !c.assignee_team_id;
    case "waiting":
      return c.status === "waiting";
    case "unread":
      return live && c.unread_count > 0;
    case "mentions":
      return !!c.id && !!ctx.mentionConversationIds?.has(c.id);
    case "closed":
      return c.status === "closed";
  }
}
