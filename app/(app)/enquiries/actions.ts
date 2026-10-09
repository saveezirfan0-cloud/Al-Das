"use server";

import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { contactDisplayName } from "@/lib/inbox/contact-name";
import { isSortable } from "@/lib/enquiries/columns";
import { enquiryFilterSchema, searchTerm, type EnquiryFilter } from "@/lib/enquiries/filter";
import {
  BULK_LIMIT,
  bulkPatchSchema,
  createEnquirySchema,
  idListSchema,
  statusChangeSchema,
  updateEnquirySchema,
} from "@/lib/enquiries/schemas";
import * as service from "@/lib/enquiries/service";
import type { BoardColumn, EnquiryRow, TimelineItem } from "@/lib/enquiries/types";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";
import { openTasksFor } from "@/lib/tasks/service";
import type { TaskRow } from "@/lib/tasks/types";

export type ActionResult<T extends object = object> =
  ({ ok: true } & T) | { ok: false; error: string };

const uuid = z.string().uuid();
const bad = (error = "Invalid input"): { ok: false; error: string } => ({ ok: false, error });

// ---------------------------------------------------------------------------
// Reads (enquiries.view)
// ---------------------------------------------------------------------------

const boardSchema = z.object({
  filter: enquiryFilterSchema,
  stage_ids: z.array(uuid).min(1).max(30),
  offsets: z.record(z.string(), z.number().int().min(0).max(100_000)).optional(),
});

export async function loadBoard(
  input: z.input<typeof boardSchema>,
): Promise<ActionResult<{ columns: BoardColumn[] }>> {
  const member = await requirePerm("enquiries.view");
  const parsed = boardSchema.safeParse(input);
  if (!parsed.success) return bad();
  const columns = await service.boardColumns(
    createAdminClient(),
    { orgId: member.orgId, userId: member.userId },
    parsed.data.filter,
    parsed.data.stage_ids,
    parsed.data.offsets,
  );
  return { ok: true, columns };
}

const tableSchema = z.object({
  filter: enquiryFilterSchema,
  page: z.number().int().min(1).max(10_000),
  pageSize: z.number().int().min(10).max(500),
  sort: z.string().max(40).optional(),
  dir: z.enum(["asc", "desc"]).optional(),
});

export async function loadTable(
  input: z.input<typeof tableSchema>,
): Promise<ActionResult<{ rows: EnquiryRow[]; total: number }>> {
  const member = await requirePerm("enquiries.view");
  const parsed = tableSchema.safeParse(input);
  if (!parsed.success) return bad();
  const d = parsed.data;
  const res = await service.listEnquiries(
    createAdminClient(),
    { orgId: member.orgId, userId: member.userId },
    d.filter,
    {
      page: d.page - 1,
      pageSize: d.pageSize,
      sort: isSortable(d.sort) ? d.sort : undefined,
      dir: d.dir,
    },
  );
  return { ok: true, ...res };
}

export type EnquiryDetail = {
  row: EnquiryRow;
  timeline: TimelineItem[];
  tasks: TaskRow[];
};

export async function getEnquiryDetail(id: string): Promise<ActionResult<EnquiryDetail>> {
  const member = await requirePerm("enquiries.view");
  if (!uuid.safeParse(id).success) return bad();
  const admin = createAdminClient();
  const row = await service.getEnquiry(admin, member.orgId, id);
  if (!row) return bad("Enquiry not found.");
  const [timeline, tasks] = await Promise.all([
    service.enquiryTimeline(admin, member.orgId, id),
    can(member, "tasks.manage")
      ? openTasksFor(admin, member.orgId, { enquiry_id: id })
      : Promise.resolve([]),
  ]);
  return { ok: true, row, timeline, tasks };
}

export async function enquiriesForContactAction(
  contactId: string,
): Promise<ActionResult<{ rows: EnquiryRow[] }>> {
  const member = await requirePerm("enquiries.view");
  if (!uuid.safeParse(contactId).success) return bad();
  return {
    ok: true,
    rows: await service.enquiriesForContact(createAdminClient(), member.orgId, contactId),
  };
}

export type ContactOption = { id: string; name: string; phone: string | null };

/** Patient picker for "New enquiry". Needs contacts.view as well: it returns names and phones. */
export async function searchContacts(
  term: string,
): Promise<ActionResult<{ contacts: ContactOption[] }>> {
  const member = await requirePerm("enquiries.manage");
  if (!can(member, "contacts.view")) return bad("You cannot search patients.");
  const t = searchTerm(term.slice(0, 100));
  if (t.length < 2) return { ok: true, contacts: [] };
  const digits = t.replace(/\D/g, "");
  const parts = [
    `first_name.ilike.%${t}%`,
    `last_name.ilike.%${t}%`,
    `wa_profile_name.ilike.%${t}%`,
  ];
  if (digits.length >= 4) parts.push(`phone_e164.ilike.%${digits}%`);
  const { data } = await createAdminClient()
    .from("contacts")
    .select("id, first_name, last_name, wa_profile_name, phone_e164")
    .eq("org_id", member.orgId)
    .is("deleted_at", null)
    .or(parts.join(","))
    .order("last_interaction_at", { ascending: false, nullsFirst: false })
    .limit(20);
  return {
    ok: true,
    contacts: (data ?? []).map((c) => ({
      id: c.id,
      name: contactDisplayName(c),
      phone: c.phone_e164,
    })),
  };
}

// ---------------------------------------------------------------------------
// Writes (enquiries.manage)
// ---------------------------------------------------------------------------

function actorOf(member: { orgId: string; userId: string }) {
  return { orgId: member.orgId, userId: member.userId };
}

export async function createEnquiryAction(
  input: z.input<typeof createEnquirySchema>,
): Promise<ActionResult<{ id: string; number: number }>> {
  const member = await requirePerm("enquiries.manage");
  const parsed = createEnquirySchema.safeParse(input);
  if (!parsed.success) return bad(parsed.error.issues[0]?.message);
  return service.createEnquiry(createAdminClient(), actorOf(member), parsed.data);
}

export async function updateEnquiryAction(
  id: string,
  patch: z.input<typeof updateEnquirySchema>,
): Promise<ActionResult> {
  const member = await requirePerm("enquiries.manage");
  const parsed = updateEnquirySchema.safeParse(patch);
  if (!uuid.safeParse(id).success || !parsed.success)
    return bad(parsed.success ? undefined : parsed.error.issues[0]?.message);
  return service.updateEnquiry(createAdminClient(), actorOf(member), id, parsed.data);
}

export async function moveStageAction(id: string, stageId: string): Promise<ActionResult> {
  const member = await requirePerm("enquiries.manage");
  if (!uuid.safeParse(id).success || !uuid.safeParse(stageId).success) return bad();
  return service.moveStage(createAdminClient(), actorOf(member), id, stageId);
}

export async function moveToPipelineAction(
  id: string,
  pipelineId: string,
  stageId?: string,
): Promise<ActionResult> {
  const member = await requirePerm("enquiries.manage");
  if (!uuid.safeParse(id).success || !uuid.safeParse(pipelineId).success) return bad();
  if (stageId && !uuid.safeParse(stageId).success) return bad();
  return service.moveToPipeline(createAdminClient(), actorOf(member), id, pipelineId, stageId);
}

export async function setStatusAction(
  id: string,
  change: z.input<typeof statusChangeSchema>,
): Promise<ActionResult> {
  const member = await requirePerm("enquiries.manage");
  const parsed = statusChangeSchema.safeParse(change);
  if (!uuid.safeParse(id).success || !parsed.success) return bad();
  return service.setStatus(
    createAdminClient(),
    actorOf(member),
    id,
    parsed.data.status,
    parsed.data.reason,
  );
}

/** Bulk edit / disqualify: audited because one request touches many records. */
export async function bulkUpdateAction(
  ids: string[],
  patch: z.input<typeof bulkPatchSchema>,
): Promise<ActionResult<{ updated: number; failed: number; firstError: string | null }>> {
  const member = await requirePerm("enquiries.manage");
  const list = idListSchema.safeParse(ids);
  const parsed = bulkPatchSchema.safeParse(patch);
  if (!list.success) return bad(`Select between 1 and ${BULK_LIMIT} enquiries.`);
  if (!parsed.success) return bad(parsed.error.issues[0]?.message);
  const admin = createAdminClient();
  const res = await service.bulkUpdate(admin, actorOf(member), list.data, parsed.data);
  if (res.ok)
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "enquiry.bulk_updated",
      entity: "enquiry",
      diff: {
        count: list.data.length,
        updated: res.updated,
        failed: res.failed,
        changes: Object.keys(parsed.data).filter((k) => k !== "reason"),
      } as Json,
    });
  return res;
}

export async function bulkDeleteAction(ids: string[]): Promise<ActionResult<{ deleted: number }>> {
  const member = await requirePerm("enquiries.manage");
  const list = idListSchema.safeParse(ids);
  if (!list.success) return bad(`Select between 1 and ${BULK_LIMIT} enquiries.`);
  const admin = createAdminClient();
  const res = await service.deleteEnquiries(admin, actorOf(member), list.data);
  if (res.ok)
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "enquiry.deleted",
      entity: "enquiry",
      diff: { requested: list.data.length, deleted: res.deleted },
    });
  return res;
}

// ---------------------------------------------------------------------------
// Saved views (private, shared with teams, or with everyone)
// ---------------------------------------------------------------------------

const viewSchema = z.object({
  id: uuid.optional(),
  name: z.string().trim().min(1).max(80),
  pipeline_id: uuid.nullable(),
  filter: enquiryFilterSchema,
  columns: z.array(z.string().max(40)).max(40).default([]),
  shared_team_ids: z.array(uuid).max(50).default([]),
  shared_with_all: z.boolean().default(false),
});
export type SaveViewInput = z.input<typeof viewSchema>;

export async function saveEnquiryView(input: SaveViewInput): Promise<ActionResult<{ id: string }>> {
  const member = await requirePerm("enquiries.view");
  const parsed = viewSchema.safeParse(input);
  if (!parsed.success) return bad(parsed.error.issues[0]?.message);
  const v = parsed.data;
  const admin = createAdminClient();

  // Sharing with a team only makes sense for teams of this org.
  if (v.shared_team_ids.length) {
    const { data: teams } = await admin
      .from("teams")
      .select("id")
      .eq("org_id", member.orgId)
      .in("id", v.shared_team_ids);
    if ((teams ?? []).length !== new Set(v.shared_team_ids).size)
      return bad("Choose teams from this workspace.");
  }
  if (v.pipeline_id) {
    const { data: p } = await admin
      .from("pipelines")
      .select("id")
      .eq("org_id", member.orgId)
      .eq("id", v.pipeline_id)
      .maybeSingle();
    if (!p) return bad("Pipeline not found.");
  }
  const row = {
    org_id: member.orgId,
    owner_id: member.userId,
    name: v.name,
    pipeline_id: v.pipeline_id,
    filter: v.filter as unknown as NonNullable<Json>,
    columns: v.columns as unknown as NonNullable<Json>,
    shared_team_ids: v.shared_team_ids,
    shared_with_all: v.shared_with_all,
  };
  if (v.id) {
    const { data, error } = await admin
      .from("enquiry_views")
      .update(row)
      .eq("org_id", member.orgId)
      .eq("owner_id", member.userId)
      .eq("id", v.id)
      .select("id")
      .maybeSingle();
    if (error || !data) return bad("View not found.");
    return { ok: true, id: data.id };
  }
  const { data, error } = await admin.from("enquiry_views").insert(row).select("id").single();
  if (error || !data) return bad("Could not save the view.");
  return { ok: true, id: data.id };
}

export async function deleteEnquiryView(id: string): Promise<ActionResult> {
  const member = await requirePerm("enquiries.view");
  if (!uuid.safeParse(id).success) return bad();
  const { error } = await createAdminClient()
    .from("enquiry_views")
    .delete()
    .eq("org_id", member.orgId)
    .eq("owner_id", member.userId)
    .eq("id", id);
  if (error) return bad("Could not delete the view.");
  return { ok: true };
}

export type { EnquiryFilter };
