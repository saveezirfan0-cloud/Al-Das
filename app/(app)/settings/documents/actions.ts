"use server";

import { formatInTimeZone } from "date-fns-tz";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { CATEGORY_KEYS, isCategory } from "@/lib/documents/categories";
import { validRetainDays } from "@/lib/documents/retention";
import {
  DOCUMENTS_CONFIRM_PHRASE,
  readDocumentSettings,
  writeDocumentSettings,
} from "@/lib/documents/settings";
import {
  deleteDocumentsWithFiles,
  findPastRetention,
  loadRetentionPolicies,
} from "@/lib/documents/server";
import { DOCUMENT_BUCKET, LIBRARY_BUCKET } from "@/lib/media/paths";
import { configuredScanner, scanColumns, scanStored } from "@/lib/media/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

const PATH = "/settings/documents";
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

async function saveSettings(
  memberOrg: { orgId: string },
  admin: ReturnType<typeof createAdminClient>,
  change: (
    current: ReturnType<typeof readDocumentSettings>,
  ) => ReturnType<typeof readDocumentSettings>,
) {
  const { data: org } = await admin
    .from("orgs")
    .select("settings")
    .eq("id", memberOrg.orgId)
    .single();
  const before = readDocumentSettings(org?.settings);
  const after = change(before);
  const { error } = await admin
    .from("orgs")
    .update({ settings: writeDocumentSettings(org?.settings, after) as NonNullable<Json> })
    .eq("id", memberOrg.orgId);
  return { before, after, error };
}

const optionsSchema = z.object({
  expiry_lead_days: z.number().int().min(1).max(90),
  expiry_task: z.boolean(),
});

/** Reminder lead time and whether a follow-up task is created with it. */
export async function saveDocumentOptions(
  input: z.input<typeof optionsSchema>,
): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const p = optionsSchema.safeParse(input);
  if (!p.success) return fail("Choose between 1 and 90 days.");
  const admin = createAdminClient(member.userId);
  const { before, after, error } = await saveSettings(member, admin, (c) => ({ ...c, ...p.data }));
  if (error) return fail("Could not save the settings.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "documents.settings_updated",
    entity: "org",
    entityId: member.orgId,
    diff: {
      expiry_lead_days: { from: before.expiry_lead_days, to: after.expiry_lead_days },
      expiry_task: { from: before.expiry_task, to: after.expiry_task },
    } as Json,
  });
  revalidatePath(PATH);
  return { ok: true, message: "Saved." };
}

/**
 * Switches patient documents on. Typing the phrase is the point: it records that someone with authority has
 * confirmed where the files may be stored (docs/15_PHASE_16_NOTES.md, the data residency question).
 */
export async function enableDocuments(phrase: string): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  if (phrase.trim() !== DOCUMENTS_CONFIRM_PHRASE)
    return fail(`Type ${DOCUMENTS_CONFIRM_PHRASE} exactly to switch patient documents on.`);
  const admin = createAdminClient(member.userId);
  const { error } = await saveSettings(member, admin, (c) => ({
    ...c,
    enabled: true,
    confirmed_at: new Date().toISOString(),
    confirmed_by: member.userId,
  }));
  if (error) return fail("Could not switch patient documents on.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "documents.enabled",
    entity: "org",
    entityId: member.orgId,
  });
  revalidatePath(PATH);
  return { ok: true, message: "Patient documents are on." };
}

/** Stops new uploads. Existing documents stay readable and keep their reminders. */
export async function disableDocuments(): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const admin = createAdminClient(member.userId);
  const { error } = await saveSettings(member, admin, (c) => ({ ...c, enabled: false }));
  if (error) return fail("Could not switch patient documents off.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "documents.disabled",
    entity: "org",
    entityId: member.orgId,
  });
  revalidatePath(PATH);
  return { ok: true, message: "New uploads are off. Existing documents stay available." };
}

const policySchema = z.object({
  category: z.enum(CATEGORY_KEYS),
  retain_days: z.number().int().nullable(),
  auto_delete: z.boolean(),
});

export async function saveRetentionPolicy(
  input: z.input<typeof policySchema>,
): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const p = policySchema.safeParse(input);
  if (!p.success) return fail("Invalid input");
  if (p.data.retain_days !== null && !validRetainDays(p.data.retain_days))
    return fail(
      "Keep documents for between 30 days and 100 years, or leave it empty to keep them for ever.",
    );
  if (p.data.auto_delete && p.data.retain_days === null)
    return fail("Automatic deletion needs a retention period.");
  const admin = createAdminClient(member.userId);
  const { error } = await admin.from("document_retention_policies").upsert(
    {
      org_id: member.orgId,
      category: p.data.category,
      retain_days: p.data.retain_days,
      auto_delete: p.data.auto_delete,
      updated_by: member.userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "org_id,category" },
  );
  if (error) return fail("Could not save the retention policy.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "documents.retention_updated",
    entity: "document_retention_policy",
    entityId: p.data.category,
    diff: { retain_days: p.data.retain_days, auto_delete: p.data.auto_delete } as Json,
  });
  revalidatePath(PATH);
  return { ok: true, message: "Retention policy saved." };
}

/** Deletes the documents of one category that are past their retention period (documents.manage as well). */
export async function purgePastRetention(category: string): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  if (!can(member, "documents.manage"))
    return fail("You also need the permission to delete patient documents.");
  if (!isCategory(category)) return fail("Invalid input");
  const admin = createAdminClient(member.userId);
  const policies = (await loadRetentionPolicies(admin, member.orgId)).filter(
    (p) => p.category === category,
  );
  const today = formatInTimeZone(new Date(), member.org.timezone || "UTC", "yyyy-MM-dd");
  const due = await findPastRetention(admin, member.orgId, policies, today, 200);
  const docs = [...due.autoDelete, ...due.review];
  if (docs.length === 0) return { ok: true, message: "Nothing is past its retention period." };
  const deleted = await deleteDocumentsWithFiles(admin, member.orgId, docs);
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "documents.retention_purged",
    entity: "document_retention_policy",
    entityId: category,
    diff: { deleted, attempted: docs.length } as Json,
  });
  revalidatePath(PATH);
  return {
    ok: true,
    message:
      deleted === docs.length
        ? `${deleted} document${deleted === 1 ? "" : "s"} deleted.`
        : `${deleted} of ${docs.length} deleted; the rest could not be removed from storage. Try again.`,
  };
}

/** Runs the configured malware scanner over files that are still unscanned (50 of each kind at a time). */
export async function scanPendingFiles(): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const scanner = configuredScanner();
  if (scanner.name === "none")
    return fail("No malware scanner is configured. Files stay marked as not scanned until one is.");
  const admin = createAdminClient(member.userId);
  let scanned = 0;
  let infected = 0;
  for (const [table, bucket] of [
    ["media_assets", LIBRARY_BUCKET],
    ["patient_documents", DOCUMENT_BUCKET],
  ] as const) {
    const { data } = await admin
      .from(table)
      .select("id, storage_path, size_bytes, mime_type")
      .eq("org_id", member.orgId)
      .eq("status", "ready")
      .in("scan_status", ["unscanned", "error"])
      .limit(50);
    for (const row of data ?? []) {
      const r = await scanStored(
        admin,
        { bucket, path: row.storage_path, size: row.size_bytes, mime: row.mime_type },
        scanner,
      );
      await admin.from(table).update(scanColumns(r)).eq("id", row.id).eq("org_id", member.orgId);
      scanned++;
      if (r.verdict === "infected") infected++;
    }
  }
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "documents.scan_run",
    entity: "org",
    entityId: member.orgId,
    diff: { scanned, infected } as Json,
  });
  revalidatePath(PATH);
  return {
    ok: true,
    message: `${scanned} file${scanned === 1 ? "" : "s"} scanned, ${infected} blocked.`,
  };
}
