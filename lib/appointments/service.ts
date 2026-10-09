import "server-only";

import { loadSlotInput } from "@/lib/appointments/availability";
import {
  buildAppointmentTemplateValues,
  computeReminders,
  planReminders,
  reminderDedupeKey,
} from "@/lib/appointments/reminders";
import { readAppointmentSettings, type AppointmentSettings } from "@/lib/appointments/settings";
import { isSlotAvailable, localDate } from "@/lib/appointments/slots";
import {
  canTransition,
  isAppointmentStatus,
  isInactive,
  notificationKeyFor,
  type AppointmentStatus,
} from "@/lib/appointments/status";
import { addTimelineEvent } from "@/lib/contacts/timeline";
import { emit } from "@/lib/events/emit";
import { ensureConversation } from "@/lib/inbox/conversations";
import { queueOutbound } from "@/lib/inbox/send";
import { scheduleJob } from "@/lib/jobs/enqueue";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Tables } from "@/lib/supabase/types";
import { renderTemplatePreview } from "@/lib/whatsapp/templates";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

type Appointment = Tables<"appointments">;

export type NotifyKey = "reminder" | "confirmed" | "cancelled" | "rescheduled";

export type NotifyResult = { ok: true; messageId: string } | { ok: false; error: string };

export type ServiceResult<T> = ({ ok: true } & T) | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Settings / channel
// ---------------------------------------------------------------------------

export async function loadOrgSettings(
  admin: AdminClient,
  orgId: string,
): Promise<{ settings: AppointmentSettings; timezone: string }> {
  const { data } = await admin.from("orgs").select("settings, timezone").eq("id", orgId).single();
  return {
    settings: readAppointmentSettings(data?.settings),
    timezone: data?.timezone ?? "Asia/Dubai",
  };
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

async function deletePendingReminderJob(admin: AdminClient, key: string): Promise<void> {
  await admin.from("scheduled_jobs").delete().eq("dedupe_key", key).is("done_at", null);
}

/** Cancels every unsent reminder of an appointment and its scheduled jobs. */
export async function cancelAppointmentReminders(
  admin: AdminClient,
  orgId: string,
  appointmentId: string,
): Promise<number> {
  const { data: pending } = await admin
    .from("appointment_reminders")
    .select("id, idx")
    .eq("org_id", orgId)
    .eq("appointment_id", appointmentId)
    .eq("status", "scheduled");
  for (const r of pending ?? []) {
    await deletePendingReminderJob(admin, reminderDedupeKey(appointmentId, r.idx));
  }
  if (pending?.length) {
    await admin
      .from("appointment_reminders")
      .update({ status: "cancelled" })
      .in(
        "id",
        pending.map((r) => r.id),
      );
  }
  return pending?.length ?? 0;
}

/**
 * Brings reminder rows and scheduled jobs in line with the booking rules and the appointment's
 * current time/status. Safe to call repeatedly (booking, edit, sync, sweep).
 */
export async function syncAppointmentReminders(
  admin: AdminClient,
  appt: Pick<Appointment, "id" | "org_id" | "contact_id" | "starts_at" | "status">,
  opts: { settings?: AppointmentSettings; now?: Date } = {},
): Promise<{ scheduled: number; cancelled: number }> {
  const settings = opts.settings ?? (await loadOrgSettings(admin, appt.org_id)).settings;
  const status = isAppointmentStatus(appt.status) ? appt.status : "awaiting";
  // Without a contact (unmatched Unite patient) there is nobody to message.
  const desired = appt.contact_id
    ? computeReminders({
        startsAt: new Date(appt.starts_at),
        now: opts.now ?? new Date(),
        status,
        rules: settings.reminders,
      })
    : [];

  const { data: existing } = await admin
    .from("appointment_reminders")
    .select("idx, due_at, status")
    .eq("appointment_id", appt.id);
  const plan = planReminders(desired, existing ?? []);

  for (const idx of plan.cancel) {
    await deletePendingReminderJob(admin, reminderDedupeKey(appt.id, idx));
    await admin
      .from("appointment_reminders")
      .update({ status: "cancelled" })
      .eq("appointment_id", appt.id)
      .eq("idx", idx);
  }

  for (const d of plan.upsert) {
    const key = reminderDedupeKey(appt.id, d.idx);
    const { data: row, error } = await admin
      .from("appointment_reminders")
      .upsert(
        {
          org_id: appt.org_id,
          appointment_id: appt.id,
          idx: d.idx,
          due_at: d.dueAt.toISOString(),
          status: "scheduled",
          sent_at: null,
          message_id: null,
          error: null,
          exclusion_reason: null,
          dedupe_key: key,
        },
        { onConflict: "appointment_id,idx" },
      )
      .select("id")
      .single();
    if (error) throw new Error(`reminder upsert failed: ${error.message}`);
    await deletePendingReminderJob(admin, key);
    await scheduleJob({
      kind: "appointment.reminder",
      payload: { reminder_id: row.id },
      runAt: d.dueAt,
      orgId: appt.org_id,
      dedupeKey: key,
    });
  }
  return { scheduled: plan.upsert.length, cancelled: plan.cancel.length };
}

// ---------------------------------------------------------------------------
// Notifications (templates)
// ---------------------------------------------------------------------------

/** Sends one of the mapped appointment templates (reminder, confirmed, cancelled, rescheduled). */
export async function sendAppointmentTemplate(
  admin: AdminClient,
  input: {
    orgId: string;
    appointmentId: string;
    key: NotifyKey;
    sentByUserId: string | null;
  },
): Promise<NotifyResult> {
  const { data: appt } = await admin
    .from("appointments")
    .select(
      "id, org_id, number, contact_id, starts_at, location_id, specialist_id, service_id, channel_id",
    )
    .eq("id", input.appointmentId)
    .eq("org_id", input.orgId)
    .maybeSingle();
  if (!appt) return { ok: false, error: "Appointment not found." };
  if (!appt.contact_id) return { ok: false, error: "This appointment has no linked patient." };

  const { settings, timezone: orgTz } = await loadOrgSettings(admin, input.orgId);
  const templateId = settings.templates[input.key];
  if (!templateId)
    return { ok: false, error: `No ${input.key} template is mapped in Settings → Appointments.` };

  const [{ data: contact }, { data: tpl }, location, specialist, service] = await Promise.all([
    admin
      .from("contacts")
      .select("first_name, last_name, phone_e164, wa_bsuid, stop_marketing")
      .eq("id", appt.contact_id)
      .eq("org_id", input.orgId)
      .maybeSingle(),
    admin
      .from("wa_templates")
      .select("id, name, status, category, components, variable_map, channel_id, waba_id")
      .eq("id", templateId)
      .eq("org_id", input.orgId)
      .maybeSingle(),
    appt.location_id
      ? admin.from("locations").select("name, timezone").eq("id", appt.location_id).maybeSingle()
      : Promise.resolve({ data: null }),
    appt.specialist_id
      ? admin.from("specialists").select("name").eq("id", appt.specialist_id).maybeSingle()
      : Promise.resolve({ data: null }),
    appt.service_id
      ? admin.from("services").select("name").eq("id", appt.service_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  if (!contact) return { ok: false, error: "Patient not found." };
  if (!contact.phone_e164 && !contact.wa_bsuid)
    return { ok: false, error: "The patient has no WhatsApp identifier." };
  if (!tpl) return { ok: false, error: "The mapped template no longer exists." };
  if (tpl.status !== "APPROVED")
    return { ok: false, error: `Template "${tpl.name}" is ${tpl.status}, not approved.` };
  if (tpl.category === "MARKETING" && contact.stop_marketing)
    return { ok: false, error: "The patient has opted out of marketing messages." };

  // Send from the channel that owns the template's WABA.
  const { data: channels } = await admin
    .from("channels")
    .select("id")
    .eq("org_id", input.orgId)
    .eq("status", "active")
    .eq("waba_id", tpl.waba_id);
  const ids = (channels ?? []).map((c) => c.id);
  const channelId =
    [appt.channel_id, settings.channel_id, tpl.channel_id].find(
      (c): c is string => !!c && ids.includes(c),
    ) ?? ids[0];
  if (!channelId) return { ok: false, error: "No active WhatsApp number can send this template." };

  const components = tpl.components as unknown as MetaTemplateComponent[];
  const values = buildAppointmentTemplateValues(
    components,
    tpl.variable_map as Record<string, string>,
    {
      contact,
      startsAt: new Date(appt.starts_at),
      timezone: location.data?.timezone ?? orgTz,
      specialist: specialist.data?.name,
      location: location.data?.name,
      service: service.data?.name,
      number: appt.number,
    },
  );
  const preview = renderTemplatePreview(components, values);
  if (preview.missing.length)
    return { ok: false, error: `Template variables are not mapped: ${preview.missing.join(", ")}` };

  const conversation = await ensureConversation(admin, input.orgId, appt.contact_id, channelId);
  const message = await queueOutbound(admin, {
    orgId: input.orgId,
    conversationId: conversation.id,
    spec: { type: "template", template_id: tpl.id, values },
    body: [preview.headerText, preview.body].filter(Boolean).join("\n"),
    sentByUserId: input.sentByUserId,
    priority: false, // automations ride the bulk lane; live chat keeps outbound_priority
  });
  return { ok: true, messageId: message.id };
}

// ---------------------------------------------------------------------------
// Create / update
// ---------------------------------------------------------------------------

async function slotOk(
  admin: AdminClient,
  args: {
    orgId: string;
    specialistId: string;
    locationId: string;
    startsAt: Date;
    durationMin: number;
    excludeAppointmentId?: string;
  },
): Promise<boolean> {
  const { data: location } = await admin
    .from("locations")
    .select("timezone")
    .eq("id", args.locationId)
    .eq("org_id", args.orgId)
    .maybeSingle();
  if (!location) return false;
  const input = await loadSlotInput(admin, {
    orgId: args.orgId,
    specialistId: args.specialistId,
    locationId: args.locationId,
    date: localDate(args.startsAt, location.timezone),
    durationMin: args.durationMin,
    excludeAppointmentId: args.excludeAppointmentId,
  });
  if (!input) return false;
  // Lead time is for patient self-booking; staff may book into it, but not into the past.
  return isSlotAvailable({ ...input, leadTimeMin: 0, now: new Date() }, args.startsAt);
}

export type CreateAppointmentInput = {
  orgId: string;
  actorId: string | null;
  contactId: string;
  locationId: string;
  specialistId: string;
  serviceId: string;
  startsAt: Date;
  notes?: string | null;
  notifyEarly?: boolean;
  /** Send the "confirmed" template after booking. */
  notify?: boolean;
  /** Book outside working hours / over a block (needs appointments.manage; checked by the caller). */
  override?: boolean;
  source?: "portal" | "bot";
};

export async function createAppointment(
  admin: AdminClient,
  input: CreateAppointmentInput,
): Promise<ServiceResult<{ appointment: Appointment; notification: NotifyResult | null }>> {
  const [{ data: contact }, { data: service }, { data: specialist }, { data: location }] =
    await Promise.all([
      admin
        .from("contacts")
        .select("id")
        .eq("id", input.contactId)
        .eq("org_id", input.orgId)
        .is("deleted_at", null)
        .maybeSingle(),
      admin
        .from("services")
        .select("id, duration_min, department_id")
        .eq("id", input.serviceId)
        .eq("org_id", input.orgId)
        .maybeSingle(),
      admin
        .from("specialists")
        .select("id, department_id")
        .eq("id", input.specialistId)
        .eq("org_id", input.orgId)
        .maybeSingle(),
      admin
        .from("locations")
        .select("id")
        .eq("id", input.locationId)
        .eq("org_id", input.orgId)
        .maybeSingle(),
    ]);
  if (!contact) return { ok: false, error: "Patient not found." };
  if (!service) return { ok: false, error: "Service not found." };
  if (!specialist) return { ok: false, error: "Specialist not found." };
  if (!location) return { ok: false, error: "Location not found." };

  if (!input.override) {
    const ok = await slotOk(admin, {
      orgId: input.orgId,
      specialistId: input.specialistId,
      locationId: input.locationId,
      startsAt: input.startsAt,
      durationMin: service.duration_min,
    });
    if (!ok) return { ok: false, error: "That time is not available for this specialist." };
  }

  const { settings } = await loadOrgSettings(admin, input.orgId);
  const endsAt = new Date(input.startsAt.getTime() + service.duration_min * 60_000);
  const { data: appointment, error } = await admin
    .from("appointments")
    .insert({
      org_id: input.orgId,
      contact_id: input.contactId,
      location_id: input.locationId,
      specialist_id: input.specialistId,
      service_id: input.serviceId,
      department_id: service.department_id ?? specialist.department_id,
      starts_at: input.startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      status: settings.auto_confirm ? "confirmed" : "awaiting",
      notes: input.notes ?? null,
      notify_early: input.notifyEarly ?? false,
      source: input.source ?? "portal",
      created_by: input.actorId,
    })
    .select("*")
    .single();
  if (error) return { ok: false, error: `Could not book: ${error.message}` };

  await syncAppointmentReminders(admin, appointment, { settings });
  await addTimelineEvent(admin, {
    orgId: input.orgId,
    contactId: input.contactId,
    type: "appointment.created",
    actorType: input.actorId ? "user" : "system",
    actorId: input.actorId,
    payload: {
      appointment_id: appointment.id,
      number: appointment.number,
      starts_at: appointment.starts_at,
    },
  });
  await emit(input.orgId, "appointment.created", {
    appointment_id: appointment.id,
    contact_id: input.contactId,
    source: appointment.source,
  });

  const notification = input.notify
    ? await sendAppointmentTemplate(admin, {
        orgId: input.orgId,
        appointmentId: appointment.id,
        key: "confirmed",
        sentByUserId: input.actorId,
      })
    : null;
  return { ok: true, appointment, notification };
}

export type StatusChangeInput = {
  orgId: string;
  appointmentId: string;
  to: AppointmentStatus;
  actorId: string | null;
  actorType?: "user" | "system" | "contact";
  /** Send the matching template (confirmed / cancelled) after the change. */
  notify?: boolean;
  via?: "portal" | "button_reply" | "unite";
};

export async function changeAppointmentStatus(
  admin: AdminClient,
  input: StatusChangeInput,
): Promise<ServiceResult<{ appointment: Appointment; notification: NotifyResult | null }>> {
  const { data: current } = await admin
    .from("appointments")
    .select("*")
    .eq("id", input.appointmentId)
    .eq("org_id", input.orgId)
    .maybeSingle();
  if (!current) return { ok: false, error: "Appointment not found." };
  const from = isAppointmentStatus(current.status) ? current.status : "awaiting";
  if (!canTransition(from, input.to))
    return { ok: false, error: `Cannot change from ${from} to ${input.to}.` };

  const { data: appointment, error } = await admin
    .from("appointments")
    .update({ status: input.to })
    .eq("id", current.id)
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };

  if (isInactive(input.to)) await cancelAppointmentReminders(admin, input.orgId, current.id);
  else await syncAppointmentReminders(admin, appointment);

  if (current.contact_id) {
    await addTimelineEvent(admin, {
      orgId: input.orgId,
      contactId: current.contact_id,
      type: "appointment.status_changed",
      actorType: input.actorType ?? (input.actorId ? "user" : "system"),
      actorId: input.actorId,
      payload: { appointment_id: current.id, from, to: input.to, via: input.via ?? "portal" },
    });
  }
  await emit(input.orgId, "appointment.status_changed", {
    appointment_id: current.id,
    contact_id: current.contact_id,
    from,
    to: input.to,
    via: input.via ?? "portal",
  });

  const key = notificationKeyFor(input.to);
  const notification =
    input.notify && key
      ? await sendAppointmentTemplate(admin, {
          orgId: input.orgId,
          appointmentId: current.id,
          key,
          sentByUserId: input.actorId,
        })
      : null;
  return { ok: true, appointment, notification };
}

export type RescheduleInput = {
  orgId: string;
  appointmentId: string;
  actorId: string | null;
  startsAt: Date;
  specialistId?: string;
  locationId?: string;
  override?: boolean;
  notify?: boolean;
};

export async function rescheduleAppointment(
  admin: AdminClient,
  input: RescheduleInput,
): Promise<ServiceResult<{ appointment: Appointment; notification: NotifyResult | null }>> {
  const { data: current } = await admin
    .from("appointments")
    .select("*")
    .eq("id", input.appointmentId)
    .eq("org_id", input.orgId)
    .maybeSingle();
  if (!current) return { ok: false, error: "Appointment not found." };
  if (current.source === "unite")
    return { ok: false, error: "Unite appointments are managed in Unite (read-only here)." };
  if (current.status === "cancelled" || current.status === "completed")
    return { ok: false, error: "This appointment can no longer be moved." };

  const specialistId = input.specialistId ?? current.specialist_id;
  const locationId = input.locationId ?? current.location_id;
  if (!specialistId || !locationId)
    return { ok: false, error: "Choose a specialist and location first." };
  const durationMin = Math.round(
    (new Date(current.ends_at).getTime() - new Date(current.starts_at).getTime()) / 60_000,
  );

  if (!input.override) {
    const ok = await slotOk(admin, {
      orgId: input.orgId,
      specialistId,
      locationId,
      startsAt: input.startsAt,
      durationMin,
      excludeAppointmentId: current.id,
    });
    if (!ok) return { ok: false, error: "That time is not available for this specialist." };
  }

  const { data: appointment, error } = await admin
    .from("appointments")
    .update({
      starts_at: input.startsAt.toISOString(),
      ends_at: new Date(input.startsAt.getTime() + durationMin * 60_000).toISOString(),
      specialist_id: specialistId,
      location_id: locationId,
      // A moved appointment needs the patient's confirmation again.
      status: current.status === "confirmed" ? "awaiting" : current.status,
    })
    .eq("id", current.id)
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };

  await syncAppointmentReminders(admin, appointment);
  if (current.contact_id) {
    await addTimelineEvent(admin, {
      orgId: input.orgId,
      contactId: current.contact_id,
      type: "appointment.rescheduled",
      actorType: input.actorId ? "user" : "system",
      actorId: input.actorId,
      payload: { appointment_id: current.id, from: current.starts_at, to: appointment.starts_at },
    });
  }
  await emit(input.orgId, "appointment.updated", {
    appointment_id: current.id,
    contact_id: current.contact_id,
    changed: ["starts_at"],
  });

  const notification = input.notify
    ? await sendAppointmentTemplate(admin, {
        orgId: input.orgId,
        appointmentId: current.id,
        key: "rescheduled",
        sentByUserId: input.actorId,
      })
    : null;
  return { ok: true, appointment, notification };
}

export type TimeBlockInput = {
  orgId: string;
  actorId: string | null;
  specialistId: string;
  locationId?: string | null;
  startsAt: Date;
  endsAt: Date;
  reason?: string | null;
};

export async function createTimeBlock(
  admin: AdminClient,
  input: TimeBlockInput,
): Promise<ServiceResult<{ block: Tables<"time_blocks"> }>> {
  if (input.endsAt <= input.startsAt) return { ok: false, error: "End must be after start." };
  const { data: specialist } = await admin
    .from("specialists")
    .select("id")
    .eq("id", input.specialistId)
    .eq("org_id", input.orgId)
    .maybeSingle();
  if (!specialist) return { ok: false, error: "Specialist not found." };
  const { data: block, error } = await admin
    .from("time_blocks")
    .insert({
      org_id: input.orgId,
      specialist_id: input.specialistId,
      location_id: input.locationId ?? null,
      starts_at: input.startsAt.toISOString(),
      ends_at: input.endsAt.toISOString(),
      reason: input.reason ?? null,
      created_by: input.actorId,
    })
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, block };
}
