/**
 * Writes one prepared contact (from the CSV importer, the Sanoflow script or
 * the Airtable script) into the database: insert or update, alternate phones,
 * tags and a timeline event. Matching is the caller's job; this module only
 * needs the id of the contact to update (or null to create).
 *
 * No "server-only" import so the import scripts (tsx) can use it. Callers
 * must already hold a service-role client and have checked permissions.
 */
import { coerceCustomObject, type CustomFieldDef } from "@/lib/contacts/custom-values";
import type { PreparedContact } from "@/lib/contacts/import";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json, TablesUpdate } from "@/lib/supabase/types";

type JsonObject = NonNullable<Json>;

export type WriteOptions = {
  orgId: string;
  /** Existing contact to update, or null to insert. */
  existingId: string | null;
  existingCustom?: Record<string, unknown> | null;
  contact: PreparedContact;
  /** Falls back to this when the row carries no source. */
  defaultSource: string;
  customFields: CustomFieldDef[];
  /** name (lower-cased) → tag id; missing tags are created and added to the map. */
  tagIds: Map<string, string>;
  actorId: string | null;
  /** Timeline payload marker (batch id / external id). */
  batch: string;
  dryRun?: boolean;
};

export type WriteResult = { ok: true; id: string; created: boolean } | { ok: false; error: string };

export function uniqueViolationMessage(error: { code?: string; message?: string }): string | null {
  if (error.code !== "23505") return null;
  if (error.message?.includes("contacts_org_phone_uidx"))
    return "A contact with this phone number already exists.";
  if (error.message?.includes("contacts_org_external_uidx"))
    return "A contact with this external ID already exists.";
  if (error.message?.includes("contacts_org_bsuid_uidx"))
    return "A contact with this WhatsApp ID already exists.";
  return "A contact with these details already exists.";
}

export async function ensureTag(
  admin: AdminClient,
  orgId: string,
  name: string,
  tagIds: Map<string, string>,
  dryRun = false,
): Promise<string | null> {
  const key = name.toLowerCase();
  const existing = tagIds.get(key);
  if (existing) return existing;
  if (dryRun) return null;
  const { data } = await admin
    .from("tags")
    .insert({ org_id: orgId, scope: "contact", name })
    .select("id")
    .single();
  if (!data) {
    // Lost a race: re-read.
    const { data: again } = await admin
      .from("tags")
      .select("id")
      .eq("org_id", orgId)
      .eq("scope", "contact")
      .ilike("name", name)
      .maybeSingle();
    if (!again) return null;
    tagIds.set(key, again.id);
    return again.id;
  }
  tagIds.set(key, data.id);
  return data.id;
}

export async function writePreparedContact(
  admin: AdminClient,
  o: WriteOptions,
): Promise<WriteResult> {
  const row = o.contact;
  const customRes = coerceCustomObject(o.customFields, row.custom, { partial: true });
  if (!customRes.ok) return { ok: false, error: Object.values(customRes.errors)[0] };

  const base = {
    first_name: row.first_name,
    last_name: row.last_name,
    phone_e164: row.phone_e164,
    email: row.email,
    gender: row.gender,
    nationality: row.nationality,
    country: row.country,
    language: row.language,
    dob: row.dob,
    label: row.label,
    external_id: row.external_id,
  };
  const source = row.source && /^[a-z_]+$/.test(row.source) ? row.source : o.defaultSource;

  if (o.dryRun) return { ok: true, id: o.existingId ?? "dry-run", created: !o.existingId };

  let contactId: string;
  let created = false;
  if (o.existingId) {
    const patch: TablesUpdate<"contacts"> = {};
    for (const [k, v] of Object.entries(base) as Array<[keyof typeof base, string | null]>)
      if (v !== null && v !== "") patch[k] = v as never;
    if (row.promotions_opt_in !== null) patch.promotions_opt_in = row.promotions_opt_in;
    if (row.stop_marketing === true) patch.stop_marketing = true; // an import never clears an opt-out
    patch.custom = { ...(o.existingCustom ?? {}), ...customRes.value } as JsonObject;
    const { error } = await admin
      .from("contacts")
      .update(patch)
      .eq("id", o.existingId)
      .eq("org_id", o.orgId);
    if (error)
      return { ok: false, error: uniqueViolationMessage(error) ?? `Update failed (${error.code})` };
    contactId = o.existingId;
  } else {
    const { data, error } = await admin
      .from("contacts")
      .insert({
        org_id: o.orgId,
        ...base,
        source,
        promotions_opt_in: row.promotions_opt_in ?? false,
        stop_marketing: row.stop_marketing ?? false,
        custom: customRes.value as JsonObject,
        created_by: o.actorId,
      })
      .select("id")
      .single();
    if (error)
      return { ok: false, error: uniqueViolationMessage(error) ?? `Insert failed (${error.code})` };
    contactId = data.id;
    created = true;
  }

  if (row.alternate_phones.length)
    await admin.from("contact_phones").upsert(
      row.alternate_phones.map((phone_e164) => ({
        org_id: o.orgId,
        contact_id: contactId,
        phone_e164,
      })),
      { onConflict: "contact_id,phone_e164", ignoreDuplicates: true },
    );

  if (row.tags.length) {
    const ids: string[] = [];
    for (const name of row.tags) {
      const id = await ensureTag(admin, o.orgId, name, o.tagIds);
      if (id) ids.push(id);
    }
    if (ids.length)
      await admin.from("contact_tags").upsert(
        ids.map((tag_id) => ({
          org_id: o.orgId,
          contact_id: contactId,
          tag_id,
          added_by: o.actorId,
        })),
        { onConflict: "contact_id,tag_id", ignoreDuplicates: true },
      );
  }

  const events: Array<{ type: string; payload: JsonObject }> = [
    { type: created ? "import.created" : "import.updated", payload: { batch: o.batch, source } },
  ];
  if (row.note) events.push({ type: "note", payload: { text: row.note } });
  await admin.from("timeline_events").insert(
    events.map((e) => ({
      org_id: o.orgId,
      contact_id: contactId,
      type: e.type,
      actor_type: o.actorId ? "user" : "job",
      actor_id: o.actorId,
      payload: e.payload,
    })),
  );

  return { ok: true, id: contactId, created };
}

export type MatchInput = {
  externalId?: string | null;
  phone?: string | null;
  fullName?: string | null;
  dob?: string | null;
};

export type MatchResult =
  | { kind: "none" }
  | {
      kind: "match";
      id: string;
      custom: Record<string, unknown>;
      on: "external_id" | "phone" | "name_dob";
    }
  | { kind: "ambiguous"; candidates: Array<{ contact_id: string; matched_on: string }> };

/**
 * Finds the contact an imported record belongs to: Unite PIN → E.164 phone
 * (primary or alternate) → name + DOB. Several candidates = ambiguous (the
 * caller sends it to sync_reviews; never auto-merge).
 */
export async function matchContact(
  admin: AdminClient,
  orgId: string,
  m: MatchInput,
): Promise<MatchResult> {
  const custom = (c: { custom: Json }) =>
    c.custom && typeof c.custom === "object" && !Array.isArray(c.custom)
      ? (c.custom as Record<string, unknown>)
      : {};

  if (m.externalId) {
    const { data } = await admin
      .from("contacts")
      .select("id, custom")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .eq("external_id", m.externalId)
      .limit(2);
    if (data && data.length === 1)
      return { kind: "match", id: data[0].id, custom: custom(data[0]), on: "external_id" };
    if (data && data.length > 1)
      return {
        kind: "ambiguous",
        candidates: data.map((c) => ({ contact_id: c.id, matched_on: "external_id" })),
      };
  }
  if (m.phone) {
    const [{ data: primary }, { data: alt }] = await Promise.all([
      admin
        .from("contacts")
        .select("id, custom")
        .eq("org_id", orgId)
        .is("deleted_at", null)
        .eq("phone_e164", m.phone)
        .limit(5),
      admin
        .from("contact_phones")
        .select("contact_id")
        .eq("org_id", orgId)
        .eq("phone_e164", m.phone)
        .limit(5),
    ]);
    const ids = new Map<string, Record<string, unknown>>();
    for (const c of primary ?? []) ids.set(c.id, custom(c));
    if (alt && alt.length) {
      const { data: altContacts } = await admin
        .from("contacts")
        .select("id, custom")
        .in(
          "id",
          alt.map((a) => a.contact_id),
        )
        .is("deleted_at", null);
      for (const c of altContacts ?? []) ids.set(c.id, custom(c));
    }
    if (ids.size === 1) {
      const [id, cu] = [...ids.entries()][0];
      return { kind: "match", id, custom: cu, on: "phone" };
    }
    if (ids.size > 1)
      return {
        kind: "ambiguous",
        candidates: [...ids.keys()].map((contact_id) => ({ contact_id, matched_on: "phone" })),
      };
  }
  if (m.fullName && m.dob) {
    const { data } = await admin
      .from("contacts")
      .select("id, custom")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .eq("dob", m.dob)
      .ilike("full_name", m.fullName.trim())
      .limit(5);
    if (data && data.length === 1)
      return { kind: "match", id: data[0].id, custom: custom(data[0]), on: "name_dob" };
    if (data && data.length > 1)
      return {
        kind: "ambiguous",
        candidates: data.map((c) => ({ contact_id: c.id, matched_on: "name_dob" })),
      };
  }
  return { kind: "none" };
}

/** Upserts an external_refs row pointing at a local contact. */
export async function upsertExternalRef(
  admin: AdminClient,
  o: {
    orgId: string;
    source: string;
    entity: string;
    externalId: string;
    localTable: string;
    localId: string;
    meta?: JsonObject;
  },
): Promise<void> {
  await admin.from("external_refs").upsert(
    {
      org_id: o.orgId,
      source: o.source,
      entity: o.entity,
      external_id: o.externalId,
      local_table: o.localTable,
      local_id: o.localId,
      meta: o.meta ?? {},
    },
    { onConflict: "org_id,source,entity,external_id" },
  );
}

export async function findExternalRef(
  admin: AdminClient,
  o: { orgId: string; source: string; entity: string; externalId: string },
): Promise<{ localId: string; meta: Record<string, unknown> } | null> {
  const { data } = await admin
    .from("external_refs")
    .select("local_id, meta")
    .eq("org_id", o.orgId)
    .eq("source", o.source)
    .eq("entity", o.entity)
    .eq("external_id", o.externalId)
    .maybeSingle();
  if (!data) return null;
  return {
    localId: data.local_id,
    meta: (data.meta && typeof data.meta === "object" && !Array.isArray(data.meta)
      ? data.meta
      : {}) as Record<string, unknown>,
  };
}

export async function queueSyncReview(
  admin: AdminClient,
  o: {
    orgId: string;
    source: string;
    entity: string;
    externalId: string;
    reason: string;
    candidates: Array<{ contact_id: string; matched_on: string }>;
    /** What the source sent (name, phone, PIN …) so a reviewer can decide without the source open. */
    incoming?: JsonObject;
  },
): Promise<void> {
  await admin.from("sync_reviews").upsert(
    {
      org_id: o.orgId,
      source: o.source,
      entity: o.entity,
      external_id: o.externalId,
      reason: o.reason,
      candidates: o.candidates,
      ...(o.incoming ? { incoming: o.incoming } : {}),
      status: "open",
    },
    { onConflict: "org_id,source,entity,external_id" },
  );
}
