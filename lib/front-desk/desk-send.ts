import "server-only";

import { buildAppointmentTemplateValues } from "@/lib/appointments/reminders";
import { readAppointmentSettings } from "@/lib/appointments/settings";
import { addTimelineEvent } from "@/lib/contacts/timeline";
import { locationMessage, runningLateText } from "@/lib/front-desk/messages";
import { readFrontDeskSettings } from "@/lib/front-desk/settings";
import { chooseOfferChannel } from "@/lib/front-desk/waitlist";
import { resolveRecipient, type HouseholdContact } from "@/lib/household/addressing";
import { loadHouseholdLink } from "@/lib/household/server";
import { ensureConversation } from "@/lib/inbox/conversations";
import { queueOutbound, type SendSpec } from "@/lib/inbox/send";
import type { AdminClient } from "@/lib/supabase/admin";
import { renderTemplatePreview } from "@/lib/whatsapp/templates";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

export type DeskMessageKind = "location" | "running_late";

export type DeskSendResult =
  | { ok: true; sentAs: "text" | "location" | "template"; messageId: string }
  | { ok: false; error: string };

/**
 * The one-tap "send location" and "running late" messages. Both go through the outbound queue (per-number rate
 * limit and the 24-hour guard apply there too); this function additionally picks the right shape up front so
 * the desk gets a clear answer instead of a failed message: free text inside the window, the mapped template
 * outside it, and a refusal when no template is mapped.
 */
export async function sendDeskMessage(
  admin: AdminClient,
  input: {
    orgId: string;
    userId: string;
    contactId: string;
    kind: DeskMessageKind;
    minutes?: number;
    locationId?: string | null;
    now?: Date;
  },
): Promise<DeskSendResult> {
  const now = input.now ?? new Date();
  const { data: patient } = await admin
    .from("contacts")
    .select("id, first_name, last_name, phone_e164, wa_bsuid, stop_marketing, language")
    .eq("id", input.contactId)
    .eq("org_id", input.orgId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!patient) return { ok: false, error: "Patient not found." };
  const target = resolveRecipient(
    patient as HouseholdContact,
    await loadHouseholdLink(admin, input.orgId, patient.id),
  );
  if (!target) return { ok: false, error: "This patient has no WhatsApp number or user id." };

  const { data: org } = await admin
    .from("orgs")
    .select("settings, timezone")
    .eq("id", input.orgId)
    .single();
  const desk = readFrontDeskSettings(org?.settings);
  const apptSettings = readAppointmentSettings(org?.settings);
  const timezone = org?.timezone ?? "Asia/Dubai";

  // The patient's next live appointment supplies the doctor, place and time for wording and templates.
  const { data: next } = await admin
    .from("appointments")
    .select(
      "id, number, starts_at, location_id, specialists(name), services(name), locations(name, timezone)",
    )
    .eq("org_id", input.orgId)
    .eq("contact_id", patient.id)
    .in("status", ["awaiting", "confirmed"])
    .gte("starts_at", new Date(now.getTime() - 3 * 3600_000).toISOString())
    .order("starts_at")
    .limit(1)
    .maybeSingle();
  const nextRow = next as unknown as {
    id: string;
    number: number;
    starts_at: string;
    location_id: string | null;
    specialists: { name: string } | null;
    services: { name: string } | null;
    locations: { name: string; timezone: string } | null;
  } | null;

  // Which conversation: the recipient's most recent open one, else a new one on the first usable number.
  const { data: existing } = await admin
    .from("conversations")
    .select("id, channel_id, last_inbound_at")
    .eq("org_id", input.orgId)
    .eq("contact_id", target.recipient.id)
    .neq("status", "closed")
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  let conversation = existing;
  if (!conversation) {
    const { data: channels } = await admin
      .from("channels")
      .select("id")
      .eq("org_id", input.orgId)
      .eq("type", "whatsapp")
      .eq("status", "active");
    const ids = (channels ?? []).map((c) => c.id);
    const channelId =
      [apptSettings.channel_id, desk.desk_channel_id].find(
        (c): c is string => !!c && ids.includes(c),
      ) ?? ids[0];
    if (!channelId) return { ok: false, error: "No active WhatsApp number is connected." };
    const created = await ensureConversation(admin, input.orgId, target.recipient.id, channelId);
    conversation = {
      id: created.id,
      channel_id: created.channel_id,
      last_inbound_at: created.last_inbound_at,
    };
  }

  const templateId =
    input.kind === "location" ? desk.location_template_id : desk.running_late_template_id;
  const { data: tpl } = templateId
    ? await admin
        .from("wa_templates")
        .select("id, name, status, category, components, variable_map")
        .eq("id", templateId)
        .eq("org_id", input.orgId)
        .maybeSingle()
    : { data: null };
  const usable = tpl && tpl.status === "APPROVED" ? tpl : null;
  const how = chooseOfferChannel(conversation.last_inbound_at, !!usable, now);

  const language = target.recipient.id === patient.id ? patient.language : null;
  let locationId = input.locationId ?? nextRow?.location_id ?? null;
  let loc: {
    name: string;
    address: string | null;
    latitude: number | null;
    longitude: number | null;
    maps_url: string | null;
    timezone: string;
  } | null = null;
  if (input.kind === "location") {
    if (!locationId) {
      const { data: first } = await admin
        .from("locations")
        .select("id")
        .eq("org_id", input.orgId)
        .eq("active", true)
        .order("name")
        .limit(1)
        .maybeSingle();
      locationId = first?.id ?? null;
    }
    if (!locationId) return { ok: false, error: "No clinic location is set up." };
    const { data } = await admin
      .from("locations")
      .select("name, address, latitude, longitude, maps_url, timezone")
      .eq("id", locationId)
      .eq("org_id", input.orgId)
      .maybeSingle();
    if (!data) return { ok: false, error: "Location not found." };
    loc = {
      name: data.name,
      address: data.address,
      latitude: data.latitude === null ? null : Number(data.latitude),
      longitude: data.longitude === null ? null : Number(data.longitude),
      maps_url: data.maps_url,
      timezone: data.timezone,
    };
  }

  if (how.kind === "blocked") {
    return {
      ok: false,
      error:
        "The 24-hour WhatsApp window is closed and no template is set for this message. Ask an administrator to choose one in Settings → Front desk, or ring the patient.",
    };
  }

  let spec: SendSpec;
  let body: string;
  let sentAs: "text" | "location" | "template";
  if (how.kind === "text") {
    if (input.kind === "running_late") {
      body = runningLateText({
        minutes: input.minutes ?? 15,
        specialist: nextRow?.specialists?.name ?? null,
        language,
      });
      spec = { type: "text", body };
      sentAs = "text";
    } else {
      const m = loc ? locationMessage(loc, language) : null;
      if (!m)
        return {
          ok: false,
          error:
            "This location has no address, coordinates or map link yet. Add one in Settings → Appointments.",
        };
      if (m.kind === "pin") {
        spec = {
          type: "location",
          latitude: m.latitude,
          longitude: m.longitude,
          name: m.name,
          address: m.address,
        };
        body = `Location: ${m.name}`;
        sentAs = "location";
      } else {
        spec = { type: "text", body: m.body };
        body = m.body;
        sentAs = "text";
      }
    }
  } else {
    const components = usable!.components as unknown as MetaTemplateComponent[];
    const values = buildAppointmentTemplateValues(
      components,
      usable!.variable_map as Record<string, string>,
      {
        contact: patient,
        guardian: target.viaGuardian ? target.recipient : null,
        startsAt: nextRow ? new Date(nextRow.starts_at) : now,
        timezone: nextRow?.locations?.timezone ?? loc?.timezone ?? timezone,
        specialist: nextRow?.specialists?.name,
        location: loc?.name ?? nextRow?.locations?.name,
        service: nextRow?.services?.name,
        number: nextRow?.number,
        delayMinutes: input.minutes ?? null,
      },
    );
    const preview = renderTemplatePreview(components, values);
    if (preview.missing.length)
      return {
        ok: false,
        error: `Template variables are not mapped: ${preview.missing.join(", ")}`,
      };
    spec = { type: "template", template_id: usable!.id, values };
    body = [preview.headerText, preview.body].filter(Boolean).join("\n");
    sentAs = "template";
  }

  const message = await queueOutbound(admin, {
    orgId: input.orgId,
    conversationId: conversation.id,
    spec,
    body,
    sentByUserId: input.userId,
    priority: true,
  });
  await addTimelineEvent(admin, {
    orgId: input.orgId,
    contactId: patient.id,
    type: input.kind === "location" ? "desk.location_sent" : "desk.running_late_sent",
    actorType: "user",
    actorId: input.userId,
    payload: { sent_as: sentAs, ...(input.minutes ? { minutes: input.minutes } : {}) },
  });
  return { ok: true, sentAs, messageId: message.id };
}

/** How long a logged call task stays open before it counts as overdue. */
const CALL_TASK_DUE_MS = 30 * 60_000;
/** Tapping Call twice within this window reuses the first task. */
const CALL_DEDUPE_MS = 10 * 60_000;

/**
 * "Call" on the patient card: the tel: link opens the phone, this records the call as an open call task for the
 * caller (so it appears in the end-of-day sheet if it was never closed). Idempotent for a few minutes.
 */
export async function logDeskCall(
  admin: AdminClient,
  input: { orgId: string; userId: string; contactId: string; now?: Date },
): Promise<{ id: string; reused: boolean }> {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - CALL_DEDUPE_MS).toISOString();
  const { data: recent } = await admin
    .from("tasks")
    .select("id")
    .eq("org_id", input.orgId)
    .eq("contact_id", input.contactId)
    .eq("type", "call")
    .eq("done", false)
    .is("deleted_at", null)
    .eq("created_by", input.userId)
    .gte("created_at", since)
    .limit(1)
    .maybeSingle();
  if (recent) return { id: recent.id, reused: true };
  const { createTask } = await import("@/lib/tasks/service");
  const created = await createTask(
    { admin, orgId: input.orgId, userId: input.userId },
    {
      type: "call",
      subject: "Call patient (front desk)",
      notes: "Logged from the Call button on the front desk. Close it with the outcome.",
      dueAt: new Date(now.getTime() + CALL_TASK_DUE_MS).toISOString(),
      assigneeId: input.userId,
      contactId: input.contactId,
    },
  );
  return { id: created.id, reused: false };
}
