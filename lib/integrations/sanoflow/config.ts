/**
 * Sanoflow sending (owner decision 20 Oct 2026, OQ-182, docs/50_SANOFLOW_SENDING_NOTES.md): the fixed host, paths and the
 * settings Pulse reads from the `sanoflow` integration account. Pure.
 *
 * The request shapes are the ones Make's live scenarios use today (docs/audit/make-raw/*.blueprint.redacted.json):
 *   POST https://developers.sanoflow.io/api/v1.1/messages/whatsapp/send-template
 *        access-token: <API key>
 *        {"template_id": 11885, "phone": "<number>", "mapper_value": ["<{{1}}>", "<{{2}}>", ...]}
 * Make never reads the answer, so its shape is unknown (see client.ts for how it is judged).
 */

export const SANOFLOW_HOST = "developers.sanoflow.io";
export const SANOFLOW_SEND_TEMPLATE_URL = `https://${SANOFLOW_HOST}/api/v1.1/messages/whatsapp/send-template`;
/** Contact list (by phone or contact id). Also the read-only check behind "Test connection" (contact id 0). */
export const SANOFLOW_CONTACTS_URL = `https://${SANOFLOW_HOST}/api/v1.1/contacts/list`;
/** Make's reminder error path creates the contact on v1 and edits tags / label on v1.1 (docs/49 D9, D11). */
export const SANOFLOW_CONTACTS_ADD_URL = `https://${SANOFLOW_HOST}/api/v1/contacts/add`;
export const SANOFLOW_CONTACTS_EDIT_URL = `https://${SANOFLOW_HOST}/api/v1.1/contacts/edit`;

/**
 * The Sanoflow tags and label Make writes after a recall send (docs/49 D11, owner decision 22 Oct 2026): birthday adds tag
 * 3590; chronic recall adds tag 4654 and sets label 1800. Editable on the integration in case Sanoflow renumbers them.
 */
export const DEFAULT_BIRTHDAY_TAG_ID = 3590;
export const DEFAULT_CHRONIC_TAG_ID = 4654;
export const DEFAULT_CHRONIC_LABEL_ID = 1800;

/** The channel waba_id and phone_number_id prefix of a number that sends through Sanoflow (migration 20261224000100). */
export const SANOFLOW_WABA_ID = "sanoflow";
export const SANOFLOW_PHONE_PREFIX = "sanoflow:";

/**
 * How a phone number is written in the `phone` field. Make passes Airtable's and Unite's own text (for example 971-5…),
 * which Sanoflow accepts, so digits only is the default; the exact format Sanoflow wants is unconfirmed (one test send).
 */
export const PHONE_FORMATS = ["digits", "plus"] as const;
export type SanoflowPhoneFormat = (typeof PHONE_FORMATS)[number];

export type SanoflowConfig = {
  phoneFormat: SanoflowPhoneFormat;
  /** Write Make's tags / label to the Sanoflow contact after a Live recall send (default on, like Make). */
  tagContacts: boolean;
  birthdayTagId: number;
  chronicTagId: number;
  chronicLabelId: number;
};

function positiveId(v: string | number | undefined, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

export function readSanoflowConfig(config: Record<string, string | number>): SanoflowConfig {
  const f = config.phone_format;
  return {
    phoneFormat: f === "plus" ? "plus" : "digits",
    tagContacts: config.tag_contacts !== "off",
    birthdayTagId: positiveId(config.birthday_tag_id, DEFAULT_BIRTHDAY_TAG_ID),
    chronicTagId: positiveId(config.chronic_tag_id, DEFAULT_CHRONIC_TAG_ID),
    chronicLabelId: positiveId(config.chronic_label_id, DEFAULT_CHRONIC_LABEL_ID),
  };
}

/** The `phone` value for an E.164 number, or null when the number is not E.164. */
export function sanoflowPhone(
  e164: string | null | undefined,
  format: SanoflowPhoneFormat,
): string | null {
  if (!e164 || !/^\+[1-9]\d{6,14}$/.test(e164)) return null;
  return format === "plus" ? e164 : e164.slice(1);
}

export function isSanoflowChannel(
  channel: { transport?: string | null } | null | undefined,
): boolean {
  return channel?.transport === "sanoflow";
}

/** The address a Sanoflow flow posts "patient replied / booked" to (app/api/webhooks/integrations/sanoflow/[accountId]). */
export function sanoflowWebhookBase(appUrl: string, accountId: string): string {
  return `${appUrl.replace(/\/+$/, "")}/api/webhooks/integrations/sanoflow/${accountId}`;
}
