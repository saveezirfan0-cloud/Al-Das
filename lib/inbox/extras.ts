/**
 * Inbox extras (Sanoflow parity G11): forwarding a message, sharing a contact card, sending a catalogue product and
 * the staff click-to-call link. Pure rules shared by the server actions and the composer; every send still goes
 * through queueOutbound (lib/inbox/send.ts), so the 24-hour window, the per-number rate limit, training mode and the
 * stop rules apply exactly as for a typed reply.
 */
import { hasWhatsAppFeatures, type ChannelType } from "@/lib/channels/types";
import type { InteractiveObject } from "@/lib/whatsapp/types";

// ---------------------------------------------------------------------------
// Forward
// ---------------------------------------------------------------------------

export type ForwardSource = {
  direction: string;
  kind: string;
  body: string | null;
  media_path: string | null;
  media_mime: string | null;
  media_filename: string | null;
};

export const FORWARD_MEDIA_KINDS = ["image", "video", "audio", "document", "sticker"] as const;
export type ForwardMediaKind = (typeof FORWARD_MEDIA_KINDS)[number];

/** Captions are allowed on these media types only (WhatsApp ignores or refuses them on audio and stickers). */
const CAPTION_KINDS = new Set<string>(["image", "video", "document"]);

export type ForwardPlan =
  | { ok: true; kind: "text"; body: string }
  | {
      ok: true;
      kind: "media";
      mediaType: ForwardMediaKind;
      sourcePath: string;
      mime: string;
      filename: string | null;
      caption: string | null;
    }
  | { ok: false; error: string };

export const FORWARD_ERRORS = {
  kind: "Only text messages and files can be forwarded.",
  note: "Internal notes cannot be forwarded.",
  empty: "This message has no text to forward.",
  notDownloaded: "The file has not finished downloading yet. Try again in a moment.",
  textOnly: "Only text can be forwarded to this channel.",
  same: "Pick a different conversation.",
} as const;

/**
 * What a message becomes when forwarded to a conversation on `targetType`. Text is sent as text; a stored file is
 * re-sent from its stored copy (the caller copies the bytes into the target conversation's folder). Templates,
 * interactive messages, locations, contact cards, reactions, notes and system rows are refused: they either carry
 * structure that only made sense in their own conversation or are not messages at all.
 */
export function planForward(source: ForwardSource, targetType: ChannelType): ForwardPlan {
  if (source.direction === "note" || source.kind === "note")
    return { ok: false, error: FORWARD_ERRORS.note };
  if (source.direction !== "in" && source.direction !== "out")
    return { ok: false, error: FORWARD_ERRORS.kind };
  if (source.kind === "text") {
    const body = (source.body ?? "").trim();
    if (!body) return { ok: false, error: FORWARD_ERRORS.empty };
    return { ok: true, kind: "text", body: body.slice(0, 4096) };
  }
  if ((FORWARD_MEDIA_KINDS as readonly string[]).includes(source.kind)) {
    if (!hasWhatsAppFeatures(targetType)) return { ok: false, error: FORWARD_ERRORS.textOnly };
    if (!source.media_path || !source.media_mime)
      return { ok: false, error: FORWARD_ERRORS.notDownloaded };
    const caption =
      CAPTION_KINDS.has(source.kind) && source.body?.trim()
        ? source.body.trim().slice(0, 1024)
        : null;
    return {
      ok: true,
      kind: "media",
      mediaType: source.kind as ForwardMediaKind,
      sourcePath: source.media_path,
      mime: source.media_mime,
      filename: source.media_filename ? source.media_filename.slice(0, 200) : null,
      caption,
    };
  }
  return { ok: false, error: FORWARD_ERRORS.kind };
}

// ---------------------------------------------------------------------------
// Catalogue product
// ---------------------------------------------------------------------------

/** Meta's limits for product messages. */
export const PRODUCT_LIMITS = {
  items: 30,
  header: 60,
  body: 1024,
  footer: 60,
  retailerId: 100,
} as const;

export type ProductInput = {
  catalogId: string | null | undefined;
  retailerIds: readonly string[];
  header?: string | null;
  body?: string | null;
  footer?: string | null;
};

/** Splits what staff typed (commas, spaces or new lines) into distinct retailer ids, keeping their order. */
export function parseRetailerIds(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(/[\s,;]+/)) {
    const id = part.trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * The interactive object for one product (`product`) or several (`product_list`, one section). Staff type the
 * product retailer ids as they appear in the channel's catalogue; no catalogue API is called. Fails closed when the
 * channel has no catalogue.
 */
export function buildProductMessage(
  input: ProductInput,
): { ok: true; interactive: InteractiveObject; label: string } | { ok: false; error: string } {
  const catalogId = input.catalogId?.trim();
  if (!catalogId)
    return {
      ok: false,
      error: "This number has no catalogue. Add the catalogue ID under Settings, Channels.",
    };
  const ids = [...new Set(input.retailerIds.map((r) => r.trim()).filter(Boolean))];
  if (ids.length === 0) return { ok: false, error: "Enter at least one product ID." };
  if (ids.length > PRODUCT_LIMITS.items)
    return { ok: false, error: `At most ${PRODUCT_LIMITS.items} products in one message.` };
  if (ids.some((r) => r.length > PRODUCT_LIMITS.retailerId))
    return { ok: false, error: "A product ID is too long." };
  const header = input.header?.trim() ?? "";
  const body = input.body?.trim() ?? "";
  const footer = input.footer?.trim() ?? "";
  if (header.length > PRODUCT_LIMITS.header)
    return { ok: false, error: "The heading is too long." };
  if (body.length > PRODUCT_LIMITS.body) return { ok: false, error: "The text is too long." };
  if (footer.length > PRODUCT_LIMITS.footer) return { ok: false, error: "The footer is too long." };

  if (ids.length === 1) {
    return {
      ok: true,
      interactive: {
        type: "product",
        ...(body ? { body: { text: body } } : {}),
        ...(footer ? { footer: { text: footer } } : {}),
        action: { catalog_id: catalogId, product_retailer_id: ids[0] },
      },
      label: body ? `🛒 ${body}` : "🛒 Product",
    };
  }
  if (!header) return { ok: false, error: "A message with several products needs a heading." };
  if (!body) return { ok: false, error: "A message with several products needs some text." };
  return {
    ok: true,
    interactive: {
      type: "product_list",
      header: { type: "text", text: header },
      body: { text: body },
      ...(footer ? { footer: { text: footer } } : {}),
      action: {
        catalog_id: catalogId,
        sections: [
          {
            title: header.slice(0, 24).trim(),
            product_items: ids.map((product_retailer_id) => ({ product_retailer_id })),
          },
        ],
      },
    },
    label: `🛒 ${header}`,
  };
}

// ---------------------------------------------------------------------------
// Employee call
// ---------------------------------------------------------------------------

/**
 * A `tel:` link for the staff member's own phone or softphone, or null when the contact has no valid E.164 number
 * (WhatsApp username users, website visitors). No WhatsApp Calling API is involved and nothing is logged.
 */
export function telHref(phoneE164: string | null | undefined): string | null {
  if (!phoneE164 || !/^\+[1-9][0-9]{6,14}$/.test(phoneE164)) return null;
  return `tel:${phoneE164}`;
}

// ---------------------------------------------------------------------------
// Window wording (no template fallback for any extra)
// ---------------------------------------------------------------------------

/** Why an extra cannot be sent when the reply window of the target conversation is closed. */
export function extrasWindowClosedMessage(
  type: ChannelType,
  what: "forward" | "card" | "product",
): string {
  if (type === "instagram" || type === "messenger")
    return "This channel only allows a reply within 24 hours of the person's last message.";
  const thing =
    what === "forward" ? "Forwarding" : what === "card" ? "A contact card" : "A catalogue product";
  return `${thing} can only be sent within 24 hours of the patient's last message. Outside it, send an approved template.`;
}
