import "server-only";

import { z } from "zod";

import { emit } from "@/lib/events/emit";
import { toE164 } from "@/lib/whatsapp/phone";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Tables, TablesUpdate } from "@/lib/supabase/types";

/**
 * Contact resource for /api/public/v1/contacts. Contacts are matched by E.164 phone (CLAUDE.md rule 5);
 * writing the same phone twice updates the one contact instead of creating a duplicate.
 */

const text = (max: number) => z.string().trim().max(max);
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), "Not a real date");

const fields = {
  first_name: text(100),
  last_name: text(100),
  phone: text(32).min(1),
  email: z.string().trim().toLowerCase().email().max(254),
  gender: z.enum(["female", "male", "other", "unknown"]),
  nationality: text(80),
  country: z.string().regex(/^[A-Z]{2}$/, "Use a 2-letter ISO country code, e.g. AE"),
  language: text(10),
  dob: isoDate,
  external_id: text(100).min(1),
  promotions_opt_in: z.boolean(),
  /** The API can record an opt-out but never lift one: re-opt-in needs evidence staff must record. */
  stop_marketing: z.literal(true, { error: "stop_marketing can only be set to true through the API." }),
};

export const createContactSchema = z
  .object({ phone: fields.phone })
  .extend({
    first_name: fields.first_name.optional(),
    last_name: fields.last_name.optional(),
    email: fields.email.nullable().optional(),
    gender: fields.gender.optional(),
    nationality: fields.nationality.optional(),
    country: fields.country.optional(),
    language: fields.language.optional(),
    dob: fields.dob.optional(),
    external_id: fields.external_id.optional(),
    promotions_opt_in: fields.promotions_opt_in.optional(),
    stop_marketing: fields.stop_marketing.optional(),
  })
  .strict();
export type CreateContactInput = z.infer<typeof createContactSchema>;

export const updateContactSchema = z
  .object({
    first_name: fields.first_name,
    last_name: fields.last_name,
    phone: fields.phone,
    email: fields.email.nullable(),
    gender: fields.gender,
    nationality: fields.nationality,
    country: fields.country,
    language: fields.language,
    dob: fields.dob,
    external_id: fields.external_id,
    promotions_opt_in: fields.promotions_opt_in,
    stop_marketing: fields.stop_marketing,
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Send at least one field to update.");
export type UpdateContactInput = z.infer<typeof updateContactSchema>;

type ContactRow = Tables<"contacts">;

export function serializeContact(c: ContactRow) {
  return {
    id: c.id,
    first_name: c.first_name,
    last_name: c.last_name,
    phone: c.phone_e164,
    email: c.email,
    gender: c.gender,
    nationality: c.nationality,
    country: c.country,
    language: c.language,
    dob: c.dob,
    external_id: c.external_id,
    promotions_opt_in: c.promotions_opt_in,
    stop_marketing: c.stop_marketing,
    source: c.source,
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
}

export type ContactResult =
  | { ok: true; contact: ContactRow; created: boolean }
  | { ok: false; status: number; code: string; message: string };

const invalidPhone = { ok: false, status: 422, code: "invalid_phone", message: "That phone number is not valid. Use international format, e.g. +971501234567." } as const;
// Deliberately does not say which value clashed, so a write-only key cannot probe for existing external ids.
const conflict = (): ContactResult => ({ ok: false, status: 409, code: "conflict", message: "That value conflicts with an existing contact." });

function updateFromInput(input: Partial<CreateContactInput & UpdateContactInput>): TablesUpdate<"contacts"> {
  const patch: TablesUpdate<"contacts"> = {};
  for (const k of ["first_name", "last_name", "email", "gender", "nationality", "country", "language", "dob", "external_id", "promotions_opt_in", "stop_marketing"] as const) {
    if (input[k] !== undefined) (patch as Record<string, unknown>)[k] = input[k];
  }
  return patch;
}

/**
 * Every live contact that owns this phone: the primary number first, then alternates in
 * contact_phones (secondary and merged numbers). Matching only the primary column would miss a
 * patient reached on their second number and create a duplicate with stop_marketing = false,
 * which could send marketing to someone who opted out (CLAUDE.md rules 5 and 11).
 */
export async function findContactsByPhone(admin: AdminClient, orgId: string, phone: string): Promise<ContactRow[]> {
  const found: ContactRow[] = [];
  const { data: primary } = await admin
    .from("contacts")
    .select("*")
    .eq("org_id", orgId)
    .eq("phone_e164", phone)
    .is("deleted_at", null)
    .is("merged_into_id", null);
  found.push(...(primary ?? []));

  const { data: alts } = await admin.from("contact_phones").select("contact_id").eq("org_id", orgId).eq("phone_e164", phone);
  const extraIds = [...new Set((alts ?? []).map((a) => a.contact_id))].filter((id) => !found.some((c) => c.id === id));
  if (extraIds.length) {
    const { data: more } = await admin
      .from("contacts")
      .select("*")
      .eq("org_id", orgId)
      .in("id", extraIds)
      .is("deleted_at", null)
      .is("merged_into_id", null);
    found.push(...(more ?? []));
  }
  return found;
}

async function afterWrite(orgId: string, before: ContactRow | null, after: ContactRow) {
  if (!before) await emit(orgId, "contact.created", { contact_id: after.id, source: "api" });
  if (after.stop_marketing && !before?.stop_marketing) await emit(orgId, "contact.stop_marketing", { contact_id: after.id, source: "api" });
}

/** Create, or update the contact that already owns this phone. */
export async function upsertContact(admin: AdminClient, orgId: string, input: CreateContactInput): Promise<ContactResult> {
  const phone = toE164(input.phone);
  if (!phone) return invalidPhone;
  const patch = updateFromInput(input);

  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = (await findContactsByPhone(admin, orgId, phone))[0];
    if (existing) {
      if (Object.keys(patch).length === 0) return { ok: true, contact: existing, created: false };
      const { data, error } = await admin.from("contacts").update(patch).eq("id", existing.id).eq("org_id", orgId).select("*").single();
      if (error) return error.code === "23505" ? conflict() : { ok: false, status: 500, code: "internal_error", message: "Could not update the contact." };
      await afterWrite(orgId, existing, data);
      return { ok: true, contact: data, created: false };
    }
    const { data, error } = await admin
      .from("contacts")
      .insert({ ...patch, org_id: orgId, phone_e164: phone, source: "api" })
      .select("*")
      .single();
    if (!error) {
      await afterWrite(orgId, null, data);
      return { ok: true, contact: data, created: true };
    }
    if (error.code !== "23505") return { ok: false, status: 500, code: "internal_error", message: "Could not create the contact." };
    // Unique violation: either a concurrent create of the same phone (retry finds it) or a clashing external id.
    if ((await findContactsByPhone(admin, orgId, phone)).length) continue;
    return conflict();
  }
  return { ok: false, status: 409, code: "conflict", message: "The contact was changed by another request. Retry." };
}

export async function updateContact(admin: AdminClient, orgId: string, id: string, input: UpdateContactInput): Promise<ContactResult> {
  const { data: existing } = await admin.from("contacts").select("*").eq("id", id).eq("org_id", orgId).is("deleted_at", null).maybeSingle();
  if (!existing) return { ok: false, status: 404, code: "not_found", message: "Contact not found." };

  const patch = updateFromInput(input);
  if (input.phone !== undefined) {
    const phone = toE164(input.phone);
    if (!phone) return invalidPhone;
    patch.phone_e164 = phone;
  }
  const { data, error } = await admin.from("contacts").update(patch).eq("id", id).eq("org_id", orgId).select("*").single();
  if (error) return error.code === "23505" ? conflict() : { ok: false, status: 500, code: "internal_error", message: "Could not update the contact." };
  await afterWrite(orgId, existing, data);
  return { ok: true, contact: data, created: false };
}
