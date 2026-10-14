"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { changeAppointmentStatus, createAppointment } from "@/lib/appointments/service";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { readBranchAccess } from "@/lib/branches/access";
import { accessFilterIds } from "@/lib/branches/filter";
import {
  BRANCH_DENIED,
  branchAllowed,
  memberBranchView,
  rowOutsideBranches,
} from "@/lib/branches/guard";
import { addTimelineEvent } from "@/lib/contacts/timeline";
import { matchContact } from "@/lib/contacts/import-writer";
import { emit } from "@/lib/events/emit";
import { checkinPatch, isCheckinState, CHECKIN_STATES } from "@/lib/front-desk/checkin";
import { logDeskCall, sendDeskMessage } from "@/lib/front-desk/desk-send";
import { isLateChoice } from "@/lib/front-desk/messages";
import { scheduleReviewRequestSafely } from "@/lib/integrations/reviews/server";
import { loadPatientCard, type PatientCardData } from "@/lib/front-desk/server";
import {
  splitName,
  storedLanguage,
  walkInPhone,
  walkInSchema,
  type WalkInInput,
} from "@/lib/front-desk/walk-in";
import { redactText } from "@/lib/redact";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

export type ActionResult<T = undefined> =
  { ok: true; data?: T; message?: string } | { ok: false; error: string };

const uuid = z.string().uuid();
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

function refresh() {
  revalidatePath("/front-desk");
}

/** Every desk action needs the workspace permission; callers add the domain permission they act under. */
async function deskMember(...also: string[]) {
  const member = await requirePerm("frontdesk.use");
  for (const perm of also) {
    if (!can(member, perm)) return { member, denied: perm };
  }
  return { member, denied: null };
}

const needs = (perm: string) => fail(`You do not have permission for this (${perm}).`);

// ---------------------------------------------------------------------------
// Check-in (Pulse only; Unite stays read-only and is never written)
// ---------------------------------------------------------------------------

const checkinSchema = z.object({
  appointmentId: uuid,
  to: z.enum(CHECKIN_STATES).nullable(),
});

export async function setCheckin(input: z.input<typeof checkinSchema>): Promise<ActionResult> {
  const { member, denied } = await deskMember("appointments.manage");
  if (denied) return needs(denied);
  const p = checkinSchema.safeParse(input);
  if (!p.success) return fail("Invalid check-in.");
  const admin = createAdminClient(member.userId);
  const { data: a } = await admin
    .from("appointments")
    .select("id, status, source, checkin_status, location_id")
    .eq("id", p.data.appointmentId)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!a) return fail("Appointment not found.");
  if (!branchAllowed(member, a.location_id)) return fail(BRANCH_DENIED);
  if (a.status === "cancelled" || a.status === "no_show")
    return fail(`This appointment is ${a.status === "no_show" ? "marked no-show" : "cancelled"}.`);
  const from = isCheckinState(a.checkin_status) ? a.checkin_status : null;
  const patch = checkinPatch(from, p.data.to, new Date());
  if (!patch) return fail("That check-in step is not allowed.");
  const { error } = await admin
    .from("appointments")
    .update(patch)
    .eq("id", a.id)
    .eq("org_id", member.orgId);
  if (error) return fail("Could not save the check-in.");
  // A patient who walked in has plainly shown up: an awaiting Pulse booking becomes confirmed. Unite rows
  // are never touched (status is theirs).
  if (p.data.to === "arrived" && a.status === "awaiting" && a.source !== "unite") {
    await changeAppointmentStatus(admin, {
      orgId: member.orgId,
      appointmentId: a.id,
      to: "confirmed",
      actorId: member.userId,
    });
  }
  // The doctor has finished (Done or Checked out): a Pulse booking becomes completed so reports and the diary agree.
  // Unite rows keep Unite's status; an undo leaves it completed (the visit still happened).
  if (
    (p.data.to === "done" || p.data.to === "checked_out") &&
    (a.status === "awaiting" || a.status === "confirmed") &&
    a.source !== "unite"
  ) {
    await changeAppointmentStatus(admin, {
      orgId: member.orgId,
      appointmentId: a.id,
      to: "completed",
      actorId: member.userId,
    });
  }
  // Phase 19b: a patient checked out has finished the visit; a Google review request may follow (switch, consent and cap apply).
  if (p.data.to === "checked_out")
    await scheduleReviewRequestSafely(admin, { orgId: member.orgId, appointmentId: a.id });
  refresh();
  return { ok: true };
}

export async function markNoShow(appointmentId: string): Promise<ActionResult> {
  const { member, denied } = await deskMember("appointments.manage");
  if (denied) return needs(denied);
  if (!uuid.safeParse(appointmentId).success) return fail("Invalid appointment.");
  const admin = createAdminClient(member.userId);
  const { data: a } = await admin
    .from("appointments")
    .select("id, source, checkin_status, location_id")
    .eq("id", appointmentId)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!a) return fail("Appointment not found.");
  if (!branchAllowed(member, a.location_id)) return fail(BRANCH_DENIED);
  if (a.source === "unite") return fail("This booking is managed in Unite. Change it there.");
  if (a.checkin_status) return fail("This patient has already arrived.");
  const res = await changeAppointmentStatus(admin, {
    orgId: member.orgId,
    appointmentId: a.id,
    to: "no_show",
    actorId: member.userId,
  });
  if (!res.ok) return fail(res.error);
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "frontdesk.no_show",
    entity: "appointment",
    entityId: a.id,
  });
  refresh();
  return { ok: true, message: "Marked no-show." };
}

export async function cancelFromDesk(input: {
  appointmentId: string;
  notify?: boolean;
}): Promise<ActionResult<{ notified: boolean; notifyError?: string }>> {
  const { member, denied } = await deskMember("appointments.manage");
  if (denied) return needs(denied);
  if (!uuid.safeParse(input.appointmentId).success) return fail("Invalid appointment.");
  const admin = createAdminClient(member.userId);
  const { data: a } = await admin
    .from("appointments")
    .select("id, source, location_id")
    .eq("id", input.appointmentId)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!a) return fail("Appointment not found.");
  if (!branchAllowed(member, a.location_id)) return fail(BRANCH_DENIED);
  if (a.source === "unite") return fail("This booking is managed in Unite. Cancel it there.");
  const res = await changeAppointmentStatus(admin, {
    orgId: member.orgId,
    appointmentId: a.id,
    to: "cancelled",
    actorId: member.userId,
    notify: !!input.notify,
  });
  if (!res.ok) return fail(res.error);
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "frontdesk.cancelled",
    entity: "appointment",
    entityId: a.id,
  });
  refresh();
  const n = res.notification;
  return {
    ok: true,
    data: { notified: !!n?.ok, notifyError: n && !n.ok ? n.error : undefined },
    message: "Appointment cancelled.",
  };
}

// ---------------------------------------------------------------------------
// Patient card, calls and one-tap messages
// ---------------------------------------------------------------------------

export async function getPatientCard(contactId: string): Promise<ActionResult<PatientCardData>> {
  const { member, denied } = await deskMember("contacts.view", "appointments.view");
  if (denied) return needs(denied);
  if (!uuid.safeParse(contactId).success) return fail("Invalid patient.");
  const admin = createAdminClient(member.userId);
  const card = await loadPatientCard(
    admin,
    member.orgId,
    contactId,
    new Date(),
    accessFilterIds(readBranchAccess(member)),
  );
  if (!card) return fail("Patient not found.");
  await recordAccess(admin, member, { entity: "contact", entityId: contactId, action: "view" });
  return { ok: true, data: card };
}

export async function logCall(contactId: string): Promise<ActionResult<{ taskId: string }>> {
  const { member, denied } = await deskMember("tasks.manage");
  if (denied) return needs(denied);
  if (!uuid.safeParse(contactId).success) return fail("Invalid patient.");
  const admin = createAdminClient(member.userId);
  const { data: contact } = await admin
    .from("contacts")
    .select("id")
    .eq("id", contactId)
    .eq("org_id", member.orgId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!contact) return fail("Patient not found.");
  const res = await logDeskCall(admin, { orgId: member.orgId, userId: member.userId, contactId });
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "frontdesk.call_logged",
    entity: "task",
    entityId: res.id,
    diff: { reused: res.reused },
  });
  refresh();
  return {
    ok: true,
    data: { taskId: res.id },
    message: res.reused ? "Call already logged." : "Call logged as a task.",
  };
}

const messageSchema = z.object({
  contactId: uuid,
  kind: z.enum(["location", "running_late"]),
  minutes: z.number().int().min(5).max(120).optional(),
  locationId: uuid.optional(),
});

export async function sendDeskMessageAction(
  input: z.input<typeof messageSchema>,
): Promise<ActionResult<{ sentAs: string }>> {
  const { member, denied } = await deskMember("inbox.send");
  if (denied) return needs(denied);
  const p = messageSchema.safeParse(input);
  if (!p.success) return fail("Check the message details.");
  if (p.data.kind === "running_late" && !isLateChoice(p.data.minutes ?? 0))
    return fail("Choose how late: 10, 15, 20, 30, 45 or 60 minutes.");
  if (!branchAllowed(member, p.data.locationId)) return fail(BRANCH_DENIED);
  const admin = createAdminClient(member.userId);
  const res = await sendDeskMessage(admin, {
    orgId: member.orgId,
    userId: member.userId,
    contactId: p.data.contactId,
    kind: p.data.kind,
    minutes: p.data.minutes,
    locationId: p.data.locationId ?? null,
  });
  if (!res.ok) return fail(res.error);
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: p.data.kind === "location" ? "frontdesk.location_sent" : "frontdesk.running_late_sent",
    entity: "contact",
    entityId: p.data.contactId,
    diff: { sent_as: res.sentAs },
  });
  return {
    ok: true,
    data: { sentAs: res.sentAs },
    message: p.data.kind === "location" ? "Location sent." : "Delay message sent.",
  };
}

// ---------------------------------------------------------------------------
// Walk-in registration
// ---------------------------------------------------------------------------

export async function registerWalkIn(
  input: WalkInInput,
): Promise<ActionResult<{ contactId: string; created: boolean; appointmentId?: string }>> {
  const { member, denied } = await deskMember("contacts.manage");
  if (denied) return needs(denied);
  const parsed = walkInSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the form.");
  const d = parsed.data;
  if (d.add_to_today && !can(member, "appointments.manage")) return needs("appointments.manage");
  if (d.add_to_today && !branchAllowed(member, d.locationId)) return fail(BRANCH_DENIED);
  const phone = walkInPhone(d.phone);
  if (!phone)
    return fail(
      "That does not look like a mobile number. Include the country code if it is not a UAE number.",
    );

  const admin = createAdminClient(member.userId);
  const { first, last } = splitName(d.name);
  const match = await matchContact(admin, member.orgId, { phone, fullName: d.name });
  if (match.kind === "ambiguous")
    return fail(
      "More than one patient uses this number (a family?). Search for the patient on the desk, or add them as a dependant of the person who owns the number.",
    );

  let contactId: string;
  let created = false;
  const now = new Date();
  if (match.kind === "match") {
    contactId = match.id;
    // Fill in only what is blank; never overwrite what the clinic already knows.
    const { data: existing } = await admin
      .from("contacts")
      .select("language, first_name")
      .eq("id", contactId)
      .eq("org_id", member.orgId)
      .maybeSingle();
    const patch: { language?: string; first_name?: string; last_name?: string } = {};
    if (!existing?.language && storedLanguage(d.language))
      patch.language = storedLanguage(d.language)!;
    if (!existing?.first_name) Object.assign(patch, { first_name: first, last_name: last });
    if (Object.keys(patch).length)
      await admin.from("contacts").update(patch).eq("id", contactId).eq("org_id", member.orgId);
  } else {
    const { data: row, error } = await admin
      .from("contacts")
      .insert({
        org_id: member.orgId,
        first_name: first,
        last_name: last,
        phone_e164: phone,
        language: storedLanguage(d.language),
        source: "walk_in",
        promotions_opt_in: d.consent_promotions,
        created_by: member.userId,
      })
      .select("id")
      .single();
    if (error || !row) {
      console.error("[front-desk] walk-in insert failed", { code: error?.code });
      return fail("Could not register the patient.");
    }
    contactId = row.id;
    created = true;
    await addTimelineEvent(admin, {
      orgId: member.orgId,
      contactId,
      type: "contact.created",
      actorType: "user",
      actorId: member.userId,
      payload: { source: "walk_in" },
    });
    await emit(member.orgId, "contact.created", { contact_id: contactId, source: "walk_in" });
  }

  // The consent that was asked at the desk, with who recorded it and when.
  await addTimelineEvent(admin, {
    orgId: member.orgId,
    contactId,
    type: "consent.contact_recorded",
    actorType: "user",
    actorId: member.userId,
    payload: { channel: "front_desk", source: "walk_in_form", obtained_at: now.toISOString() },
  });
  if (d.consent_promotions) {
    await admin
      .from("contacts")
      .update({ promotions_opt_in: true })
      .eq("id", contactId)
      .eq("org_id", member.orgId)
      .eq("stop_marketing", false);
    await addTimelineEvent(admin, {
      orgId: member.orgId,
      contactId,
      type: "consent.marketing_recorded",
      actorType: "user",
      actorId: member.userId,
      payload: { channel: "front_desk", source: "walk_in_form", obtained_at: now.toISOString() },
    });
  }

  let appointmentId: string | undefined;
  if (d.add_to_today) {
    if (!d.locationId || !d.specialistId || !d.serviceId)
      return fail("Choose a place, a doctor and a service to put the patient on today's board.");
    const res = await createAppointment(admin, {
      orgId: member.orgId,
      actorId: member.userId,
      contactId,
      locationId: d.locationId,
      specialistId: d.specialistId,
      serviceId: d.serviceId,
      startsAt: now,
      override: true, // a walk-in is not booked into a free slot; the doctor decides
      source: "portal",
    });
    if (!res.ok) return fail(`Registered, but could not add to today's board: ${res.error}`);
    appointmentId = res.appointment.id;
    await admin
      .from("appointments")
      .update({
        is_walk_in: true,
        status: "confirmed",
        checkin_status: "arrived",
        arrived_at: now.toISOString(),
      })
      .eq("id", appointmentId)
      .eq("org_id", member.orgId);
  }

  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "frontdesk.walk_in_registered",
    entity: "contact",
    entityId: contactId,
    diff: { created, promotions: d.consent_promotions, on_board: !!appointmentId },
  });
  refresh();
  return {
    ok: true,
    data: { contactId, created, appointmentId },
    message: created ? "Patient registered." : "Existing patient found and updated.",
  };
}

// ---------------------------------------------------------------------------
// Waiting list
// ---------------------------------------------------------------------------

const waitSchema = z
  .object({
    contactId: uuid,
    specialistId: uuid.optional(),
    serviceId: uuid.optional(),
    locationId: uuid.optional(),
    notAfter: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    notes: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.specialistId || v.serviceId, {
    message: "Choose a doctor, a service, or both.",
  });

export async function addToWaitlist(
  input: z.input<typeof waitSchema>,
): Promise<ActionResult<{ id: string }>> {
  const { member, denied } = await deskMember("appointments.manage");
  if (denied) return needs(denied);
  const p = waitSchema.safeParse(input);
  if (!p.success) return fail(p.error.issues[0]?.message ?? "Check the waiting list entry.");
  if (!branchAllowed(member, p.data.locationId)) return fail(BRANCH_DENIED);
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin
    .from("waitlist_entries")
    .insert({
      org_id: member.orgId,
      contact_id: p.data.contactId,
      specialist_id: p.data.specialistId ?? null,
      service_id: p.data.serviceId ?? null,
      location_id: p.data.locationId ?? null,
      not_after: p.data.notAfter ?? null,
      notes: p.data.notes || null,
      created_by: member.userId,
    })
    .select("id")
    .single();
  if (error || !data) {
    if (error?.code === "23505")
      return fail("This patient is already waiting for that doctor and service.");
    if (error?.code === "23514")
      return fail("One of the selected values does not belong to this workspace.");
    console.error("[front-desk] waitlist insert failed", { code: error?.code });
    return fail("Could not add to the waiting list.");
  }
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "waitlist.added",
    entity: "waitlist_entry",
    entityId: data.id,
  });
  refresh();
  return { ok: true, data: { id: data.id }, message: "Added to the waiting list." };
}

export async function removeFromWaitlist(entryId: string): Promise<ActionResult> {
  const { member, denied } = await deskMember("appointments.manage");
  if (denied) return needs(denied);
  if (!uuid.safeParse(entryId).success) return fail("Invalid entry.");
  const admin = createAdminClient(member.userId);
  if (await rowOutsideBranches(admin, member, "waitlist_entries", entryId))
    return fail(BRANCH_DENIED);
  const { data, error } = await admin
    .from("waitlist_entries")
    .update({ status: "removed" })
    .eq("id", entryId)
    .eq("org_id", member.orgId)
    .eq("status", "waiting")
    .select("id")
    .maybeSingle();
  if (error || !data) return fail("That entry is not on the waiting list any more.");
  // An open offer to this person is withdrawn so a late YES cannot book them.
  await admin
    .from("slot_offers")
    .update({ status: "withdrawn", responded_at: new Date().toISOString() })
    .eq("waitlist_entry_id", entryId)
    .eq("org_id", member.orgId)
    .eq("status", "pending");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "waitlist.removed",
    entity: "waitlist_entry",
    entityId: entryId,
  });
  refresh();
  return { ok: true, message: "Removed from the waiting list." };
}

// ---------------------------------------------------------------------------
// Households
// ---------------------------------------------------------------------------

const linkSchema = z.object({
  guardianId: uuid,
  dependantId: uuid,
  relationship: z.enum(["child", "parent", "spouse", "other"]).default("child"),
  remindersToGuardian: z.boolean().default(true),
});

function householdError(code: string | undefined, message: string | undefined): string {
  if (code === "23505") return "That person already has a guardian.";
  if (code === "23514" && /already a (dependant|guardian)/.test(message ?? ""))
    return "A household is one level deep: a guardian cannot be someone else's dependant.";
  if (code === "23514") return "Choose two different patients from this workspace.";
  return "Could not save the household link.";
}

export async function linkDependant(input: z.input<typeof linkSchema>): Promise<ActionResult> {
  const { member, denied } = await deskMember("contacts.manage");
  if (denied) return needs(denied);
  const p = linkSchema.safeParse(input);
  if (!p.success) return fail("Choose the guardian and the dependant.");
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin
    .from("household_links")
    .insert({
      org_id: member.orgId,
      guardian_contact_id: p.data.guardianId,
      dependant_contact_id: p.data.dependantId,
      relationship: p.data.relationship,
      reminders_to_guardian: p.data.remindersToGuardian,
      created_by: member.userId,
    })
    .select("id")
    .single();
  if (error || !data) return fail(householdError(error?.code, error?.message));
  await addTimelineEvent(admin, {
    orgId: member.orgId,
    contactId: p.data.dependantId,
    type: "household.linked",
    actorType: "user",
    actorId: member.userId,
    payload: { guardian_id: p.data.guardianId },
  });
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "household.linked",
    entity: "household_link",
    entityId: data.id,
  });
  refresh();
  return { ok: true, message: "Household link saved." };
}

export async function unlinkDependant(linkId: string): Promise<ActionResult> {
  const { member, denied } = await deskMember("contacts.manage");
  if (denied) return needs(denied);
  if (!uuid.safeParse(linkId).success) return fail("Invalid link.");
  const admin = createAdminClient(member.userId);
  const { data } = await admin
    .from("household_links")
    .delete()
    .eq("id", linkId)
    .eq("org_id", member.orgId)
    .select("id, dependant_contact_id")
    .maybeSingle();
  if (!data) return fail("That link no longer exists.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "household.unlinked",
    entity: "household_link",
    entityId: linkId,
  });
  refresh();
  return { ok: true, message: "Household link removed." };
}

const dependantSchema = z.object({
  guardianId: uuid,
  name: z.string().trim().min(2).max(120),
  dob: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  relationship: z.enum(["child", "parent", "spouse", "other"]).default("child"),
});

/** A dependant with no number of their own: created under the guardian in one step. */
export async function createDependant(
  input: z.input<typeof dependantSchema>,
): Promise<ActionResult<{ id: string }>> {
  const { member, denied } = await deskMember("contacts.manage");
  if (denied) return needs(denied);
  const p = dependantSchema.safeParse(input);
  if (!p.success) return fail("Enter the dependant's name.");
  const admin = createAdminClient(member.userId);
  const { data: guardian } = await admin
    .from("contacts")
    .select("id, language")
    .eq("id", p.data.guardianId)
    .eq("org_id", member.orgId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!guardian) return fail("Guardian not found.");
  const { first, last } = splitName(p.data.name);
  const { data: kid, error } = await admin
    .from("contacts")
    .insert({
      org_id: member.orgId,
      first_name: first,
      last_name: last,
      dob: p.data.dob ?? null,
      language: guardian.language,
      source: "walk_in",
      created_by: member.userId,
    })
    .select("id")
    .single();
  if (error || !kid) return fail("Could not create the dependant.");
  const { error: linkError } = await admin.from("household_links").insert({
    org_id: member.orgId,
    guardian_contact_id: guardian.id,
    dependant_contact_id: kid.id,
    relationship: p.data.relationship,
    created_by: member.userId,
  });
  if (linkError) {
    await admin.from("contacts").delete().eq("id", kid.id).eq("org_id", member.orgId);
    return fail(householdError(linkError.code, linkError.message));
  }
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "household.dependant_created",
    entity: "contact",
    entityId: kid.id,
  });
  refresh();
  return { ok: true, data: { id: kid.id }, message: "Dependant added." };
}

// ---------------------------------------------------------------------------
// Shift handover notes
// ---------------------------------------------------------------------------

const noteSchema = z.object({
  body: z.string().trim().min(1, "Write the note first.").max(2000),
  pinned: z.boolean().default(false),
  locationId: uuid.optional(),
});

export async function addHandoverNote(input: z.input<typeof noteSchema>): Promise<ActionResult> {
  const { member, denied } = await deskMember();
  if (denied) return needs(denied);
  const p = noteSchema.safeParse(input);
  if (!p.success) return fail(p.error.issues[0]?.message ?? "Check the note.");
  if (!branchAllowed(member, p.data.locationId)) return fail(BRANCH_DENIED);
  const admin = createAdminClient(member.userId);
  // Phase B: a note belongs to the branch the desk is showing (none when it shows every branch).
  const locationId = p.data.locationId ?? (await memberBranchView(admin, member)).current;
  const { error } = await admin.from("handover_notes").insert({
    org_id: member.orgId,
    body: p.data.body,
    pinned: p.data.pinned,
    location_id: locationId ?? null,
    created_by: member.userId,
  });
  if (error) {
    console.error("[front-desk] handover note failed", { code: error.code });
    return fail("Could not save the note.");
  }
  refresh();
  return { ok: true, message: "Note added for the next shift." };
}

export async function resolveHandoverNote(
  noteId: string,
  resolved: boolean,
): Promise<ActionResult> {
  const { member, denied } = await deskMember();
  if (denied) return needs(denied);
  if (!uuid.safeParse(noteId).success) return fail("Invalid note.");
  const admin = createAdminClient(member.userId);
  if (await rowOutsideBranches(admin, member, "handover_notes", noteId)) return fail(BRANCH_DENIED);
  const { error } = await admin
    .from("handover_notes")
    .update(
      resolved
        ? { resolved_at: new Date().toISOString(), resolved_by: member.userId }
        : { resolved_at: null, resolved_by: null },
    )
    .eq("id", noteId)
    .eq("org_id", member.orgId);
  if (error) return fail(redactText(error.message));
  refresh();
  return { ok: true };
}
