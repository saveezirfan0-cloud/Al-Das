"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { generateApiKey } from "@/lib/public-api/keys";
import { API_KEY_SCOPES, type ApiKeyScope } from "@/lib/public-api/scopes";
import { createAdminClient } from "@/lib/supabase/admin";

export type CreateResult =
  | { ok: true; data: { id: string; key: string; prefix: string } }
  | { ok: false; error: string };
export type ActionResult = { ok: true; message: string } | { ok: false; error: string };

const PATH = "/settings/api-keys";
const MAX_ACTIVE_KEYS = 50;

/** A key may only carry powers its creator already has: settings.manage alone must not unlock patient data. */
const SCOPE_REQUIRES: Record<ApiKeyScope, string> = {
  "contacts:read": "contacts.view",
  "contacts:write": "contacts.manage",
  "messages:send_template": "inbox.send",
};

const createSchema = z.object({
  name: z.string().trim().min(1, "Give the key a name, e.g. the system that will use it.").max(80),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1, "Pick at least one permission."),
  expires_in_days: z.number().int().min(1).max(730).nullable(),
});

/** The only time the full key exists in plain text: it is returned here and never stored. */
export async function createApiKey(input: z.input<typeof createSchema>): Promise<CreateResult> {
  const member = await requirePerm("settings.manage");
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const missing = parsed.data.scopes.filter((sc) => !can(member, SCOPE_REQUIRES[sc]));
  if (missing.length) return { ok: false, error: `You can only grant permissions you hold yourself. You lack access for: ${missing.join(", ")}.` };
  const admin = createAdminClient();

  const { count } = await admin
    .from("api_keys")
    .select("id", { count: "exact", head: true })
    .eq("org_id", member.orgId)
    .is("revoked_at", null);
  if ((count ?? 0) >= MAX_ACTIVE_KEYS) return { ok: false, error: `You can have at most ${MAX_ACTIVE_KEYS} active keys. Revoke one you no longer use.` };

  const { key, prefix, hash } = generateApiKey();
  const { data, error } = await admin
    .from("api_keys")
    .insert({
      org_id: member.orgId,
      name: parsed.data.name,
      key_prefix: prefix,
      key_hash: hash,
      scopes: [...new Set(parsed.data.scopes)],
      expires_at: parsed.data.expires_in_days ? new Date(Date.now() + parsed.data.expires_in_days * 86_400_000).toISOString() : null,
      created_by: member.userId,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: "Could not create the key." };

  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "api_key.created",
    entity: "api_key",
    entityId: data.id,
    diff: { name: parsed.data.name, scopes: parsed.data.scopes, prefix }, // never the key
  });
  revalidatePath(PATH);
  return { ok: true, data: { id: data.id, key, prefix } };
}

export async function revokeApiKey(id: string): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  if (!z.string().uuid().safeParse(id).success) return { ok: false, error: "Invalid input" };
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .eq("org_id", member.orgId)
    .is("revoked_at", null)
    .select("id, name, key_prefix")
    .maybeSingle();
  if (error || !data) return { ok: false, error: "Key not found or already revoked." };
  await recordAudit(admin, { orgId: member.orgId, userId: member.userId, action: "api_key.revoked", entity: "api_key", entityId: id, diff: { name: data.name, prefix: data.key_prefix } });
  revalidatePath(PATH);
  return { ok: true, message: "Key revoked. It stops working immediately." };
}
