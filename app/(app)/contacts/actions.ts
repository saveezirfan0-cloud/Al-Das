"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember, requirePerm } from "@/lib/auth/session";
import { coerceCustomObject } from "@/lib/contacts/custom-values";
import { contactInputSchema } from "@/lib/contacts/fields";
import type { PreparedContact } from "@/lib/contacts/import";
import { matchContact, writePreparedContact } from "@/lib/contacts/import-writer";
import { MERGE_FIELDS, resolveMergeFields, type MergeField } from "@/lib/contacts/merge";
import {
  countContacts,
  fetchContactsByIds,
  matchingContactIds,
  queryContacts,
  type ContactListRow,
} from "@/lib/contacts/query";
import { loadContactContext } from "@/lib/contacts/server";
import { addTimelineEvent, diffFields } from "@/lib/contacts/timeline";
import { combineFilters, isContactViewKey, viewFilter } from "@/lib/contacts/views";
import { filterSchema, type Filter } from "@/lib/filters/ast";
import { FilterCompileError, InvalidOperatorError } from "@/lib/filters";
import { UnknownFieldError } from "@/lib/filters/field-registry";
import { normalizePhone } from "@/lib/phone";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json, Tables, TablesUpdate } from "@/lib/supabase/types";

type JsonObject = NonNullable<Json>;

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
    e instanceof UnknownFieldError ||
    e instanceof InvalidOperatorError ||
    e instanceof FilterCompileError
  )
    return e.message;
  return fallback;
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

const sortSchema = z.array(z.object({ field: z.string(), dir: z.enum(["asc", "desc"]) })).max(3);

const listSchema = z.object({
  view: z.string().optional(),
  segmentId: uuid.nullable().optional(),
  filter: filterSchema.nullable().optional(),
  search: z.string().max(200).nullable().optional(),
  sort: sortSchema.nullable().optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(10).max(500).default(100),
});
export type ListContactsInput = z.input<typeof listSchema>;

/** Resolves view + segment + ad-hoc filter into one filter (segments: static → membership, dynamic → saved filter). */
async function effectiveFilter(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  userId: string,
  input: { view?: string; segmentId?: string | null; filter?: Filter | null },
): Promise<Filter> {
  const parts: Array<Filter | null> = [];
  if (isContactViewKey(input.view) && input.view !== "all")
    parts.push(viewFilter(input.view, userId));
  if (input.segmentId) {
    const { data: seg } = await admin
      .from("segments")
      .select("id, kind, filter")
      .eq("org_id", orgId)
      .eq("id", input.segmentId)
      .maybeSingle();
    if (!seg) throw new FilterCompileError("Segment not found");
    if (seg.kind === "static")
      parts.push({
        include: {
          type: "group",
          logic: "and",
          children: [{ type: "condition", field: "segments", op: "has_any", value: [seg.id] }],
        },
      });
    else {
      const parsed = filterSchema.safeParse(seg.filter);
      if (parsed.success) parts.push(parsed.data);
    }
  }
  parts.push(input.filter ?? null);
  return combineFilters(...parts);
}

export async function listContacts(
  raw: ListContactsInput,
): Promise<
  ActionResult<{ rows: ContactListRow[]; total: number; page: number; pageSize: number }>
> {
  const member = await requirePerm("contacts.view");
  const parsed = listSchema.safeParse(raw);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid query");
  const admin = createAdminClient();
  try {
    const ctx = await loadContactContext(admin, member.orgId);
    const filter = await effectiveFilter(admin, member.orgId, member.userId, parsed.data);
    const page = await queryContacts(admin, {
      orgId: member.orgId,
      registry: ctx.registry,
      filter,
      search: parsed.data.search,
      sort: parsed.data.sort,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      timezone: member.org.timezone,
    });
    return { ok: true, data: page };
  } catch (e) {
    return fail(describeError(e, "Could not load contacts."));
  }
}

/** Ids of every contact matching the current list (for "select all N"). */
export async function listMatchingIds(
  raw: ListContactsInput,
): Promise<ActionResult<{ ids: string[] }>> {
  const member = await requirePerm("contacts.view");
  const parsed = listSchema.safeParse(raw);
  if (!parsed.success) return fail("Invalid query");
  const admin = createAdminClient();
  try {
    const ctx = await loadContactContext(admin, member.orgId);
    const filter = await effectiveFilter(admin, member.orgId, member.userId, parsed.data);
    const ids = await matchingContactIds(
      admin,
      member.orgId,
      ctx.registry,
      filter,
      parsed.data.search,
      member.org.timezone,
      20_000,
    );
    return { ok: true, data: { ids } };
  } catch (e) {
    return fail(describeError(e, "Could not load contacts."));
  }
}

/** Quick picker search (merge dialog, etc.). */
export async function searchContactsQuick(
  q: string,
  excludeId?: string,
): Promise<ActionResult<{ rows: ContactListRow[] }>> {
  const member = await requirePerm("contacts.view");
  const admin = createAdminClient();
  try {
    const ctx = await loadContactContext(admin, member.orgId);
    const page = await queryContacts(admin, {
      orgId: member.orgId,
      registry: ctx.registry,
      search: q.slice(0, 100),
      pageSize: 10,
      sort: [{ field: "full_name", dir: "asc" }],
    });
    return { ok: true, data: { rows: page.rows.filter((r) => r.id !== excludeId) } };
  } catch (e) {
    return fail(describeError(e, "Search failed."));
  }
}

// ---------------------------------------------------------------------------
// Single contact
// ---------------------------------------------------------------------------

export type ContactDetail = {
  contact: ContactListRow;
  phones: Array<Pick<Tables<"contact_phones">, "id" | "phone_e164" | "label">>;
  segments: Array<{ id: string; name: string; kind: string }>;
  timeline: Array<
    Pick<
      Tables<"timeline_events">,
      "id" | "type" | "actor_type" | "actor_id" | "payload" | "at"
    > & { actor_name: string | null }
  >;
};

export async function getContact(id: string): Promise<ActionResult<ContactDetail>> {
  const member = await requirePerm("contacts.view");
  if (!uuid.safeParse(id).success) return fail("Invalid contact id");
  const admin = createAdminClient();
  const [rows, { data: phones }, { data: segs }, { data: events }] = await Promise.all([
    fetchContactsByIds(admin, member.orgId, [id]),
    admin
      .from("contact_phones")
      .select("id, phone_e164, label")
      .eq("contact_id", id)
      .order("created_at"),
    admin.from("segment_members").select("segments(id, name, kind)").eq("contact_id", id),
    admin
      .from("timeline_events")
      .select("id, type, actor_type, actor_id, payload, at")
      .eq("org_id", member.orgId)
      .eq("contact_id", id)
      .order("at", { ascending: false })
      .limit(200),
  ]);
  const contact = rows[0];
  if (!contact || contact.deleted_at) return fail("Contact not found");
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
      contact,
      phones: phones ?? [],
      segments: (segs ?? []).map((s) => s.segments).filter((s): s is NonNullable<typeof s> => !!s),
      timeline: (events ?? []).map((e) => ({
        ...e,
        actor_name: e.actor_id ? (nameOf.get(e.actor_id) ?? null) : null,
      })),
    },
  };
}

type ContactWrite = Omit<
  Tables<"contacts">,
  | "id"
  | "org_id"
  | "full_name"
  | "created_at"
  | "updated_at"
  | "deleted_at"
  | "merged_into_id"
  | "wa_bsuid"
  | "last_interaction_at"
  | "created_by"
>;

const CONTACT_DIFF_KEYS = [
  "first_name",
  "last_name",
  "phone_e164",
  "email",
  "gender",
  "nationality",
  "country",
  "language",
  "dob",
  "label",
  "owner_id",
  "assignee_id",
  "source",
  "external_id",
  "promotions_opt_in",
  "stop_marketing",
  "custom",
] as const;

async function buildContactWrite(
  orgId: string,
  input: unknown,
  existingCustom: Record<string, unknown> | null,
  partial: boolean,
): Promise<{ ok: true; write: Partial<ContactWrite> } | { ok: false; error: string }> {
  const parsed = contactInputSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid contact");
  const d = parsed.data;
  const write: Partial<ContactWrite> = {};
  const has = (k: string) => (input as Record<string, unknown>)?.[k] !== undefined;

  if (has("first_name")) write.first_name = d.first_name;
  if (has("last_name")) write.last_name = d.last_name;
  if (has("phone")) {
    if (d.phone) {
      const norm = normalizePhone(d.phone);
      if (!norm) return fail("Enter a valid phone number");
      write.phone_e164 = norm.e164;
      if (!has("country") && norm.country) write.country = norm.country;
    } else write.phone_e164 = null;
  }
  if (has("email")) write.email = d.email || null;
  if (has("gender")) write.gender = d.gender ?? null;
  if (has("nationality")) write.nationality = d.nationality || null;
  if (has("country")) write.country = d.country || null;
  if (has("language")) write.language = d.language || null;
  if (has("dob")) write.dob = d.dob || null;
  if (has("label")) write.label = d.label || null;
  if (has("owner_id")) write.owner_id = d.owner_id ?? null;
  if (has("assignee_id")) write.assignee_id = d.assignee_id ?? null;
  if (has("source") && d.source) write.source = d.source;
  if (has("external_id")) write.external_id = d.external_id || null;
  if (has("promotions_opt_in")) write.promotions_opt_in = d.promotions_opt_in ?? false;
  if (has("stop_marketing")) write.stop_marketing = d.stop_marketing ?? false;
  if (has("custom")) {
    const admin = createAdminClient();
    const { customFields } = await loadContactContext(admin, orgId);
    const res = coerceCustomObject(customFields, d.custom ?? {}, { partial });
    if (!res.ok) return fail(Object.values(res.errors)[0]);
    write.custom = (
      partial ? { ...(existingCustom ?? {}), ...res.value } : res.value
    ) as JsonObject;
    // partial updates may clear a key explicitly with null
    if (partial && d.custom) {
      const merged = { ...(write.custom as Record<string, unknown>) };
      for (const [k, v] of Object.entries(d.custom)) if (v === null || v === "") delete merged[k];
      write.custom = merged as JsonObject;
    }
  }
  if (!partial && !write.first_name && !write.last_name && !write.phone_e164 && !write.email)
    return fail("Enter at least a name, phone or email");
  return { ok: true, write };
}

function uniqueViolation(error: { code?: string; message?: string }): string | null {
  if (error.code !== "23505") return null;
  if (error.message?.includes("contacts_org_phone_uidx"))
    return "A contact with this phone number already exists.";
  if (error.message?.includes("contacts_org_external_uidx"))
    return "A contact with this external ID already exists.";
  if (error.message?.includes("contacts_org_bsuid_uidx"))
    return "A contact with this WhatsApp ID already exists.";
  return "A contact with these details already exists.";
}

export async function createContact(input: unknown): Promise<ActionResult<{ id: string }>> {
  const member = await requirePerm("contacts.manage");
  const built = await buildContactWrite(member.orgId, input, null, false);
  if (!built.ok) return built;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("contacts")
    .insert({ org_id: member.orgId, source: "manual", ...built.write, created_by: member.userId })
    .select("id")
    .single();
  if (error) return fail(uniqueViolation(error) ?? "Could not create the contact.");
  await addTimelineEvent(admin, {
    orgId: member.orgId,
    contactId: data.id,
    type: "contact.created",
    actorId: member.userId,
  });
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "contact.created",
    entity: "contact",
    entityId: data.id,
  });
  revalidatePath("/contacts");
  return { ok: true, data: { id: data.id }, message: "Contact created." };
}

export async function updateContact(id: string, input: unknown): Promise<ActionResult> {
  const member = await requirePerm("contacts.manage");
  if (!uuid.safeParse(id).success) return fail("Invalid contact id");
  const admin = createAdminClient();
  const [before] = await fetchContactsByIds(admin, member.orgId, [id]);
  if (!before || before.deleted_at) return fail("Contact not found");
  const built = await buildContactWrite(member.orgId, input, before.custom, true);
  if (!built.ok) return built;
  if (Object.keys(built.write).length === 0) return { ok: true };
  const { error } = await admin
    .from("contacts")
    .update(built.write)
    .eq("id", id)
    .eq("org_id", member.orgId);
  if (error) return fail(uniqueViolation(error) ?? "Could not save the contact.");
  const changes = diffFields(
    before as unknown as Record<string, unknown>,
    built.write as Record<string, unknown>,
    CONTACT_DIFF_KEYS,
  );
  if (Object.keys(changes).length)
    await addTimelineEvent(admin, {
      orgId: member.orgId,
      contactId: id,
      type: "contact.updated",
      actorId: member.userId,
      payload: { changes } as Json,
    });
  revalidatePath("/contacts");
  return { ok: true, message: "Contact saved." };
}

export async function deleteContacts(ids: string[]): Promise<ActionResult> {
  const member = await requirePerm("contacts.manage");
  const parsed = uuids.safeParse(ids);
  if (!parsed.success) return fail("Select at least one contact");
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("contacts")
    .update({
      deleted_at: new Date().toISOString(),
      phone_e164: null,
      wa_bsuid: null,
      external_id: null,
    })
    .eq("org_id", member.orgId)
    .is("deleted_at", null)
    .in("id", parsed.data)
    .select("id");
  if (error) return fail("Could not delete the contacts.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "contact.deleted",
    entity: "contact",
    diff: { count: data?.length ?? 0 },
  });
  revalidatePath("/contacts");
  return {
    ok: true,
    message: `${data?.length ?? 0} contact${data?.length === 1 ? "" : "s"} deleted.`,
  };
}

// ---------------------------------------------------------------------------
// Phones, tags, notes
// ---------------------------------------------------------------------------

export async function addContactPhone(
  contactId: string,
  phone: string,
  label?: string,
): Promise<ActionResult> {
  const member = await requirePerm("contacts.manage");
  const norm = normalizePhone(phone);
  if (!norm) return fail("Enter a valid phone number");
  const admin = createAdminClient();
  const [c] = await fetchContactsByIds(admin, member.orgId, [contactId]);
  if (!c) return fail("Contact not found");
  if (c.phone_e164 === norm.e164) return fail("That is already the primary phone");
  const { error } = await admin
    .from("contact_phones")
    .insert({
      org_id: member.orgId,
      contact_id: contactId,
      phone_e164: norm.e164,
      label: label?.trim() || null,
    });
  if (error)
    return fail(
      error.code === "23505" ? "That phone is already listed." : "Could not add the phone.",
    );
  await addTimelineEvent(admin, {
    orgId: member.orgId,
    contactId,
    type: "phone.added",
    actorId: member.userId,
  });
  revalidatePath("/contacts");
  return { ok: true, message: "Phone added." };
}

export async function removeContactPhone(phoneId: string): Promise<ActionResult> {
  const member = await requirePerm("contacts.manage");
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("contact_phones")
    .delete()
    .eq("id", phoneId)
    .eq("org_id", member.orgId)
    .select("contact_id");
  if (error || !data?.length) return fail("Could not remove the phone.");
  await addTimelineEvent(admin, {
    orgId: member.orgId,
    contactId: data[0].contact_id,
    type: "phone.removed",
    actorId: member.userId,
  });
  revalidatePath("/contacts");
  return { ok: true };
}

export async function makePhonePrimary(phoneId: string): Promise<ActionResult> {
  const member = await requirePerm("contacts.manage");
  const admin = createAdminClient();
  const { data: ph } = await admin
    .from("contact_phones")
    .select("id, contact_id, phone_e164")
    .eq("id", phoneId)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!ph) return fail("Phone not found");
  const [c] = await fetchContactsByIds(admin, member.orgId, [ph.contact_id]);
  if (!c) return fail("Contact not found");
  // Swap: old primary becomes an alternate.
  await admin.from("contact_phones").delete().eq("id", phoneId);
  const { error } = await admin
    .from("contacts")
    .update({ phone_e164: ph.phone_e164 })
    .eq("id", c.id);
  if (error) {
    await admin
      .from("contact_phones")
      .insert({ org_id: member.orgId, contact_id: c.id, phone_e164: ph.phone_e164 });
    return fail(uniqueViolation(error) ?? "Could not change the primary phone.");
  }
  if (c.phone_e164)
    await admin
      .from("contact_phones")
      .insert({ org_id: member.orgId, contact_id: c.id, phone_e164: c.phone_e164 });
  await addTimelineEvent(admin, {
    orgId: member.orgId,
    contactId: c.id,
    type: "phone.primary_changed",
    actorId: member.userId,
  });
  revalidatePath("/contacts");
  return { ok: true, message: "Primary phone updated." };
}

const tagSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: z
    .string()
    .regex(/^[a-z]+$/)
    .default("gray"),
});

export async function createTag(input: {
  name: string;
  color?: string;
}): Promise<ActionResult<{ id: string; name: string; color: string }>> {
  const member = await requirePerm("contacts.manage");
  const parsed = tagSchema.safeParse(input);
  if (!parsed.success) return fail("Enter a tag name");
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("tags")
    .insert({
      org_id: member.orgId,
      scope: "contact",
      name: parsed.data.name,
      color: parsed.data.color,
    })
    .select("id, name, color")
    .single();
  if (error)
    return fail(error.code === "23505" ? "That tag already exists." : "Could not create the tag.");
  revalidatePath("/contacts");
  return { ok: true, data };
}

export async function setContactTags(contactId: string, tagIds: string[]): Promise<ActionResult> {
  const member = await requirePerm("contacts.manage");
  const parsed = z.array(uuid).max(100).safeParse(tagIds);
  if (!parsed.success) return fail("Invalid tags");
  const admin = createAdminClient();
  const { data: current } = await admin
    .from("contact_tags")
    .select("tag_id")
    .eq("contact_id", contactId)
    .eq("org_id", member.orgId);
  const have = new Set((current ?? []).map((t) => t.tag_id));
  const want = new Set(parsed.data);
  const add = [...want].filter((t) => !have.has(t));
  const remove = [...have].filter((t) => !want.has(t));
  if (add.length) {
    const { error } = await admin
      .from("contact_tags")
      .insert(
        add.map((tag_id) => ({
          org_id: member.orgId,
          contact_id: contactId,
          tag_id,
          added_by: member.userId,
        })),
      );
    if (error) return fail("Could not add the tags.");
  }
  if (remove.length)
    await admin.from("contact_tags").delete().eq("contact_id", contactId).in("tag_id", remove);
  if (add.length || remove.length)
    await addTimelineEvent(admin, {
      orgId: member.orgId,
      contactId,
      type: "tags.changed",
      actorId: member.userId,
      payload: { added: add, removed: remove },
    });
  revalidatePath("/contacts");
  return { ok: true };
}

export async function addNote(contactId: string, text: string): Promise<ActionResult> {
  const member = await requirePerm("contacts.manage");
  const body = text.trim();
  if (!body) return fail("Write something first");
  if (body.length > 4000) return fail("Notes are limited to 4000 characters");
  const admin = createAdminClient();
  const [c] = await fetchContactsByIds(admin, member.orgId, [contactId]);
  if (!c) return fail("Contact not found");
  await addTimelineEvent(admin, {
    orgId: member.orgId,
    contactId,
    type: "note",
    actorId: member.userId,
    payload: { text: body },
  });
  revalidatePath("/contacts");
  return { ok: true, message: "Note added." };
}

// ---------------------------------------------------------------------------
// Bulk actions
// ---------------------------------------------------------------------------

async function ownedIds(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  ids: string[],
): Promise<string[]> {
  const { data } = await admin
    .from("contacts")
    .select("id")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .in("id", ids);
  return (data ?? []).map((c) => c.id);
}

export async function bulkTag(
  ids: string[],
  tagId: string,
  mode: "add" | "remove",
): Promise<ActionResult> {
  const member = await requirePerm("contacts.manage");
  const parsed = uuids.safeParse(ids);
  if (!parsed.success || !uuid.safeParse(tagId).success) return fail("Select contacts and a tag");
  const admin = createAdminClient();
  const owned = await ownedIds(admin, member.orgId, parsed.data);
  if (mode === "add") {
    const { error } = await admin.from("contact_tags").upsert(
      owned.map((contact_id) => ({
        org_id: member.orgId,
        contact_id,
        tag_id: tagId,
        added_by: member.userId,
      })),
      { onConflict: "contact_id,tag_id", ignoreDuplicates: true },
    );
    if (error) return fail("Could not add the tag.");
  } else {
    await admin.from("contact_tags").delete().eq("tag_id", tagId).in("contact_id", owned);
  }
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: `contact.bulk_tag_${mode}`,
    entity: "contact",
    diff: { count: owned.length, tag_id: tagId },
  });
  revalidatePath("/contacts");
  return {
    ok: true,
    message: `Tag ${mode === "add" ? "added to" : "removed from"} ${owned.length} contacts.`,
  };
}

export async function bulkSegment(
  ids: string[],
  segmentId: string,
  mode: "add" | "remove",
): Promise<ActionResult> {
  const member = await requirePerm("contacts.manage");
  const parsed = uuids.safeParse(ids);
  if (!parsed.success || !uuid.safeParse(segmentId).success)
    return fail("Select contacts and a segment");
  const admin = createAdminClient();
  const { data: seg } = await admin
    .from("segments")
    .select("id, kind")
    .eq("org_id", member.orgId)
    .eq("id", segmentId)
    .maybeSingle();
  if (!seg) return fail("Segment not found");
  if (seg.kind !== "static") return fail("Only static segments can be edited by hand.");
  const owned = await ownedIds(admin, member.orgId, parsed.data);
  if (mode === "add") {
    const { error } = await admin.from("segment_members").upsert(
      owned.map((contact_id) => ({
        org_id: member.orgId,
        segment_id: segmentId,
        contact_id,
        added_by: member.userId,
      })),
      { onConflict: "segment_id,contact_id", ignoreDuplicates: true },
    );
    if (error) return fail("Could not add to the segment.");
  } else {
    await admin
      .from("segment_members")
      .delete()
      .eq("segment_id", segmentId)
      .in("contact_id", owned);
  }
  await refreshSegmentCountInternal(admin, member.orgId, segmentId, member.org.timezone);
  revalidatePath("/contacts");
  return {
    ok: true,
    message: `${owned.length} contacts ${mode === "add" ? "added to" : "removed from"} the segment.`,
  };
}

const bulkPatchSchema = z.object({
  owner_id: uuid.nullable().optional(),
  assignee_id: uuid.nullable().optional(),
  promotions_opt_in: z.boolean().optional(),
  stop_marketing: z.boolean().optional(),
  language: z.string().trim().max(40).nullable().optional(),
  label: z.string().trim().max(80).nullable().optional(),
  source: z.string().optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
});
export type BulkPatch = z.input<typeof bulkPatchSchema>;

export async function bulkUpdate(ids: string[], patch: BulkPatch): Promise<ActionResult> {
  const member = await requirePerm("contacts.manage");
  const parsedIds = uuids.safeParse(ids);
  const parsed = bulkPatchSchema.safeParse(patch);
  if (!parsedIds.success || !parsed.success) return fail("Nothing to update");
  const admin = createAdminClient();
  const owned = await ownedIds(admin, member.orgId, parsedIds.data);
  const { custom, ...scalar } = parsed.data;
  const write: TablesUpdate<"contacts"> = { ...scalar };
  if (custom && Object.keys(custom).length) {
    const { customFields } = await loadContactContext(admin, member.orgId);
    const res = coerceCustomObject(customFields, custom, { partial: true });
    if (!res.ok) return fail(Object.values(res.errors)[0]);
    // jsonb merge per row
    const rows = await fetchContactsByIds(admin, member.orgId, owned);
    for (const r of rows) {
      const merged = { ...r.custom, ...res.value };
      for (const [k, v] of Object.entries(custom)) if (v === null || v === "") delete merged[k];
      await admin
        .from("contacts")
        .update({ ...write, custom: merged as JsonObject })
        .eq("id", r.id);
    }
  } else if (Object.keys(write).length) {
    const { error } = await admin
      .from("contacts")
      .update(write)
      .eq("org_id", member.orgId)
      .in("id", owned);
    if (error) return fail("Could not update the contacts.");
  } else return fail("Nothing to update");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "contact.bulk_updated",
    entity: "contact",
    diff: { count: owned.length, fields: Object.keys(parsed.data) },
  });
  revalidatePath("/contacts");
  return { ok: true, message: `${owned.length} contacts updated.` };
}

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

const segmentSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(["static", "dynamic"]),
  filter: filterSchema.nullable().optional(),
});
export type SegmentInput = z.input<typeof segmentSchema>;

async function refreshSegmentCountInternal(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  segmentId: string,
  timezone: string,
): Promise<number> {
  const { data: seg } = await admin
    .from("segments")
    .select("id, kind, filter")
    .eq("org_id", orgId)
    .eq("id", segmentId)
    .maybeSingle();
  if (!seg) return 0;
  let n = 0;
  if (seg.kind === "static") {
    const { count } = await admin
      .from("segment_members")
      .select("contact_id", { count: "exact", head: true })
      .eq("segment_id", segmentId);
    n = count ?? 0;
  } else {
    const ctx = await loadContactContext(admin, orgId);
    const parsed = filterSchema.safeParse(seg.filter);
    n = parsed.success ? await countContacts(admin, orgId, ctx.registry, parsed.data, timezone) : 0;
  }
  await admin
    .from("segments")
    .update({ member_count: n, count_refreshed_at: new Date().toISOString() })
    .eq("id", segmentId);
  return n;
}

export async function saveSegment(
  id: string | null,
  input: SegmentInput,
): Promise<ActionResult<{ id: string }>> {
  const member = await requirePerm("contacts.manage");
  const parsed = segmentSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid segment");
  if (parsed.data.kind === "dynamic" && !parsed.data.filter)
    return fail("A dynamic segment needs a filter");
  const admin = createAdminClient();
  try {
    if (parsed.data.kind === "dynamic") {
      const ctx = await loadContactContext(admin, member.orgId);
      await countContacts(
        admin,
        member.orgId,
        ctx.registry,
        parsed.data.filter,
        member.org.timezone,
      ); // validates the filter
    }
  } catch (e) {
    return fail(describeError(e, "The filter is not valid."));
  }
  const row = {
    name: parsed.data.name,
    kind: parsed.data.kind,
    filter: (parsed.data.kind === "dynamic" ? parsed.data.filter : null) as unknown as Json,
  };
  let segmentId = id;
  if (id) {
    const { error } = await admin
      .from("segments")
      .update(row)
      .eq("id", id)
      .eq("org_id", member.orgId);
    if (error)
      return fail(
        error.code === "23505" ? "A segment with that name exists." : "Could not save the segment.",
      );
  } else {
    const { data, error } = await admin
      .from("segments")
      .insert({ org_id: member.orgId, created_by: member.userId, ...row })
      .select("id")
      .single();
    if (error)
      return fail(
        error.code === "23505"
          ? "A segment with that name exists."
          : "Could not create the segment.",
      );
    segmentId = data.id;
  }
  await refreshSegmentCountInternal(admin, member.orgId, segmentId!, member.org.timezone);
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: id ? "segment.updated" : "segment.created",
    entity: "segment",
    entityId: segmentId,
    diff: { name: row.name, kind: row.kind },
  });
  revalidatePath("/contacts");
  return {
    ok: true,
    data: { id: segmentId! },
    message: id ? "Segment saved." : "Segment created.",
  };
}

export async function deleteSegment(id: string): Promise<ActionResult> {
  const member = await requirePerm("contacts.manage");
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("segments")
    .delete()
    .eq("id", id)
    .eq("org_id", member.orgId)
    .select("name");
  if (error || !data?.length) return fail("Could not delete the segment.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "segment.deleted",
    entity: "segment",
    entityId: id,
    diff: { name: data[0].name },
  });
  revalidatePath("/contacts");
  return { ok: true, message: "Segment deleted." };
}

export async function refreshSegmentCounts(): Promise<
  ActionResult<{ counts: Record<string, number> }>
> {
  const member = await requirePerm("contacts.view");
  const admin = createAdminClient();
  const { data: segs } = await admin.from("segments").select("id").eq("org_id", member.orgId);
  const counts: Record<string, number> = {};
  for (const s of segs ?? [])
    counts[s.id] = await refreshSegmentCountInternal(
      admin,
      member.orgId,
      s.id,
      member.org.timezone,
    );
  return { ok: true, data: { counts } };
}

/** Preview the number of contacts a filter matches (filter panel). */
export async function previewFilterCount(
  filter: unknown,
): Promise<ActionResult<{ count: number }>> {
  const member = await requirePerm("contacts.view");
  const parsed = filterSchema.safeParse(filter);
  if (!parsed.success) return fail("Invalid filter");
  const admin = createAdminClient();
  try {
    const ctx = await loadContactContext(admin, member.orgId);
    const count = await countContacts(
      admin,
      member.orgId,
      ctx.registry,
      parsed.data,
      member.org.timezone,
    );
    return { ok: true, data: { count } };
  } catch (e) {
    return fail(describeError(e, "Invalid filter"));
  }
}

// ---------------------------------------------------------------------------
// Grid preferences
// ---------------------------------------------------------------------------

const gridPrefsSchema = z.object({
  columns: z
    .array(
      z.object({
        id: z.string().max(80),
        width: z.number().int().min(40).max(1200).optional(),
        hidden: z.boolean().optional(),
      }),
    )
    .max(100),
  pageSize: z.number().int().min(10).max(500).optional(),
});
export type GridPrefs = z.infer<typeof gridPrefsSchema>;

export async function saveGridPrefs(gridKey: string, prefs: GridPrefs): Promise<ActionResult> {
  const member = await requireMember();
  const parsed = gridPrefsSchema.safeParse(prefs);
  if (!parsed.success || !/^[a-z_]+$/.test(gridKey)) return fail("Invalid preferences");
  const admin = createAdminClient();
  const { error } = await admin
    .from("user_grid_prefs")
    .upsert(
      {
        org_id: member.orgId,
        user_id: member.userId,
        grid_key: gridKey,
        prefs: parsed.data as unknown as JsonObject,
      },
      { onConflict: "org_id,user_id,grid_key" },
    );
  if (error) return fail("Could not save the layout.");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

const preparedContactSchema = z.object({
  first_name: z.string().max(80),
  last_name: z.string().max(80),
  phone_e164: z
    .string()
    .regex(/^\+[1-9][0-9]{6,14}$/)
    .nullable(),
  alternate_phones: z.array(z.string().regex(/^\+[1-9][0-9]{6,14}$/)).max(10),
  email: z.string().max(254).nullable(),
  gender: z.enum(["female", "male", "other", "unknown"]).nullable(),
  nationality: z.string().max(80).nullable(),
  country: z.string().length(2).nullable(),
  language: z.string().max(40).nullable(),
  dob: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  label: z.string().max(80).nullable(),
  external_id: z.string().max(80).nullable(),
  promotions_opt_in: z.boolean().nullable(),
  stop_marketing: z.boolean().nullable(),
  tags: z.array(z.string().max(40)).max(20),
  source: z.string().max(40).nullable(),
  note: z.string().max(4000).nullable(),
  custom: z.record(z.string(), z.unknown()),
});

const importChunkSchema = z.object({
  rows: z.array(preparedContactSchema).min(1).max(500),
  mode: z.enum(["skip", "update"]).default("skip"),
  batchId: z.string().max(64),
});

export type ImportChunkResult = {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: string[];
};

/**
 * Writes one chunk of prepared rows. Matches existing contacts by phone, then
 * external id. Idempotent: re-importing the same file updates or skips.
 */
export async function importContactsChunk(input: {
  rows: PreparedContact[];
  mode: "skip" | "update";
  batchId: string;
}): Promise<ActionResult<ImportChunkResult>> {
  const member = await requirePerm("contacts.manage");
  const parsed = importChunkSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid rows");
  const admin = createAdminClient();
  const ctx = await loadContactContext(admin, member.orgId);
  const result: ImportChunkResult = { created: 0, updated: 0, skipped: 0, failed: 0, errors: [] };
  const tagIds = new Map(ctx.tags.map((t) => [t.name.toLowerCase(), t.id]));

  for (const row of parsed.data.rows) {
    const m = await matchContact(admin, member.orgId, {
      externalId: row.external_id,
      phone: row.phone_e164,
    });
    if (m.kind === "ambiguous") {
      result.failed++;
      result.errors.push(
        "Several existing contacts match this phone / external ID; merge them first.",
      );
      continue;
    }
    if (m.kind === "match" && parsed.data.mode === "skip") {
      result.skipped++;
      continue;
    }
    const res = await writePreparedContact(admin, {
      orgId: member.orgId,
      existingId: m.kind === "match" ? m.id : null,
      existingCustom: m.kind === "match" ? m.custom : null,
      contact: row,
      defaultSource: "import_csv",
      customFields: ctx.customFields,
      tagIds,
      actorId: member.userId,
      batch: parsed.data.batchId,
    });
    if (!res.ok) {
      result.failed++;
      result.errors.push(res.error);
      continue;
    }
    if (res.created) result.created++;
    else result.updated++;
  }

  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "contact.imported",
    entity: "contact",
    entityId: parsed.data.batchId,
    diff: {
      created: result.created,
      updated: result.updated,
      skipped: result.skipped,
      failed: result.failed,
    },
  });
  revalidatePath("/contacts");
  return { ok: true, data: result };
}

// ---------------------------------------------------------------------------
// Duplicates & merge
// ---------------------------------------------------------------------------

export type DuplicatePair = { a: ContactListRow; b: ContactListRow; reason: string };

export async function listDuplicates(): Promise<ActionResult<{ pairs: DuplicatePair[] }>> {
  const member = await requirePerm("contacts.view");
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("contact_duplicate_candidates", {
    p_org_id: member.orgId,
    p_limit: 100,
  });
  if (error) return fail("Could not load duplicates.");
  const ids = [...new Set((data ?? []).flatMap((p) => [p.a_id, p.b_id]))];
  const rows = await fetchContactsByIds(admin, member.orgId, ids);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const pairs = (data ?? [])
    .map((p) => ({ a: byId.get(p.a_id), b: byId.get(p.b_id), reason: p.reason }))
    .filter((p): p is DuplicatePair => !!p.a && !!p.b);
  return { ok: true, data: { pairs } };
}

export async function mergeContacts(
  primaryId: string,
  secondaryId: string,
  picks: Partial<Record<MergeField, "primary" | "secondary">>,
): Promise<ActionResult> {
  const member = await requirePerm("contacts.manage");
  if (
    !uuid.safeParse(primaryId).success ||
    !uuid.safeParse(secondaryId).success ||
    primaryId === secondaryId
  )
    return fail("Pick two different contacts");
  const admin = createAdminClient();
  const rows = await fetchContactsByIds(admin, member.orgId, [primaryId, secondaryId]);
  const p = rows.find((r) => r.id === primaryId);
  const s = rows.find((r) => r.id === secondaryId);
  if (!p || !s || p.deleted_at || s.deleted_at) return fail("Contact not found");
  const side = (c: ContactListRow) =>
    Object.fromEntries(
      MERGE_FIELDS.map((f) => [f, (c as unknown as Record<string, string | null>)[f] ?? null]),
    );
  const safePicks: Partial<Record<MergeField, "primary" | "secondary">> = {};
  for (const f of MERGE_FIELDS) if (picks[f] === "secondary") safePicks[f] = "secondary";
  const fields = resolveMergeFields(side(p), side(s), safePicks);
  const { error } = await admin.rpc("merge_contacts", {
    p_org_id: member.orgId,
    p_primary_id: primaryId,
    p_secondary_id: secondaryId,
    p_fields: fields,
    p_user_id: member.userId,
  });
  if (error)
    return fail(
      error.message.includes("duplicate key")
        ? "The merged identifiers clash with another contact."
        : "Merge failed.",
    );
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "contact.merged",
    entity: "contact",
    entityId: primaryId,
    diff: { merged: secondaryId },
  });
  revalidatePath("/contacts");
  return { ok: true, message: "Contacts merged." };
}

/** Whether the current member may export (used to show the button). */
export async function exportPermission(): Promise<boolean> {
  const member = await requireMember();
  return can(member, "contacts.export");
}
