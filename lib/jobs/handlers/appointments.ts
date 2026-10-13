import { z } from "zod";

import { isInactive, isAppointmentStatus } from "@/lib/appointments/status";
import {
  loadOrgSettings,
  sendAppointmentTemplate,
  syncAppointmentReminders,
} from "@/lib/appointments/service";
import { applyReminderReply } from "@/lib/appointments/replies";
import { expireOffer, handleOfferReply, offerFreedSlot } from "@/lib/front-desk/offers";
import { classifyOfferButton, classifyOfferReply } from "@/lib/front-desk/waitlist";
import { resolveRecipient, type HouseholdContact } from "@/lib/household/addressing";
import { loadHouseholdLink } from "@/lib/household/server";
import { emit, on } from "@/lib/events/emit";
import { queueSmsFallback } from "@/lib/integrations/sms/fallback";
import { processReviewRequest } from "@/lib/integrations/reviews/server";
import { cleanupRoom } from "@/lib/integrations/telehealth/server";
import { redactText } from "@/lib/redact";
import { maybeRetryTemplateMessage } from "@/lib/templates/retry";
import { registerHandler } from "@/lib/jobs/registry";
import { registerTask } from "@/lib/jobs/tasks";
import { PermanentJobError, type JobLogger } from "@/lib/jobs/types";
import { memberIdsWithPermission, notify } from "@/lib/notify/dispatch-db";
import { createTask } from "@/lib/tasks/service";
import type { AdminClient } from "@/lib/supabase/admin";
import type { TablesUpdate } from "@/lib/supabase/types";

/**
 * `appointments` queue: scheduled_jobs of kind 'appointment.reminder' arrive as
 *   { kind, org_id, scheduled_job_id, attempt, payload: { reminder_id } }
 *
 * Idempotent: the reminder row decides. Anything other than status = 'scheduled', a stale due time,
 * a closed appointment, an exclusion or test mode ends in a terminal status without sending.
 */
const job = z.object({
  org_id: z.string().uuid(),
  payload: z.object({ reminder_id: z.string().uuid() }),
});

/** Phase 14: the waiting list rides the same queue (kinds 'waitlist.freed' and 'waitlist.expire'). */
const freedJob = z.object({
  org_id: z.string().uuid(),
  payload: z.object({
    source_appointment_id: z.string().uuid().nullable(),
    specialist_id: z.string().uuid(),
    location_id: z.string().uuid(),
    service_id: z.string().uuid().nullable(),
    starts_at: z.string().datetime({ offset: true }),
    ends_at: z.string().datetime({ offset: true }),
  }),
});
const expireJob = z.object({
  org_id: z.string().uuid(),
  payload: z.object({ offer_id: z.string().uuid() }),
});

/** Phase 19b: Google review requests ride the same queue (kind 'review.send'). */
const reviewJob = z.object({
  org_id: z.string().uuid(),
  payload: z.object({ request_id: z.string().uuid() }),
});

/** Phase 19b: removing a revoked video room at the provider (kind 'telehealth.cleanup'). */
const cleanupJob = z.object({
  org_id: z.string().uuid(),
  payload: z.object({ room_id: z.string().uuid() }),
});

const STALE_SLACK_MS = 60_000;

export type ReminderOutcome =
  "sent" | "failed" | "excluded" | "cancelled" | "skipped_not_scheduled" | "skipped_not_due";

export async function processReminder(
  admin: AdminClient,
  orgId: string,
  reminderId: string,
  log: JobLogger,
  now: Date = new Date(),
): Promise<ReminderOutcome> {
  const { data: reminder } = await admin
    .from("appointment_reminders")
    .select(
      "id, status, due_at, appointment_id, appointments(id, number, status, starts_at, contact_id, specialist_id, custom)",
    )
    .eq("id", reminderId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!reminder) throw new PermanentJobError("reminder not found");
  if (reminder.status !== "scheduled") return "skipped_not_scheduled";
  if (new Date(reminder.due_at).getTime() > now.getTime() + STALE_SLACK_MS)
    return "skipped_not_due";

  const appt = reminder.appointments;
  const finish = (patch: TablesUpdate<"appointment_reminders">) =>
    admin.from("appointment_reminders").update(patch).eq("id", reminder.id);

  const status = appt && isAppointmentStatus(appt.status) ? appt.status : "awaiting";
  if (!appt || isInactive(status) || new Date(appt.starts_at).getTime() <= now.getTime()) {
    await finish({ status: "cancelled" });
    return "cancelled";
  }
  if (!appt.contact_id) {
    await finish({ status: "excluded", exclusion_reason: "no_contact" });
    return "excluded";
  }

  const [{ data: contact }, { data: specialist }, { settings }] = await Promise.all([
    admin
      .from("contacts")
      .select("id, full_name, first_name, last_name, phone_e164, wa_bsuid")
      .eq("id", appt.contact_id)
      .eq("org_id", orgId)
      .maybeSingle(),
    appt.specialist_id
      ? admin.from("specialists").select("name").eq("id", appt.specialist_id).maybeSingle()
      : Promise.resolve({ data: null }),
    loadOrgSettings(admin, orgId),
  ]);

  const { data: excluded } = await admin.rpc("is_reminder_excluded", {
    p_org: orgId,
    p_patient_name: contact?.full_name ?? "",
    p_doctor_name: specialist?.name ?? "",
  });
  if (excluded) {
    await finish({ status: "excluded", exclusion_reason: "exclusion_list" });
    return "excluded";
  }
  // Test mode checks the number the message would actually go to (a dependant's goes to the guardian's).
  const target = contact
    ? resolveRecipient(
        contact as HouseholdContact,
        await loadHouseholdLink(admin, orgId, contact.id),
      )
    : null;
  const sendsTo = target?.recipient.phone_e164 ?? contact?.phone_e164 ?? null;
  if (
    settings.reminder_test_mode &&
    !(sendsTo && settings.reminder_test_numbers.includes(sendsTo))
  ) {
    await finish({ status: "excluded", exclusion_reason: "test_mode" });
    return "excluded";
  }

  const result = await sendAppointmentTemplate(admin, {
    orgId,
    appointmentId: appt.id,
    key: "reminder",
    sentByUserId: null,
  });
  if (!result.ok) {
    await finish({ status: "failed", error: result.error.slice(0, 300) });
    await reportReminderFailure(admin, orgId, appt.id, appt.number, result.error, {
      reminderId: reminder.id,
    });
    log.warn("reminder not sent", { reminderId: reminder.id, reason: result.error });
    return "failed";
  }
  await finish({ status: "sent", sent_at: now.toISOString(), message_id: result.messageId });
  await emit(orgId, "appointment.reminder_sent", {
    appointment_id: appt.id,
    reminder_id: reminder.id,
    message_id: result.messageId,
  });
  return "sent";
}

/** How long reception has to ring the patient before the task is overdue. */
const CALL_TASK_DUE_MS = 30 * 60_000;

/**
 * A reminder that did not reach the patient: tell reception, and leave a "call patient" task so the
 * call cannot be forgotten. Idempotent: one open call task per appointment (also enforced by a
 * partial unique index), so a repeat failure, a replayed job or both failure paths add nothing.
 * The task subject carries the appointment number only, never the patient's name.
 */
export async function reportReminderFailure(
  admin: AdminClient,
  orgId: string,
  appointmentId: string,
  number: number,
  reason: string,
  sms: {
    reminderId: string | null;
    sourceMessageId?: string | null;
    whatsappErrorCode?: number | null;
  } = {
    reminderId: null,
  },
): Promise<void> {
  await emit(orgId, "appointment.reminder_failed", { appointment_id: appointmentId, reason });
  await createCallTask(admin, orgId, appointmentId, number);
  // Phase 19: when the SMS fallback is switched on, the patient also gets a short, generic text (consent, opt-out and training
  // rules are applied inside). The call task above stays: it is the human safety net if the SMS does not arrive either.
  try {
    await queueSmsFallback(admin, {
      orgId,
      appointmentId,
      reminderId: sms.reminderId,
      sourceMessageId: sms.sourceMessageId ?? null,
      whatsappErrorCode: sms.whatsappErrorCode ?? null,
    });
  } catch (err) {
    console.error("[sms-fallback] could not queue", { error: redactText(err, 120) });
  }
  await notify(admin, {
    orgId,
    userIds: await memberIdsWithPermission(admin, orgId, "appointments.manage"),
    event: "reminder.failed",
    type: "reminder.failed",
    title: "Appointment reminder not delivered",
    body: `Appointment #${number}: call the patient to remind them.`,
    payload: { appointment_id: appointmentId },
    ids: { appointment_id: appointmentId },
  });
}

async function createCallTask(
  admin: AdminClient,
  orgId: string,
  appointmentId: string,
  number: number,
): Promise<void> {
  const openTask = () =>
    admin
      .from("tasks")
      .select("id")
      .eq("org_id", orgId)
      .eq("appointment_id", appointmentId)
      .eq("type", "call")
      .eq("done", false)
      .limit(1)
      .maybeSingle();
  if ((await openTask()).data) return;

  const { data: appt } = await admin
    .from("appointments")
    .select("contact_id, created_by")
    .eq("id", appointmentId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!appt) return;

  // The booking's creator owns the call if they still work here; otherwise it is left unassigned.
  let assigneeId: string | null = null;
  if (appt.created_by) {
    const { data: m } = await admin
      .from("memberships")
      .select("user_id")
      .eq("org_id", orgId)
      .eq("user_id", appt.created_by)
      .eq("status", "active")
      .maybeSingle();
    assigneeId = m?.user_id ?? null;
  }

  try {
    await createTask(
      { admin, orgId, userId: null },
      {
        type: "call",
        subject: `Call patient: reminder for appointment #${number} not delivered`,
        dueAt: new Date(Date.now() + CALL_TASK_DUE_MS).toISOString(),
        assigneeId,
        contactId: appt.contact_id,
        appointmentId,
      },
    );
  } catch (e) {
    // A concurrent failure path may have created it first; that is the outcome we wanted.
    if ((await openTask()).data) return;
    throw e;
  }
}

registerHandler({
  queue: "appointments",
  name: "appointments.reminder",
  batchSize: 25,
  visibilityTimeout: 60,
  maxReads: 5,
  concurrency: "serial",
  async handler(raw, ctx) {
    const kind = (raw as { kind?: unknown } | null)?.kind;
    if (kind === "waitlist.freed") {
      const p = freedJob.safeParse(raw);
      if (!p.success)
        throw new PermanentJobError(`invalid waitlist job: ${p.error.issues[0]?.message}`);
      const res = await offerFreedSlot(ctx.admin, { orgId: p.data.org_id, slot: p.data.payload });
      ctx.log.info("freed slot processed", { ...res });
      return;
    }
    if (kind === "waitlist.expire") {
      const p = expireJob.safeParse(raw);
      if (!p.success)
        throw new PermanentJobError(`invalid waitlist job: ${p.error.issues[0]?.message}`);
      const res = await expireOffer(ctx.admin, p.data.org_id, p.data.payload.offer_id);
      ctx.log.info("offer expiry processed", { result: res });
      return;
    }
    if (kind === "telehealth.cleanup") {
      const p = cleanupJob.safeParse(raw);
      if (!p.success)
        throw new PermanentJobError(`invalid telehealth job: ${p.error.issues[0]?.message}`);
      const outcome = await cleanupRoom(ctx.admin, {
        orgId: p.data.org_id,
        roomId: p.data.payload.room_id,
      });
      ctx.log.info("video room clean-up processed", { outcome });
      return;
    }
    if (kind === "review.send") {
      const p = reviewJob.safeParse(raw);
      if (!p.success)
        throw new PermanentJobError(`invalid review job: ${p.error.issues[0]?.message}`);
      const outcome = await processReviewRequest(ctx.admin, {
        orgId: p.data.org_id,
        requestId: p.data.payload.request_id,
      });
      ctx.log.info("review request processed", { outcome });
      return;
    }
    const parsed = job.safeParse(raw);
    if (!parsed.success)
      throw new PermanentJobError(`invalid appointment job: ${parsed.error.issues[0]?.message}`);
    await processReminder(ctx.admin, parsed.data.org_id, parsed.data.payload.reminder_id, ctx.log);
  },
});

// Template button replies on reminders (Confirm / Reschedule / Cancel) update the appointment.
on("message.received", async (event) => {
  const p = event.payload;
  if (typeof p.contact_id !== "string" || !p.interactive) return;
  const { createAdminClient } = await import("@/lib/supabase/admin");
  await applyReminderReply(createAdminClient(), {
    orgId: event.orgId,
    contactId: p.contact_id,
    replyToWaMessageId:
      typeof p.reply_to_wa_message_id === "string" ? p.reply_to_wa_message_id : null,
    interactive: p.interactive as {
      type?: string | null;
      id?: string | null;
      title?: string | null;
    },
  });
});

// A patient answering a waiting-list offer: a tap on the offer template's buttons, or a typed YES / NO.
// First YES wins inside accept_slot_offer(); this listener only reads the answer.
on("message.received", async (event) => {
  const p = event.payload;
  if (typeof p.contact_id !== "string" || typeof p.conversation_id !== "string") return;
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const admin = createAdminClient();
  const interactive = p.interactive as { id?: string | null; title?: string | null } | null;
  const messageId = typeof p.message_id === "string" ? p.message_id : null;
  await handleOfferReply(admin, {
    orgId: event.orgId,
    contactId: p.contact_id,
    conversationId: p.conversation_id,
    viaButton: !!interactive,
    replyToWaMessageId:
      typeof p.reply_to_wa_message_id === "string" ? p.reply_to_wa_message_id : null,
    intent: async () => {
      if (interactive) return classifyOfferButton(interactive);
      if (p.kind !== "text" || !messageId) return "unknown";
      const { data } = await admin
        .from("messages")
        .select("body")
        .eq("id", messageId)
        .eq("org_id", event.orgId)
        .maybeSingle();
      return classifyOfferReply(data?.body);
    },
  });
});

// A send that Meta rejects (immediately or via a status webhook) turns the reminder into 'failed'.
on("message.failed", async (event) => {
  const messageId = event.payload.message_id;
  if (typeof messageId !== "string") return;
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const admin = createAdminClient();
  // Phase 20d: when the reminder's template retries on failure, the reminder follows the retry and is only failed
  // (call task, SMS fallback) once the retries are used up. Same idempotent call as the generic listener.
  const retry = await maybeRetryTemplateMessage(admin, event.orgId, messageId).catch(() => null);
  if (retry && retry.status !== "skipped") {
    await admin
      .from("appointment_reminders")
      .update({ message_id: retry.retryMessageId })
      .eq("message_id", messageId)
      .eq("org_id", event.orgId)
      .eq("status", "sent");
    return;
  }
  const { data: failed } = await admin
    .from("appointment_reminders")
    .update({
      status: "failed",
      error: `WhatsApp error ${String(event.payload.code ?? "")}`.trim(),
    })
    .eq("message_id", messageId)
    .eq("org_id", event.orgId)
    .eq("status", "sent")
    .select("id, appointment_id, appointments(number)");
  const code = Number(event.payload.code);
  for (const r of failed ?? []) {
    await reportReminderFailure(
      admin,
      event.orgId,
      r.appointment_id,
      r.appointments?.number ?? 0,
      "delivery failed",
      {
        reminderId: r.id,
        sourceMessageId: messageId,
        whatsappErrorCode: Number.isFinite(code) ? code : null,
      },
    );
  }
});

/**
 * /api/jobs/appointments_sweep (every 5 min): reconcile reminders for upcoming appointments so a
 * booking-rule edit or a missed hook can't leave a patient without their reminder.
 */
registerTask("appointments_sweep", {
  name: "appointments.sweep",
  async run(admin, log) {
    const { data: orgs } = await admin.from("orgs").select("id");
    let checked = 0;
    let scheduled = 0;
    let cancelled = 0;
    for (const org of orgs ?? []) {
      const { settings } = await loadOrgSettings(admin, org.id);
      const horizon = new Date(Date.now() + 30 * 24 * 3600_000).toISOString();
      const { data: upcoming } = await admin
        .from("appointments")
        .select("id, org_id, contact_id, starts_at, status, source")
        .eq("org_id", org.id)
        .in("status", ["awaiting", "confirmed"])
        .gt("starts_at", new Date().toISOString())
        .lt("starts_at", horizon)
        .order("starts_at")
        .limit(1000);
      for (const a of upcoming ?? []) {
        const r = await syncAppointmentReminders(admin, a, { settings });
        checked++;
        scheduled += r.scheduled;
        cancelled += r.cancelled;
      }
    }
    log.info("appointments sweep", { checked, scheduled, cancelled });
    return { checked, scheduled, cancelled };
  },
});
