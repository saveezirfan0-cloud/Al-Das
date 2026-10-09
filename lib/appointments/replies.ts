import "server-only";

import { classifyButtonReply, decideReply } from "@/lib/appointments/button-reply";
import { changeAppointmentStatus, loadOrgSettings } from "@/lib/appointments/service";
import { isAppointmentStatus } from "@/lib/appointments/status";
import { addTimelineEvent } from "@/lib/contacts/timeline";
import { notifyMembersWithPermission } from "@/lib/notifications";
import type { AdminClient } from "@/lib/supabase/admin";

export type ReminderReply = {
  orgId: string;
  contactId: string;
  /** wa_message_id of the outbound reminder the patient replied to. */
  replyToWaMessageId: string | null;
  interactive: { type?: string | null; id?: string | null; title?: string | null } | null;
};

export type ReplyOutcome =
  "ignored" | "confirmed" | "cancelled" | "reception_notified" | "no_reminder";

/**
 * A patient tapped Confirm / Reschedule / Cancel on a reminder: find the reminder that message
 * belongs to and apply the booking rules. Only replies to a message we sent as a reminder count,
 * so a stray "Cancel" button from another template can't touch an appointment.
 */
export async function applyReminderReply(
  admin: AdminClient,
  reply: ReminderReply,
  now: Date = new Date(),
): Promise<ReplyOutcome> {
  if (!reply.interactive || !reply.replyToWaMessageId) return "ignored";
  const action = classifyButtonReply(reply.interactive);
  if (action === "unknown") return "ignored";

  const { data: outbound } = await admin
    .from("messages")
    .select("id")
    .eq("org_id", reply.orgId)
    .eq("wa_message_id", reply.replyToWaMessageId)
    .eq("direction", "out")
    .maybeSingle();
  if (!outbound) return "no_reminder";

  const { data: reminder } = await admin
    .from("appointment_reminders")
    .select("appointment_id, appointments(id, number, status, starts_at, contact_id)")
    .eq("org_id", reply.orgId)
    .eq("message_id", outbound.id)
    .maybeSingle();
  const appt = reminder?.appointments;
  // The reply must come from the patient the appointment belongs to.
  if (!appt || appt.contact_id !== reply.contactId) return "no_reminder";

  const { settings } = await loadOrgSettings(admin, reply.orgId);
  const decision = decideReply(
    action,
    {
      status: isAppointmentStatus(appt.status) ? appt.status : "awaiting",
      startsAt: new Date(appt.starts_at),
    },
    settings,
    now,
  );

  if (decision.kind === "ignore") return "ignored";

  if (decision.kind === "set_status") {
    const res = await changeAppointmentStatus(admin, {
      orgId: reply.orgId,
      appointmentId: appt.id,
      to: decision.status,
      actorId: null,
      actorType: "contact",
      via: "button_reply",
    });
    return res.ok ? (decision.status === "cancelled" ? "cancelled" : "confirmed") : "ignored";
  }

  await addTimelineEvent(admin, {
    orgId: reply.orgId,
    contactId: reply.contactId,
    type: "appointment.reply",
    actorType: "contact",
    payload: { appointment_id: appt.id, action, reason: decision.reason },
  });
  const text = {
    cancel_too_late: [
      "Late cancellation request",
      `Appointment #${appt.number}: the patient tapped Cancel inside the cancellation window.`,
    ],
    reschedule_too_late: [
      "Late reschedule request",
      `Appointment #${appt.number}: the patient tapped Reschedule inside the reschedule window. Please call them.`,
    ],
    reschedule_requested: [
      "Patient asked to reschedule",
      `Appointment #${appt.number}: the patient tapped Reschedule. Please offer new times.`,
    ],
  }[decision.reason];
  await notifyMembersWithPermission(admin, reply.orgId, "appointments.manage", {
    type: "appointment.reply",
    title: text[0],
    body: text[1],
    payload: { appointment_id: appt.id, contact_id: reply.contactId },
  });
  return "reception_notified";
}
