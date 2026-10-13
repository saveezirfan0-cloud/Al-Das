import "server-only";

import { addTimelineEvent } from "@/lib/contacts/timeline";
import { aed } from "@/lib/finance/format";
import {
  planReminders,
  recoveryReadiness,
  recoveryValues,
  type BalanceRow,
  type PriorReminder,
  type RecoveryPerson,
  type RecoveryTarget,
  type RecoveryValueContext,
  type ReminderPlan,
  type SkipReason,
} from "@/lib/finance/recovery";
import { templateWordingHash } from "@/lib/finance/recovery-approval";
import { loadFinanceSettings, type FinanceSettings } from "@/lib/finance/settings-db";
import { resolveRecipient, type HouseholdContact } from "@/lib/household/addressing";
import { loadHouseholdLink } from "@/lib/household/server";
import { ensureConversation } from "@/lib/inbox/conversations";
import { queueOutbound } from "@/lib/inbox/send";
import { redactText } from "@/lib/redact";
import type { AdminClient } from "@/lib/supabase/admin";
import { renderTemplatePreview } from "@/lib/whatsapp/templates";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

/**
 * Self-pay recovery reminders: gather the overdue self-pay balances (SQL, PINs only), decide who may be reminded (pure),
 * then send through the outbound queue as an approved template. Nothing is sent unless the feature is switched on, finance
 * approved the wording of the mapped template, and the person who would receive the message opted in and has not stopped
 * marketing. Training workspaces queue as usual: the outbound handler marks them as sent on screen and never reaches Meta.
 * Logs and audit rows carry counts only, never a name, a number or an amount.
 */

export type RecoveryRunSummary = {
  ok: boolean;
  /** Why nothing could run, in words for the screen. */
  blocked: string[];
  considered: number;
  planned: number;
  queued: number;
  failed: number;
  skipped: Record<string, number>;
  /** Only for a dry run: what would be sent (invoice number, amount, recipient kind), never a name or phone. */
  preview: Array<{
    invoiceNumber: string;
    balance: number;
    sequence: number;
    viaGuardian: boolean;
  }>;
};

const empty = (blocked: string[] = []): RecoveryRunSummary => ({
  ok: blocked.length === 0,
  blocked,
  considered: 0,
  planned: 0,
  queued: 0,
  failed: 0,
  skipped: {},
  preview: [],
});

type TemplateRow = {
  id: string;
  name: string;
  status: string;
  components: unknown;
  channel_id: string | null;
  waba_id: string | null;
};

async function loadTemplate(
  admin: AdminClient,
  orgId: string,
  id: string | null,
): Promise<TemplateRow | null> {
  if (!id) return null;
  const { data } = await admin
    .from("wa_templates")
    .select("id, name, status, components, channel_id, waba_id")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  return data;
}

/** Everything that must be true before the feature can be switched on or run (empty = ready). */
export async function recoveryBlockers(
  admin: AdminClient,
  orgId: string,
  settings: FinanceSettings,
): Promise<{ problems: string[]; template: TemplateRow | null }> {
  const template = await loadTemplate(admin, orgId, settings.recovery.templateId);
  const comps = (template?.components ?? []) as MetaTemplateComponent[];
  const probe = recoveryValues(comps, settings.recovery.variableMap, {
    first_name: "x",
    patient_first_name: "x",
    amount_due: "x",
    invoice_ref: "x",
    clinic_name: "x",
    days_overdue: "x",
  });
  const problems = recoveryReadiness({
    templateStatus: template?.status ?? null,
    mappedAll: !!template && probe.missing.length === 0 && probe.unsupported.length === 0,
    toneApprovedHash: settings.recovery.toneApprovedHash,
    currentHash: template ? templateWordingHash(comps) : null,
  });
  if (template && probe.unsupported.length > 0)
    problems.push(
      "This template has a media header or a button variable, which reminders cannot fill.",
    );
  return { problems: [...new Set(problems)], template };
}

async function targetsFor(
  admin: AdminClient,
  orgId: string,
  pins: string[],
): Promise<Map<string, RecoveryTarget | null>> {
  const out = new Map<string, RecoveryTarget | null>();
  const unique = [...new Set(pins)];
  for (let i = 0; i < unique.length; i += 200) {
    const slice = unique.slice(i, i + 200);
    const { data } = await admin
      .from("contacts")
      .select(
        "id, first_name, last_name, phone_e164, wa_bsuid, promotions_opt_in, stop_marketing, external_id",
      )
      .eq("org_id", orgId)
      .in("external_id", slice)
      .is("deleted_at", null)
      .is("merged_into_id", null)
      .is("erased_at", null);
    for (const row of data ?? []) {
      const patient: RecoveryPerson = {
        id: row.id,
        first_name: row.first_name,
        phone_e164: row.phone_e164,
        wa_bsuid: row.wa_bsuid,
        promotions_opt_in: row.promotions_opt_in,
        stop_marketing: row.stop_marketing,
      };
      // a dependant without a number is reminded through their guardian (same rule as appointment messages)
      const link = await loadHouseholdLink(admin, orgId, row.id);
      const resolved = resolveRecipient(
        {
          id: row.id,
          first_name: row.first_name,
          last_name: row.last_name,
          phone_e164: row.phone_e164,
          wa_bsuid: row.wa_bsuid,
          stop_marketing: row.stop_marketing,
        } as HouseholdContact,
        link,
      );
      if (!resolved) {
        out.set(row.external_id!, { recipient: patient, patient, viaGuardian: false }); // no identifier: skipped as no_whatsapp_id
        continue;
      }
      if (!resolved.viaGuardian) {
        out.set(row.external_id!, { recipient: patient, patient, viaGuardian: false });
        continue;
      }
      const { data: g } = await admin
        .from("contacts")
        .select(
          "id, first_name, phone_e164, wa_bsuid, promotions_opt_in, stop_marketing, deleted_at, erased_at",
        )
        .eq("id", resolved.recipient.id)
        .eq("org_id", orgId)
        .maybeSingle();
      if (!g || g.deleted_at || g.erased_at) {
        out.set(row.external_id!, null);
        continue;
      }
      out.set(row.external_id!, {
        patient,
        viaGuardian: true,
        recipient: {
          id: g.id,
          first_name: g.first_name,
          phone_e164: g.phone_e164,
          wa_bsuid: g.wa_bsuid,
          promotions_opt_in: g.promotions_opt_in,
          stop_marketing: g.stop_marketing,
        },
      });
    }
  }
  return out;
}

async function planFor(admin: AdminClient, orgId: string, settings: FinanceSettings, now: Date) {
  const { data: balances } = await admin.rpc("fin_selfpay_balances", {
    p_org_id: orgId,
    p_min_balance: settings.recovery.minBalance,
    p_min_days: settings.recovery.minDaysOverdue,
    p_limit: settings.recovery.batchSize * 10,
  });
  const rows = (Array.isArray(balances) ? balances : []) as unknown as BalanceRow[];
  const ids = rows.map((r) => r.invoice_id);
  const { data: priorRows } = ids.length
    ? await admin
        .from("fin_recovery_reminders")
        .select("invoice_id, sequence_no, status, created_at")
        .eq("org_id", orgId)
        .in("invoice_id", ids)
    : { data: [] };
  const priors = (priorRows ?? []).filter(
    (p) => p.status === "queued" || p.status === "failed",
  ) as PriorReminder[];
  const targets = await targetsFor(
    admin,
    orgId,
    rows.map((r) => r.patient_pin),
  );
  const plan = planReminders({
    balances: rows.map((r) => ({ ...r, balance: Number(r.balance), days_old: Number(r.days_old) })),
    priors,
    targets,
    settings: settings.recovery,
    now,
  });
  return { rows, targets, ...plan };
}

/**
 * Plans, and (unless `dryRun`) sends, one batch of reminders. Idempotent: the (invoice, sequence) row is claimed before
 * anything is queued, so a retry or an overlapping run never sends the same reminder twice.
 */
export async function runRecovery(
  admin: AdminClient,
  orgId: string,
  opts: { actorId: string | null; dryRun: boolean; clinicName: string; now?: Date },
): Promise<RecoveryRunSummary> {
  const now = opts.now ?? new Date();
  const settings = await loadFinanceSettings(admin, orgId);
  if (!settings.recovery.enabled && !opts.dryRun)
    return empty(["Self-pay reminders are switched off."]);
  const { problems, template } = await recoveryBlockers(admin, orgId, settings);
  if (problems.length > 0 && !opts.dryRun) return empty(problems);

  const { rows, targets, plans, skipped } = await planFor(admin, orgId, settings, now);
  const summary: RecoveryRunSummary = {
    ...empty(problems),
    ok: problems.length === 0,
    considered: rows.length,
    planned: plans.length,
    skipped: skipped.reduce<Record<string, number>>(
      (a, s) => ((a[s.reason] = (a[s.reason] ?? 0) + 1), a),
      {},
    ),
  };
  if (opts.dryRun) {
    summary.preview = plans.map((p) => ({
      invoiceNumber: p.invoiceNumber,
      balance: p.balance,
      sequence: p.sequence,
      viaGuardian: p.viaGuardian,
    }));
    return summary;
  }
  if (!template) return summary;

  const comps = template.components as MetaTemplateComponent[];
  const { data: channels } = await admin
    .from("channels")
    .select("id, waba_id")
    .eq("org_id", orgId)
    .eq("type", "whatsapp")
    .eq("status", "active");
  const channelIds = (channels ?? [])
    .filter((c) => !template.waba_id || c.waba_id === template.waba_id)
    .map((c) => c.id);
  const channelId =
    template.channel_id && channelIds.includes(template.channel_id)
      ? template.channel_id
      : channelIds[0];
  if (!channelId) {
    summary.ok = false;
    summary.blocked.push("No active WhatsApp number can send this template.");
    return summary;
  }

  for (const plan of plans) {
    const outcome = await sendOne(admin, orgId, {
      plan,
      comps,
      variableMap: settings.recovery.variableMap,
      templateId: template.id,
      channelId,
      clinicName: opts.clinicName,
      actorId: opts.actorId,
      target: targets.get(plan.patientPin) ?? null,
      now,
    });
    if (outcome === "queued") summary.queued++;
    else if (outcome === "failed") summary.failed++;
    else summary.skipped[outcome] = (summary.skipped[outcome] ?? 0) + 1;
  }
  return summary;
}

async function sendOne(
  admin: AdminClient,
  orgId: string,
  a: {
    plan: ReminderPlan;
    comps: MetaTemplateComponent[];
    variableMap: Record<string, string>;
    templateId: string;
    channelId: string;
    clinicName: string;
    actorId: string | null;
    target: RecoveryTarget | null;
    /** The run's clock: the gap to the next reminder is measured from this, the same clock the planner uses. */
    now: Date;
  },
): Promise<"queued" | "failed" | SkipReason | "already_sent"> {
  const { plan, target } = a;
  if (!target) return "no_patient_record";

  // claim the slot first: unique (org, invoice, sequence). A previously failed attempt is retried, a queued one never repeats.
  const claim = await admin
    .from("fin_recovery_reminders")
    .upsert(
      {
        org_id: orgId,
        invoice_id: plan.invoiceId,
        patient_pin: plan.patientPin,
        contact_id: target.recipient.id,
        sequence_no: plan.sequence,
        status: "queued",
        skip_reason: null,
        balance: plan.balance,
        template_id: a.templateId,
        created_by: a.actorId,
        created_at: a.now.toISOString(),
      },
      { onConflict: "org_id,invoice_id,sequence_no", ignoreDuplicates: true },
    )
    .select("id");
  let rowId = claim.data?.[0]?.id as string | undefined;
  if (!rowId) {
    // the slot exists: only a failed one may be retried
    const { data: retry } = await admin
      .from("fin_recovery_reminders")
      .update({
        status: "queued",
        contact_id: target.recipient.id,
        balance: plan.balance,
        template_id: a.templateId,
        created_by: a.actorId,
      })
      .eq("org_id", orgId)
      .eq("invoice_id", plan.invoiceId)
      .eq("sequence_no", plan.sequence)
      .eq("status", "failed")
      .select("id");
    rowId = retry?.[0]?.id;
    if (!rowId) return "already_sent";
  }

  const fail = async (reason: string): Promise<"failed"> => {
    await admin
      .from("fin_recovery_reminders")
      .update({ status: "failed", skip_reason: reason.slice(0, 60) })
      .eq("id", rowId!);
    return "failed";
  };

  const ctx: RecoveryValueContext = {
    first_name: (target.recipient.first_name ?? "").trim().split(/\s+/)[0] ?? "",
    patient_first_name: (target.patient.first_name ?? "").trim().split(/\s+/)[0] ?? "",
    amount_due: aed(plan.balance).replace(/ /g, " "),
    invoice_ref: plan.invoiceNumber,
    clinic_name: a.clinicName,
    days_overdue: String(plan.daysOld),
  };
  const { values, missing, unsupported } = recoveryValues(a.comps, a.variableMap, ctx);
  if (missing.length || unsupported.length) return fail("template_variables_unmapped");
  const preview = renderTemplatePreview(a.comps, values);
  if (preview.missing.length) return fail("template_variables_unmapped");

  try {
    const conversation = await ensureConversation(admin, orgId, target.recipient.id, a.channelId);
    const message = await queueOutbound(admin, {
      orgId,
      conversationId: conversation.id,
      spec: { type: "template", template_id: a.templateId, values },
      body: [preview.headerText, preview.body].filter(Boolean).join("\n"),
      sentByUserId: a.actorId,
      priority: false,
    });
    await admin.from("fin_recovery_reminders").update({ message_id: message.id }).eq("id", rowId);
    await addTimelineEvent(admin, {
      orgId,
      contactId: target.patient.id,
      type: "finance.payment_reminder",
      actorType: a.actorId ? "user" : "job",
      actorId: a.actorId,
      payload: { sequence: plan.sequence },
    });
    return "queued";
  } catch (err) {
    console.error("[finance] recovery reminder could not be queued", {
      reason: redactText(err, 120),
    });
    return fail("queue_failed");
  }
}
