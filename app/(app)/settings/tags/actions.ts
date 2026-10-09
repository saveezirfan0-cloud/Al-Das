"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { TAG_COLORS } from "@/lib/contacts/format";
import { createAdminClient } from "@/lib/supabase/admin";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

const tagSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(40),
  color: z.enum(TAG_COLORS).default("gray"),
});
export type TagInput = z.input<typeof tagSchema>;

export async function saveTag(id: string | null, input: TagInput): Promise<ActionResult> {
  const member = await requirePerm("contacts.manage");
  const parsed = tagSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid tag" };
  const admin = createAdminClient();
  const { error } = id
    ? await admin.from("tags").update(parsed.data).eq("id", id).eq("org_id", member.orgId)
    : await admin.from("tags").insert({ org_id: member.orgId, scope: "contact", ...parsed.data });
  if (error)
    return {
      ok: false,
      error:
        error.code === "23505" ? "A tag with that name already exists." : "Could not save the tag.",
    };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: id ? "tag.updated" : "tag.created",
    entity: "tag",
    entityId: id,
    diff: { name: parsed.data.name },
  });
  revalidatePath("/settings/tags");
  revalidatePath("/contacts");
  return { ok: true, message: id ? "Tag saved." : "Tag created." };
}

export async function deleteTag(id: string): Promise<ActionResult> {
  const member = await requirePerm("contacts.manage");
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("tags")
    .delete()
    .eq("id", id)
    .eq("org_id", member.orgId)
    .select("name");
  if (error || !data?.length) return { ok: false, error: "Could not delete the tag." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "tag.deleted",
    entity: "tag",
    entityId: id,
    diff: { name: data[0].name },
  });
  revalidatePath("/settings/tags");
  revalidatePath("/contacts");
  return { ok: true, message: "Tag deleted." };
}
