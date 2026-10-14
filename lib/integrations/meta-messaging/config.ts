import type { Config } from "@/lib/integrations/types";

/**
 * Settings of the Instagram and Messenger integrations (Phase 20e, G12). Both use the Messenger Platform on Meta's Graph API with a
 * Page access token: Messenger messages are sent from the Facebook Page, Instagram messages from the Instagram professional account
 * linked to that Page. Shapes come from Meta's documentation and are NOT verified against a live account.
 */
export type MessagingPlatform = "instagram" | "messenger";

export const META_MESSAGING_HOST = "graph.facebook.com";
export const DEFAULT_GRAPH_VERSION = "v21.0";

export type MessagingConfig = {
  platform: MessagingPlatform;
  /** The Facebook Page that sends (both platforms). */
  pageId: string;
  /** The id Meta puts in `recipient.id` / `entry.id` of inbound events: the Page id (Messenger) or the Instagram account id. */
  recipientId: string;
  graphVersion: string;
};

const ID_RE = /^\d{5,25}$/;

export function readMessagingConfig(
  platform: MessagingPlatform,
  config: Config,
  fallbackVersion: string = DEFAULT_GRAPH_VERSION,
): MessagingConfig | null {
  const pageId = String(config.page_id ?? "").trim();
  const ig = String(config.ig_account_id ?? "").trim();
  const version = String(config.graph_version ?? "").trim();
  if (!ID_RE.test(pageId)) return null;
  if (platform === "instagram" && !ID_RE.test(ig)) return null;
  return {
    platform,
    pageId,
    recipientId: platform === "instagram" ? ig : pageId,
    graphVersion: /^v\d{1,2}\.\d$/.test(version)
      ? version
      : /^v\d{1,2}\.\d$/.test(fallbackVersion)
        ? fallbackVersion
        : DEFAULT_GRAPH_VERSION,
  };
}

/** The callback address an administrator gives Meta (App dashboard, Webhooks, the Page or Instagram object). */
export function messagingWebhookBase(
  appUrl: string,
  platform: MessagingPlatform,
  accountId: string,
): string {
  return `${appUrl.replace(/\/+$/, "")}/api/webhooks/integrations/${platform}/${accountId}`;
}

/** The provider name written to integration_calls (and counted by CALL_PROVIDERS). */
export function messagingProvider(platform: MessagingPlatform): string {
  return platform;
}
