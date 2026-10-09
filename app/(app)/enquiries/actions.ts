"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember, requirePerm } from "@/lib/auth/session";
import { addTimelineEvent } from "@/lib/contacts/timeline";
import { CARD_FIELD_KEYS } from "@/lib/enquiries/constants";
import { mergeEnquiryCustom } from "@/lib/enquiries/custom";
import {
  bulkApply,
  createEnquiry,
  deleteEnquiries,
  EnquiryError,
  moveStage,
  movePipeline,
  setStatus,
  updateEnquiry,
  type BulkOp,
} from "@/lib/enquiries/service";
import {
  countEnquiries,
  fetchEnquiriesByIds,
  matchingEnquiryIds,
  queryEnquiries,
  stageCounts,
  type EnquiryRow,
} from "@/lib/enquiries/query";
import {
  bulkOpSchema,
  enquiryDetailsSchema,
  newEnquirySchema,
  statusSchema,
  viewSchema,
} from "@/lib/enquiries/schemas";
import { loadEnquiryContext } from "@/lib/enquiries/server";
import { buildEnquiryFilter, isScope, type EnquiryScope } from "@/lib/enquiries/views";
import { FilterCompileError, InvalidOperatorError } from "@/lib/filters";
import { filterSchema } from "@/lib/filters/ast";
import { UnknownFieldError } from "@/lib/filters/field-registry";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json, Tables } from "@/lib/supabase/types";

export type ActionResult<T = undefined> =
  | (T extends undefined ? { ok: true; message?: string } : { ok: true; message?: string; data: T })
  | { ok: false; error: string };

const uuid = z.string().uuid();
const uuids = z.array(uuid).min(1).max(5000);

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function describeError(e: unknown, fallback: string): string {
  if (
    e instanceof EnquiryError ||
    e instanceof UnknownFieldError ||
    e instanceof InvalidOperatorError ||
    e instanceof FilterCompileError
  )
    return e.message;
  console.error("[enquiries] action failed", e instanceof Error ? e.name : "unknown");
  return fallback;
}

function refresh() {
  revalidatePath("/enquiries");
}

// ---------------------------------------------------------------------------
// Listing: table + board
// ---------------------------------------------------------------------------

const sortSchema = z.array(z.object({ field: z.string(), dir: z.enum(["asc", "desc"]) })).max(3);

const listSchema = z.object({
  scope: z.enum(["open", "closed", "all"]).default("open"),
  pipelineId: uuid.nullable().optional(),
  filter: filterSchema.nullable().optional(),
  search: z.string().max(200).nullable().optional(),
  sort: sortSchema.nullable().optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(10).max(500).default(100),
});
export type ListEnquiriesInput = z.input<typeof listSchema>;

export async function listEnquiries(
  raw: ListEnquiriesInput,
): Promise<ActionResult<{ rows: EnquiryRow[]; total: number; page: number; pageSize: number }>> {
  const member = await requirePerm("enquiries.view");
  const parsed = listSchema.safeParse(raw);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid query");
  const admin = createAdminClient();
  try {
    const ctx = await loadEnquiryContext(admin, member.orgId);
    const page = await queryEnquiries(admin, {
      orgId: member.orgId,
      registry: ctx.registry,
      filter: buildEnquiryFilter(parsed.data),
      search: parsed.data.search,
      sort: parsed.data.sort,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      timezone: member.org.timezone,
    });
    return { ok: true, data: page };
  } catch (e) {
    return fail(describeError(e, "Could not load enquiries."));
  }
}

const boardSchema = listSchema
  .pick({ scope: true, pipelineId: true, filter: true, search: true })
  .extend({
    pipelineId: uuid,
  });
export type BoardInput = z.input<typeof boardSchema>;

export type BoardColumn = { stageId: string; total: number; rows: EnquiryRow[] };

const COLUMN_PAGE = 50;

export async function getBoard(raw: BoardInput): Promise<ActionResult<{ columns: BoardColumn[] }>> {
  const member = await requirePerm("enquiries.view");
  const parsed = boardSchema.safeParse(raw);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid query");
  const admin = createAdminClient();
  try {
    const ctx = await loadEnquiryContext(admin, member.orgId);
    const pipeline = ctx.pipelines.find((p) => p.id === parsed.data.pipelineId);
    if (!pipeline) return fail("Pipeline not found");
    const base = {
      orgId: member.orgId,
      registry: ctx.registry,
      filter: buildEnquiryFilter(parsed.data),
      search: parsed.data.search,
      timezone: member.org.timezone,
    };
    const counts = await stageCounts(admin, base);
    const columns = await Promise.all(
      pipeline.stages.map(async (s): Promise<BoardColumn> => {
        const total = counts[s.id] ?? 0;
        if (total === 0) return { stageId: s.id, total, rows: [] };
        const page = await queryEnquiries(admin, {
          ...base,
          stageId: s.id,
          pageSize: COLUMN_PAGE,
          page: 1,
        });
        return { stageId: s.id, total, rows: page.rows };
      }),
    );
    return { ok: true, data: { columns } };
  } catch (e) {
    return fail(describeError(e, "Could not load the board."));
  }
}

/** "Load more" for one Kanban column. */
export async function getBoardColumnPage(
  raw: BoardInput & { stageId: string; page: number },
): Promise<ActionResult<{ rows: EnquiryRow[] }>> {
  const member = await requirePerm("enquiries.view");
  const parsed = boardSchema
    .extend({ stageId: uuid, page: z.number().int().min(2).max(1000) })
    .safeParse(raw);
  if (!parsed.success) return fail("Invalid query");
  const admin = createAdminClient();
  try {
    const ctx = await loadEnquiryContext(admin, member.orgId);
    const page = await queryEnquiries(admin, {
      orgId: member.orgId,
      registry: ctx.registry,
      filter: buildEnquiryFilter(parsed.data),
      search: parsed.data.search,
      timezone: member.org.timezone,
      stageId: parsed.data.stageId,
      page: parsed.data.page,
      pageSize: COLUMN_PAGE,
    });
    return { ok: true, data: { rows: page.rows } };
  } catch (e) {
    return fail(describeError(e, "Could not load more."));
  }
}

export async function listMatchingEnquiryIds(
  raw: ListEnquiriesInput,
): Promise<ActionResult<{ ids: string[] }>> {
  const member = await requirePerm("enquiries.view");
  const parsed = listSchema.safeParse(raw);
  if (!parsed.success) return fail("Invalid query");
  const admin = createAdminClient();
  try {
    const ctx = await loadEnquiryContext(admin, member.orgId);
    const ids = await matchingEnquiryIds(
      admin,
      {
        orgId: member.orgId,
        registry: ctx.registry,
        filter: buildEnquiryFilter(parsed.data),
        search: parsed.data.search,
        timezone: member.org.timezone,
      },
      20_000,
    );
    return { ok: true, data: { ids } };
  } catch (e) {
    return fail(describeError(e, "Could not load enquiries."));
  }
}

/** Number of enquiries a filter matches (filter panel preview). */
export async function previewEnquiryFilterCount(
  filter: unknown,
  scope: EnquiryScope = "all",
  pipelineId?: string | null,
): Promise<ActionResult<{ count: number }>> {
  const member = await requirePerm("enquiries.view");
  const parsed = filterSchema.safeParse(filter);
  if (!parsed.success || !isScope(scope)) return fail("Invalid filter");
  const admin = createAdminClient();
  try {
    const ctx = await loadEnquiryContext(admin, member.orgId);
    const count = await countEnquiries(admin, {
      orgId: member.orgId,
      registry: ctx.registry,
      filter: buildEnquiryFilter({ scope, pipelineId, filter: parsed.data }),
      timezone: member.org.timezone,
    });
    return { ok: true, data: { count } };
  } catch (e) {
    return fail(describeError(e, "Invalid filter"));
  }
}

// ---------------------------------------------------------------------------
// One enquiry
// ---------------------------------------------------------------------------

export type EnquiryDetail = {
  enquiry: EnquiryRow;
  timeline: Array<
    Pick<
      Tables<"timeline_events">,
      "id" | "type" | "actor_type" | "actor_id" | "payload" | "at"
    > & {
      actor_name: string | null;
    }
  >;
  tasks: Array<
    Pick<Tables<"tasks">, "id" | "type" | "subject" | "due_at" | "done" | "assignee_id">
  >;
};

export async function getEnquiry(id: string): Promise<ActionResult<EnquiryDetail>> {
  const member = await requirePerm("enquiries.view");
  if (!uuid.safeParse(id).success) return fail("Invalid enquiry id");
  const admin = createAdminClient();
  const [rows, { data: events }, tasks] = await Promise.all([
    fetchEnquiriesByIds(admin, member.orgId, [id]),
    admin
      .from("timeline_events")
      .select("id, type, actor_type, actor_id, payload, at")
      .eq("org_id", member.orgId)
      .eq("enquiry_id", id)
      .order("at", { ascending: false })
      .limit(200),
    can(member, "tasks.view")
      ? admin
          .from("tasks")
          .select("id, type, subject, due_at, done, assignee_id")
          .eq("org_id", member.orgId)
          .eq("enquiry_id", id)
          .order("done")
          .order("due_at")
          .limit(100)
      : Promise.resolve({ data: [] }),
  ]);
  const enquiry = rows[0];
  if (!enquiry || enquiry.deleted_at) return fail("Enquiry not found");
  const actorIds = [
    ...new Set((events ?? []).map((e) => e.actor_id).filter((x): x is string => !!x)),
  ];
  const { data: actors } = actorIds.length
    ? await admin.from("profiles").select("id, first_name, last_name, email").in("id", actorIds)
    : {
        data: [] as Array<{
          id: string;
          first_name: string;
          last_name: string;
          email: string | null;
        }>,
      };
  const nameOf = new Map(
    (actors ?? []).map((a) => [
      a.id,
      `${a.first_name} ${a.last_name}`.trim() || a.email || "Someone",
    ]),
  );
  return {
    ok: true,
    data: {
      enquiry,
      timeline: (events ?? []).map((e) => ({
        ...e,
        actor_name: e.actor_id ? (nameOf.get(e.actor_id) ?? null) : null,
      })),
      tasks: tasks.data ?? [],
    },
  };
}

// ---------------------------------------------------------------------------
// Create / update
// ---------------------------------------------------------------------------

export async function createNewEnquiry(
  input: unknown,
): Promise<ActionResult<{ id: string; number: number }>> {
  const member = await requirePerm("enquiries.manage");
  const parsed = newEnquirySchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  const d = parsed.data;
  const admin = createAdminClient();
  try {
    const ctx = await loadEnquiryContext(admin, member.orgId);
    const custom = mergeEnquiryCustom(ctx.customFields, {}, d.custom ?? {});
    if (!custom.ok) return fail(custom.error);
    if (d.contact_id && !can(member, "contacts.view")) return fail("You cannot link contacts.");
    const created = await createEnquiry(
      { admin, orgId: member.orgId, userId: member.userId },
      {
        title: d.title,
        pipelineId: d.pipeline_id,
        stageId: d.stage_id ?? null,
        contactId: d.contact_id ?? null,
        channelId: d.channel_id ?? null,
        source: d.source ?? null,
        assigneeId: d.auto_assign ? undefined : (d.assignee_id ?? null),
        estValue: d.est_value,
        locationId: d.location_id ?? null,
        departmentId: d.department_id ?? null,
        specialistId: d.specialist_id ?? null,
        serviceId: d.service_id ?? null,
        apptDate: d.appt_date,
        custom: custom.value,
      },
    );
    refresh();
    return { ok: true, message: `Enquiry #${created.number} created.`, data: created };
  } catch (e) {
    return fail(describeError(e, "Could not create the enquiry."));
  }
}

export async function updateEnquiryDetails(id: string, input: unknown): Promise<ActionResult> {
  const member = await requirePerm("enquiries.manage");
  if (!uuid.safeParse(id).success) return fail("Invalid enquiry id");
  const parsed = enquiryDetailsSchema.partial().safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  const d = parsed.data;
  const admin = createAdminClient();
  try {
    let custom: Record<string, unknown> | undefined;
    if (d.custom) {
      const ctx = await loadEnquiryContext(admin, member.orgId);
      const { data: current } = await admin
        .from("enquiries")
        .select("custom")
        .eq("org_id", member.orgId)
        .eq("id", id)
        .maybeSingle();
      if (!current) return fail("Enquiry not found.");
      const merged = mergeEnquiryCustom(
        ctx.customFields,
        (current.custom ?? {}) as Record<string, unknown>,
        d.custom,
      );
      if (!merged.ok) return fail(merged.error);
      custom = merged.value;
    }
    if (d.contact_id && !can(member, "contacts.view")) return fail("You cannot link contacts.");
    await updateEnquiry({ admin, orgId: member.orgId, userId: member.userId }, id, {
      title: d.title,
      contactId: d.contact_id,
      channelId: d.channel_id,
      source: d.source,
      assigneeId: d.assignee_id,
      estValue: d.est_value,
      locationId: d.location_id,
      departmentId: d.department_id,
      specialistId: d.specialist_id,
      serviceId: d.service_id,
      apptDate: d.appt_date,
      custom,
    });
    refresh();
    return { ok: true, message: "Saved." };
  } catch (e) {
    return fail(describeError(e, "Could not save the enquiry."));
  }
}

export async function changeStage(id: string, stageId: string): Promise<ActionResult> {
  const member = await requirePerm("enquiries.manage");
  if (!uuid.safeParse(id).success || !uuid.safeParse(stageId).success) return fail("Invalid id");
  try {
    await moveStage(
      { admin: createAdminClient(), orgId: member.orgId, userId: member.userId },
      id,
      stageId,
    );
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(describeError(e, "Could not move the enquiry."));
  }
}

export async function changeStatus(id: string, input: unknown): Promise<ActionResult> {
  const member = await requirePerm("enquiries.manage");
  const parsed = statusSchema.safeParse(input);
  if (!uuid.safeParse(id).success || !parsed.success)
    return fail(parsed.success ? "Invalid id" : "Invalid status");
  try {
    await setStatus(
      { admin: createAdminClient(), orgId: member.orgId, userId: member.userId },
      id,
      parsed.data.status,
      parsed.data.reason,
    );
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(describeError(e, "Could not change the status."));
  }
}

export async function changePipeline(
  id: string,
  pipelineId: string,
  stageId?: string | null,
): Promise<ActionResult> {
  const member = await requirePerm("enquiries.manage");
  if (!uuid.safeParse(id).success || !uuid.safeParse(pipelineId).success) return fail("Invalid id");
  try {
    await movePipeline(
      { admin: createAdminClient(), orgId: member.orgId, userId: member.userId },
      id,
      pipelineId,
      stageId ?? null,
    );
    refresh();
    return { ok: true, message: "Moved." };
  } catch (e) {
    return fail(describeError(e, "Could not move the enquiry."));
  }
}

export async function addEnquiryNote(id: string, text: string): Promise<ActionResult> {
  const member = await requirePerm("enquiries.manage");
  const note = text.trim();
  if (!uuid.safeParse(id).success || !note || note.length > 4000)
    return fail("Write a note first.");
  const admin = createAdminClient();
  const { data: e } = await admin
    .from("enquiries")
    .select("id, contact_id")
    .eq("org_id", member.orgId)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!e) return fail("Enquiry not found.");
  await addTimelineEvent(admin, {
    orgId: member.orgId,
    contactId: e.contact_id,
    enquiryId: e.id,
    type: "note",
    actorId: member.userId,
    payload: { text: note },
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Bulk + delete
// ---------------------------------------------------------------------------

export async function bulkEnquiries(
  ids: string[],
  input: unknown,
): Promise<ActionResult<{ updated: number; failed: number }>> {
  const member = await requirePerm("enquiries.manage");
  const idsParsed = uuids.safeParse(ids);
  const opParsed = bulkOpSchema.safeParse(input);
  if (!idsParsed.success || !opParsed.success)
    return fail(
      opParsed.success
        ? "Select at least one enquiry."
        : (opParsed.error.issues[0]?.message ?? "Invalid input"),
    );
  if (idsParsed.data.length > 1000)
    return fail("Bulk changes are limited to 1,000 enquiries at a time.");
  const o = opParsed.data;
  let op: BulkOp;
  switch (o.type) {
    case "assign":
      op = { type: "assign", assigneeId: o.assignee_id };
      break;
    case "stage":
      op = { type: "stage", stageId: o.stage_id };
      break;
    case "status":
      op = { type: "status", status: o.status, reason: o.reason };
      break;
    case "pipeline":
      op = { type: "pipeline", pipelineId: o.pipeline_id, stageId: o.stage_id };
      break;
    case "edit": {
      const patch: Record<string, unknown> = {};
      const map = {
        source: "source",
        channel_id: "channelId",
        location_id: "locationId",
        department_id: "departmentId",
        specialist_id: "specialistId",
        service_id: "serviceId",
        est_value: "estValue",
      } as const;
      for (const f of o.fields) patch[map[f]] = o[f] ?? null;
      op = { type: "edit", patch };
      break;
    }
  }
  const admin = createAdminClient();
  try {
    const res = await bulkApply(
      { admin, orgId: member.orgId, userId: member.userId },
      idsParsed.data,
      op,
    );
    refresh();
    const failed = res.failed.length;
    return {
      ok: true,
      message: failed
        ? `${res.updated} updated, ${failed} could not be changed (${res.failed[0].error})`
        : `${res.updated} enquir${res.updated === 1 ? "y" : "ies"} updated.`,
      data: { updated: res.updated, failed },
    };
  } catch (e) {
    return fail(describeError(e, "Could not update the enquiries."));
  }
}

export async function removeEnquiries(ids: string[]): Promise<ActionResult> {
  const member = await requirePerm("enquiries.delete");
  const parsed = uuids.safeParse(ids);
  if (!parsed.success) return fail("Select at least one enquiry.");
  try {
    const n = await deleteEnquiries(
      { admin: createAdminClient(), orgId: member.orgId, userId: member.userId },
      parsed.data,
    );
    refresh();
    return { ok: true, message: `${n} enquir${n === 1 ? "y" : "ies"} deleted.` };
  } catch (e) {
    return fail(describeError(e, "Could not delete the enquiries."));
  }
}

// ---------------------------------------------------------------------------
// Contact picker
// ---------------------------------------------------------------------------

export type ContactOption = { id: string; full_name: string; phone_e164: string | null };

export async function searchContactsForEnquiry(
  q: string,
): Promise<ActionResult<{ rows: ContactOption[] }>> {
  const member = await requirePerm("enquiries.manage");
  if (!can(member, "contacts.view")) return fail("You do not have access to contacts.");
  const term = q.trim().slice(0, 100);
  if (term.length < 2) return { ok: true, data: { rows: [] } };
  const admin = createAdminClient();
  // Two parameterised ilike queries rather than a PostgREST .or() string built from user input.
  const like = `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const base = () =>
    admin
      .from("contacts")
      .select("id, full_name, phone_e164")
      .eq("org_id", member.orgId)
      .is("deleted_at", null)
      .limit(10);
  const [byName, byPhone] = await Promise.all([
    base().ilike("full_name", like).order("full_name"),
    /\d{3}/.test(term)
      ? base().ilike("phone_e164", `%${term.replace(/\D/g, "")}%`)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (byName.error || byPhone.error) return fail("Search failed.");
  const seen = new Map<string, ContactOption>();
  for (const r of [...(byName.data ?? []), ...(byPhone.data ?? [])])
    seen.set(r.id, { id: r.id, full_name: r.full_name ?? "", phone_e164: r.phone_e164 });
  return { ok: true, data: { rows: [...seen.values()].slice(0, 10) } };
}

// ---------------------------------------------------------------------------
// Saved views
// ---------------------------------------------------------------------------

export async function saveEnquiryView(
  id: string | null,
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const member = await requirePerm("enquiries.view");
  const parsed = viewSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  const filter = filterSchema.safeParse(parsed.data.filter);
  if (!filter.success) return fail("Invalid filter");
  const shared = parsed.data.shared_all || parsed.data.shared_team_ids.length > 0;
  if (shared && !can(member, "enquiries.manage")) return fail("You cannot share views.");
  const admin = createAdminClient();
  const row = {
    org_id: member.orgId,
    owner_id: member.userId,
    name: parsed.data.name,
    pipeline_id: parsed.data.pipeline_id ?? null,
    mode: parsed.data.mode,
    filter: filter.data as unknown as NonNullable<Json>,
    columns: parsed.data.columns as unknown as NonNullable<Json>,
    shared_team_ids: parsed.data.shared_all ? [] : parsed.data.shared_team_ids,
    shared_all: parsed.data.shared_all,
  };
  if (id) {
    const { data } = await admin
      .from("enquiry_views")
      .update(row)
      .eq("id", id)
      .eq("org_id", member.orgId)
      .eq("owner_id", member.userId)
      .select("id")
      .maybeSingle();
    if (!data) return fail("View not found (only the owner can edit it).");
    return { ok: true, data: { id: data.id }, message: "View saved." };
  }
  const { data, error } = await admin.from("enquiry_views").insert(row).select("id").single();
  if (error || !data) return fail("Could not save the view.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "enquiry_view.created",
    entity: "enquiry_view",
    entityId: data.id,
  });
  return { ok: true, data: { id: data.id }, message: "View saved." };
}

export async function deleteEnquiryView(id: string): Promise<ActionResult> {
  const member = await requireMember();
  if (!uuid.safeParse(id).success) return fail("Invalid id");
  const admin = createAdminClient();
  const { data } = await admin
    .from("enquiry_views")
    .delete()
    .eq("id", id)
    .eq("org_id", member.orgId)
    .eq("owner_id", member.userId)
    .select("id")
    .maybeSingle();
  if (!data) return fail("View not found (only the owner can delete it).");
  return { ok: true, message: "View deleted." };
}

// ---------------------------------------------------------------------------
// Pipelines rail + card fields
// ---------------------------------------------------------------------------

/** Enquiry counts per pipeline for the rail, for the given Open / Closed / All scope. */
export async function getPipelineCounts(
  scope: EnquiryScope = "open",
): Promise<ActionResult<{ counts: Record<string, number> }>> {
  const member = await requirePerm("enquiries.view");
  if (!isScope(scope)) return fail("Invalid scope");
  const admin = createAdminClient();
  const { data: pipelines } = await admin.from("pipelines").select("id").eq("org_id", member.orgId);
  const entries = await Promise.all(
    (pipelines ?? []).map(async (p) => {
      let q = admin
        .from("enquiries")
        .select("id", { count: "exact", head: true })
        .eq("org_id", member.orgId)
        .eq("pipeline_id", p.id)
        .is("deleted_at", null);
      if (scope === "open") q = q.eq("status", "open");
      if (scope === "closed") q = q.neq("status", "open");
      const { count } = await q;
      return [p.id, count ?? 0] as const;
    }),
  );
  return { ok: true, data: { counts: Object.fromEntries(entries) } };
}

/** Which fields a pipeline's Kanban cards show. */
export async function savePipelineCardFields(
  pipelineId: string,
  fields: string[],
): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = z
    .array(z.enum(CARD_FIELD_KEYS as [string, ...string[]]))
    .max(CARD_FIELD_KEYS.length)
    .safeParse(fields);
  if (!uuid.safeParse(pipelineId).success || !parsed.success) return fail("Invalid input");
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("pipelines")
    .update({ card_fields: [...new Set(parsed.data)] })
    .eq("org_id", member.orgId)
    .eq("id", pipelineId)
    .select("id")
    .maybeSingle();
  if (error || !data) return fail("Could not save the card fields.");
  refresh();
  return { ok: true, message: "Card fields saved." };
}

/** One contact's display fields, e.g. to prefill "New enquiry" from the inbox or a contact. */
export async function getContactOption(
  id: string,
): Promise<ActionResult<{ contact: ContactOption }>> {
  const member = await requirePerm("enquiries.manage");
  if (!can(member, "contacts.view")) return fail("You do not have access to contacts.");
  if (!uuid.safeParse(id).success) return fail("Invalid contact id");
  const { data } = await createAdminClient()
    .from("contacts")
    .select("id, full_name, phone_e164")
    .eq("org_id", member.orgId)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!data) return fail("Contact not found");
  return {
    ok: true,
    data: {
      contact: { id: data.id, full_name: data.full_name ?? "", phone_e164: data.phone_e164 },
    },
  };
}

// ---------------------------------------------------------------------------
// Contact drawer → Enquiries tab
// ---------------------------------------------------------------------------

export type ContactEnquiry = {
  id: string;
  number: number;
  title: string;
  status: string;
  stage: string | null;
  pipeline: string | null;
  created_at: string;
};

export async function listContactEnquiries(
  contactId: string,
): Promise<ActionResult<{ rows: ContactEnquiry[] }>> {
  const member = await requirePerm("enquiries.view");
  if (!uuid.safeParse(contactId).success) return fail("Invalid contact id");
  const admin = createAdminClient();
  const [{ data }, { data: stages }, { data: pipelines }] = await Promise.all([
    admin
      .from("enquiries")
      .select("id, number, title, status, stage_id, pipeline_id, created_at")
      .eq("org_id", member.orgId)
      .eq("contact_id", contactId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(50),
    admin.from("stages").select("id, name").eq("org_id", member.orgId),
    admin.from("pipelines").select("id, name").eq("org_id", member.orgId),
  ]);
  const stage = new Map((stages ?? []).map((s) => [s.id, s.name]));
  const pipeline = new Map((pipelines ?? []).map((p) => [p.id, p.name]));
  return {
    ok: true,
    data: {
      rows: (data ?? []).map((e) => ({
        id: e.id,
        number: e.number,
        title: e.title,
        status: e.status,
        stage: stage.get(e.stage_id) ?? null,
        pipeline: pipeline.get(e.pipeline_id) ?? null,
        created_at: e.created_at,
      })),
    },
  };
}
