import "server-only";

import { readAppointmentSettings } from "@/lib/appointments/settings";
import { addTimelineEvent } from "@/lib/contacts/timeline";
import { resolveRecipient, type HouseholdContact } from "@/lib/household/addressing";
import { loadHouseholdLink } from "@/lib/household/server";
import { bumpUsage, loadAccount, readConfig } from "@/lib/integrations/accounts";
import { readSmsConfig } from "@/lib/integrations/sms/config";
import { smsDecision } from "@/lib/integrations/sms/policy";
import { enqueue } from "@/lib/jobs/enqueue";
import type { AdminClient } from "@/lib/supabase/admin";
import { smsFallbackAllowed } from "@/lib/templates/delivery";
import { isTrainingOrg } from "@/lib/training/mode";

/**
 * Called when an appointment reminder could not be delivered over WhatsApp. Decides, writes ONE sms_messages row and puts it on
 * the sms_outbound queue; nothing is sent here. Every guard is checked again when the queue handler sends.
 */

export type FallbackOutcome =
  | "queued"
  | "duplicate"
  | "off"
  | "training"
  | "no_appointment"
  | "no_recipient"
  | `skipped:${string}`;

export async function queueSmsFallback(
  admin: AdminClient,
  a: {
    orgId: string;
    appointmentId: string;
    /** appointment_reminders.id: the dedupe key, so one failed reminder produces at most one SMS. */
    reminderId: string | null;
    sourceMessageId?: string | null;
    whatsappErrorCode?: number | null;
    now?: Date;
  },
): Promise<FallbackOutcome> {
  const now = a.now ?? new Date();
  const account = await loadAccount(admin, a.orgId, "sms");
  if (!account?.enabled) return "off";
  const cfg = readSmsConfig(readConfig(account));
  if (await isTrainingOrg(admin, a.orgId)) {
    await bumpUsage(admin, a.orgId, "sms", "blocked_training");
    return "training";
  }

  // Phase 20d: the template's own switch can turn the fallback off for it, and a marketing template never falls
  // back. The template is the one the failed message used, or (when the reminder never became a message) the one
  // mapped for reminders in Settings, Appointments.
  const template = await fallbackTemplate(admin, a.orgId, a.sourceMessageId ?? null);
  if (template && !smsFallbackAllowed(template)) {
    await bumpUsage(admin, a.orgId, "sms", "skipped_template_off");
    return "skipped:template_off";
  }

  const { data: appt } = await admin
    .from("appointments")
    .select("id, status, starts_at, contact_id")
    .eq("id", a.appointmentId)
    .eq("org_id", a.orgId)
    .maybeSingle();
  if (!appt || !appt.contact_id) return "no_appointment";

  const { data: patient } = await admin
    .from("contacts")
    .select("id, first_name, last_name, phone_e164, wa_bsuid, stop_marketing")
    .eq("id", appt.contact_id)
    .eq("org_id", a.orgId)
    .maybeSingle();
  if (!patient) return "no_appointment";
  const target = resolveRecipient(
    patient as HouseholdContact,
    await loadHouseholdLink(admin, a.orgId, patient.id),
  );
  if (!target) {
    await bumpUsage(admin, a.orgId, "sms", "skipped_no_recipient");
    return "no_recipient";
  }
  const { data: recipient } = await admin
    .from("contacts")
    .select(
      "id, phone_e164, sms_opt_out_at, promotions_opt_in, stop_marketing, deleted_at, erased_at",
    )
    .eq("id", target.recipient.id)
    .eq("org_id", a.orgId)
    .maybeSingle();
  if (!recipient || recipient.deleted_at || recipient.erased_at) return "no_recipient";

  const decision = smsDecision({
    messageClass: "reminder",
    recipient,
    whatsappErrorCode: a.whatsappErrorCode ?? null,
    appointment: { status: appt.status, startsAt: appt.starts_at },
    now,
  });
  if (!decision.allow) {
    await bumpUsage(admin, a.orgId, "sms", `skipped_${decision.reason}`);
    return `skipped:${decision.reason}`;
  }

  const dedupeKey = a.reminderId
    ? `reminder:${a.reminderId}`
    : `appt:${appt.id}:${Math.floor(new Date(appt.starts_at).getTime() / 1000)}`;
  const { data: inserted, error } = await admin
    .from("sms_messages")
    .upsert(
      {
        org_id: a.orgId,
        contact_id: recipient.id,
        appointment_id: appt.id,
        source_message_id: a.sourceMessageId ?? null,
        kind: "reminder_fallback",
        provider: cfg.provider,
        dedupe_key: dedupeKey,
        status: "queued",
      },
      { onConflict: "org_id,dedupe_key", ignoreDuplicates: true },
    )
    .select("id");
  if (error) throw new Error(`sms fallback insert failed: ${error.code ?? "error"}`);
  const smsId = inserted?.[0]?.id;
  if (!smsId) return "duplicate";

  await enqueue("sms_outbound", { sms_id: smsId });
  await bumpUsage(admin, a.orgId, "sms", "queued");
  await addTimelineEvent(admin, {
    orgId: a.orgId,
    contactId: patient.id,
    type: "sms.fallback_queued",
    actorType: "system",
    payload: { appointment_id: appt.id, sms_id: smsId },
  });
  return "queued";
}

/** The template behind a failed reminder: from the failed message, else the reminder template mapped in settings. */
async function fallbackTemplate(
  admin: AdminClient,
  orgId: string,
  sourceMessageId: string | null,
): Promise<{ category: string; sms_fallback: boolean } | null> {
  let templateId: string | null = null;
  if (sourceMessageId) {
    const { data: msg } = await admin
      .from("messages")
      .select("payload")
      .eq("id", sourceMessageId)
      .eq("org_id", orgId)
      .maybeSingle();
    const send = (msg?.payload as { send?: { type?: unknown; template_id?: unknown } } | null)
      ?.send;
    if (send?.type === "template" && typeof send.template_id === "string")
      templateId = send.template_id;
  }
  if (!templateId) {
    const { data: org } = await admin.from("orgs").select("settings").eq("id", orgId).maybeSingle();
    templateId = readAppointmentSettings(org?.settings).templates.reminder ?? null;
  }
  if (!templateId) return null;
  const { data } = await admin
    .from("wa_templates")
    .select("category, sms_fallback")
    .eq("id", templateId)
    .eq("org_id", orgId)
    .maybeSingle();
  return data ?? null;
}
