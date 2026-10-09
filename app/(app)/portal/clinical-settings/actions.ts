"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import {
  CONFIRM_PHRASE,
  isGuardedKey,
  normaliseApprovedValue,
  type ValueType,
} from "@/lib/clinical/sign-off";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

/**
 * All writes go through the signed-in user's own client (RLS: clinical.settings.manage) so the
 * history trigger records auth.uid() as the person who changed the value.
 */
const signSchema = z.object({
  key: z.string().min(1).max(100),
  value: z.string().max(10000),
  signedBy: z.string().trim().min(2).max(120),
  signedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  confirm: z.string().optional(),
});

export async function signOffSetting(input: z.input<typeof signSchema>): Promise<ActionResult> {
  const member = await requirePerm("clinical.settings.manage");
  const parsed = signSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Fill in the value, who signed and the date." };
  const d = parsed.data;
  if (Number.isNaN(Date.parse(d.signedAt))) return { ok: false, error: "Invalid date." };

  const supabase = await createClient();
  const { data: row } = await supabase
    .from("clinical_settings")
    .select("id, key, value_type")
    .eq("org_id", member.orgId)
    .eq("key", d.key)
    .maybeSingle();
  if (!row) return { ok: false, error: "Setting not found." };

  const v = normaliseApprovedValue(row.value_type as ValueType, d.value);
  if (!v.ok) return v;
  if (isGuardedKey(d.key) && v.value === "true" && d.confirm !== CONFIRM_PHRASE)
    return { ok: false, error: `Type "${CONFIRM_PHRASE}" to switch this on.` };

  const { error } = await supabase
    .from("clinical_settings")
    .update({
      approved_value: v.value,
      sign_off_status: "approved",
      signed_by: d.signedBy,
      signed_at: d.signedAt,
    })
    .eq("id", row.id)
    .eq("org_id", member.orgId);
  if (error) return { ok: false, error: "Could not save the sign-off." };

  await recordAudit(createAdminClient(), {
    orgId: member.orgId,
    userId: member.userId,
    action: "clinical_setting.sign_off",
    entity: "clinical_setting",
    entityId: row.id,
    diff: { key: d.key, signed_by: d.signedBy },
  });
  revalidatePath("/portal/clinical-settings");
  return { ok: true, message: "Signed off." };
}

export async function revokeSetting(key: string): Promise<ActionResult> {
  const member = await requirePerm("clinical.settings.manage");
  if (!z.string().min(1).max(100).safeParse(key).success)
    return { ok: false, error: "Invalid request." };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("clinical_settings")
    .update({ approved_value: null, sign_off_status: "awaiting", signed_by: null, signed_at: null })
    .eq("org_id", member.orgId)
    .eq("key", key)
    .select("id")
    .maybeSingle();
  if (error || !data) return { ok: false, error: "Could not revoke." };
  await recordAudit(createAdminClient(), {
    orgId: member.orgId,
    userId: member.userId,
    action: "clinical_setting.revoke",
    entity: "clinical_setting",
    entityId: data.id,
    diff: { key },
  });
  revalidatePath("/portal/clinical-settings");
  return { ok: true, message: "Sign-off revoked. Rules that need it stop firing." };
}

const metaSchema = z.object({
  key: z.string().min(1).max(100),
  proposedValue: z.string().max(10000).nullable(),
  owner: z.string().max(120).nullable(),
  notes: z.string().max(4000).nullable(),
});

/** Working fields only: proposal, owner, notes. Never touches the approved value or status. */
export async function updateSettingMeta(input: z.input<typeof metaSchema>): Promise<ActionResult> {
  const member = await requirePerm("clinical.settings.manage");
  const parsed = metaSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  const d = parsed.data;
  const supabase = await createClient();
  const { error } = await supabase
    .from("clinical_settings")
    .update({
      proposed_value: d.proposedValue?.trim() || null,
      owner: d.owner?.trim() || null,
      notes: d.notes?.trim() || null,
    })
    .eq("org_id", member.orgId)
    .eq("key", d.key);
  if (error) return { ok: false, error: "Could not save." };
  revalidatePath("/portal/clinical-settings");
  return { ok: true, message: "Saved." };
}

export type HistoryEntry = {
  at: string;
  by: string | null;
  from: string | null;
  to: string | null;
  status: string | null;
};

export async function loadSettingHistory(
  key: string,
): Promise<{ ok: true; entries: HistoryEntry[] } | { ok: false; error: string }> {
  const member = await requirePerm("clinical.settings.manage");
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("clinical_settings_history")
    .select("changed_at, changed_by, old_row, new_row")
    .eq("org_id", member.orgId)
    .eq("setting_key", key)
    .order("changed_at", { ascending: false })
    .limit(50);
  if (error) return { ok: false, error: "Could not load history." };
  const pick = (row: unknown, field: string) => {
    const v = (row as Record<string, unknown> | null)?.[field];
    return typeof v === "string" ? v : null;
  };
  return {
    ok: true,
    entries: (data ?? []).map((h) => ({
      at: h.changed_at,
      by: h.changed_by,
      from: pick(h.old_row, "approved_value"),
      to: pick(h.new_row, "approved_value"),
      status: pick(h.new_row, "sign_off_status"),
    })),
  };
}
