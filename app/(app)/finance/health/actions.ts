"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { decryptJson, encryptJson } from "@/lib/crypto";
import { dbProcessDeps } from "@/lib/finance/db";
import { processBatch } from "@/lib/finance/process-batch";
import type { UniteCredentials } from "@/lib/unite/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

const PERM = "finance.capture.manage";
const PATH = "/finance/health";

const optional = z
  .string()
  .trim()
  .max(4000)
  .optional()
  .transform((v) => (v ? v : undefined));

const credentialsSchema = z.object({
  authorize_app_id: optional,
  authorize_app_key: optional,
  refresh_app_id: optional,
  refresh_app_key: optional,
  access_token: optional,
  refresh_token: optional,
});

/**
 * Write-only: blank fields keep the stored value. Secrets are encrypted before
 * they are stored and never returned, logged or put in the audit diff (only the
 * names of the fields that changed).
 */
export async function saveUniteCredentials(formData: FormData): Promise<ActionResult> {
  const member = await requirePerm(PERM);
  const parsed = credentialsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, error: "Some fields are too long." };
  const v = parsed.data;

  if (!process.env.ENCRYPTION_KEY)
    return { ok: false, error: "ENCRYPTION_KEY is not configured on the server." };

  const admin = createAdminClient();
  const { data: existing, error: loadError } = await admin
    .from("integration_accounts")
    .select("id, config_enc")
    .eq("org_id", member.orgId)
    .eq("kind", "unite")
    .maybeSingle();
  if (loadError) return { ok: false, error: "Could not load the stored credentials." };

  let current: Partial<UniteCredentials> = {};
  if (existing) {
    try {
      current = decryptJson<UniteCredentials>(existing.config_enc);
    } catch {
      return {
        ok: false,
        error: "Stored credentials cannot be decrypted with the current ENCRYPTION_KEY.",
      };
    }
  }

  const next: UniteCredentials = {
    authorize: {
      app_id: v.authorize_app_id ?? current.authorize?.app_id ?? "",
      app_key: v.authorize_app_key ?? current.authorize?.app_key ?? "",
    },
    refresh: {
      app_id: v.refresh_app_id ?? current.refresh?.app_id ?? "",
      app_key: v.refresh_app_key ?? current.refresh?.app_key ?? "",
    },
    access_token: v.access_token ?? current.access_token,
    refresh_token: v.refresh_token ?? current.refresh_token,
    issued_at: v.access_token ? Date.now() : current.issued_at,
    ttl_seconds: current.ttl_seconds,
  };
  if (
    !next.authorize.app_id ||
    !next.authorize.app_key ||
    !next.refresh.app_id ||
    !next.refresh.app_key
  )
    return { ok: false, error: "Both the authorize and the refresh app id / key are required." };

  const config_enc = encryptJson(next);
  const { error } = existing
    ? await admin
        .from("integration_accounts")
        .update({ config_enc, status: "active", last_error: null })
        .eq("id", existing.id)
    : await admin
        .from("integration_accounts")
        .insert({ org_id: member.orgId, kind: "unite", config_enc });
  if (error) return { ok: false, error: "Could not save the credentials." };

  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.unite_credentials.saved",
    entity: "integration_account",
    entityId: "unite",
    diff: {
      fields: Object.entries(v)
        .filter(([, val]) => val !== undefined)
        .map(([k]) => k),
    },
  });
  revalidatePath(PATH);
  return { ok: true, message: "Credentials saved (encrypted)." };
}

const settingsSchema = z.object({
  batch_size: z.coerce.number().int().min(1).max(500),
  max_batches_per_run: z.coerce.number().int().min(1).max(100),
  window_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export async function saveCaptureSettings(formData: FormData): Promise<ActionResult> {
  const member = await requirePerm(PERM);
  const parsed = settingsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success)
    return { ok: false, error: "Check batch size (1-500), batches per run (1-100) and the date." };
  const admin = createAdminClient();
  const { error } = await admin
    .from("fin_capture_settings")
    .update({ ...parsed.data, updated_by: member.userId })
    .eq("org_id", member.orgId);
  if (error) return { ok: false, error: "Could not save the settings." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.capture_settings.saved",
    entity: "fin_capture_settings",
    entityId: member.orgId,
    diff: parsed.data,
  });
  revalidatePath(PATH);
  return { ok: true, message: "Settings saved." };
}

/**
 * Switching capture ON starts consuming records from the Unite Finance API,
 * which delivers each record once. Requires typing ENABLE and stored credentials.
 */
export async function setCaptureEnabled(
  enabled: boolean,
  confirmation: string,
): Promise<ActionResult> {
  const member = await requirePerm(PERM);
  const admin = createAdminClient();

  if (enabled) {
    if (confirmation.trim() !== "ENABLE") return { ok: false, error: "Type ENABLE to confirm." };
    const { data: account } = await admin
      .from("integration_accounts")
      .select("id")
      .eq("org_id", member.orgId)
      .eq("kind", "unite")
      .eq("status", "active")
      .maybeSingle();
    if (!account) return { ok: false, error: "Save the Unite credentials first." };
  }

  const { error } = await admin
    .from("fin_capture_settings")
    .update({ enabled, updated_by: member.userId })
    .eq("org_id", member.orgId);
  if (error) return { ok: false, error: "Could not change the capture setting." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: enabled ? "finance.capture.enabled" : "finance.capture.disabled",
    entity: "fin_capture_settings",
    entityId: member.orgId,
  });
  revalidatePath(PATH);
  return {
    ok: true,
    message: enabled
      ? "Capture is ON. The next hourly run will pull from Unite."
      : "Capture is OFF.",
  };
}

/** Re-process raw batches that are not processed yet. Never calls Unite. */
export async function reprocessPendingBatches(): Promise<ActionResult> {
  const member = await requirePerm(PERM);
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("fin_raw_unite_batches")
    .select("id")
    .eq("org_id", member.orgId)
    .neq("process_status", "processed")
    .order("requested_at", { ascending: true })
    .limit(25);
  if (error) return { ok: false, error: "Could not load pending batches." };
  const deps = dbProcessDeps(admin);
  let ok = 0;
  let failed = 0;
  for (const b of data ?? []) {
    const r = await processBatch(deps, b.id);
    if (r.ok) ok++;
    else failed++;
  }
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.batches.reprocessed",
    entity: "fin_raw_unite_batches",
    diff: { processed: ok, failed },
  });
  revalidatePath(PATH);
  return failed
    ? { ok: false, error: `${ok} processed, ${failed} still failing (see the batch log).` }
    : { ok: true, message: `${ok} batch(es) processed.` };
}

/** After mapping a Unite clinic name to a branch, fix invoices that were stored without one. */
export async function rederiveBranches(): Promise<ActionResult> {
  const member = await requirePerm(PERM);
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fin_rederive_branches", { p_org_id: member.orgId });
  if (error) return { ok: false, error: "Could not re-derive branches." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.branches_rederived",
    entity: "finance",
    diff: { updated: Number(data) || 0 },
  });
  revalidatePath(PATH);
  return { ok: true, message: `${data} invoice(s) updated.` };
}
