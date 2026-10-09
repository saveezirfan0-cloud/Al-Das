import "server-only";

import type { CustomFieldDef } from "@/lib/contacts/custom-values";
import { loadCustomFields } from "@/lib/contacts/server";
import { DEFAULT_CARD_FIELDS } from "@/lib/enquiries/constants";
import { buildEnquiryFieldRegistry } from "@/lib/enquiries/registry";
import { readEnquirySettings, type EnquirySettings } from "@/lib/enquiries/settings";
import type { FieldRegistry } from "@/lib/filters/field-registry";
import type { AdminClient } from "@/lib/supabase/admin";

export type StageInfo = { id: string; name: string; color: string; sort: number };
export type PipelineInfo = {
  id: string;
  name: string;
  sort: number;
  card_fields: string[];
  sla_minutes: number | null;
  is_default: boolean;
  archived: boolean;
  stages: StageInfo[];
};
export type NamedOption = { id: string; name: string };
/** Phase 6 lists carry an `active` flag: inactive entries stay on old enquiries but are not offered for new choices. */
export type ActiveOption = NamedOption & { active: boolean };
export type Lookups = {
  locations: ActiveOption[];
  departments: ActiveOption[];
  services: Array<ActiveOption & { department_id: string | null }>;
  specialists: Array<ActiveOption & { department_id: string | null }>;
  channels: NamedOption[];
};
export type OrgUser = { id: string; label: string };
export type TeamInfo = { id: string; name: string };

export type EnquiryContext = {
  customFields: CustomFieldDef[];
  registry: FieldRegistry;
  pipelines: PipelineInfo[];
  lookups: Lookups;
  users: OrgUser[];
  teams: TeamInfo[];
  settings: EnquirySettings;
};

export async function loadOrgUsers(admin: AdminClient, orgId: string): Promise<OrgUser[]> {
  const { data: members } = await admin
    .from("memberships")
    .select("user_id, profiles:profiles!memberships_user_id_fkey(first_name, last_name, email)")
    .eq("org_id", orgId)
    .eq("status", "active");
  return (members ?? [])
    .map((m) => ({
      id: m.user_id,
      label:
        `${m.profiles?.first_name ?? ""} ${m.profiles?.last_name ?? ""}`.trim() ||
        m.profiles?.email ||
        m.user_id,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export async function loadPipelines(admin: AdminClient, orgId: string): Promise<PipelineInfo[]> {
  const [{ data: pipelines }, { data: stages }] = await Promise.all([
    admin.from("pipelines").select("*").eq("org_id", orgId).order("sort").order("name"),
    admin
      .from("stages")
      .select("id, pipeline_id, name, color, sort")
      .eq("org_id", orgId)
      .order("sort")
      .order("created_at"),
  ]);
  return (pipelines ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    sort: p.sort,
    card_fields: p.card_fields?.length ? p.card_fields : [...DEFAULT_CARD_FIELDS],
    sla_minutes: p.sla_minutes,
    is_default: p.is_default,
    archived: !!p.archived_at,
    stages: (stages ?? [])
      .filter((s) => s.pipeline_id === p.id)
      .map(({ id, name, color, sort }) => ({ id, name, color, sort })),
  }));
}

export async function loadLookups(admin: AdminClient, orgId: string): Promise<Lookups> {
  const [locations, departments, services, specialists, channels] = await Promise.all([
    admin.from("locations").select("id, name, active").eq("org_id", orgId).order("name"),
    admin.from("departments").select("id, name, active").eq("org_id", orgId).order("name"),
    admin
      .from("services")
      .select("id, name, department_id, active")
      .eq("org_id", orgId)
      .order("name"),
    admin
      .from("specialists")
      .select("id, name, department_id, active")
      .eq("org_id", orgId)
      .order("name"),
    admin.from("channels").select("id, name").eq("org_id", orgId).order("name"),
  ]);
  return {
    locations: locations.data ?? [],
    departments: departments.data ?? [],
    services: services.data ?? [],
    specialists: specialists.data ?? [],
    channels: channels.data ?? [],
  };
}

/** Everything the Enquiries screens and actions need to interpret filters, fields and dropdowns. */
export async function loadEnquiryContext(
  admin: AdminClient,
  orgId: string,
): Promise<EnquiryContext> {
  const [customFields, pipelines, lookups, users, { data: teams }, { data: org }] =
    await Promise.all([
      loadCustomFields(admin, orgId, "enquiry"),
      loadPipelines(admin, orgId),
      loadLookups(admin, orgId),
      loadOrgUsers(admin, orgId),
      admin.from("teams").select("id, name").eq("org_id", orgId).order("name"),
      admin.from("orgs").select("settings").eq("id", orgId).single(),
    ]);
  return {
    customFields,
    registry: buildEnquiryFieldRegistry({
      customFields: customFields.map((f) => ({
        key: f.key,
        label: f.label,
        type: f.type,
        options: f.options,
      })),
    }),
    pipelines,
    lookups,
    users,
    teams: teams ?? [],
    settings: readEnquirySettings(org?.settings),
  };
}

export type EnquiryViewSummary = {
  id: string;
  name: string;
  owner_id: string;
  pipeline_id: string | null;
  mode: "kanban" | "table";
  filter: unknown;
  columns: string[];
  shared_all: boolean;
  shared_team_ids: string[];
  mine: boolean;
};

/** Views the user can see: their own, shared with everyone, or shared with one of their teams. */
export async function loadEnquiryViews(
  admin: AdminClient,
  orgId: string,
  userId: string,
): Promise<EnquiryViewSummary[]> {
  const [{ data: views }, { data: myTeams }] = await Promise.all([
    admin.from("enquiry_views").select("*").eq("org_id", orgId).order("sort").order("name"),
    admin.from("team_members").select("team_id").eq("org_id", orgId).eq("user_id", userId),
  ]);
  const teamIds = new Set((myTeams ?? []).map((t) => t.team_id));
  return (views ?? [])
    .filter(
      (v) => v.owner_id === userId || v.shared_all || v.shared_team_ids.some((t) => teamIds.has(t)),
    )
    .map((v) => ({
      id: v.id,
      name: v.name,
      owner_id: v.owner_id,
      pipeline_id: v.pipeline_id,
      mode: v.mode as "kanban" | "table",
      filter: v.filter,
      columns: Array.isArray(v.columns) ? (v.columns as string[]) : [],
      shared_all: v.shared_all,
      shared_team_ids: v.shared_team_ids,
      mine: v.owner_id === userId,
    }));
}
