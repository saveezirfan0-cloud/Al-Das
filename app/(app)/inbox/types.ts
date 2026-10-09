import type { FolderKey, InboxQuery } from "@/lib/inbox/folders";
import type { ConversationListRow, MessageRow } from "@/lib/inbox/queries";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

export type Person = { id: string; name: string; presence: "online" | "away" | "offline" };
export type TeamInfo = { id: string; name: string; round_robin: boolean; mine: boolean };
export type ChannelInfo = {
  id: string;
  name: string;
  display_phone: string | null;
  status: string;
};
export type LabelInfo = { id: string; name: string; color: string };
export type CategoryInfo = { id: string; name: string };
export type QuickReply = { id: string; shortcut: string; text: string };
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
  };
  query: InboxQuery;
  counts: { folders: Record<FolderKey, number>; teams: Record<string, number> };
  teams: TeamInfo[];
  channels: ChannelInfo[];
  labels: LabelInfo[];
  categories: CategoryInfo[];
  views: ViewInfo[];
  quickReplies: QuickReply[];
  templates: TemplateInfo[];
  people: Person[];
  settings: { require_category_on_close: boolean; require_summary_on_close: boolean };
  conversations: ConversationListRow[];
  selected: ConversationDetail | null;
  messages: MessageRow[];
  sidebar: SidebarData | null;
};
