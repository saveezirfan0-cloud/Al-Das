/**
 * WhatsApp Cloud API request/response types (subset used by Pulse).
 * Framework-free so handlers, UI previews and tests can share them.
 */

export type MediaType = "image" | "video" | "audio" | "document" | "sticker";

export type MediaRef = { id: string; link?: never } | { link: string; id?: never };

export type MediaObject = MediaRef & {
  caption?: string;
  filename?: string;
};

export type TextObject = { body: string; preview_url?: boolean };

export type LocationObject = {
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
};

export type ContactObject = {
  name: { formatted_name: string; first_name?: string; last_name?: string };
  phones?: Array<{ phone: string; type?: string; wa_id?: string }>;
  emails?: Array<{ email: string; type?: string }>;
  org?: { company?: string; department?: string; title?: string };
};

export type InteractiveHeader =
  | { type: "text"; text: string }
  | { type: "image"; image: MediaRef }
  | { type: "video"; video: MediaRef }
  | { type: "document"; document: MediaRef };

export type InteractiveButton = { type: "reply"; reply: { id: string; title: string } };

export type InteractiveObject =
  | {
      type: "button";
      header?: InteractiveHeader;
      body: { text: string };
      footer?: { text: string };
      action: { buttons: InteractiveButton[] }; // max 3
    }
  | {
      type: "list";
      header?: { type: "text"; text: string };
      body: { text: string };
      footer?: { text: string };
      action: {
        button: string;
        sections: Array<{
          title?: string;
          rows: Array<{ id: string; title: string; description?: string }>; // max 10 rows total
        }>;
      };
    }
  | {
      type: "cta_url";
      header?: InteractiveHeader;
      body: { text: string };
      footer?: { text: string };
      action: { name: "cta_url"; parameters: { display_text: string; url: string } };
    };

export type TemplateParameter =
  | { type: "text"; text: string; parameter_name?: string }
  | { type: "currency"; currency: { fallback_value: string; code: string; amount_1000: number } }
  | { type: "date_time"; date_time: { fallback_value: string } }
  | { type: "image"; image: MediaRef }
  | { type: "video"; video: MediaRef }
  | { type: "document"; document: MediaRef }
  | { type: "payload"; payload: string }
  | { type: "coupon_code"; coupon_code: string };

export type TemplateComponent =
  | { type: "header"; parameters: TemplateParameter[] }
  | { type: "body"; parameters: TemplateParameter[] }
  | {
      type: "button";
      sub_type: "quick_reply" | "url" | "copy_code" | "catalog" | "flow";
      index: number | string;
      parameters: TemplateParameter[];
    }
  | { type: "carousel"; cards: Array<{ card_index: number; components: TemplateComponent[] }> };

export type TemplateObject = {
  name: string;
  language: { code: string; policy?: "deterministic" };
  components?: TemplateComponent[];
};

type Base = {
  messaging_product: "whatsapp";
  recipient_type?: "individual";
  to: string;
  context?: { message_id: string };
  biz_opaque_callback_data?: string;
};

export type OutboundMessage =
  | (Base & { type: "text"; text: TextObject })
  | (Base & { type: "image"; image: MediaObject })
  | (Base & { type: "video"; video: MediaObject })
  | (Base & { type: "audio"; audio: MediaRef })
  | (Base & { type: "document"; document: MediaObject })
  | (Base & { type: "sticker"; sticker: MediaRef })
  | (Base & { type: "location"; location: LocationObject })
  | (Base & { type: "contacts"; contacts: ContactObject[] })
  | (Base & { type: "interactive"; interactive: InteractiveObject })
  | (Base & { type: "template"; template: TemplateObject })
  | (Base & { type: "reaction"; reaction: { message_id: string; emoji: string } });

export type OutboundKind = OutboundMessage["type"];

export type SendResult = {
  messaging_product: "whatsapp";
  contacts?: Array<{ input: string; wa_id: string }>;
  messages: Array<{ id: string; message_status?: "accepted" | "held_for_quality_assessment" }>;
};

export type MarkReadRequest = {
  messaging_product: "whatsapp";
  status: "read";
  message_id: string;
  typing_indicator?: { type: "text" };
};

export type MediaUploadResult = { id: string };

export type MediaInfo = {
  id: string;
  url: string;
  mime_type: string;
  sha256: string;
  file_size: number;
  messaging_product: "whatsapp";
};

export type BusinessProfile = {
  messaging_product?: "whatsapp";
  about?: string;
  address?: string;
  description?: string;
  email?: string;
  profile_picture_url?: string;
  websites?: string[];
  vertical?: string;
};

export const BUSINESS_PROFILE_FIELDS = [
  "about",
  "address",
  "description",
  "email",
  "profile_picture_url",
  "websites",
  "vertical",
] as const;

export const BUSINESS_VERTICALS = [
  "UNDEFINED",
  "OTHER",
  "AUTO",
  "BEAUTY",
  "APPAREL",
  "EDU",
  "ENTERTAIN",
  "EVENT_PLAN",
  "FINANCE",
  "GROCERY",
  "GOVT",
  "HOTEL",
  "HEALTH",
  "NONPROFIT",
  "PROF_SERVICES",
  "RETAIL",
  "TRAVEL",
  "RESTAURANT",
  "NOT_A_BIZ",
] as const;

export type PhoneNumberInfo = {
  id: string;
  verified_name?: string;
  display_phone_number?: string;
  quality_rating?: "GREEN" | "YELLOW" | "RED" | "UNKNOWN" | string;
  messaging_limit_tier?: string;
  name_status?: string;
  code_verification_status?: string;
  platform_type?: string;
  throughput?: { level?: string };
  is_official_business_account?: boolean;
  account_mode?: string;
  status?: string;
  certificate?: string;
};

export const PHONE_NUMBER_FIELDS = [
  "id",
  "verified_name",
  "display_phone_number",
  "quality_rating",
  "messaging_limit_tier",
  "name_status",
  "code_verification_status",
  "platform_type",
  "throughput",
  "is_official_business_account",
  "account_mode",
  "status",
] as const;

export type Paging = { cursors?: { before?: string; after?: string }; next?: string };

export type MetaTemplate = {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  sub_category?: string;
  parameter_format?: "POSITIONAL" | "NAMED";
  components: MetaTemplateComponent[];
  quality_score?: { score?: string; date?: number; reasons?: string[] | null };
  rejected_reason?: string;
  previous_category?: string;
};

export type MetaTemplateComponent =
  | {
      type: "HEADER";
      format: "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT" | "LOCATION";
      text?: string;
      example?: {
        header_text?: string[];
        header_handle?: string[];
        header_text_named_params?: Array<{ param_name: string; example: string }>;
      };
    }
  | {
      type: "BODY";
      text: string;
      example?: {
        body_text?: string[][];
        body_text_named_params?: Array<{ param_name: string; example: string }>;
      };
    }
  | { type: "FOOTER"; text: string }
  | {
      type: "BUTTONS";
      buttons: Array<
        | { type: "QUICK_REPLY"; text: string }
        | { type: "URL"; text: string; url: string; example?: string[] }
        | { type: "PHONE_NUMBER"; text: string; phone_number: string }
        | { type: "COPY_CODE"; text?: string; example?: string }
        | { type: "FLOW"; text: string; flow_id?: string }
      >;
    }
  | { type: "CAROUSEL"; cards: Array<{ components: MetaTemplateComponent[] }> }
  | { type: string; [key: string]: unknown };

export type TemplateCreateRequest = {
  name: string;
  language: string;
  category: "MARKETING" | "UTILITY" | "AUTHENTICATION";
  parameter_format?: "POSITIONAL" | "NAMED";
  components: MetaTemplateComponent[];
  allow_category_change?: boolean;
};

export type SubscribedApp = {
  whatsapp_business_api_data: { id: string; name?: string; link?: string };
};
