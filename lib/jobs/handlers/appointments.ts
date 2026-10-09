import { z } from "zod";

import { isInactive, isAppointmentStatus } from "@/lib/appointments/status";
import {
  loadOrgSettings,
  sendAppointmentTemplate,
  syncAppointmentReminders,
} from "@/lib/appointments/service";
import { applyReminderReply } from "@/lib/appointments/replies";
import { emit, on } from "@/lib/events/emit";
import { registerHandler } from "@/lib/jobs/registry";
import { registerTask } from "@/lib/jobs/tasks";
import { PermanentJobError, type JobLogger } from "@/lib/jobs/types";
import { notifyMembersWithPermission } from "@/lib/notifications";
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
      .select("full_name, phone_e164")
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
  if (
    settings.reminder_test_mode &&
    !(contact?.phone_e164 && settings.reminder_test_numbers.includes(contact.phone_e164))
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
    await reportReminderFailure(admin, orgId, appt.id, appt.number, result.error);
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

async function reportReminderFailure(
  admin: AdminClient,
  orgId: string,
  appointmentId: string,
  number: number,
  reason: string,
): Promise<void> {
  await emit(orgId, "appointment.reminder_failed", { appointment_id: appointmentId, reason });
  // No tasks table until Phase 5: ring reception through a notification instead.
  await notifyMembersWithPermission(admin, orgId, "appointments.manage", {
    type: "appointment.reminder_failed",
    title: "Appointment reminder not delivered",
    body: `Appointment #${number}: call the patient to remind them.`,
    payload: { appointment_id: appointmentId },
  });
}

registerHandler({
  queue: "appointments",
  name: "appointments.reminder",
  batchSize: 25,
  visibilityTimeout: 60,
  maxReads: 5,
  concurrency: "serial",
  async handler(raw, ctx) {
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

// A send that Meta rejects (immediately or via a status webhook) turns the reminder into 'failed'.
on("message.failed", async (event) => {
  const messageId = event.payload.message_id;
  if (typeof messageId !== "string") return;
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const admin = createAdminClient();
  const { data: failed } = await admin
    .from("appointment_reminders")
    .update({
      status: "failed",
      error: `WhatsApp error ${String(event.payload.code ?? "")}`.trim(),
    })
    .eq("message_id", messageId)
    .eq("org_id", event.orgId)
    .eq("status", "sent")
    .select("appointment_id, appointments(number)");
  for (const r of failed ?? []) {
    await reportReminderFailure(
      admin,
      event.orgId,
      r.appointment_id,
      r.appointments?.number ?? 0,
      "delivery failed",
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
        .select("id, org_id, contact_id, starts_at, status")
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
