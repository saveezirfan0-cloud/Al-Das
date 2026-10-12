"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import {
  DENIED,
  dbMessage,
  fail,
  firstIssue,
  uuid,
  type ActionResult,
} from "@/lib/finance/action-support";
import { RECOVERY_SOURCES } from "@/lib/finance/recovery";
import { templateWordingHash } from "@/lib/finance/recovery-approval";
import {
  recoveryBlockers,
  runRecovery,
  type RecoveryRunSummary,
} from "@/lib/finance/recovery-server";
import { loadFinanceSettings } from "@/lib/finance/settings-db";
import { createAdminClient } from "@/lib/supabase/admin";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

/**
 * Self-pay recovery reminders by WhatsApp. OFF by default. Switching them on needs, in this order: an APPROVED template, a
 * mapping for every variable, and Finance's approval of the wording (finance.recovery.approve), which is tied to the exact
 * text: editing the template cancels the approval and switches the reminders off. They only ever go out through the outbound
 * queue, as that template, to people who opted in and have not stopped marketing.
 */

async function gate(perm: string) {
  const member = await requireMember();
  return can(member, perm) ? member : null;
}
const refresh = () => revalidatePath("/finance/recovery");

const settingsSchema = z.object({
  template_id: z.union([uuid, z.literal("")]),
  min_balance: z.coerce.number().min(0).max(1e7),
  min_days_overdue: z.coerce.number().int().min(0).max(365),
  gap_days: z.coerce.number().int().min(1).max(365),
  max_reminders: z.coerce.number().int().min(1).max(10),
  batch_size: z.coerce.number().int().min(1).max(500),
});

/** Template choice, variable mapping (fields named map.body.1 ...) and the thresholds. */
export async function saveRecoverySettings(raw: Record<string, string>): Promise<ActionResult> {
  const member = await gate("finance.recovery.manage");
  if (!member) return fail(DENIED);
  const p = settingsSchema.safeParse(raw);
  if (!p.success) return fail(firstIssue(p.error, "Check the numbers."));
  const map: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!k.startsWith("map.") || !v) continue;
    if (!RECOVERY_SOURCES.some((s) => s.key === v))
      return fail("Choose a value from the list for each variable.");
    map[k.slice(4)] = v;
  }
  const admin = createAdminClient(member.userId);
  const current = await loadFinanceSettings(admin, member.orgId);
  const templateId = p.data.template_id || null;
  if (templateId) {
    const { data: t } = await admin
      .from("wa_templates")
      .select("id")
      .eq("id", templateId)
      .eq("org_id", member.orgId)
      .maybeSingle();
    if (!t) return fail("That template was not found.");
  }
  const templateChanged = templateId !== current.recovery.templateId;
  const { error } = await admin
    .from("fin_ref_finance_settings")
    .update({
      recovery_template_id: templateId,
      recovery_variable_map: map,
      recovery_min_balance: p.data.min_balance,
      recovery_min_days_overdue: p.data.min_days_overdue,
      recovery_gap_days: p.data.gap_days,
      recovery_max_reminders: p.data.max_reminders,
      recovery_batch_size: p.data.batch_size,
      // a different template needs a fresh approval and a fresh decision to switch on
      ...(templateChanged
        ? {
            recovery_enabled: false,
            recovery_tone_approved_by: null,
            recovery_tone_approved_at: null,
            recovery_tone_approved_hash: null,
          }
        : {}),
    })
    .eq("org_id", member.orgId);
  if (error) return fail(dbMessage(error, "Could not save the settings."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.recovery.settings_saved",
    entity: "fin_ref_finance_settings",
    entityId: member.orgId,
    diff: { template_changed: templateChanged },
  });
  refresh();
  return {
    ok: true,
    message: templateChanged
      ? "Saved. The new template needs Finance's approval before reminders can start."
      : "Saved.",
  };
}

/** Finance confirms they have read the template wording and the tone is acceptable. Bound to that exact wording. */
export async function approveRecoveryTone(): Promise<ActionResult> {
  const member = await gate("finance.recovery.approve");
  if (!member) return fail(DENIED);
  const admin = createAdminClient(member.userId);
  const settings = await loadFinanceSettings(admin, member.orgId);
  if (!settings.recovery.templateId) return fail("Choose a template first.");
  const { data: t } = await admin
    .from("wa_templates")
    .select("components, status")
    .eq("id", settings.recovery.templateId)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!t) return fail("The template was not found.");
  const hash = templateWordingHash((t.components ?? []) as unknown as MetaTemplateComponent[]);
  const { error } = await admin
    .from("fin_ref_finance_settings")
    .update({
      recovery_tone_approved_by: member.userId,
      recovery_tone_approved_at: new Date().toISOString(),
      recovery_tone_approved_hash: hash,
    })
    .eq("org_id", member.orgId);
  if (error) return fail("Could not record the approval.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.recovery.tone_approved",
    entity: "fin_ref_finance_settings",
    entityId: member.orgId,
    diff: { wording_hash: hash.slice(0, 12) },
  });
  refresh();
  return {
    ok: true,
    message: "Approved. This approval stops applying if the template wording changes.",
  };
}

const enableSchema = z.object({ enabled: z.boolean(), confirm: z.string().optional() });

export async function setRecoveryEnabled(raw: {
  enabled: boolean;
  confirm?: string;
}): Promise<ActionResult> {
  const member = await gate("finance.recovery.manage");
  if (!member) return fail(DENIED);
  const p = enableSchema.safeParse(raw);
  if (!p.success) return fail("Invalid request.");
  const admin = createAdminClient(member.userId);
  if (p.data.enabled) {
    if (p.data.confirm !== "START REMINDERS") return fail("Type START REMINDERS to confirm.");
    const settings = await loadFinanceSettings(admin, member.orgId);
    const { problems } = await recoveryBlockers(admin, member.orgId, settings);
    if (problems.length > 0) return fail(problems.join(" "));
  }
  const { error } = await admin
    .from("fin_ref_finance_settings")
    .update({ recovery_enabled: p.data.enabled })
    .eq("org_id", member.orgId);
  if (error) return fail("Could not change the setting.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: p.data.enabled ? "finance.recovery.enabled" : "finance.recovery.disabled",
    entity: "fin_ref_finance_settings",
    entityId: member.orgId,
  });
  refresh();
  return {
    ok: true,
    message: p.data.enabled
      ? "Reminders are on. The daily job sends them in batches."
      : "Reminders are off.",
  };
}

/** What would be sent right now. Sends nothing, and shows invoice numbers and amounts only. */
export async function previewRecovery(): Promise<ActionResult<RecoveryRunSummary>> {
  const member = await gate("finance.recovery.manage");
  if (!member) return fail(DENIED);
  const admin = createAdminClient(member.userId);
  const summary = await runRecovery(admin, member.orgId, {
    actorId: member.userId,
    dryRun: true,
    clinicName: member.org.name,
  });
  return { ok: true, data: summary };
}

/** Sends one batch now (the same thing the daily job does). Only when switched on and approved. */
export async function runRecoveryNow(): Promise<ActionResult<RecoveryRunSummary>> {
  const member = await gate("finance.recovery.manage");
  if (!member) return fail(DENIED);
  const admin = createAdminClient(member.userId);
  const summary = await runRecovery(admin, member.orgId, {
    actorId: member.userId,
    dryRun: false,
    clinicName: member.org.name,
  });
  if (!summary.ok) return fail(summary.blocked.join(" ") || "Nothing was sent.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.recovery.run",
    entity: "fin_recovery_reminders",
    diff: { queued: summary.queued, failed: summary.failed, skipped: summary.skipped },
  });
  refresh();
  return {
    ok: true,
    data: summary,
    message: `${summary.queued} reminder(s) queued${summary.failed ? `, ${summary.failed} failed` : ""}.`,
  };
}
