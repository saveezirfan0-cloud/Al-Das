import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { loadCustomFields } from "@/lib/contacts/server";
import { enquiryFilterSchema } from "@/lib/enquiries/filter";
import { loadReferenceData } from "@/lib/enquiries/reference";
import { ensureDefaultPipelines, loadPipelines, orgEnquirySettings } from "@/lib/enquiries/service";
import { createAdminClient } from "@/lib/supabase/admin";

import type { GridPrefs } from "../contacts/actions";
import { EnquiriesWorkspace } from "./enquiries-workspace";
import type { EnquiriesBootstrap, SavedView } from "./types";

export const metadata = { title: "Enquiries" };

/** Sources people usually pick; extended with whatever is already in use. */
const COMMON_SOURCES = [
  "WhatsApp",
  "Phone call",
  "Walk-in",
  "Website",
  "Instagram",
  "Facebook",
  "Referral",
];

export default async function EnquiriesPage() {
  const member = await requirePerm("enquiries.view");
  const admin = createAdminClient();
  const manage = can(member, "enquiries.manage");
  if (manage) await ensureDefaultPipelines(admin, member.orgId);

  const [
    pipelines,
    ref,
    customFields,
    settings,
    { data: prefsRow },
    { data: sourceRows },
    { data: myTeams },
    { data: viewRows },
  ] = await Promise.all([
    loadPipelines(admin, member.orgId),
    loadReferenceData(admin, member.orgId),
    loadCustomFields(admin, member.orgId, "enquiry"),
    orgEnquirySettings(admin, member.orgId),
    admin
      .from("user_grid_prefs")
      .select("prefs")
      .eq("org_id", member.orgId)
      .eq("user_id", member.userId)
      .eq("grid_key", "enquiries")
      .maybeSingle(),
    admin
      .from("enquiries")
      .select("source")
      .eq("org_id", member.orgId)
      .not("source", "is", null)
      .limit(1000),
    admin
      .from("team_members")
      .select("team_id")
      .eq("org_id", member.orgId)
      .eq("user_id", member.userId),
    admin.from("enquiry_views").select("*").eq("org_id", member.orgId).order("name"),
  ]);

  const myTeamIds = new Set((myTeams ?? []).map((t) => t.team_id));
  const views: SavedView[] = (viewRows ?? [])
    .filter(
      (v) =>
        v.owner_id === member.userId ||
        v.shared_with_all ||
        v.shared_team_ids.some((t) => myTeamIds.has(t)),
    )
    .flatMap((v) => {
      const filter = enquiryFilterSchema.safeParse(v.filter);
      if (!filter.success) return [];
      return [
        {
          id: v.id,
          name: v.name,
          pipeline_id: v.pipeline_id,
          filter: filter.data,
          columns: Array.isArray(v.columns)
            ? v.columns.filter((c): c is string => typeof c === "string")
            : [],
          shared_team_ids: v.shared_team_ids,
          shared_with_all: v.shared_with_all,
          mine: v.owner_id === member.userId,
        },
      ];
    });

  const used = new Set((sourceRows ?? []).map((r) => r.source).filter((s): s is string => !!s));
  const sources = [...new Set([...COMMON_SOURCES, ...used])].sort((a, b) => a.localeCompare(b));

  const bootstrap: EnquiriesBootstrap = {
    orgId: member.orgId,
    userId: member.userId,
    timezone: member.org.timezone,
    slaHours: settings.sla_hours,
    can: {
      manage,
      tasks: can(member, "tasks.manage"),
      contacts: can(member, "contacts.view"),
      settings: can(member, "settings.manage"),
    },
    pipelines,
    ...ref,
    customFields,
    sources,
    views,
    gridPrefs: (prefsRow?.prefs as GridPrefs | null) ?? null,
  };
  return <EnquiriesWorkspace bootstrap={bootstrap} />;
}
