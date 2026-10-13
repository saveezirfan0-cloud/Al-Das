import { createHash } from "node:crypto";

import { hashEmail, hashPhone } from "@/lib/integrations/capi/hash";

/**
 * The server-side event Pulse sends to Meta's Conversions API for business messaging (pure).
 *
 * Only three event names exist, and none carries any health information:
 *   Contact   the patient reached the clinic through an ad (first message with a click id)
 *   Lead      an enquiry was opened for that patient
 *   Schedule  an appointment was booked for that patient
 * No custom_data at all: no service, doctor, department, diagnosis, price or value. The builder has no input for them, and a test
 * lists the exact keys it can produce.
 *
 * Shape (from Meta's documentation for business messaging; NOT verified against a live dataset, see docs/19_PHASE_19B_NOTES.md):
 *   { data: [{ event_name, event_time (seconds), event_id, action_source: "business_messaging", messaging_channel: "whatsapp",
 *              user_data: { whatsapp_business_account_id, ctwa_clid, ph?, em? } }], test_event_code? }
 */
export const CAPI_EVENT_NAMES = ["Contact", "Lead", "Schedule"] as const;
export type CapiEventName = (typeof CAPI_EVENT_NAMES)[number];

export function isCapiEventName(v: unknown): v is CapiEventName {
  return typeof v === "string" && (CAPI_EVENT_NAMES as readonly string[]).includes(v);
}

export type CapiUserData = {
  whatsapp_business_account_id: string;
  ctwa_clid: string;
  ph?: string[];
  em?: string[];
};

export type CapiEvent = {
  event_name: CapiEventName;
  event_time: number;
  event_id: string;
  action_source: "business_messaging";
  messaging_channel: "whatsapp";
  user_data: CapiUserData;
};

export type CapiPayload = { data: CapiEvent[]; test_event_code?: string };

export type BuildCapiInput = {
  eventName: CapiEventName;
  eventId: string;
  eventTime: Date;
  /** The click id exactly as WhatsApp delivered it. It is never altered or hashed. */
  ctwaClid: string;
  wabaId: string;
  /** Optional matching keys, hashed here. Off unless the clinic chose to include them. */
  phone?: string | null;
  email?: string | null;
  testEventCode?: string | null;
};

export type BuildResult = { ok: true; payload: CapiPayload } | { ok: false; error: string };

export function buildCapiEvent(i: BuildCapiInput): BuildResult {
  if (!isCapiEventName(i.eventName)) return { ok: false, error: "unsupported_event" };
  if (!i.ctwaClid || i.ctwaClid.length > 500) return { ok: false, error: "no_click_id" };
  if (!/^\d{5,25}$/.test(i.wabaId)) return { ok: false, error: "no_waba" };
  if (!i.eventId || i.eventId.length > 100) return { ok: false, error: "no_event_id" };
  const t = Math.floor(i.eventTime.getTime() / 1000);
  if (!Number.isFinite(t) || t <= 0) return { ok: false, error: "bad_time" };

  const user: CapiUserData = {
    whatsapp_business_account_id: i.wabaId,
    ctwa_clid: i.ctwaClid,
  };
  const ph = hashPhone(i.phone);
  if (ph) user.ph = [ph];
  const em = hashEmail(i.email);
  if (em) user.em = [em];

  const payload: CapiPayload = {
    data: [
      {
        event_name: i.eventName,
        event_time: t,
        event_id: i.eventId,
        action_source: "business_messaging",
        messaging_channel: "whatsapp",
        user_data: user,
      },
    ],
  };
  const code = (i.testEventCode ?? "").trim();
  if (code) payload.test_event_code = code;
  return { ok: true, payload };
}

/**
 * The id Meta uses to de-duplicate an event: stable for (workspace, event, thing it is about), meaningless outside Pulse (a hash,
 * never a raw record id).
 */
export function capiEventId(orgId: string, eventName: CapiEventName, subjectId: string): string {
  return createHash("sha256")
    .update(`${orgId}:${eventName}:${subjectId}`)
    .digest("hex")
    .slice(0, 40);
}

/** Meta rejects events older than 7 days. */
export const MAX_EVENT_AGE_MS = 7 * 24 * 3_600_000;
