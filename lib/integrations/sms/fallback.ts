import "server-only";

import { addTimelineEvent } from "@/lib/contacts/timeline";
import { resolveRecipient, type HouseholdContact } from "@/lib/household/addressing";
import { loadHouseholdLink } from "@/lib/household/server";
import { bumpUsage, loadAccount, readConfig } from "@/lib/integrations/accounts";
import { readSmsConfig } from "@/lib/integrations/sms/config";
import { smsDecision } from "@/lib/integrations/sms/policy";
import { enqueue } from "@/lib/jobs/enqueue";
import type { AdminClient } from "@/lib/supabase/admin";
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
