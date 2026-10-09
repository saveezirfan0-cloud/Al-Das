import { readAiSettings } from "@/lib/ai/settings";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { contactDisplayName } from "@/lib/inbox/contact-name";
import { parseInboxQuery, viewFilterToQuery, type InboxQuery } from "@/lib/inbox/folders";
import {
  folderCounts,
  listConversations,
  listMessages,
  type ConversationListRow,
} from "@/lib/inbox/queries";
import { readInboxSettings } from "@/lib/inbox/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

import { InboxShell } from "./inbox-shell";
import type { ContactDetail, InboxProps, MergeSuggestion, SidebarData } from "./types";

export const metadata = { title: "Inbox" };
export const dynamic = "force-dynamic";

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const member = await requireMember();
  const params = await searchParams;
  const supabase = await createClient();
  const admin = createAdminClient();

  const [
    { data: myTeams },
    { data: teams },
    { data: channels },
    { data: labels },
    { data: categories },
    { data: views },
    { data: quickReplies },
    { data: templates },
    { data: members },
    { data: org },
    { data: shortcuts },
  ] = await Promise.all([
    supabase
      .from("team_members")
      .select("team_id")
      .eq("org_id", member.orgId)
      .eq("user_id", member.userId),
    supabase.from("teams").select("id, name, round_robin").eq("org_id", member.orgId).order("name"),
    supabase
      .from("channels")
      .select("id, name, display_phone, status")
      .eq("org_id", member.orgId)
      .order("created_at"),
    supabase
      .from("tags")
      .select("id, name, color")
      .eq("org_id", member.orgId)
      .eq("scope", "conversation")
      .order("name"),
    supabase
      .from("conv_categories")
      .select("id, name")
      .eq("org_id", member.orgId)
      .order("sort")
      .order("name"),
    supabase
      .from("inbox_views")
      .select("id, name, owner_id, filter, shared_all, shared_team_ids")
      .eq("org_id", member.orgId)
      .order("sort")
      .order("name"),
    supabase
      .from("quick_replies")
      .select("id, shortcut, text")
      .eq("org_id", member.orgId)
      .order("shortcut"),
    supabase
      .from("wa_templates")
      .select("id, name, language, category, status, channel_id, components, variable_map")
      .eq("org_id", member.orgId)
      .eq("status", "APPROVED")
      .is("archived_at", null)
      .order("name"),
    supabase
      .from("memberships")
      .select(
        "user_id, presence, profiles:profiles!memberships_user_id_fkey(first_name, last_name, email)",
      )
      .eq("org_id", member.orgId)
      .eq("status", "active"),
    supabase.from("orgs").select("settings").eq("id", member.orgId).single(),
    supabase
      .from("flows")
      .select("id, name, channel_id, trigger_config")
      .eq("org_id", member.orgId)
      .eq("status", "active")
      .eq("trigger_type", "shortcut")
      .gte("version", 1)
      .order("name"),
  ]);

  const teamIds = (myTeams ?? []).map((t) => t.team_id);
  const ctx = { userId: member.userId, orgId: member.orgId, teamIds };

  let query: InboxQuery = parseInboxQuery(params);
  if (query.view) {
    const v = (views ?? []).find((x) => x.id === query.view);
    if (v) query = { ...viewFilterToQuery(v.filter), view: v.id };
  }

  const selectedId = typeof params.c === "string" ? params.c : null;
  const [conversations, counts, selectedRow] = await Promise.all([
    listConversations(supabase, query, ctx),
    folderCounts(
      supabase,
      ctx,
      (teams ?? []).map((t) => t.id),
    ),
    selectedId
      ? supabase
          .from("conversations")
          .select(
            "*, contacts(*), channels(id, name, display_phone), conversation_labels(tag_id, tags(id, name, color))",
          )
          .eq("id", selectedId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  let selected: InboxProps["selected"] = null;
  let messages: InboxProps["messages"] = [];
  let sidebar: SidebarData | null = null;
  const sel = selectedRow?.data;
  if (sel && sel.contacts) {
    const c = sel.contacts;
    const contact: ContactDetail = {
      id: c.id,
      first_name: c.first_name,
      last_name: c.last_name,
      wa_profile_name: c.wa_profile_name,
      phone_e164: c.phone_e164,
      wa_bsuid: c.wa_bsuid,
      email: c.email,
      gender: c.gender,
      nationality: c.nationality,
      language: c.language,
      dob: c.dob,
      source: c.source,
      promotions_opt_in: c.promotions_opt_in,
      stop_marketing: c.stop_marketing,
      last_interaction_at: c.last_interaction_at,
      created_at: c.created_at,
    };
    selected = { ...(sel as unknown as ConversationListRow), contact };
    const [msgs, media, sameName, others] = await Promise.all([
      listMessages(supabase, sel.id),
      supabase
        .from("messages")
        .select("id, kind, media_path, media_mime, media_filename, at, body")
        .eq("conversation_id", sel.id)
        .not("media_path", "is", null)
        .order("at", { ascending: false })
        .limit(60),
      c.first_name || c.last_name
        ? admin
            .from("contacts")
            .select("id, first_name, last_name, wa_profile_name, phone_e164")
            .eq("org_id", member.orgId)
            .is("deleted_at", null)
            .neq("id", c.id)
            .ilike("first_name", c.first_name || "~")
            .ilike("last_name", c.last_name || "~")
            .limit(5)
        : Promise.resolve({ data: [] }),
      supabase
        .from("conversations")
        .select("id, status, last_message_at, channels(name)")
        .eq("contact_id", c.id)
        .neq("id", sel.id)
        .order("last_message_at", { ascending: false })
        .limit(10),
    ]);
    messages = msgs;
    const merge: MergeSuggestion[] = (sameName.data ?? []).map((d) => ({
      id: d.id,
      name: contactDisplayName(d),
      phone: d.phone_e164,
      reason: "same name",
    }));
    if (c.phone_e164) {
      const { data: byAlt } = await admin
        .from("contact_phones")
        .select("contact_id, contacts(id, first_name, last_name, wa_profile_name, phone_e164)")
        .eq("org_id", member.orgId)
        .eq("phone_e164", c.phone_e164)
        .neq("contact_id", c.id)
        .limit(5);
      for (const row of byAlt ?? []) {
        if (row.contacts && !merge.some((m) => m.id === row.contacts!.id))
          merge.push({
            id: row.contacts.id,
            name: contactDisplayName(row.contacts),
            phone: row.contacts.phone_e164,
            reason: "same phone (alternate)",
          });
      }
    }
    sidebar = {
      media: (media.data ?? []).map((m) => ({
        ...m,
        conversation_id: sel.id,
        direction: "in",
        payload: null,
        wa_message_id: null,
        reply_to_wa_message_id: null,
        status: "received",
        error_code: null,
        error_message: null,
        sent_by_user_id: null,
        profiles: null,
      })),
      merge,
      otherConversations: (others.data ?? []).map((o) => ({
        id: o.id,
        status: o.status,
        channel_name: o.channels?.name ?? "",
        last_message_at: o.last_message_at,
      })),
    };
  }

  const settings = readInboxSettings(org?.settings);
  const props: InboxProps = {
    orgId: member.orgId,
    me: {
      userId: member.userId,
      name:
        `${member.profile.first_name} ${member.profile.last_name}`.trim() ||
        member.user.email ||
        "Me",
    },
    perms: {
      send: can(member, "inbox.send"),
      viewAll: can(member, "inbox.view_all"),
      contactsManage: can(member, "contacts.manage"),
      appointmentsManage: can(member, "appointments.manage"),
      settings: can(member, "settings.manage"),
      enquiriesManage: can(member, "enquiries.manage"),
    },
    ai: { available: can(member, "ai.use") && readAiSettings(org?.settings).enabled },
    query,
    counts,
    teams: (teams ?? []).map((t) => ({ ...t, mine: teamIds.includes(t.id) })),
    channels: channels ?? [],
    labels: labels ?? [],
    categories: categories ?? [],
    views: (views ?? []).map((v) => ({ ...v, shared_team_ids: v.shared_team_ids ?? [] })),
    quickReplies: quickReplies ?? [],
    shortcuts: can(member, "inbox.send")
      ? (shortcuts ?? []).map((f) => ({
          id: f.id,
          name: f.name,
          channelId:
            ((f.trigger_config as { channel_id?: string } | null)?.channel_id ?? f.channel_id) ||
            null,
        }))
      : [],
    templates: (templates ?? []).map((t) => ({
      ...t,
      components: t.components as unknown as MetaTemplateComponent[],
      variable_map: (t.variable_map as Record<string, string>) ?? {},
    })),
    people: (members ?? []).map((m) => ({
      id: m.user_id,
      name:
        `${m.profiles?.first_name ?? ""} ${m.profiles?.last_name ?? ""}`.trim() ||
        m.profiles?.email ||
        "Member",
      presence: (m.presence as "online" | "away" | "offline") ?? "offline",
    })),
    settings: {
      require_category_on_close: settings.require_category_on_close,
      require_summary_on_close: settings.require_summary_on_close,
    },
    conversations,
    selected,
    messages,
    sidebar,
  };

  return <InboxShell {...props} />;
}
