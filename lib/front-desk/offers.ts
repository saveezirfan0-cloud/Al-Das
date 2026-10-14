import "server-only";

import { intervalHasPlace } from "@/lib/appointments/availability";
import { buildAppointmentTemplateValues } from "@/lib/appointments/reminders";
import { syncAppointmentReminders } from "@/lib/appointments/service";
import { addTimelineEvent } from "@/lib/contacts/timeline";
import { emit } from "@/lib/events/emit";
import {
  chooseOfferChannel,
  offerExpiry,
  rankEntries,
  renderOfferOutcomeText,
  renderOfferText,
  serviceForEntry,
  slotOfferable,
  type FreedSlot,
  type ReplyIntent,
  type ServiceFit,
  type WaitlistEntry,
} from "@/lib/front-desk/waitlist";
import { readFrontDeskSettings } from "@/lib/front-desk/settings";
import { WHATSAPP_DECLINED_REASON } from "@/lib/front-desk/whatsapp-consent";
import { recipientDeclinedWhatsApp } from "@/lib/front-desk/whatsapp-consent-server";
import { resolveRecipient, type HouseholdContact } from "@/lib/household/addressing";
import { loadHouseholdLink } from "@/lib/household/server";
import { readAppointmentSettings } from "@/lib/appointments/settings";
import { ensureConversation } from "@/lib/inbox/conversations";
import { queueOutbound } from "@/lib/inbox/send";
import { scheduleJob } from "@/lib/jobs/enqueue";
import type { FreedSlotPayload } from "@/lib/front-desk/freed";
import { memberIdsWithPermission, notify } from "@/lib/notify/dispatch-db";
import { redactText } from "@/lib/redact";
import type { AdminClient } from "@/lib/supabase/admin";
import { renderTemplatePreview } from "@/lib/whatsapp/templates";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

export type SlotOfferSkip =
  "disabled" | "too_soon" | "slot_busy" | "no_candidates" | "capacity_full" | "no_location";

export type FreedSlotResult =
  | { offered: number; failed: number; skipped?: undefined }
  | { offered: 0; failed: 0; skipped: SlotOfferSkip };

/**
 * Is the freed slot already gone (rebooked, blocked, or no place left)? The same rule as the slot list and
 * the SQL re-check (lib/appointments/slots.ts slotFits); accept_slot_offer checks again under the lock.
 */
async function slotIsBusy(admin: AdminClient, orgId: string, slot: FreedSlot): Promise<boolean> {
  return !(await intervalHasPlace(admin, {
    orgId,
    specialistId: slot.specialist_id,
    locationId: slot.location_id,
    serviceId: slot.service_id,
    start: new Date(slot.starts_at),
    end: new Date(slot.ends_at),
  }));
}

async function loadFits(
  admin: AdminClient,
  orgId: string,
  specialistId: string,
  serviceIds: string[],
): Promise<ServiceFit[]> {
  if (serviceIds.length === 0) return [];
  const [{ data: services }, { data: offered }] = await Promise.all([
    admin.from("services").select("id, duration_min").eq("org_id", orgId).in("id", serviceIds),
    admin
      .from("specialist_services")
      .select("service_id")
      .eq("org_id", orgId)
      .eq("specialist_id", specialistId),
  ]);
  const offeredIds = new Set((offered ?? []).map((o) => o.service_id));
  return (services ?? []).map((s) => ({
    service_id: s.id,
    duration_min: s.duration_min,
    offered_by_specialist: offeredIds.has(s.id),
  }));
}

/**
 * Offers a freed slot to the waitlist, in order. Idempotent: the (entry, specialist, start) unique key means a
 * replayed job asks nobody twice, and it only tops the number of open offers up to the batch size.
 */
export async function offerFreedSlot(
  admin: AdminClient,
  input: { orgId: string; slot: FreedSlotPayload; now?: Date },
): Promise<FreedSlotResult> {
  const now = input.now ?? new Date();
  const { data: org } = await admin
    .from("orgs")
    .select("settings, timezone")
    .eq("id", input.orgId)
    .single();
  const settings = readFrontDeskSettings(org?.settings);
  const timezone = org?.timezone ?? "Asia/Dubai";
  if (!settings.offers_enabled) return { offered: 0, failed: 0, skipped: "disabled" };
  const slot = input.slot;
  if (!slotOfferable(slot, now, settings.offer_min_lead_minutes))
    return { offered: 0, failed: 0, skipped: "too_soon" };
  if (await slotIsBusy(admin, input.orgId, slot))
    return { offered: 0, failed: 0, skipped: "slot_busy" };

  const [{ data: entries }, { data: priorOffers }] = await Promise.all([
    admin
      .from("waitlist_entries")
      .select(
        "id, contact_id, specialist_id, service_id, location_id, not_after, created_at, status",
      )
      .eq("org_id", input.orgId)
      .eq("status", "waiting")
      .or(`specialist_id.eq.${slot.specialist_id},specialist_id.is.null`)
      .order("created_at")
      .limit(200),
    admin
      .from("slot_offers")
      .select("waitlist_entry_id, status")
      .eq("org_id", input.orgId)
      .eq("specialist_id", slot.specialist_id)
      .eq("starts_at", slot.starts_at),
  ]);
  const entryList = (entries ?? []) as WaitlistEntry[];
  const pendingNow = (priorOffers ?? []).filter((o) => o.status === "pending").length;
  const capacity = settings.offer_batch_size - pendingNow;
  if (capacity <= 0) return { offered: 0, failed: 0, skipped: "capacity_full" };

  const fits = await loadFits(admin, input.orgId, slot.specialist_id, [
    ...new Set(entryList.map((e) => e.service_id).filter((s): s is string => !!s)),
  ]);
  const ranked = rankEntries(
    entryList,
    slot,
    fits,
    timezone,
    new Set((priorOffers ?? []).map((o) => o.waitlist_entry_id)),
  );
  if (ranked.length === 0) return { offered: 0, failed: 0, skipped: "no_candidates" };

  let offered = 0;
  let failed = 0;
  for (const entry of ranked) {
    if (offered >= capacity) break;
    const res = await createAndSendOffer(admin, {
      orgId: input.orgId,
      entry,
      slot,
      fits,
      timezone,
      now,
    });
    if (res === "sent") offered++;
    else if (res === "failed") failed++;
  }
  return { offered, failed };
}

type OfferOutcome = "sent" | "failed" | "duplicate";

async function createAndSendOffer(
  admin: AdminClient,
  o: {
    orgId: string;
    entry: WaitlistEntry;
    slot: FreedSlotPayload;
    fits: readonly ServiceFit[];
    timezone: string;
    now: Date;
  },
): Promise<OfferOutcome> {
  const { entry, slot } = o;
  const { data: org } = await admin.from("orgs").select("settings").eq("id", o.orgId).single();
  const settings = readFrontDeskSettings(org?.settings);
  const apptSettings = readAppointmentSettings(org?.settings);

  const serviceId = serviceForEntry(entry, slot, o.fits);
  if (!serviceId) return "failed";

  const expires = offerExpiry(o.now, settings.offer_ttl_minutes, new Date(slot.starts_at));
  const { data: offer, error } = await admin
    .from("slot_offers")
    .insert({
      org_id: o.orgId,
      waitlist_entry_id: entry.id,
      source_appointment_id: slot.source_appointment_id,
      specialist_id: slot.specialist_id,
      location_id: slot.location_id,
      service_id: serviceId,
      starts_at: slot.starts_at,
      ends_at: slot.ends_at,
      expires_at: expires.toISOString(),
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") return "duplicate"; // a replayed job: this person was already asked
    console.error("[waitlist] offer insert failed", { code: error.code });
    return "failed";
  }

  const fail = async (reason: string): Promise<OfferOutcome> => {
    await admin
      .from("slot_offers")
      .update({
        status: "failed",
        failure_reason: reason.slice(0, 200),
        responded_at: o.now.toISOString(),
      })
      .eq("id", offer.id);
    return "failed";
  };

  // Who gets the message: the patient, or their guardian when they are a dependant.
  const { data: contact } = await admin
    .from("contacts")
    .select("id, first_name, last_name, phone_e164, wa_bsuid, stop_marketing, language")
    .eq("id", entry.contact_id)
    .eq("org_id", o.orgId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!contact) return fail("patient_missing");
  const target = resolveRecipient(
    contact as HouseholdContact,
    await loadHouseholdLink(admin, o.orgId, contact.id),
  );
  if (!target) return fail("no_whatsapp");
  // Phase E: registered at the desk without the WhatsApp agreement: never offered on WhatsApp.
  if (await recipientDeclinedWhatsApp(admin, o.orgId, target.recipient.id))
    return fail(WHATSAPP_DECLINED_REASON);

  const [{ data: specialist }, { data: location }, { data: service }, { data: channels }] =
    await Promise.all([
      admin.from("specialists").select("name").eq("id", slot.specialist_id).maybeSingle(),
      admin.from("locations").select("name, timezone").eq("id", slot.location_id).maybeSingle(),
      admin.from("services").select("name").eq("id", serviceId).maybeSingle(),
      admin
        .from("channels")
        .select("id, waba_id")
        .eq("org_id", o.orgId)
        .eq("type", "whatsapp")
        .eq("status", "active"),
    ]);

  const templateId = settings.offer_template_id;
  const { data: tpl } = templateId
    ? await admin
        .from("wa_templates")
        .select("id, name, status, category, components, variable_map, channel_id, waba_id")
        .eq("id", templateId)
        .eq("org_id", o.orgId)
        .maybeSingle()
    : { data: null };
  const usableTemplate = tpl && tpl.status === "APPROVED" ? tpl : null;

  const channelIds = (channels ?? [])
    .filter((c) => !usableTemplate || c.waba_id === usableTemplate.waba_id)
    .map((c) => c.id);
  const channelId =
    [apptSettings.channel_id, usableTemplate?.channel_id].find(
      (c): c is string => !!c && channelIds.includes(c),
    ) ?? channelIds[0];
  if (!channelId) return fail("no_channel");

  const conversation = await ensureConversation(admin, o.orgId, target.recipient.id, channelId);
  const how = chooseOfferChannel(conversation.last_inbound_at, !!usableTemplate, o.now);
  if (how.kind === "blocked") return fail("window_closed_no_template");

  const tz = location?.timezone ?? o.timezone;
  const startsAt = new Date(slot.starts_at);
  let message;
  try {
    if (how.kind === "text") {
      message = await queueOutbound(admin, {
        orgId: o.orgId,
        conversationId: conversation.id,
        spec: {
          type: "text",
          body: renderOfferText({
            startsAt,
            timezone: tz,
            specialist: specialist?.name ?? null,
            location: location?.name ?? null,
            expiresInMin: Math.max(1, Math.round((expires.getTime() - o.now.getTime()) / 60_000)),
            language: target.recipient.id === contact.id ? contact.language : null,
          }),
        },
        body: "Waiting list offer",
        sentByUserId: null,
        priority: false,
      });
    } else {
      const components = usableTemplate!.components as unknown as MetaTemplateComponent[];
      const values = buildAppointmentTemplateValues(
        components,
        usableTemplate!.variable_map as Record<string, string>,
        {
          contact,
          guardian: target.viaGuardian ? target.recipient : null,
          startsAt,
          timezone: tz,
          specialist: specialist?.name,
          location: location?.name,
          service: service?.name,
        },
      );
      const preview = renderTemplatePreview(components, values);
      if (preview.missing.length) return fail("template_variables_unmapped");
      message = await queueOutbound(admin, {
        orgId: o.orgId,
        conversationId: conversation.id,
        spec: { type: "template", template_id: usableTemplate!.id, values },
        body: [preview.headerText, preview.body].filter(Boolean).join("\n"),
        sentByUserId: null,
        priority: false,
      });
    }
  } catch (e) {
    console.error("[waitlist] could not queue the offer", redactText(e));
    return fail("queue_failed");
  }

  await admin
    .from("slot_offers")
    .update({ sent_as: how.kind, message_id: message.id })
    .eq("id", offer.id);
  // The expiry rides scheduled_jobs, never an in-memory timer.
  await scheduleJob({
    kind: "waitlist.expire",
    orgId: o.orgId,
    runAt: expires,
    payload: { offer_id: offer.id },
    dedupeKey: `waitlist-expire:${offer.id}`,
  }).catch((e) => console.error("[waitlist] could not schedule the expiry", redactText(e)));
  return "sent";
}

// ---------------------------------------------------------------------------
// Answers and expiry
// ---------------------------------------------------------------------------

export type AcceptResult =
  | { result: "booked"; appointment_id: string; contact_id: string; entry_id: string }
  | { result: "taken" | "expired" | "not_pending" | "not_found" };

/** First YES wins: the database function takes the per-specialist lock and books or refuses atomically. */
export async function acceptOffer(
  admin: AdminClient,
  orgId: string,
  offerId: string,
  now: Date = new Date(),
): Promise<AcceptResult> {
  const { data, error } = await admin.rpc("accept_slot_offer", {
    p_org_id: orgId,
    p_offer_id: offerId,
    p_now: now.toISOString(),
  });
  if (error) throw new Error(`accept_slot_offer: ${error.message}`);
  const res = data as unknown as {
    result: string;
    appointment_id?: string;
    contact_id?: string;
    entry_id?: string;
  };
  if (res.result === "booked" && res.appointment_id && res.contact_id && res.entry_id) {
    const { data: appt } = await admin
      .from("appointments")
      .select("id, org_id, contact_id, starts_at, status, number")
      .eq("id", res.appointment_id)
      .single();
    if (appt) {
      await syncAppointmentReminders(admin, appt);
      await addTimelineEvent(admin, {
        orgId,
        contactId: res.contact_id,
        type: "appointment.created",
        actorType: "contact",
        payload: { appointment_id: appt.id, number: appt.number, via: "waitlist_offer" },
      });
      await emit(orgId, "appointment.created", {
        appointment_id: appt.id,
        contact_id: res.contact_id,
        source: "bot",
      });
    }
    return {
      result: "booked",
      appointment_id: res.appointment_id,
      contact_id: res.contact_id,
      entry_id: res.entry_id,
    };
  }
  const known = ["taken", "expired", "not_pending", "not_found"] as const;
  return {
    result: (known as readonly string[]).includes(res.result)
      ? (res.result as (typeof known)[number])
      : "not_found",
  };
}

/** Moves on to the next person after an offer ends without a booking. */
async function continueSlot(admin: AdminClient, orgId: string, offerId: string, now: Date) {
  const { data: o } = await admin
    .from("slot_offers")
    .select("specialist_id, location_id, service_id, starts_at, ends_at, source_appointment_id")
    .eq("id", offerId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!o) return;
  let serviceId: string | null = o.service_id;
  if (o.source_appointment_id) {
    const { data: src } = await admin
      .from("appointments")
      .select("service_id")
      .eq("id", o.source_appointment_id)
      .maybeSingle();
    serviceId = src?.service_id ?? serviceId;
  }
  await offerFreedSlot(admin, {
    orgId,
    slot: {
      specialist_id: o.specialist_id,
      location_id: o.location_id,
      service_id: serviceId,
      starts_at: o.starts_at,
      ends_at: o.ends_at,
      source_appointment_id: o.source_appointment_id,
    },
    now,
  });
}

/** The offer ran out of time. Atomic: only a still-pending, overdue offer changes. */
export async function expireOffer(
  admin: AdminClient,
  orgId: string,
  offerId: string,
  now: Date = new Date(),
): Promise<"expired" | "not_due" | "gone"> {
  const { data: expired } = await admin
    .from("slot_offers")
    .update({ status: "expired", responded_at: now.toISOString() })
    .eq("id", offerId)
    .eq("org_id", orgId)
    .eq("status", "pending")
    .lte("expires_at", now.toISOString())
    .select("id")
    .maybeSingle();
  if (expired) {
    await continueSlot(admin, orgId, offerId, now);
    return "expired";
  }
  const { data: still } = await admin
    .from("slot_offers")
    .select("status")
    .eq("id", offerId)
    .eq("org_id", orgId)
    .maybeSingle();
  return still?.status === "pending" ? "not_due" : "gone";
}

export async function declineOffer(
  admin: AdminClient,
  orgId: string,
  offerId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const { data } = await admin
    .from("slot_offers")
    .update({ status: "declined", responded_at: now.toISOString() })
    .eq("id", offerId)
    .eq("org_id", orgId)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  if (!data) return false;
  await continueSlot(admin, orgId, offerId, now);
  return true;
}

export type OfferReply = {
  orgId: string;
  /** The contact who wrote back: the patient, or their guardian. */
  contactId: string;
  conversationId: string;
  /** Read lazily, after we know there is an offer to answer (reading a message body is not free). */
  intent: ReplyIntent | (() => Promise<ReplyIntent>);
  /** The reply is a template button tap: it counts only when it quotes the offer message itself. */
  viaButton?: boolean;
  /** The wa_message_id the reply quotes (a template button reply), when known. */
  replyToWaMessageId?: string | null;
  now?: Date;
};

export type ReplyHandled = "no_offer" | "booked" | "taken" | "expired" | "declined" | "ignored";

/** Applies a patient's YES / NO to the offer they were sent. Returns what happened (for tests and logs). */
export async function handleOfferReply(admin: AdminClient, r: OfferReply): Promise<ReplyHandled> {
  const now = r.now ?? new Date();

  // Offers addressed to this person: their own entries and, for a guardian, their dependants'.
  const { data: links } = await admin
    .from("household_links")
    .select("dependant_contact_id")
    .eq("org_id", r.orgId)
    .eq("guardian_contact_id", r.contactId);
  const contactIds = [r.contactId, ...(links ?? []).map((l) => l.dependant_contact_id)];

  const { data: offers } = await admin
    .from("slot_offers")
    .select(
      "id, message_id, created_at, expires_at, waitlist_entries!inner(contact_id), messages:messages!slot_offers_message_id_fkey(wa_message_id)",
    )
    .eq("org_id", r.orgId)
    .eq("status", "pending")
    .in("waitlist_entries.contact_id", contactIds)
    .order("created_at", { ascending: false })
    .limit(10);
  const list = (offers ?? []) as unknown as Array<{
    id: string;
    messages: { wa_message_id: string | null } | null;
  }>;
  if (list.length === 0) return "no_offer";
  const quoted = r.replyToWaMessageId
    ? list.find((o) => o.messages?.wa_message_id === r.replyToWaMessageId)
    : undefined;
  // A button tap names its offer (a "Confirm" tap on an appointment reminder must never accept one). A typed
  // answer applies to the most recent offer.
  if (r.viaButton && !quoted) return "ignored";
  const offer = quoted ?? list[0];
  const intent = typeof r.intent === "function" ? await r.intent() : r.intent;
  if (intent === "unknown") return "ignored";

  const { data: contact } = await admin
    .from("contacts")
    .select("language")
    .eq("id", r.contactId)
    .maybeSingle();
  const say = async (outcome: "booked" | "taken" | "expired") => {
    // The patient has just written, so the 24-hour window is open and plain text is allowed.
    await queueOutbound(admin, {
      orgId: r.orgId,
      conversationId: r.conversationId,
      spec: { type: "text", body: renderOfferOutcomeText(outcome, contact?.language) },
      body: "Waiting list answer",
      sentByUserId: null,
      priority: true,
    }).catch((e) => console.error("[waitlist] could not send the answer", redactText(e)));
  };

  if (intent === "no") {
    const done = await declineOffer(admin, r.orgId, offer.id, now);
    return done ? "declined" : "ignored";
  }
  const res = await acceptOffer(admin, r.orgId, offer.id, now);
  switch (res.result) {
    case "booked":
      await say("booked");
      // Tell the desk (ids and a fixed sentence only; the title never names the patient).
      await notify(admin, {
        orgId: r.orgId,
        userIds: await memberIdsWithPermission(admin, r.orgId, "frontdesk.use"),
        event: "waitlist.booked",
        type: "appointment.waitlist_booked",
        title: "Waiting-list slot booked",
        body: "A patient on the waiting list took an offered slot.",
        payload: { appointment_id: res.appointment_id },
        ids: { appointment_id: res.appointment_id },
      });
      return "booked";
    case "taken":
      await say("taken");
      return "taken";
    case "expired":
      await say("expired");
      await continueSlot(admin, r.orgId, offer.id, now);
      return "expired";
    default:
      return "ignored";
  }
}
