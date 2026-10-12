import "server-only";

import { serverEnv } from "@/lib/env";
import { resolveRecipient, type HouseholdContact } from "@/lib/household/addressing";
import { loadHouseholdLink } from "@/lib/household/server";
import {
  bumpUsage,
  loadAccount,
  readConfig,
  recordFailure,
  recordOk,
} from "@/lib/integrations/accounts";
import { buildSmsProvider } from "@/lib/integrations/sms/provider";
import { readSmsConfig, smsCallbackUrl } from "@/lib/integrations/sms/config";
import { smsDecision } from "@/lib/integrations/sms/policy";
import { smsLength } from "@/lib/integrations/sms/segments";
import { chooseSmsLanguage, renderReminderSms } from "@/lib/integrations/sms/templates";
import type { SmsProvider } from "@/lib/integrations/sms/types";
import { enqueue } from "@/lib/jobs/enqueue";
import { PermanentJobError } from "@/lib/jobs/types";
import { checkRateLimit } from "@/lib/rate-limit";
import type { AdminClient } from "@/lib/supabase/admin";
import { isTrainingOrg } from "@/lib/training/mode";

/**
 * The sms_outbound queue handler's work for one SMS. Idempotent and safe to repeat: the row is claimed (queued -> sending) before
 * anything leaves, so a duplicate delivery of the job sends nothing. Order of guards:
 *   row still queued -> integration on -> not a training workspace -> recipient and policy checked again against fresh data
 *   -> daily limit -> per-sender rate limit (re-queued a second later when full) -> claim -> send.
 */

export type SendOutcome = "sent" | "failed" | "skipped" | "requeued" | "retry";

async function fail(admin: AdminClient, id: string, code: string): Promise<void> {
  await admin
    .from("sms_messages")
    .update({ status: "failed", error_code: code.slice(0, 40) })
    .eq("id", id)
    .in("status", ["queued", "sending"]);
}

export async function processSmsJob(
  admin: AdminClient,
  smsId: string,
  opts: { readCt: number; provider?: SmsProvider; now?: Date },
): Promise<SendOutcome> {
  const now = opts.now ?? new Date();
  const { data: sms } = await admin
    .from("sms_messages")
    .select("id, org_id, contact_id, appointment_id, status")
    .eq("id", smsId)
    .maybeSingle();
  if (!sms) throw new PermanentJobError("sms message not found");
  if (sms.status !== "queued") return "skipped";
  const orgId = sms.org_id;

  const account = await loadAccount(admin, orgId, "sms");
  if (!account?.enabled) {
    await fail(admin, sms.id, "integration_off");
    return "failed";
  }
  if (await isTrainingOrg(admin, orgId)) {
    await fail(admin, sms.id, "training_mode");
    await bumpUsage(admin, orgId, "sms", "blocked_training");
    return "failed";
  }
  const cfg = readSmsConfig(readConfig(account));
  const provider = opts.provider ?? buildSmsProvider(admin, account);
  if (!provider) {
    await fail(admin, sms.id, "not_configured");
    return "failed";
  }

  // Fresh data: the appointment may have moved or been cancelled, the person may have opted out since.
  const [{ data: appt }, { data: recipient }] = await Promise.all([
    sms.appointment_id
      ? admin
          .from("appointments")
          .select("id, status, starts_at, contact_id, locations(timezone)")
          .eq("id", sms.appointment_id)
          .eq("org_id", orgId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    sms.contact_id
      ? admin
          .from("contacts")
          .select(
            "id, first_name, language, phone_e164, sms_opt_out_at, promotions_opt_in, stop_marketing, deleted_at, erased_at",
          )
          .eq("id", sms.contact_id)
          .eq("org_id", orgId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  if (!appt || !recipient || recipient.deleted_at || recipient.erased_at) {
    await fail(admin, sms.id, "no_recipient");
    return "failed";
  }
  const decision = smsDecision({
    messageClass: "reminder",
    recipient,
    appointment: { status: appt.status, startsAt: appt.starts_at },
    now,
  });
  if (!decision.allow) {
    await fail(admin, sms.id, `skip_${decision.reason}`);
    await bumpUsage(admin, orgId, "sms", `skipped_${decision.reason}`);
    return "skipped";
  }

  // Daily limit (a runaway guard on cost).
  const today = now.toISOString().slice(0, 10);
  const { data: used } = await admin
    .from("integration_usage_daily")
    .select("value")
    .eq("org_id", orgId)
    .eq("provider", "sms")
    .eq("day", today)
    .eq("metric", "sent")
    .maybeSingle();
  if ((used?.value ?? 0) >= cfg.dailyCap) {
    await fail(admin, sms.id, "daily_cap");
    await bumpUsage(admin, orgId, "sms", "blocked_daily_cap");
    return "failed";
  }

  // Per-sender rate limit, one-second window. When full, the job comes back a second later.
  const slot = await checkRateLimit(admin, "sms-send", account.id, {
    limit: cfg.ratePerSec,
    windowSec: 1,
    failOpen: false,
  });
  if (!slot.allowed) {
    await enqueue(
      "sms_outbound",
      { sms_id: sms.id },
      { delaySeconds: Math.max(1, slot.retryAfter) },
    );
    return "requeued";
  }

  // Claim: only one worker moves queued -> sending.
  const { data: claimed } = await admin
    .from("sms_messages")
    .update({ status: "sending" })
    .eq("id", sms.id)
    .eq("status", "queued")
    .select("id");
  if (!claimed?.length) return "skipped";

  // The text is rebuilt from the appointment now, so a rescheduled visit is described correctly. A dependant's reminder goes
  // to the guardian and names the child by first name (the household rule); everything else carries no name at all.
  let patientFirstName: string | null = null;
  if (appt.contact_id && appt.contact_id !== recipient.id) {
    const link = await loadHouseholdLink(admin, orgId, appt.contact_id);
    const { data: patient } = await admin
      .from("contacts")
      .select("id, first_name, last_name, phone_e164, wa_bsuid, stop_marketing")
      .eq("id", appt.contact_id)
      .eq("org_id", orgId)
      .maybeSingle();
    const target = patient ? resolveRecipient(patient as HouseholdContact, link) : null;
    if (target?.viaGuardian) patientFirstName = patient?.first_name ?? null;
  }
  const { data: org } = await admin.from("orgs").select("timezone").eq("id", orgId).single();
  const timezone = appt.locations?.timezone ?? org?.timezone ?? "Asia/Dubai";
  const body = renderReminderSms({
    clinicName: cfg.clinicName,
    callbackPhone: cfg.callbackPhone,
    startsAt: new Date(appt.starts_at),
    timezone,
    language: chooseSmsLanguage(recipient.language),
    patientFirstName,
  });

  const result = await provider.send({
    to: recipient.phone_e164!,
    body,
    clientRef: sms.id,
    statusCallbackUrl: smsCallbackUrl(serverEnv().APP_URL, account.id, sms.id),
  });

  if (result.ok) {
    const parts = result.segments ?? smsLength(body).segments;
    await admin
      .from("sms_messages")
      .update({
        status: "sent",
        provider_message_id: result.providerMessageId.slice(0, 80),
        segments: Math.min(20, Math.max(1, parts)),
        sent_at: now.toISOString(),
        error_code: null,
      })
      .eq("id", sms.id)
      .eq("status", "sending");
    await bumpUsage(admin, orgId, "sms", "sent");
    await bumpUsage(admin, orgId, "sms", "segments", parts);
    await recordOk(admin, orgId, "sms");
    return "sent";
  }

  await recordFailure(admin, orgId, "sms", `SMS provider error ${result.code}`);
  if (result.optOut && sms.contact_id) {
    await admin
      .from("contacts")
      .update({ sms_opt_out_at: now.toISOString() })
      .eq("id", sms.contact_id)
      .eq("org_id", orgId);
    await bumpUsage(admin, orgId, "sms", "opted_out");
  }
  if (result.retryable && opts.readCt < 5) {
    await admin
      .from("sms_messages")
      .update({ status: "queued" })
      .eq("id", sms.id)
      .eq("status", "sending");
    return "retry";
  }
  // An ambiguous failure (timeout or 5xx after the request left) is NOT retried: the provider may already have sent it.
  await fail(admin, sms.id, result.ambiguous ? "unknown_delivery" : result.code);
  await bumpUsage(admin, orgId, "sms", "failed");
  return "failed";
}
