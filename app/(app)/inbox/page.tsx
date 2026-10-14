import { readAiSettings } from "@/lib/ai/settings";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { allowedLocations } from "@/lib/branches/access";
import { accessFilterIds, withBranchFilter } from "@/lib/branches/filter";
import { branchView } from "@/lib/branches/server";
import { formatCardTime, loadPatientCard } from "@/lib/front-desk/server";
import { loadDeskOptions } from "@/lib/front-desk/options";
import { quickReplyAppointmentValues } from "@/lib/front-desk/patient-card";
import { contactDisplayName } from "@/lib/inbox/contact-name";
import type { QuickReplyContext } from "@/lib/inbox/quick-reply";
import {
  inboxBranchIds,
  parseInboxQuery,
  viewFilterToQuery,
  type InboxQuery,
} from "@/lib/inbox/folders";
import {
  folderCounts,
  listConversationsPage,
  listMessagesPage,
  type ConversationListRow,
} from "@/lib/inbox/queries";
import { readInboxSettings } from "@/lib/inbox/settings";
import { recordAccess } from "@/lib/security/access-log";
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
    { data: locations },
  ] = await Promise.all([
    supabase
      .from("team_members")
      .select("team_id")
      .eq("org_id", member.orgId)
      .eq("user_id", member.userId),
    supabase.from("teams").select("id, name, round_robin").eq("org_id", member.orgId).order("name"),
    supabase
      .from("channels")
      .select("id, name, display_phone, status, type, catalog_id")
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
      .select(
        "id, shortcut, text, text_ar, label, media_asset_id, media_assets(id, name, kind, scan_status, status)",
      )
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
    // Phase B: branch names for the filter and the row chips (names only).
    admin
      .from("locations")
      .select("id, name")
      .eq("org_id", member.orgId)
      .eq("active", true)
      .order("name"),
  ]);

  const teamIds = (myTeams ?? []).map((t) => t.team_id);

  let query: InboxQuery = parseInboxQuery(params);
  if (query.view) {
    const v = (views ?? []).find((x) => x.id === query.view);
    if (v) query = { ...viewFilterToQuery(v.filter), view: v.id };
  }
  // Phase B: the list follows the branch switcher unless a branch is chosen in the filter (or a saved view).
  const branchList = locations ?? [];
  const branch = await branchView(
    member,
    branchList.map((l) => l.id),
  );
  const ctx = {
    userId: member.userId,
    orgId: member.orgId,
    teamIds,
    branchIds: inboxBranchIds(query.branch, branch),
  };

  const selectedId = typeof params.c === "string" ? params.c : null;
  const [{ rows: conversations, nextCursor: conversationsCursor }, counts, selectedRow] =
    await Promise.all([
      listConversationsPage(supabase, query, ctx),
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

  // The conversation list is a patient list too: sampled, like the other list screens.
  await recordAccess(admin, member, {
    entity: "conversation",
    action: "list",
    detail: { rows: conversations.length },
  });

  let selected: InboxProps["selected"] = null;
  let messages: InboxProps["messages"] = [];
  let messagesCursor: string | null = null;
  let sidebar: SidebarData | null = null;
  let quickReplyContext: QuickReplyContext = {
    agent_name: `${member.profile.first_name} ${member.profile.last_name}`.trim() || null,
    clinic_name: member.org.name,
  };
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
    // Opening a conversation shows the patient's messages: always logged (id only).
    await recordAccess(admin, member, { entity: "conversation", entityId: sel.id, action: "view" });
    const [msgs, media, sameName, others] = await Promise.all([
      listMessagesPage(supabase, sel.id),
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
    messages = msgs.messages;
    messagesCursor = msgs.nextCursor;
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
    // Family members are not duplicates of each other: a guardian, her dependants and their siblings.
    const { data: household } = await admin
      .from("household_links")
      .select("guardian_contact_id, dependant_contact_id")
      .eq("org_id", member.orgId)
      .or(`guardian_contact_id.eq.${c.id},dependant_contact_id.eq.${c.id}`);
    const family = new Set<string>();
    for (const l of household ?? []) {
      family.add(l.guardian_contact_id);
      family.add(l.dependant_contact_id);
      if (l.dependant_contact_id === c.id) {
        const { data: siblings } = await admin
          .from("household_links")
          .select("dependant_contact_id")
          .eq("org_id", member.orgId)
          .eq("guardian_contact_id", l.guardian_contact_id);
        for (const sib of siblings ?? []) family.add(sib.dependant_contact_id);
      }
    }
    family.delete(c.id);
    for (let i = merge.length - 1; i >= 0; i--) if (family.has(merge[i].id)) merge.splice(i, 1);

    // Front desk screen pop: the patient card beside the conversation (only for people who use the desk).
    const showDesk = can(member, "frontdesk.use") && can(member, "appointments.view");
    const tz = member.org.timezone || "Asia/Dubai";
    // Phase B: the card and the desk dialogs keep to the branches this member may work in.
    const card = showDesk
      ? await loadPatientCard(admin, member.orgId, c.id, new Date(), accessFilterIds(branch.access))
      : null;
    const desk = showDesk
      ? {
          card,
          options: await loadDeskOptions(admin, member.orgId, tz, {
            access: branch.access,
            current: branch.current,
          }),
          can: {
            appointments: can(member, "appointments.manage"),
            contacts: can(member, "contacts.manage"),
            tasks: can(member, "tasks.manage"),
            send: can(member, "inbox.send"),
          },
        }
      : null;
    const apptValues = quickReplyAppointmentValues(
      card?.next_appointment ??
        (await nextAppointmentForReplies(
          admin,
          member.orgId,
          c.id,
          accessFilterIds(branch.access),
        )),
      (iso) => formatCardTime(iso, tz),
    );
    quickReplyContext = {
      first_name: c.first_name || null,
      last_name: c.last_name || null,
      full_name: [c.first_name, c.last_name].filter(Boolean).join(" ") || null,
      agent_name: `${member.profile.first_name} ${member.profile.last_name}`.trim() || null,
      clinic_name: member.org.name,
      ...apptValues,
    };

    sidebar = {
      desk,
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
      media: can(member, "media.view") || can(member, "media.manage"),
    },
    ai: { available: can(member, "ai.use") && readAiSettings(org?.settings).enabled },
    query,
    counts,
    teams: (teams ?? []).map((t) => ({ ...t, mine: teamIds.includes(t.id) })),
    channels: (channels ?? []).map(({ catalog_id, ...c }) => ({ ...c, has_catalog: !!catalog_id })),
    labels: labels ?? [],
    categories: categories ?? [],
    views: (views ?? []).map((v) => ({ ...v, shared_team_ids: v.shared_team_ids ?? [] })),
    quickReplies: (quickReplies ?? []).map((q) => ({
      id: q.id,
      shortcut: q.shortcut,
      text: q.text,
      text_ar: q.text_ar,
      label: q.label,
      // A file that is still uploading, or was blocked by the scan, is not offered with the reply.
      media:
        q.media_assets &&
        q.media_assets.status === "ready" &&
        q.media_assets.scan_status !== "infected" &&
        (q.media_assets.kind === "image" ||
          q.media_assets.kind === "video" ||
          q.media_assets.kind === "document")
          ? { id: q.media_assets.id, name: q.media_assets.name, kind: q.media_assets.kind }
          : null,
    })),
    quickReplyContext,
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
    branches: allowedLocations(branchList, branch.access),
    branchNames: Object.fromEntries(branchList.map((l) => [l.id, l.name])),
    currentBranch: branch.current,
    conversations,
    conversationsCursor,
    selected,
    messages,
    messagesCursor,
    sidebar,
  };

  return <InboxShell {...props} />;
}

/**
 * Next live appointment of a patient, for {{doctor}} / {{appointment_time}} when the desk card is not loaded. Phase B:
 * only in the branches this member may see (service role, so the rule is applied here like RLS would).
 */
async function nextAppointmentForReplies(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  contactId: string,
  branchIds: string[] | null,
) {
  const query = admin
    .from("appointments")
    .select("starts_at, specialists(name), locations(name)")
    .eq("org_id", orgId)
    .eq("contact_id", contactId)
    .in("status", ["awaiting", "confirmed"])
    .gte("starts_at", new Date().toISOString());
  const { data } = await withBranchFilter(query, branchIds)
    .order("starts_at")
    .limit(1)
    .maybeSingle();
  const row = data as unknown as {
    starts_at: string;
    specialists: { name: string } | null;
    locations: { name: string } | null;
  } | null;
  return row
    ? {
        starts_at: row.starts_at,
        specialist_name: row.specialists?.name ?? null,
        location_name: row.locations?.name ?? null,
      }
    : null;
}
