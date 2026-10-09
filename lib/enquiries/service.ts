import "server-only";

import { coerceCustomObject, formatCustomValue } from "@/lib/contacts/custom-values";
import { loadCustomFields } from "@/lib/contacts/server";
import { addTimelineEvent } from "@/lib/contacts/timeline";
import { decideAssignment } from "@/lib/enquiries/assignment";
import {
  isCardField,
  isSortable,
  type CardFieldKey,
  type SortableColumn,
} from "@/lib/enquiries/columns";
import { DEFAULT_PIPELINES } from "@/lib/enquiries/defaults";
import { describeActivity, type ExportRow } from "@/lib/enquiries/export";
import {
  applyClauses,
  filterToClauses,
  searchExpression,
  searchTerm,
  type LooseQuery,
  type EnquiryFilter,
} from "@/lib/enquiries/filter";
import type { BulkPatch, CreateEnquiryInput, UpdateEnquiryInput } from "@/lib/enquiries/schemas";
import { readEnquirySettings } from "@/lib/enquiries/settings";
import { isEnquiryStatus, validateStatusChange, type EnquiryStatus } from "@/lib/enquiries/status";
import type { BoardColumn, EnquiryRow, PipelineView, TimelineItem } from "@/lib/enquiries/types";
import { emit } from "@/lib/events/emit";
import { contactDisplayName } from "@/lib/inbox/contact-name";
import { createNotification, notifyMembersWithPermission } from "@/lib/notifications";
import { redactText } from "@/lib/redact";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json, TablesUpdate } from "@/lib/supabase/types";

export type Actor = { orgId: string; userId: string };
export type Result<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** Maps a database error to a message safe to show; details go to the log, redacted. */
function dbFail(
  err: { code?: string; message?: string } | null,
  fallback: string,
): { ok: false; error: string } {
  if (err?.code === "23514")
    return fail("That choice does not belong to this workspace or pipeline.");
  if (err?.code === "23503") return fail("A referenced record no longer exists.");
  console.error("[enquiries]", err?.code, redactText(err?.message));
  return fail(fallback);
}

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

/** First visit: create the clinic's default queues. Idempotent (unique on org + name). */
export async function ensureDefaultPipelines(admin: AdminClient, orgId: string): Promise<void> {
  const { count } = await admin
    .from("pipelines")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId);
  if ((count ?? 0) > 0) return;
  const { data: created } = await admin
    .from("pipelines")
    .upsert(
      DEFAULT_PIPELINES.map((p, i) => ({
        org_id: orgId,
        name: p.name,
        sort: (i + 1) * 10,
        card_fields: p.card_fields,
      })),
      { onConflict: "org_id,name", ignoreDuplicates: true },
    )
    .select("id, name");
  const byName = new Map((created ?? []).map((p) => [p.name, p.id]));
  const stages = DEFAULT_PIPELINES.flatMap((p) => {
    const pipelineId = byName.get(p.name);
    return pipelineId
      ? p.stages.map((s, i) => ({
          org_id: orgId,
          pipeline_id: pipelineId,
          name: s.name,
          color: s.color,
          sort: (i + 1) * 10,
        }))
      : [];
  });
  if (stages.length)
    await admin
      .from("stages")
      .upsert(stages, { onConflict: "pipeline_id,name", ignoreDuplicates: true });
}

export async function loadPipelines(admin: AdminClient, orgId: string): Promise<PipelineView[]> {
  const [{ data: pipelines }, { data: stages }] = await Promise.all([
    admin.from("pipelines").select("*").eq("org_id", orgId).order("sort").order("name"),
    admin.from("stages").select("*").eq("org_id", orgId).order("sort"),
  ]);
  return (pipelines ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    sort: p.sort,
    card_fields: (p.card_fields ?? []).filter(isCardField) as CardFieldKey[],
    default_team_id: p.default_team_id,
    archived: !!p.archived_at,
    stages: (stages ?? [])
      .filter((s) => s.pipeline_id === p.id)
      .map((s) => ({ id: s.id, name: s.name, color: s.color, sort: s.sort })),
  }));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const ROW_SELECT =
  "id, number, title, status, lost_reason, pipeline_id, stage_id, contact_id, assignee_id, source, channel_id, location_id, department_id, specialist_id, service_id, appointment_at, est_value, custom, stage_entered_at, created_at, closed_at, " +
  "contacts(first_name, last_name, wa_profile_name, phone_e164), pipelines(name), stages(name, color), " +
  "assignee:profiles!enquiries_assignee_id_fkey(first_name, last_name, email), creator:profiles!enquiries_created_by_fkey(first_name, last_name, email), " +
  "channels(name), locations(name), departments(name), specialists(name), services(name)";

type NameOnly = { name: string } | null;
type ProfileLite = { first_name: string; last_name: string; email: string | null } | null;
type RawRow = {
  id: string;
  number: number;
  title: string;
  status: string;
  lost_reason: string | null;
  pipeline_id: string;
  stage_id: string;
  contact_id: string | null;
  assignee_id: string | null;
  source: string | null;
  channel_id: string | null;
  location_id: string | null;
  department_id: string | null;
  specialist_id: string | null;
  service_id: string | null;
  appointment_at: string | null;
  est_value: number | null;
  custom: Json;
  stage_entered_at: string;
  created_at: string;
  closed_at: string | null;
  contacts: {
    first_name: string | null;
    last_name: string | null;
    wa_profile_name: string | null;
    phone_e164: string | null;
  } | null;
  pipelines: NameOnly;
  stages: { name: string; color: string } | null;
  assignee: ProfileLite;
  creator: ProfileLite;
  channels: NameOnly;
  locations: NameOnly;
  departments: NameOnly;
  specialists: NameOnly;
  services: NameOnly;
};

function personName(p: ProfileLite): string {
  if (!p) return "";
  return `${p.first_name} ${p.last_name}`.trim() || (p.email ?? "");
}

function toRow(r: RawRow): EnquiryRow {
  return {
    id: r.id,
    number: Number(r.number),
    title: r.title,
    status: isEnquiryStatus(r.status) ? r.status : "open",
    lost_reason: r.lost_reason,
    pipeline_id: r.pipeline_id,
    pipeline_name: r.pipelines?.name ?? "",
    stage_id: r.stage_id,
    stage_name: r.stages?.name ?? "",
    stage_color: r.stages?.color ?? "slate",
    contact_id: r.contact_id,
    patient: r.contacts ? contactDisplayName(r.contacts) : "",
    phone: r.contacts?.phone_e164 ?? null,
    assignee_id: r.assignee_id,
    assignee_name: personName(r.assignee),
    source: r.source,
    channel_id: r.channel_id,
    channel_name: r.channels?.name ?? "",
    location_id: r.location_id,
    location_name: r.locations?.name ?? "",
    department_id: r.department_id,
    department_name: r.departments?.name ?? "",
    specialist_id: r.specialist_id,
    specialist_name: r.specialists?.name ?? "",
    service_id: r.service_id,
    service_name: r.services?.name ?? "",
    appointment_at: r.appointment_at,
    est_value: r.est_value === null ? null : Number(r.est_value),
    custom:
      r.custom && typeof r.custom === "object" && !Array.isArray(r.custom)
        ? (r.custom as Record<string, unknown>)
        : {},
    stage_entered_at: r.stage_entered_at,
    created_at: r.created_at,
    closed_at: r.closed_at,
    created_by_name: personName(r.creator),
  };
}

/** Contacts matching the search box (name, profile name or phone digits), for the enquiry search. */
async function searchContactIds(
  admin: AdminClient,
  orgId: string,
  term: string,
): Promise<string[]> {
  const t = searchTerm(term);
  if (!t) return [];
  const digits = t.replace(/\D/g, "");
  const parts = [
    `first_name.ilike.%${t}%`,
    `last_name.ilike.%${t}%`,
    `wa_profile_name.ilike.%${t}%`,
  ];
  if (digits.length >= 4) parts.push(`phone_e164.ilike.%${digits}%`);
  const { data } = await admin
    .from("contacts")
    .select("id")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .or(parts.join(","))
    .limit(100);
  return (data ?? []).map((c) => c.id);
}

async function filteredQuery(
  admin: AdminClient,
  actor: Actor,
  filter: EnquiryFilter,
  count: boolean,
) {
  let q = admin
    .from("enquiries")
    .select<string, RawRow>(ROW_SELECT, count ? { count: "exact" } : undefined)
    .eq("org_id", actor.orgId);
  q = applyClauses(
    q as unknown as LooseQuery,
    filterToClauses(filter, { userId: actor.userId }),
  ) as unknown as typeof q;
  if (filter.search) {
    const ids = await searchContactIds(admin, actor.orgId, filter.search);
    const expr = searchExpression(filter.search, ids);
    if (expr) q = q.or(expr);
  }
  // Wrapped on purpose: an async function that returns a query builder would await (run) it.
  return { query: q };
}

export type ListOptions = { page: number; pageSize: number; sort?: string; dir?: "asc" | "desc" };

/** One page of the table view. */
export async function listEnquiries(
  admin: AdminClient,
  actor: Actor,
  filter: EnquiryFilter,
  opts: ListOptions,
): Promise<{ rows: EnquiryRow[]; total: number }> {
  const sort: SortableColumn = isSortable(opts.sort) ? opts.sort : "created_at";
  const pageSize = Math.min(Math.max(opts.pageSize, 1), 200);
  const from = Math.max(opts.page, 0) * pageSize;
  const { query: q } = await filteredQuery(admin, actor, filter, true);
  const { data, count, error } = await q
    .order(sort, { ascending: opts.dir === "asc", nullsFirst: false })
    .order("id")
    .range(from, from + pageSize - 1);
  if (error) {
    console.error("[enquiries] list failed", error.code, redactText(error.message));
    return { rows: [], total: 0 };
  }
  return { rows: ((data ?? []) as unknown as RawRow[]).map(toRow), total: count ?? 0 };
}

export const BOARD_PAGE = 50;

/** Kanban data: for each stage of a pipeline, the total and the first page of cards. */
export async function boardColumns(
  admin: AdminClient,
  actor: Actor,
  filter: EnquiryFilter,
  stageIds: string[],
  offsets: Record<string, number> = {},
): Promise<BoardColumn[]> {
  return Promise.all(
    stageIds.map(async (stageId) => {
      const q = (await filteredQuery(admin, actor, filter, true)).query.eq("stage_id", stageId);
      const from = offsets[stageId] ?? 0;
      const { data, count, error } = await q
        .order("created_at", { ascending: false })
        .order("id")
        .range(from, from + BOARD_PAGE - 1);
      if (error) console.error("[enquiries] board failed", error.code, redactText(error.message));
      return {
        stage_id: stageId,
        total: count ?? 0,
        rows: ((data ?? []) as unknown as RawRow[]).map(toRow),
      };
    }),
  );
}

export async function getEnquiry(
  admin: AdminClient,
  orgId: string,
  id: string,
): Promise<EnquiryRow | null> {
  const { data } = await admin
    .from("enquiries")
    .select<string, RawRow>(ROW_SELECT)
    .eq("org_id", orgId)
    .eq("id", id)
    .maybeSingle();
  return data ? toRow(data as unknown as RawRow) : null;
}

export async function enquiriesForContact(
  admin: AdminClient,
  orgId: string,
  contactId: string,
): Promise<EnquiryRow[]> {
  const { data } = await admin
    .from("enquiries")
    .select<string, RawRow>(ROW_SELECT)
    .eq("org_id", orgId)
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })
    .limit(50);
  return ((data ?? []) as unknown as RawRow[]).map(toRow);
}

/** Timeline of one enquiry (its own events only). */
export async function enquiryTimeline(
  admin: AdminClient,
  orgId: string,
  enquiryId: string,
): Promise<TimelineItem[]> {
  const { data } = await admin
    .from("timeline_events")
    .select("id, at, type, actor_type, actor_id, payload")
    .eq("org_id", orgId)
    .eq("enquiry_id", enquiryId)
    .order("at", { ascending: false })
    .limit(200);
  const actorIds = [
    ...new Set((data ?? []).map((e) => e.actor_id).filter((v): v is string => !!v)),
  ];
  const { data: profiles } = actorIds.length
    ? await admin.from("profiles").select("id, first_name, last_name, email").in("id", actorIds)
    : { data: [] };
  const names = new Map((profiles ?? []).map((p) => [p.id, personName(p)]));
  return (data ?? []).map((e) => ({
    id: e.id,
    at: e.at,
    type: e.type,
    actor: e.actor_id ? (names.get(e.actor_id) ?? "") : e.actor_type === "system" ? "System" : "",
    detail: describeActivity(e.type, e.payload),
  }));
}

/** Rows for CSV export (capped; callers have checked enquiries.manage). */
export const EXPORT_LIMIT = 5000;

export async function exportRows(
  admin: AdminClient,
  actor: Actor,
  filter: EnquiryFilter,
): Promise<{
  rows: ExportRow[];
  customLabels: Array<{ key: string; label: string }>;
  truncated: boolean;
}> {
  const defs = await loadCustomFields(admin, actor.orgId, "enquiry");
  const { query: q } = await filteredQuery(admin, actor, filter, true);
  const { data, count } = await q.order("number", { ascending: false }).range(0, EXPORT_LIMIT - 1);
  const rows = ((data ?? []) as unknown as RawRow[]).map(toRow);
  return {
    truncated: (count ?? 0) > EXPORT_LIMIT,
    customLabels: defs.map((d) => ({ key: d.key, label: d.label })),
    rows: rows.map((r) => ({
      number: r.number,
      title: r.title,
      patient: r.patient,
      phone: r.phone ?? "",
      pipeline: r.pipeline_name,
      stage: r.stage_name,
      status: r.status,
      reason: r.lost_reason ?? "",
      assignee: r.assignee_name,
      source: r.source ?? "",
      channel: r.channel_name,
      location: r.location_name,
      department: r.department_name,
      specialist: r.specialist_name,
      service: r.service_name,
      appointment_at: r.appointment_at ?? "",
      est_value: r.est_value === null ? "" : r.est_value.toFixed(2),
      created_at: r.created_at,
      closed_at: r.closed_at ?? "",
      created_by: r.created_by_name,
      custom: Object.fromEntries(defs.map((d) => [d.key, formatCustomValue(d, r.custom[d.key])])),
    })),
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

type Brief = {
  id: string;
  number: number;
  status: EnquiryStatus;
  lost_reason: string | null;
  pipeline_id: string;
  stage_id: string;
  contact_id: string | null;
  assignee_id: string | null;
  custom: Record<string, unknown>;
  pipeline_name: string;
  stage_name: string;
};

async function loadBrief(admin: AdminClient, orgId: string, id: string): Promise<Brief | null> {
  const { data } = await admin
    .from("enquiries")
    .select(
      "id, number, status, lost_reason, pipeline_id, stage_id, contact_id, assignee_id, custom, pipelines(name), stages(name)",
    )
    .eq("org_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (!data) return null;
  return {
    id: data.id,
    number: Number(data.number),
    status: isEnquiryStatus(data.status) ? data.status : "open",
    lost_reason: data.lost_reason,
    pipeline_id: data.pipeline_id,
    stage_id: data.stage_id,
    contact_id: data.contact_id,
    assignee_id: data.assignee_id,
    custom:
      data.custom && typeof data.custom === "object" && !Array.isArray(data.custom)
        ? (data.custom as Record<string, unknown>)
        : {},
    pipeline_name: data.pipelines?.name ?? "",
    stage_name: data.stages?.name ?? "",
  };
}

async function userName(admin: AdminClient, orgId: string, userId: string | null): Promise<string> {
  if (!userId) return "";
  const { data } = await admin
    .from("profiles")
    .select("first_name, last_name, email, memberships!inner(org_id)")
    .eq("id", userId)
    .eq("memberships.org_id", orgId)
    .maybeSingle();
  return data ? personName(data) : "";
}

async function isActiveMember(admin: AdminClient, orgId: string, userId: string): Promise<boolean> {
  const { data } = await admin
    .from("memberships")
    .select("user_id")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  return !!data;
}

async function timeline(
  admin: AdminClient,
  actor: Actor,
  brief: Pick<Brief, "id" | "contact_id">,
  type: string,
  payload: Record<string, unknown>,
) {
  if (!brief.contact_id) return;
  await addTimelineEvent(admin, {
    orgId: actor.orgId,
    contactId: brief.contact_id,
    enquiryId: brief.id,
    type,
    actorId: actor.userId,
    payload: payload as Json,
  });
}

async function notifyAssigned(admin: AdminClient, actor: Actor, brief: Brief, assigneeId: string) {
  if (assigneeId === actor.userId) return;
  const settings = await orgEnquirySettings(admin, actor.orgId);
  if (!settings.notifications.on_assigned) return;
  await createNotification(admin, {
    orgId: actor.orgId,
    userId: assigneeId,
    type: "enquiry.assigned",
    title: `Enquiry #${brief.number} was assigned to you`,
    body: brief.pipeline_name,
    payload: { enquiry_id: brief.id },
  });
}

export async function orgEnquirySettings(admin: AdminClient, orgId: string) {
  const { data } = await admin.from("orgs").select("settings").eq("id", orgId).maybeSingle();
  return readEnquirySettings(data?.settings);
}

async function firstStageId(
  admin: AdminClient,
  orgId: string,
  pipelineId: string,
): Promise<string | null> {
  const { data } = await admin
    .from("stages")
    .select("id")
    .eq("org_id", orgId)
    .eq("pipeline_id", pipelineId)
    .order("sort")
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

export async function createEnquiry(
  admin: AdminClient,
  actor: Actor,
  input: CreateEnquiryInput,
): Promise<Result<{ id: string; number: number }>> {
  const { data: pipeline } = await admin
    .from("pipelines")
    .select("id, name, default_team_id, archived_at")
    .eq("org_id", actor.orgId)
    .eq("id", input.pipeline_id)
    .maybeSingle();
  if (!pipeline || pipeline.archived_at) return fail("Choose an active pipeline.");

  const stageId = input.stage_id ?? (await firstStageId(admin, actor.orgId, pipeline.id));
  if (!stageId) return fail("This pipeline has no stages yet.");
  const { data: stage } = await admin
    .from("stages")
    .select("id, name")
    .eq("org_id", actor.orgId)
    .eq("pipeline_id", pipeline.id)
    .eq("id", stageId)
    .maybeSingle();
  if (!stage) return fail("That stage is not in this pipeline.");

  const { data: contact } = await admin
    .from("contacts")
    .select("id")
    .eq("org_id", actor.orgId)
    .eq("id", input.contact_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!contact) return fail("Choose a patient for this enquiry.");

  const defs = await loadCustomFields(admin, actor.orgId, "enquiry");
  const custom = coerceCustomObject(defs, input.custom ?? {});
  if (!custom.ok) return fail(Object.values(custom.errors)[0] ?? "Check the custom fields.");

  if (input.assignee_id && !(await isActiveMember(admin, actor.orgId, input.assignee_id)))
    return fail("That user is not an active member of this workspace.");

  const settings = await orgEnquirySettings(admin, actor.orgId);
  const decision = decideAssignment({
    requestedAssigneeId: input.assignee_id ?? null,
    creatorId: actor.userId,
    pipelineTeamId: pipeline.default_team_id,
    mode: settings.assignment.mode,
  });
  let assigneeId: string | null = null;
  if (decision.kind === "user") assigneeId = decision.userId;
  else if (decision.kind === "team_round_robin") {
    const { data } = await admin.rpc("pick_round_robin_assignee", {
      p_org_id: actor.orgId,
      p_team_id: decision.teamId,
    });
    assigneeId = typeof data === "string" ? data : null;
  }

  const { data: row, error } = await admin
    .from("enquiries")
    .insert({
      org_id: actor.orgId,
      pipeline_id: pipeline.id,
      stage_id: stage.id,
      contact_id: contact.id,
      title: input.title ?? "",
      source: input.source ?? null,
      channel_id: input.channel_id ?? null,
      location_id: input.location_id ?? null,
      department_id: input.department_id ?? null,
      specialist_id: input.specialist_id ?? null,
      service_id: input.service_id ?? null,
      appointment_at: input.appointment_at ?? null,
      est_value: input.est_value ?? null,
      assignee_id: assigneeId,
      custom: custom.value as NonNullable<Json>,
      created_by: actor.userId,
    })
    .select("id, number")
    .single();
  if (error || !row) return dbFail(error, "Could not create the enquiry.");

  const brief: Brief = {
    id: row.id,
    number: Number(row.number),
    status: "open",
    lost_reason: null,
    pipeline_id: pipeline.id,
    stage_id: stage.id,
    contact_id: contact.id,
    assignee_id: assigneeId,
    custom: custom.value,
    pipeline_name: pipeline.name,
    stage_name: stage.name,
  };
  await timeline(admin, actor, brief, "enquiry.created", {
    number: brief.number,
    pipeline: pipeline.name,
    stage: stage.name,
  });
  await emit(actor.orgId, "enquiry.created", {
    enquiry_id: row.id,
    contact_id: contact.id,
    pipeline_id: pipeline.id,
    stage_id: stage.id,
  });
  if (assigneeId) await notifyAssigned(admin, actor, brief, assigneeId);
  else if (settings.notifications.on_new_unassigned)
    await notifyMembersWithPermission(admin, actor.orgId, "enquiries.manage", {
      type: "enquiry.unassigned",
      title: `New unassigned enquiry #${brief.number}`,
      body: pipeline.name,
      payload: { enquiry_id: row.id },
    });
  return { ok: true, id: row.id, number: brief.number };
}

const DETAIL_KEYS = [
  "title",
  "source",
  "channel_id",
  "location_id",
  "department_id",
  "specialist_id",
  "service_id",
  "appointment_at",
  "est_value",
] as const;

export async function updateEnquiry(
  admin: AdminClient,
  actor: Actor,
  id: string,
  patch: UpdateEnquiryInput,
): Promise<Result> {
  const brief = await loadBrief(admin, actor.orgId, id);
  if (!brief) return fail("Enquiry not found.");

  const update: Record<string, unknown> = {};
  for (const k of DETAIL_KEYS) if (k in patch && patch[k] !== undefined) update[k] = patch[k];

  if (patch.custom !== undefined) {
    const defs = await loadCustomFields(admin, actor.orgId, "enquiry");
    const merged = coerceCustomObject(defs, { ...brief.custom, ...patch.custom });
    if (!merged.ok) return fail(Object.values(merged.errors)[0] ?? "Check the custom fields.");
    update.custom = merged.value;
  }

  const assigneeChanged =
    patch.assignee_id !== undefined && patch.assignee_id !== brief.assignee_id;
  if (assigneeChanged) {
    if (patch.assignee_id && !(await isActiveMember(admin, actor.orgId, patch.assignee_id)))
      return fail("That user is not an active member of this workspace.");
    update.assignee_id = patch.assignee_id;
  }
  if (!Object.keys(update).length) return { ok: true };

  const { error } = await admin
    .from("enquiries")
    .update(update as TablesUpdate<"enquiries">)
    .eq("org_id", actor.orgId)
    .eq("id", id);
  if (error) return dbFail(error, "Could not save the enquiry.");

  const changed = Object.keys(update).filter((k) => k !== "assignee_id");
  if (changed.length) await timeline(admin, actor, brief, "enquiry.updated", { fields: changed });
  if (assigneeChanged) {
    const name = await userName(admin, actor.orgId, patch.assignee_id ?? null);
    await timeline(admin, actor, brief, "enquiry.assigned", {
      assignee: name,
      assignee_id: patch.assignee_id ?? null,
    });
    await emit(actor.orgId, "enquiry.assigned", {
      enquiry_id: id,
      assignee_id: patch.assignee_id ?? null,
      previous: brief.assignee_id,
    });
    if (patch.assignee_id) await notifyAssigned(admin, actor, brief, patch.assignee_id);
  }
  return { ok: true };
}

export async function moveStage(
  admin: AdminClient,
  actor: Actor,
  id: string,
  stageId: string,
): Promise<Result> {
  const brief = await loadBrief(admin, actor.orgId, id);
  if (!brief) return fail("Enquiry not found.");
  if (brief.stage_id === stageId) return { ok: true };
  const { data: stage } = await admin
    .from("stages")
    .select("id, name")
    .eq("org_id", actor.orgId)
    .eq("pipeline_id", brief.pipeline_id)
    .eq("id", stageId)
    .maybeSingle();
  if (!stage) return fail("That stage is not in this pipeline.");

  const { error } = await admin
    .from("enquiries")
    .update({ stage_id: stage.id })
    .eq("org_id", actor.orgId)
    .eq("id", id);
  if (error) return dbFail(error, "Could not move the enquiry.");

  await timeline(admin, actor, brief, "enquiry.stage_changed", {
    from_stage: brief.stage_name,
    to_stage: stage.name,
  });
  await emit(actor.orgId, "enquiry.stage_changed", {
    enquiry_id: id,
    from_stage_id: brief.stage_id,
    to_stage_id: stage.id,
    pipeline_id: brief.pipeline_id,
  });
  if (brief.assignee_id && brief.assignee_id !== actor.userId) {
    const settings = await orgEnquirySettings(admin, actor.orgId);
    if (settings.notifications.on_stage_change)
      await createNotification(admin, {
        orgId: actor.orgId,
        userId: brief.assignee_id,
        type: "enquiry.stage_changed",
        title: `Enquiry #${brief.number} moved to ${stage.name}`,
        body: brief.pipeline_name,
        payload: { enquiry_id: id },
      });
  }
  return { ok: true };
}

export async function moveToPipeline(
  admin: AdminClient,
  actor: Actor,
  id: string,
  pipelineId: string,
  stageId?: string,
): Promise<Result> {
  const brief = await loadBrief(admin, actor.orgId, id);
  if (!brief) return fail("Enquiry not found.");
  if (brief.pipeline_id === pipelineId)
    return stageId ? moveStage(admin, actor, id, stageId) : { ok: true };
  const { data: pipeline } = await admin
    .from("pipelines")
    .select("id, name, archived_at")
    .eq("org_id", actor.orgId)
    .eq("id", pipelineId)
    .maybeSingle();
  if (!pipeline || pipeline.archived_at) return fail("Choose an active pipeline.");
  const targetStage = stageId ?? (await firstStageId(admin, actor.orgId, pipeline.id));
  if (!targetStage) return fail("That pipeline has no stages yet.");
  const { data: stage } = await admin
    .from("stages")
    .select("id, name")
    .eq("org_id", actor.orgId)
    .eq("pipeline_id", pipeline.id)
    .eq("id", targetStage)
    .maybeSingle();
  if (!stage) return fail("That stage is not in the chosen pipeline.");

  const { error } = await admin
    .from("enquiries")
    .update({ pipeline_id: pipeline.id, stage_id: stage.id })
    .eq("org_id", actor.orgId)
    .eq("id", id);
  if (error) return dbFail(error, "Could not move the enquiry.");

  await timeline(admin, actor, brief, "enquiry.pipeline_changed", {
    from_pipeline: brief.pipeline_name,
    to_pipeline: pipeline.name,
    from_stage: brief.stage_name,
    to_stage: stage.name,
  });
  await emit(actor.orgId, "enquiry.stage_changed", {
    enquiry_id: id,
    from_stage_id: brief.stage_id,
    to_stage_id: stage.id,
    pipeline_id: pipeline.id,
    from_pipeline_id: brief.pipeline_id,
  });
  return { ok: true };
}

export async function setStatus(
  admin: AdminClient,
  actor: Actor,
  id: string,
  status: EnquiryStatus,
  reason?: string | null,
): Promise<Result> {
  const brief = await loadBrief(admin, actor.orgId, id);
  if (!brief) return fail("Enquiry not found.");
  const change = validateStatusChange(brief.status, status, reason, brief.lost_reason);
  if (!change.ok) return fail(change.error);
  if (!change.changed) return { ok: true };

  const { error } = await admin
    .from("enquiries")
    .update({ status: change.status, lost_reason: change.reason })
    .eq("org_id", actor.orgId)
    .eq("id", id);
  if (error) return dbFail(error, "Could not change the status.");

  await timeline(admin, actor, brief, "enquiry.status_changed", {
    from: brief.status,
    to: change.status,
    reason: change.reason,
  });
  await emit(actor.orgId, "enquiry.status_changed", {
    enquiry_id: id,
    from: brief.status,
    to: change.status,
    reason: change.reason,
  });
  return { ok: true };
}

/** Deletes enquiries (their timeline events go with them). Returns how many were removed. */
export async function deleteEnquiries(
  admin: AdminClient,
  actor: Actor,
  ids: string[],
): Promise<Result<{ deleted: number }>> {
  const { data, error } = await admin
    .from("enquiries")
    .delete()
    .eq("org_id", actor.orgId)
    .in("id", ids)
    .select("id");
  if (error) return dbFail(error, "Could not delete the enquiries.");
  return { ok: true, deleted: data?.length ?? 0 };
}

/** Applies one patch to many enquiries, one at a time so every change is recorded and emitted. */
export async function bulkUpdate(
  admin: AdminClient,
  actor: Actor,
  ids: string[],
  patch: BulkPatch,
): Promise<Result<{ updated: number; failed: number; firstError: string | null }>> {
  let updated = 0;
  let failed = 0;
  let firstError: string | null = null;
  for (const id of ids) {
    const results: Result[] = [];
    if (patch.stage_id) results.push(await moveStage(admin, actor, id, patch.stage_id));
    if (patch.assignee_id !== undefined)
      results.push(await updateEnquiry(admin, actor, id, { assignee_id: patch.assignee_id }));
    if (patch.status) results.push(await setStatus(admin, actor, id, patch.status, patch.reason));
    const bad = results.find((r) => !r.ok);
    if (bad && !bad.ok) {
      failed++;
      firstError ??= bad.error;
    } else updated++;
  }
  return { ok: true, updated, failed, firstError };
}
