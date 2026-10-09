/**
 * Zod schemas for the Meta WhatsApp webhook payload. Loose where Meta is loose
 * (`passthrough`), strict on the fields we route on.
 */
import { z } from "zod";

const loose = z.object({}).passthrough();

export const webhookMediaSchema = z
  .object({
    id: z.string(),
    mime_type: z.string().optional(),
    sha256: z.string().optional(),
    caption: z.string().optional(),
    filename: z.string().optional(),
    voice: z.boolean().optional(),
    animated: z.boolean().optional(),
  })
  .passthrough();

export const webhookContactSchema = z
  .object({
    /** Phone digits for phone users; for username users wa_id may be absent or non-numeric. */
    wa_id: z.string().optional(),
    /** BSUID — business-scoped user id for WhatsApp username users. */
    user_id: z.string().optional(),
    profile: z.object({ name: z.string().optional() }).passthrough().optional(),
    /** Username (@handle) when the user has one. */
    username: z.string().optional(),
  })
  .passthrough();

export const webhookMessageSchema = z
  .object({
    id: z.string(),
    from: z.string(),
    timestamp: z.string(),
    type: z.string(),
    context: z
      .object({
        from: z.string().optional(),
        id: z.string().optional(),
        forwarded: z.boolean().optional(),
        frequently_forwarded: z.boolean().optional(),
        referred_product: loose.optional(),
      })
      .passthrough()
      .optional(),
    referral: z
      .object({
        source_url: z.string().optional(),
        source_id: z.string().optional(),
        source_type: z.string().optional(),
        headline: z.string().optional(),
        body: z.string().optional(),
        media_type: z.string().optional(),
        image_url: z.string().optional(),
        video_url: z.string().optional(),
        thumbnail_url: z.string().optional(),
        ctwa_clid: z.string().optional(),
      })
      .passthrough()
      .optional(),
    text: z.object({ body: z.string() }).passthrough().optional(),
    image: webhookMediaSchema.optional(),
    video: webhookMediaSchema.optional(),
    audio: webhookMediaSchema.optional(),
    document: webhookMediaSchema.optional(),
    sticker: webhookMediaSchema.optional(),
    location: z
      .object({
        latitude: z.number(),
        longitude: z.number(),
        name: z.string().optional(),
        address: z.string().optional(),
      })
      .passthrough()
      .optional(),
    contacts: z.array(loose).optional(),
    interactive: z
      .object({
        type: z.string(),
        button_reply: z.object({ id: z.string(), title: z.string() }).optional(),
        list_reply: z
          .object({ id: z.string(), title: z.string(), description: z.string().optional() })
          .optional(),
        nfm_reply: loose.optional(),
      })
      .passthrough()
      .optional(),
    button: z.object({ text: z.string(), payload: z.string().optional() }).passthrough().optional(),
    reaction: z
      .object({ message_id: z.string(), emoji: z.string().optional() })
      .passthrough()
      .optional(),
    order: loose.optional(),
    system: z
      .object({
        body: z.string().optional(),
        type: z.string().optional(),
        wa_id: z.string().optional(),
      })
      .passthrough()
      .optional(),
    errors: z.array(loose).optional(),
    unsupported: loose.optional(),
  })
  .passthrough();

export const webhookStatusSchema = z
  .object({
    id: z.string(),
    status: z.string(), // sent | delivered | read | failed | deleted | warning
    timestamp: z.string(),
    recipient_id: z.string().optional(),
    biz_opaque_callback_data: z.string().optional(),
    conversation: z
      .object({
        id: z.string().optional(),
        origin: z.object({ type: z.string().optional() }).passthrough().optional(),
        expiration_timestamp: z.string().optional(),
      })
      .passthrough()
      .optional(),
    pricing: z
      .object({
        billable: z.boolean().optional(),
        pricing_model: z.string().optional(),
        category: z.string().optional(),
        type: z.string().optional(),
      })
      .passthrough()
      .optional(),
    errors: z
      .array(
        z
          .object({
            code: z.number(),
            title: z.string().optional(),
            message: z.string().optional(),
            error_data: z.object({ details: z.string().optional() }).passthrough().optional(),
            href: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export const messagesValueSchema = z
  .object({
    messaging_product: z.literal("whatsapp").optional(),
    metadata: z
      .object({ display_phone_number: z.string().optional(), phone_number_id: z.string() })
      .passthrough(),
    contacts: z.array(webhookContactSchema).optional(),
    messages: z.array(webhookMessageSchema).optional(),
    statuses: z.array(webhookStatusSchema).optional(),
    errors: z.array(loose).optional(),
  })
  .passthrough();

export const templateStatusValueSchema = z
  .object({
    event: z.string(), // APPROVED | REJECTED | PENDING | PAUSED | DISABLED | IN_APPEAL | FLAGGED | REINSTATED | PENDING_DELETION
    message_template_id: z.union([z.string(), z.number()]).transform(String),
    message_template_name: z.string(),
    message_template_language: z.string(),
    reason: z.string().nullable().optional(),
    disable_info: loose.optional(),
    other_info: loose.optional(),
  })
  .passthrough();

export const templateCategoryValueSchema = z
  .object({
    message_template_id: z.union([z.string(), z.number()]).transform(String),
    message_template_name: z.string(),
    message_template_language: z.string(),
    previous_category: z.string().optional(),
    new_category: z.string(),
    correct_category: z.string().optional(),
  })
  .passthrough();

export const templateQualityValueSchema = z
  .object({
    message_template_id: z.union([z.string(), z.number()]).transform(String),
    message_template_name: z.string(),
    message_template_language: z.string(),
    previous_quality_score: z.string().optional(),
    new_quality_score: z.string(),
  })
  .passthrough();

export const phoneQualityValueSchema = z
  .object({
    display_phone_number: z.string(),
    event: z.string(), // ONBOARDING | UPGRADE | DOWNGRADE | FLAGGED | UNFLAGGED
    current_limit: z.string().optional(),
    old_limit: z.string().optional(),
  })
  .passthrough();

export const accountUpdateValueSchema = z
  .object({
    phone_number: z.string().optional(),
    event: z.string(), // VERIFIED_ACCOUNT | DISABLED_UPDATE | ACCOUNT_VIOLATION | ACCOUNT_RESTRICTION | PARTNER_ADDED | ...
    ban_info: loose.optional(),
    restriction_info: z.array(loose).optional(),
    violation_info: loose.optional(),
    waba_info: loose.optional(),
  })
  .passthrough();

/** Sent when a user's BSUID changes (e.g. username users re-registering). */
export const userIdUpdateValueSchema = z
  .object({
    metadata: z
      .object({
        phone_number_id: z.string().optional(),
        display_phone_number: z.string().optional(),
      })
      .passthrough()
      .optional(),
    user_id_update: z
      .object({
        old_user_id: z.string().optional(),
        new_user_id: z.string().optional(),
        user_id: z.string().optional(),
        phone_number: z.string().optional(),
        wa_id: z.string().optional(),
        username: z.string().optional(),
        event: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const businessUsernameValueSchema = z
  .object({
    metadata: z.object({ phone_number_id: z.string().optional() }).passthrough().optional(),
    username: z.string().optional(),
    event: z.string().optional(),
  })
  .passthrough();

export const webhookChangeSchema = z
  .object({
    field: z.string(),
    value: loose,
  })
  .passthrough();

export const webhookEntrySchema = z
  .object({
    id: z.string(), // WABA id
    time: z.number().optional(),
    changes: z.array(webhookChangeSchema),
  })
  .passthrough();

export const webhookBodySchema = z
  .object({
    object: z.string(), // "whatsapp_business_account"
    entry: z.array(webhookEntrySchema),
  })
  .passthrough();

export type WebhookBody = z.infer<typeof webhookBodySchema>;
export type WebhookMessage = z.infer<typeof webhookMessageSchema>;
export type WebhookStatus = z.infer<typeof webhookStatusSchema>;
export type WebhookContact = z.infer<typeof webhookContactSchema>;
export type MessagesValue = z.infer<typeof messagesValueSchema>;
