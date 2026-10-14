import type { DeskCan } from "@/app/(app)/front-desk/types";
import type { DeskOptions } from "@/lib/front-desk/options";
import type { PatientCardData } from "@/lib/front-desk/server";
import type { FolderKey, InboxQuery } from "@/lib/inbox/folders";
import type { QuickReplyContext } from "@/lib/inbox/quick-reply";
import type { ConversationListRow, MessageRow } from "@/lib/inbox/queries";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

export type Person = { id: string; name: string; presence: "online" | "away" | "offline" };
export type TeamInfo = { id: string; name: string; round_robin: boolean; mine: boolean };
export type ChannelInfo = {
  id: string;
  name: string;
  display_phone: string | null;
  status: string;
  /** whatsapp | web | instagram | messenger (Phase 20e). Only WhatsApp has templates, media and number switching. */
  type: string;
  /** G11: a WhatsApp catalogue ID is set (Settings, Channels), so catalogue products can be sent. */
  has_catalog?: boolean;
};
export type LabelInfo = { id: string; name: string; color: string };
export type CategoryInfo = { id: string; name: string };
export type QuickReply = {
  id: string;
  shortcut: string;
  text: string;
  /** Arabic wording; used for Arabic-speaking patients. */
  text_ar: string | null;
  label: string | null;
  /** A Media Library file sent with the text (image, video or document). */
  media: { id: string; name: string; kind: "image" | "video" | "document" } | null;
};
export type ViewInfo = {
  id: string;
  name: string;
  owner_id: string;
  filter: unknown;
  shared_all: boolean;
  shared_team_ids: string[];
};
export type TemplateInfo = {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  channel_id: string | null;
  components: MetaTemplateComponent[];
  variable_map: Record<string, string>;
};

export type ContactDetail = {
  id: string;
  first_name: string;
  last_name: string;
  wa_profile_name: string | null;
  phone_e164: string | null;
  wa_bsuid: string | null;
  email: string | null;
  gender: string | null;
  nationality: string | null;
  language: string | null;
  dob: string | null;
  source: string;
  promotions_opt_in: boolean;
  stop_marketing: boolean;
  last_interaction_at: string | null;
  created_at: string;
};

export type ConversationDetail = ConversationListRow & { contact: ContactDetail };

export type MergeSuggestion = { id: string; name: string; phone: string | null; reason: string };

export type SidebarData = {
  /** Front desk screen pop (null without the frontdesk.use permission). */
  desk: { card: PatientCardData | null; options: DeskOptions; can: DeskCan } | null;
  media: MessageRow[];
  merge: MergeSuggestion[];
  otherConversations: Array<{
    id: string;
    status: string;
    channel_name: string;
    last_message_at: string | null;
  }>;
};

export type InboxProps = {
  orgId: string;
  me: { userId: string; name: string };
  perms: {
    send: boolean;
    viewAll: boolean;
    contactsManage: boolean;
    settings: boolean;
    enquiriesManage: boolean;
    appointmentsManage: boolean;
    /** May pick files from the Media Library (media.view or media.manage). */
    media: boolean;
    /** Phase F: may create a task from a chat (tasks.manage). */
    tasksManage: boolean;
  };
  /** AI assist is usable here: the member has ai.use AND the workspace switched it on. */
  ai: { available: boolean };
  query: InboxQuery;
  counts: { folders: Record<FolderKey, number>; teams: Record<string, number> };
  teams: TeamInfo[];
  channels: ChannelInfo[];
  labels: LabelInfo[];
  categories: CategoryInfo[];
  views: ViewInfo[];
  quickReplies: QuickReply[];
  /** Values for {{variables}} in quick replies, for the open conversation's patient. */
  quickReplyContext: QuickReplyContext;
  templates: TemplateInfo[];
  people: Person[];
  settings: {
    require_category_on_close: boolean;
    require_summary_on_close: boolean;
    /** Phase F: first-response colours on the list (minutes without a reply). */
    first_response_amber_minutes: number;
    first_response_red_minutes: number;
  };
  /** The workspace timezone (snooze presets, "tomorrow 9:00"). */
  timezone: string;
  /** Phase B: the branches this member may choose in the filter (active ones), and every branch's name for the chips. */
  branches: Array<{ id: string; name: string }>;
  branchNames: Record<string, string>;
  /** The branch the switcher shows (null = all the member may see); the list follows it unless query.branch is set. */
  currentBranch: string | null;
  /** First page of the list (kept live by Realtime refreshes). */
  conversations: ConversationListRow[];
  /** Cursor for the next (older) page of the list; null when the first page is everything. */
  conversationsCursor: string | null;
  selected: ConversationDetail | null;
  /** Latest page of the open thread, oldest first. */
  messages: MessageRow[];
  /** Cursor for earlier messages of the open thread; null when the thread is complete. */
  messagesCursor: string | null;
  sidebar: SidebarData | null;
};
