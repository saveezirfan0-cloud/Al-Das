import { serviceWindow, type WindowState } from "@/lib/whatsapp/window";

/**
 * Inbox channel types (Phase 20e, G12). WhatsApp keeps every feature it had; the website chat, Instagram and Messenger
 * carry plain text only (no templates, media, interactive messages, reactions or locations).
 *
 * Pure: shared by server code and client components.
 */
export const CHANNEL_TYPES = ["whatsapp", "web", "instagram", "messenger"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];
export type SocialPlatform = "instagram" | "messenger";

export const CHANNEL_TYPE_LABEL: Record<ChannelType, string> = {
  whatsapp: "WhatsApp",
  web: "Website chat",
  instagram: "Instagram",
  messenger: "Messenger",
};

/** A missing or unknown value is WhatsApp: every channel created before Phase 20e is a WhatsApp number. */
export function channelTypeOf(value: unknown): ChannelType {
  return typeof value === "string" && (CHANNEL_TYPES as readonly string[]).includes(value)
    ? (value as ChannelType)
    : "whatsapp";
}

export function isSocialPlatform(value: unknown): value is SocialPlatform {
  return value === "instagram" || value === "messenger";
}

/** Only WhatsApp has templates, media, interactive messages, reactions, locations, blue ticks and number switching. */
export function hasWhatsAppFeatures(type: ChannelType): boolean {
  return type === "whatsapp";
}

/**
 * The namespaced reference stored in channels.phone_number_id for a channel that is not a WhatsApp number
 * ('web:<org id>', 'instagram:<account id>', 'messenger:<page id>'). The database refuses any other shape for these types.
 */
export function channelRef(type: Exclude<ChannelType, "whatsapp">, id: string): string {
  return `${type}:${id}`;
}

/** Meta's standard messaging window for Instagram and Messenger: a business may reply within 24 hours of the person's last message. */
export const SOCIAL_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

export type ReplyWindow = WindowState & { kind: "whatsapp" | "social" | "none" };

/**
 * When staff may send a free-text reply on a conversation.
 *   whatsapp           the WhatsApp customer-service window (templates outside it), unchanged
 *   instagram/messenger 24 hours after the person's last message, nothing outside it (no template support)
 *   web                always (the visitor's own browser fetches the reply; no third-party window)
 */
export function replyWindow(
  type: ChannelType,
  input: {
    lastInboundAt: Date | string | null | undefined;
    adOpenedAt?: Date | string | null;
    now?: Date;
  },
): ReplyWindow {
  if (type === "whatsapp") return { ...serviceWindow(input), kind: "whatsapp" };
  if (type === "web")
    return {
      open: true,
      remainingMs: Number.POSITIVE_INFINITY,
      closesAt: null,
      reason: "service",
      kind: "none",
    };
  const now = (input.now ?? new Date()).getTime();
  const raw = input.lastInboundAt;
  const last = raw ? (raw instanceof Date ? raw.getTime() : new Date(raw).getTime()) : NaN;
  if (!Number.isFinite(last))
    return { open: false, remainingMs: 0, closesAt: null, reason: "never_inbound", kind: "social" };
  const closes = last + SOCIAL_REPLY_WINDOW_MS;
  if (closes <= now)
    return {
      open: false,
      remainingMs: 0,
      closesAt: new Date(closes),
      reason: "closed",
      kind: "social",
    };
  return {
    open: true,
    remainingMs: closes - now,
    closesAt: new Date(closes),
    reason: "service",
    kind: "social",
  };
}

/** The sentence staff see when a reply is refused because the window has closed. */
export function windowClosedMessage(type: ChannelType): string {
  if (type === "instagram" || type === "messenger")
    return `${CHANNEL_TYPE_LABEL[type]} only allows a reply within 24 hours of the person's last message. Ask them to write again, or contact them another way.`;
  return "The 24-hour window is closed: send an approved template instead.";
}
