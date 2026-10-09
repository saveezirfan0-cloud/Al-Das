/**
 * Turns a raw Meta webhook body into a flat list of typed events that the
 * meta_events handler routes. Pure; fixtures in scripts/wa-fixtures exercise
 * every branch in tests/unit/whatsapp-parse.test.ts.
 */
import { looksLikeBsuid, waIdToE164 } from "@/lib/whatsapp/phone";
import {
  accountUpdateValueSchema,
  businessUsernameValueSchema,
  messagesValueSchema,
  phoneQualityValueSchema,
  templateCategoryValueSchema,
  templateQualityValueSchema,
  templateStatusValueSchema,
  userIdUpdateValueSchema,
  webhookBodySchema,
  type WebhookContact,
  type WebhookMessage,
  type WebhookStatus,
} from "@/lib/whatsapp/webhook-types";

export type InboundKind =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "sticker"
  | "location"
  | "contacts"
  | "interactive"
  | "button"
  | "reaction"
  | "order"
  | "system"
  | "unsupported";

export type InboundIdentity = {
  /** E.164 phone, when the sender has one. */
  phoneE164: string | null;
  /** Meta business-scoped user id (BSUID), when provided. */
  bsuid: string | null;
  /** Raw `from` / `wa_id` used by Meta for replies. */
  waId: string;
  profileName: string | null;
  username: string | null;
};

export type InboundMedia = {
  metaId: string;
  mimeType: string | null;
  sha256: string | null;
  caption: string | null;
  filename: string | null;
  voice: boolean;
};

export type InboundMessageEvent = {
  kind: "message";
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  waMessageId: string;
  timestamp: Date;
  type: InboundKind;
  rawType: string;
  identity: InboundIdentity;
  /** Text body, caption, button title, list row title, location name, reaction emoji… */
  body: string | null;
  media: InboundMedia | null;
  replyToWaMessageId: string | null;
  forwarded: boolean;
  referral: Record<string, unknown> | null;
  interactive: {
    type: string;
    id: string | null;
    title: string | null;
    payload: Record<string, unknown> | null;
  } | null;
  reaction: { messageId: string; emoji: string | null } | null;
  location: {
    latitude: number;
    longitude: number;
    name: string | null;
    address: string | null;
  } | null;
  errors: unknown[] | null;
  raw: WebhookMessage;
};

export type StatusEvent = {
  kind: "status";
  wabaId: string;
  phoneNumberId: string;
  waMessageId: string;
  status: string;
  timestamp: Date;
  recipientWaId: string | null;
  conversationId: string | null;
  conversationOrigin: string | null;
  conversationExpiresAt: Date | null;
  pricingCategory: string | null;
  billable: boolean | null;
  errorCode: number | null;
  errorMessage: string | null;
  callbackData: string | null;
  raw: WebhookStatus;
};

export type TemplateStatusEvent = {
  kind: "template_status";
  wabaId: string;
  templateId: string;
  name: string;
  language: string;
  event: string;
  reason: string | null;
  raw: Record<string, unknown>;
};

export type TemplateCategoryEvent = {
  kind: "template_category";
  wabaId: string;
  templateId: string;
  name: string;
  language: string;
  previousCategory: string | null;
  newCategory: string;
  raw: Record<string, unknown>;
};

export type TemplateQualityEvent = {
  kind: "template_quality";
  wabaId: string;
  templateId: string;
  name: string;
  language: string;
  previousQuality: string | null;
  newQuality: string;
  raw: Record<string, unknown>;
};

export type PhoneQualityEvent = {
  kind: "phone_quality";
  wabaId: string;
  displayPhoneNumber: string;
  event: string;
  currentLimit: string | null;
  oldLimit: string | null;
  raw: Record<string, unknown>;
};

export type AccountUpdateEvent = {
  kind: "account_update";
  wabaId: string;
  event: string;
  phoneNumber: string | null;
  raw: Record<string, unknown>;
};

export type UserIdUpdateEvent = {
  kind: "user_id_update";
  wabaId: string;
  phoneNumberId: string | null;
  oldBsuid: string | null;
  newBsuid: string | null;
  phoneE164: string | null;
  raw: Record<string, unknown>;
};

export type BusinessUsernameEvent = {
  kind: "business_username";
  wabaId: string;
  phoneNumberId: string | null;
  username: string | null;
  event: string | null;
  raw: Record<string, unknown>;
};

export type UnknownFieldEvent = {
  kind: "unknown";
  wabaId: string;
  field: string;
  raw: Record<string, unknown>;
};

export type WebhookEvent =
  | InboundMessageEvent
  | StatusEvent
  | TemplateStatusEvent
  | TemplateCategoryEvent
  | TemplateQualityEvent
  | PhoneQualityEvent
  | AccountUpdateEvent
  | UserIdUpdateEvent
  | BusinessUsernameEvent
  | UnknownFieldEvent;

export type ParseResult = { ok: true; events: WebhookEvent[] } | { ok: false; error: string };

const MEDIA_TYPES = new Set(["image", "video", "audio", "document", "sticker"]);

function tsToDate(ts: string | number | undefined): Date {
  const n = typeof ts === "number" ? ts : Number(ts);
  if (!Number.isFinite(n)) return new Date();
  // Meta sends epoch seconds.
  return new Date(n < 1e12 ? n * 1000 : n);
}

/**
 * Resolve who sent a message. `from` is the phone (digits) for phone users. For
 * username (BSUID) users `from` carries the BSUID and the contact has `user_id`
 * with no numeric `wa_id`. We subscribe to user_id_update to follow BSUID changes.
 */
export function resolveIdentity(
  from: string,
  contacts: WebhookContact[] | undefined,
): InboundIdentity {
  const contact =
    contacts?.find((c) => c.wa_id === from || c.user_id === from) ?? contacts?.[0] ?? undefined;
  const phoneCandidates = [from, contact?.wa_id].filter((v): v is string => !!v);
  let phoneE164: string | null = null;
  for (const c of phoneCandidates) {
    const e = waIdToE164(c);
    if (e) {
      phoneE164 = e;
      break;
    }
  }
  let bsuid: string | null = contact?.user_id ?? null;
  if (!bsuid && looksLikeBsuid(from)) bsuid = from;
  return {
    phoneE164,
    bsuid,
    waId: from,
    profileName: contact?.profile?.name ?? null,
    username: contact?.username ?? null,
  };
}

export function parseInboundMessage(
  m: WebhookMessage,
  contacts: WebhookContact[] | undefined,
  meta: { wabaId: string; phoneNumberId: string; displayPhoneNumber: string | null },
): InboundMessageEvent {
  const rawType = m.type;
  let type: InboundKind = "unsupported";
  let body: string | null = null;
  let media: InboundMedia | null = null;
  let interactive: InboundMessageEvent["interactive"] = null;
  let reaction: InboundMessageEvent["reaction"] = null;
  let location: InboundMessageEvent["location"] = null;

  if (rawType === "text" && m.text) {
    type = "text";
    body = m.text.body;
  } else if (MEDIA_TYPES.has(rawType)) {
    const obj = (m as Record<string, unknown>)[rawType] as
      | {
          id: string;
          mime_type?: string;
          sha256?: string;
          caption?: string;
          filename?: string;
          voice?: boolean;
        }
      | undefined;
    if (obj) {
      type = rawType as InboundKind;
      body = obj.caption ?? null;
      media = {
        metaId: obj.id,
        mimeType: obj.mime_type ?? null,
        sha256: obj.sha256 ?? null,
        caption: obj.caption ?? null,
        filename: obj.filename ?? null,
        voice: obj.voice === true,
      };
    }
  } else if (rawType === "location" && m.location) {
    type = "location";
    location = {
      latitude: m.location.latitude,
      longitude: m.location.longitude,
      name: m.location.name ?? null,
      address: m.location.address ?? null,
    };
    body =
      m.location.name ?? m.location.address ?? `${m.location.latitude}, ${m.location.longitude}`;
  } else if (rawType === "contacts" && m.contacts) {
    type = "contacts";
    const names = m.contacts
      .map((c) => (c as { name?: { formatted_name?: string } }).name?.formatted_name)
      .filter((n): n is string => !!n);
    body = names.length ? names.join(", ") : null;
  } else if (rawType === "interactive" && m.interactive) {
    type = "interactive";
    const i = m.interactive;
    if (i.type === "button_reply" && i.button_reply) {
      interactive = {
        type: "button_reply",
        id: i.button_reply.id,
        title: i.button_reply.title,
        payload: null,
      };
      body = i.button_reply.title;
    } else if (i.type === "list_reply" && i.list_reply) {
      interactive = {
        type: "list_reply",
        id: i.list_reply.id,
        title: i.list_reply.title,
        payload: null,
      };
      body = i.list_reply.title;
    } else if (i.type === "nfm_reply" && i.nfm_reply) {
      interactive = {
        type: "nfm_reply",
        id: null,
        title: null,
        payload: i.nfm_reply as Record<string, unknown>,
      };
      body = "Form reply";
    } else {
      interactive = { type: i.type, id: null, title: null, payload: i as Record<string, unknown> };
    }
  } else if (rawType === "button" && m.button) {
    // Quick-reply button on a template.
    type = "button";
    body = m.button.text;
    interactive = {
      type: "template_button",
      id: m.button.payload ?? null,
      title: m.button.text,
      payload: null,
    };
  } else if (rawType === "reaction" && m.reaction) {
    type = "reaction";
    reaction = { messageId: m.reaction.message_id, emoji: m.reaction.emoji ?? null };
    body = m.reaction.emoji ?? null;
  } else if (rawType === "order") {
    type = "order";
    body = "Order";
  } else if (rawType === "system" && m.system) {
    type = "system";
    body = m.system.body ?? null;
  } else {
    type = "unsupported";
  }

  return {
    kind: "message",
    wabaId: meta.wabaId,
    phoneNumberId: meta.phoneNumberId,
    displayPhoneNumber: meta.displayPhoneNumber,
    waMessageId: m.id,
    timestamp: tsToDate(m.timestamp),
    type,
    rawType,
    identity: resolveIdentity(m.from, contacts),
    body,
    media,
    replyToWaMessageId: m.context?.id ?? null,
    forwarded: m.context?.forwarded === true || m.context?.frequently_forwarded === true,
    referral: (m.referral as Record<string, unknown> | undefined) ?? null,
    interactive,
    reaction,
    location,
    errors: m.errors ?? null,
    raw: m,
  };
}

export function parseStatus(
  s: WebhookStatus,
  meta: { wabaId: string; phoneNumberId: string },
): StatusEvent {
  const err = s.errors?.[0];
  return {
    kind: "status",
    wabaId: meta.wabaId,
    phoneNumberId: meta.phoneNumberId,
    waMessageId: s.id,
    status: s.status,
    timestamp: tsToDate(s.timestamp),
    recipientWaId: s.recipient_id ?? null,
    conversationId: s.conversation?.id ?? null,
    conversationOrigin: s.conversation?.origin?.type ?? null,
    conversationExpiresAt: s.conversation?.expiration_timestamp
      ? tsToDate(s.conversation.expiration_timestamp)
      : null,
    pricingCategory: s.pricing?.category ?? null,
    billable: s.pricing?.billable ?? null,
    errorCode: err?.code ?? null,
    errorMessage: err
      ? [err.title, err.message, err.error_data?.details].filter(Boolean).join(" — ") || null
      : null,
    callbackData: s.biz_opaque_callback_data ?? null,
    raw: s,
  };
}

/** Parse the whole body. Unknown fields are kept as `unknown` events so nothing is silently dropped. */
export function parseWebhookBody(input: unknown): ParseResult {
  const parsed = webhookBodySchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  }
  const body = parsed.data;
  if (body.object !== "whatsapp_business_account") {
    return { ok: false, error: `unexpected object "${body.object}"` };
  }
  const events: WebhookEvent[] = [];
  for (const entry of body.entry) {
    const wabaId = entry.id;
    for (const change of entry.changes) {
      const raw = change.value as Record<string, unknown>;
      switch (change.field) {
        case "messages": {
          const v = messagesValueSchema.safeParse(change.value);
          if (!v.success) {
            events.push({
              kind: "unknown",
              wabaId,
              field: `messages (invalid: ${v.error.issues[0]?.message})`,
              raw,
            });
            break;
          }
          const meta = {
            wabaId,
            phoneNumberId: v.data.metadata.phone_number_id,
            displayPhoneNumber: v.data.metadata.display_phone_number ?? null,
          };
          for (const m of v.data.messages ?? [])
            events.push(parseInboundMessage(m, v.data.contacts, meta));
          for (const s of v.data.statuses ?? []) events.push(parseStatus(s, meta));
          break;
        }
        case "message_template_status_update": {
          const v = templateStatusValueSchema.safeParse(change.value);
          if (!v.success) {
            events.push({ kind: "unknown", wabaId, field: change.field, raw });
            break;
          }
          events.push({
            kind: "template_status",
            wabaId,
            templateId: v.data.message_template_id,
            name: v.data.message_template_name,
            language: v.data.message_template_language,
            event: v.data.event,
            reason: v.data.reason ?? null,
            raw,
          });
          break;
        }
        case "template_category_update": {
          const v = templateCategoryValueSchema.safeParse(change.value);
          if (!v.success) {
            events.push({ kind: "unknown", wabaId, field: change.field, raw });
            break;
          }
          events.push({
            kind: "template_category",
            wabaId,
            templateId: v.data.message_template_id,
            name: v.data.message_template_name,
            language: v.data.message_template_language,
            previousCategory: v.data.previous_category ?? null,
            newCategory: v.data.new_category,
            raw,
          });
          break;
        }
        case "message_template_quality_update": {
          const v = templateQualityValueSchema.safeParse(change.value);
          if (!v.success) {
            events.push({ kind: "unknown", wabaId, field: change.field, raw });
            break;
          }
          events.push({
            kind: "template_quality",
            wabaId,
            templateId: v.data.message_template_id,
            name: v.data.message_template_name,
            language: v.data.message_template_language,
            previousQuality: v.data.previous_quality_score ?? null,
            newQuality: v.data.new_quality_score,
            raw,
          });
          break;
        }
        case "phone_number_quality_update": {
          const v = phoneQualityValueSchema.safeParse(change.value);
          if (!v.success) {
            events.push({ kind: "unknown", wabaId, field: change.field, raw });
            break;
          }
          events.push({
            kind: "phone_quality",
            wabaId,
            displayPhoneNumber: v.data.display_phone_number,
            event: v.data.event,
            currentLimit: v.data.current_limit ?? null,
            oldLimit: v.data.old_limit ?? null,
            raw,
          });
          break;
        }
        case "account_update": {
          const v = accountUpdateValueSchema.safeParse(change.value);
          if (!v.success) {
            events.push({ kind: "unknown", wabaId, field: change.field, raw });
            break;
          }
          events.push({
            kind: "account_update",
            wabaId,
            event: v.data.event,
            phoneNumber: v.data.phone_number ?? null,
            raw,
          });
          break;
        }
        case "user_id_update": {
          const v = userIdUpdateValueSchema.safeParse(change.value);
          if (!v.success) {
            events.push({ kind: "unknown", wabaId, field: change.field, raw });
            break;
          }
          const u = v.data.user_id_update ?? {};
          events.push({
            kind: "user_id_update",
            wabaId,
            phoneNumberId: v.data.metadata?.phone_number_id ?? null,
            oldBsuid: u.old_user_id ?? null,
            newBsuid: u.new_user_id ?? u.user_id ?? null,
            phoneE164: waIdToE164(u.phone_number ?? u.wa_id ?? null),
            raw,
          });
          break;
        }
        case "business_username_updates": {
          const v = businessUsernameValueSchema.safeParse(change.value);
          events.push({
            kind: "business_username",
            wabaId,
            phoneNumberId: v.success ? (v.data.metadata?.phone_number_id ?? null) : null,
            username: v.success ? (v.data.username ?? null) : null,
            event: v.success ? (v.data.event ?? null) : null,
            raw,
          });
          break;
        }
        default:
          events.push({ kind: "unknown", wabaId, field: change.field, raw });
      }
    }
  }
  return { ok: true, events };
}

/** Short, PHI-free preview for the conversation list. */
export function previewFor(
  type: InboundKind | string,
  body: string | null,
  filename?: string | null,
): string {
  switch (type) {
    case "text":
      return (body ?? "").slice(0, 140);
    case "image":
      return body ? `📷 ${body.slice(0, 120)}` : "📷 Photo";
    case "video":
      return body ? `🎬 ${body.slice(0, 120)}` : "🎬 Video";
    case "audio":
      return "🎤 Voice message";
    case "document":
      return `📄 ${filename ?? body ?? "Document"}`.slice(0, 140);
    case "sticker":
      return "Sticker";
    case "location":
      return `📍 ${body ?? "Location"}`.slice(0, 140);
    case "contacts":
      return `👤 ${body ?? "Contact card"}`.slice(0, 140);
    case "interactive":
    case "button":
      return (body ?? "Reply").slice(0, 140);
    case "reaction":
      return `Reacted ${body ?? ""}`.trim();
    case "template":
      return (body ?? "Template message").slice(0, 140);
    case "note":
      return `📝 ${(body ?? "").slice(0, 120)}`;
    case "system":
      return (body ?? "System message").slice(0, 140);
    case "order":
      return "🛒 Order";
    default:
      return "Unsupported message";
  }
}
