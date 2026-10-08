"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { CUSTOM_FIELD_TYPES, customFieldOption } from "@/lib/contacts/custom-values";
import { createAdminClient } from "@/lib/supabase/admin";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

const RESERVED = new Set(["id", "org_id", "custom", "tags", "segments", "phone", "email", "first_name", "last_name", "full_name"]);

const fieldSchema = z.object({
  entity: z.enum(["contact", "enquiry", "appointment"]).default("contact"),
  key: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z][a-z0-9_]{0,63}$/, "Key must start with a letter and use only a-z, 0-9 and _"),
  label: z.string().trim().min(1, "Label is required").max(80),
  type: z.enum(CUSTOM_FIELD_TYPES),
  options: z.array(customFieldOption).max(200).default([]),
  required: z.boolean().default(false),
});
export type CustomFieldInputValues = z.input<typeof fieldSchema>;

/** Turns a label into a key: "Insurance plan" → insurance_plan. */
export async function slugifyKey(label: string): Promise<string> {
  return label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 64);
}

export async function createCustomField(input: CustomFieldInputValues): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = fieldSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid field" };
  if (RESERVED.has(parsed.data.key)) return { ok: false, error: "That key is reserved." };
  if ((parsed.data.type === "select" || parsed.data.type === "multi_select") && parsed.data.options.length === 0)
    return { ok: false, error: "Add at least one option." };
  const admin = createAdminClient();
  const { count } = await admin.from("custom_fields").select("id", { count: "exact", head: true }).eq("org_id", member.orgId).eq("entity", parsed.data.entity);
  const { data, error } = await admin
    .from("custom_fields")
    .insert({ org_id: member.orgId, ...parsed.data, sort: count ?? 0 })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.code === "23505" ? "A field with that key already exists." : "Could not create the field." };
  await recordAudit(admin, { orgId: member.orgId, userId: member.userId, action: "custom_field.created", entity: "custom_field", entityId: data.id, diff: { key: parsed.data.key, type: parsed.data.type } });
  revalidatePath("/settings/custom-fields");
  revalidatePath("/contacts");
  return { ok: true, message: "Field created." };
}

export async function updateCustomField(id: string, input: Omit<CustomFieldInputValues, "key" | "entity">): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const admin = createAdminClient();
  const { data: existing } = await admin.from("custom_fields").select("id, key, entity, type").eq("id", id).eq("org_id", member.orgId).maybeSingle();
  if (!existing) return { ok: false, error: "Field not found." };
  const parsed = fieldSchema.safeParse({ ...input, key: existing.key, entity: existing.entity });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid field" };
  if ((parsed.data.type === "select" || parsed.data.type === "multi_select") && parsed.data.options.length === 0)
    return { ok: false, error: "Add at least one option." };
  const { error } = await admin
    .from("custom_fields")
    .update({ label: parsed.data.label, type: parsed.data.type, options: parsed.data.options, required: parsed.data.required })
    .eq("id", id);
  if (error) return { ok: false, error: "Could not save the field." };
  await recordAudit(admin, { orgId: member.orgId, userId: member.userId, action: "custom_field.updated", entity: "custom_field", entityId: id, diff: { key: existing.key, type_changed: existing.type !== parsed.data.type } });
  revalidatePath("/settings/custom-fields");
  revalidatePath("/contacts");
  return { ok: true, message: "Field saved." };
}

export async function deleteCustomField(id: string): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const admin = createAdminClient();
  const { data, error } = await admin.from("custom_fields").delete().eq("id", id).eq("org_id", member.orgId).select("key");
  if (error || !data?.length) return { ok: false, error: "Could not delete the field." };
  await recordAudit(admin, { orgId: member.orgId, userId: member.userId, action: "custom_field.deleted", entity: "custom_field", entityId: id, diff: { key: data[0].key } });
  revalidatePath("/settings/custom-fields");
  revalidatePath("/contacts");
  return { ok: true, message: "Field deleted. Existing values stay on the records until overwritten." };
}

export async function reorderCustomFields(entity: string, orderedIds: string[]): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const parsed = z.array(z.string().uuid()).max(200).safeParse(orderedIds);
  if (!parsed.success) return { ok: false, error: "Invalid order" };
  const admin = createAdminClient();
  for (let i = 0; i < parsed.data.length; i++)
    await admin.from("custom_fields").update({ sort: i }).eq("id", parsed.data[i]).eq("org_id", member.orgId).eq("entity", entity);
  revalidatePath("/settings/custom-fields");
  revalidatePath("/contacts");
  return { ok: true };
}
