"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { assertCan } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { TAG_COLORS } from "@/lib/contacts/format";
import { createAdminClient } from "@/lib/supabase/admin";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

const tagSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(40),
  color: z.enum(TAG_COLORS).default("gray"),
});
export type TagInput = z.input<typeof tagSchema>;

/** Contact tags are managed with contacts.manage, enquiry tags (Phase 20a) with enquiries.manage. */
export type TagScope = "contact" | "enquiry";
const SCOPE_PERM: Record<TagScope, string> = {
  contact: "contacts.manage",
  enquiry: "enquiries.manage",
};

/** The member, after checking the permission for the scope of the tag being changed. */
async function gate(scope: TagScope) {
  const member = await requireMember();
  assertCan(member, SCOPE_PERM[scope]);
  return member;
}

/** Scope of an existing tag of this org (null when not found or another scope, e.g. conversation labels). */
async function scopeOf(orgId: string, id: string): Promise<TagScope | null> {
  const { data } = await createAdminClient()
    .from("tags")
    .select("scope")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  return data?.scope === "contact" || data?.scope === "enquiry" ? data.scope : null;
}

export async function saveTag(
  id: string | null,
  input: TagInput,
  newScope: TagScope = "contact",
): Promise<ActionResult> {
  const self = await requireMember();
  const scope = id ? await scopeOf(self.orgId, id) : newScope;
  if (!scope || !(scope in SCOPE_PERM)) return { ok: false, error: "Tag not found." };
  const member = await gate(scope);
  const parsed = tagSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid tag" };
  const admin = createAdminClient();
  const { error } = id
    ? await admin.from("tags").update(parsed.data).eq("id", id).eq("org_id", member.orgId)
    : await admin.from("tags").insert({ org_id: member.orgId, scope, ...parsed.data });
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
    diff: { name: parsed.data.name, scope },
  });
  revalidatePath("/settings/tags");
  revalidatePath(scope === "enquiry" ? "/enquiries" : "/contacts");
  return { ok: true, message: id ? "Tag saved." : "Tag created." };
}

export async function deleteTag(id: string): Promise<ActionResult> {
  const self = await requireMember();
  const scope = await scopeOf(self.orgId, id);
  if (!scope) return { ok: false, error: "Could not delete the tag." };
  const member = await gate(scope);
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
    diff: { name: data[0].name, scope },
  });
  revalidatePath("/settings/tags");
  revalidatePath(scope === "enquiry" ? "/enquiries" : "/contacts");
  return { ok: true, message: "Tag deleted." };
}
