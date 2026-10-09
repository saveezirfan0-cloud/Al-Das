/**
 * Typed WhatsApp Cloud API client. One instance per (token, phone_number_id).
 * fetch is injectable for tests. Every call maps Graph errors to WhatsAppApiError.
 * Never log the token, recipient numbers or message bodies from here.
 */
import { WhatsAppApiError, type GraphErrorBody } from "@/lib/whatsapp/errors";
import {
  BUSINESS_PROFILE_FIELDS,
  PHONE_NUMBER_FIELDS,
  type BusinessProfile,
  type ContactObject,
  type InteractiveObject,
  type LocationObject,
  type MarkReadRequest,
  type MediaInfo,
  type MediaObject,
  type MediaRef,
  type MediaType,
  type MediaUploadResult,
  type MetaTemplate,
  type OutboundMessage,
  type Paging,
  type PhoneNumberInfo,
  type SendResult,
  type SubscribedApp,
  type TemplateCreateRequest,
  type TemplateObject,
} from "@/lib/whatsapp/types";

export const DEFAULT_GRAPH_VERSION = "v21.0";

export type WhatsAppClientOptions = {
  accessToken: string;
  phoneNumberId?: string;
  wabaId?: string;
  graphVersion?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Per-request timeout in ms (default 20s). */
  timeoutMs?: number;
};

type RequestOptions = {
  method?: "GET" | "POST" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  json?: unknown;
  form?: FormData;
  /** Override the token (e.g. a WABA-level call with a different token). */
  token?: string;
};

export type SendOptions = { replyTo?: string; callbackData?: string };

export class WhatsAppClient {
  private readonly token: string;
  private readonly phoneNumberId?: string;
  private readonly wabaId?: string;
  private readonly version: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: WhatsAppClientOptions) {
    if (!opts.accessToken) throw new Error("WhatsAppClient: accessToken is required");
    this.token = opts.accessToken;
    this.phoneNumberId = opts.phoneNumberId;
    this.wabaId = opts.wabaId;
    this.version = opts.graphVersion ?? process.env.META_GRAPH_VERSION ?? DEFAULT_GRAPH_VERSION;
    this.baseUrl = (opts.baseUrl ?? "https://graph.facebook.com").replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  // ---------------------------------------------------------------------------
  // Core
  // ---------------------------------------------------------------------------

  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}/${this.version}/${path.replace(/^\//, "")}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${opts.token ?? this.token}` };
    let body: BodyInit | undefined;
    if (opts.form) {
      body = opts.form;
    } else if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.json);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: opts.method ?? (body ? "POST" : "GET"),
        headers,
        body,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      // Network failure / timeout: treat as transient.
      throw new WhatsAppApiError(
        503,
        { error: { message: err instanceof Error ? err.message : "network error", code: 2 } },
        "network error",
      );
    }
    clearTimeout(timer);
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (!res.ok) {
      throw new WhatsAppApiError(res.status, (parsed as GraphErrorBody) ?? null);
    }
    return parsed as T;
  }

  private phonePath(suffix: string): string {
    if (!this.phoneNumberId)
      throw new Error("WhatsAppClient: phoneNumberId is required for this call");
    return `${this.phoneNumberId}/${suffix}`;
  }

  private wabaPath(suffix: string, wabaId = this.wabaId): string {
    if (!wabaId) throw new Error("WhatsAppClient: wabaId is required for this call");
    return `${wabaId}/${suffix}`;
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  sendMessage(message: OutboundMessage): Promise<SendResult> {
    return this.request<SendResult>(this.phonePath("messages"), { json: message });
  }

  private recipient(to: string, opts?: SendOptions) {
    return {
      messaging_product: "whatsapp" as const,
      recipient_type: "individual" as const,
      to,
      ...(opts?.replyTo ? { context: { message_id: opts.replyTo } } : {}),
      ...(opts?.callbackData ? { biz_opaque_callback_data: opts.callbackData } : {}),
    };
  }

  sendText(to: string, body: string, opts?: SendOptions & { previewUrl?: boolean }) {
    return this.sendMessage({
      ...this.recipient(to, opts),
      type: "text",
      text: { body, preview_url: opts?.previewUrl ?? false },
    });
  }

  sendMedia(to: string, type: MediaType, media: MediaObject, opts?: SendOptions) {
    const b = this.recipient(to, opts);
    switch (type) {
      case "image":
        return this.sendMessage({ ...b, type, image: media });
      case "video":
        return this.sendMessage({ ...b, type, video: media });
      case "document":
        return this.sendMessage({ ...b, type, document: media });
      case "audio":
        return this.sendMessage({ ...b, type, audio: stripCaption(media) });
      case "sticker":
        return this.sendMessage({ ...b, type, sticker: stripCaption(media) });
    }
  }

  sendInteractive(to: string, interactive: InteractiveObject, opts?: SendOptions) {
    return this.sendMessage({ ...this.recipient(to, opts), type: "interactive", interactive });
  }

  sendTemplate(to: string, template: TemplateObject, opts?: SendOptions) {
    return this.sendMessage({ ...this.recipient(to, opts), type: "template", template });
  }

  sendReaction(to: string, messageId: string, emoji: string) {
    return this.sendMessage({
      ...this.recipient(to),
      type: "reaction",
      reaction: { message_id: messageId, emoji },
    });
  }

  sendLocation(to: string, location: LocationObject, opts?: SendOptions) {
    return this.sendMessage({ ...this.recipient(to, opts), type: "location", location });
  }

  sendContacts(to: string, contacts: ContactObject[], opts?: SendOptions) {
    return this.sendMessage({ ...this.recipient(to, opts), type: "contacts", contacts });
  }

  /** Mark an inbound message as read; optionally show the typing indicator (auto-clears in 25s). */
  markRead(messageId: string, opts: { typing?: boolean } = {}): Promise<{ success: boolean }> {
    const body: MarkReadRequest = {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
      ...(opts.typing ? { typing_indicator: { type: "text" } } : {}),
    };
    return this.request(this.phonePath("messages"), { json: body });
  }

  // ---------------------------------------------------------------------------
  // Media
  // ---------------------------------------------------------------------------

  async uploadMedia(file: {
    data: Blob | ArrayBuffer | Uint8Array;
    mimeType: string;
    filename?: string;
  }): Promise<MediaUploadResult> {
    const form = new FormData();
    form.set("messaging_product", "whatsapp");
    form.set("type", file.mimeType);
    const blob =
      file.data instanceof Blob
        ? file.data
        : new Blob([file.data instanceof Uint8Array ? new Uint8Array(file.data) : file.data], {
            type: file.mimeType,
          });
    form.set("file", blob, file.filename ?? "upload");
    return this.request<MediaUploadResult>(this.phonePath("media"), { form });
  }

  getMediaInfo(mediaId: string): Promise<MediaInfo> {
    return this.request<MediaInfo>(mediaId, {
      query: this.phoneNumberId ? { phone_number_id: this.phoneNumberId } : {},
    });
  }

  /** Download media bytes from the short-lived URL returned by getMediaInfo (requires the bearer token). */
  async downloadMedia(url: string): Promise<{ bytes: Uint8Array; mimeType: string | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs * 3);
    try {
      const res = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: controller.signal,
      });
      if (!res.ok) {
        let body: GraphErrorBody | null = null;
        try {
          body = (await res.json()) as GraphErrorBody;
        } catch {
          body = null;
        }
        throw new WhatsAppApiError(
          res.status,
          body ?? { error: { message: "media download failed", code: 131052 } },
        );
      }
      return {
        bytes: new Uint8Array(await res.arrayBuffer()),
        mimeType: res.headers.get("content-type"),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  deleteMedia(mediaId: string): Promise<{ success: boolean }> {
    return this.request(mediaId, {
      method: "DELETE",
      query: this.phoneNumberId ? { phone_number_id: this.phoneNumberId } : {},
    });
  }

  // ---------------------------------------------------------------------------
  // Business profile & phone number
  // ---------------------------------------------------------------------------

  async getBusinessProfile(): Promise<BusinessProfile> {
    const res = await this.request<{ data: BusinessProfile[] }>(
      this.phonePath("whatsapp_business_profile"),
      {
        query: { fields: BUSINESS_PROFILE_FIELDS.join(",") },
      },
    );
    return res.data?.[0] ?? {};
  }

  updateBusinessProfile(profile: BusinessProfile): Promise<{ success: boolean }> {
    return this.request(this.phonePath("whatsapp_business_profile"), {
      json: { messaging_product: "whatsapp", ...profile },
    });
  }

  getPhoneNumber(fields: readonly string[] = PHONE_NUMBER_FIELDS): Promise<PhoneNumberInfo> {
    if (!this.phoneNumberId)
      throw new Error("WhatsAppClient: phoneNumberId is required for this call");
    return this.request<PhoneNumberInfo>(this.phoneNumberId, {
      query: { fields: fields.join(",") },
    });
  }

  listPhoneNumbers(wabaId = this.wabaId): Promise<{ data: PhoneNumberInfo[]; paging?: Paging }> {
    return this.request(this.wabaPath("phone_numbers", wabaId), {
      query: { fields: PHONE_NUMBER_FIELDS.join(",") },
    });
  }

  // ---------------------------------------------------------------------------
  // Webhook subscription (WABA-level)
  // ---------------------------------------------------------------------------

  getSubscribedApps(wabaId = this.wabaId): Promise<{ data: SubscribedApp[] }> {
    return this.request(this.wabaPath("subscribed_apps", wabaId));
  }

  subscribeApp(wabaId = this.wabaId): Promise<{ success: boolean }> {
    return this.request(this.wabaPath("subscribed_apps", wabaId), { method: "POST", json: {} });
  }

  unsubscribeApp(wabaId = this.wabaId): Promise<{ success: boolean }> {
    return this.request(this.wabaPath("subscribed_apps", wabaId), { method: "DELETE" });
  }

  // ---------------------------------------------------------------------------
  // Templates (WABA-level)
  // ---------------------------------------------------------------------------

  listTemplates(
    opts: { wabaId?: string; limit?: number; after?: string; status?: string; name?: string } = {},
  ): Promise<{ data: MetaTemplate[]; paging?: Paging }> {
    return this.request(this.wabaPath("message_templates", opts.wabaId), {
      query: {
        fields:
          "id,name,language,status,category,sub_category,parameter_format,components,quality_score,rejected_reason,previous_category",
        limit: opts.limit ?? 100,
        after: opts.after,
        status: opts.status,
        name: opts.name,
      },
    });
  }

  /** Walks every page. */
  async listAllTemplates(wabaId = this.wabaId): Promise<MetaTemplate[]> {
    const all: MetaTemplate[] = [];
    let after: string | undefined;
    for (let page = 0; page < 50; page++) {
      const res = await this.listTemplates({ wabaId, after });
      all.push(...(res.data ?? []));
      after = res.paging?.cursors?.after;
      if (!after || !res.paging?.next) break;
    }
    return all;
  }

  getTemplate(templateId: string): Promise<MetaTemplate> {
    return this.request<MetaTemplate>(templateId, {
      query: {
        fields:
          "id,name,language,status,category,parameter_format,components,quality_score,rejected_reason",
      },
    });
  }

  createTemplate(
    body: TemplateCreateRequest,
    wabaId = this.wabaId,
  ): Promise<{ id: string; status: string; category: string }> {
    return this.request(this.wabaPath("message_templates", wabaId), { json: body });
  }

  updateTemplate(
    templateId: string,
    body: Partial<Pick<TemplateCreateRequest, "components" | "category">>,
  ): Promise<{ success: boolean }> {
    return this.request(templateId, { json: body });
  }

  deleteTemplate(
    name: string,
    opts: { wabaId?: string; hsmId?: string } = {},
  ): Promise<{ success: boolean }> {
    return this.request(this.wabaPath("message_templates", opts.wabaId), {
      method: "DELETE",
      query: { name, hsm_id: opts.hsmId },
    });
  }
}

function stripCaption(media: MediaObject): MediaRef {
  return media.id !== undefined ? { id: media.id } : { link: media.link };
}
