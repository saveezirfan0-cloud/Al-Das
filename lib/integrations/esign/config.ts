import type { Config } from "@/lib/integrations/accounts";

export type EsignConfig = {
  provider: "dropbox_sign";
  /** Test mode requests are free and not legally binding. On until an administrator turns it off. */
  testMode: boolean;
  expiryDays: number;
};

export const DROPBOX_SIGN_HOST = "api.hellosign.com";

export function readEsignConfig(config: Config): EsignConfig {
  const days = Number(config.expiry_days);
  return {
    provider: "dropbox_sign",
    testMode: config.test_mode !== "no",
    expiryDays: Number.isInteger(days) && days >= 1 && days <= 30 ? days : 7,
  };
}

/** Where the provider reports events (the account's callback address in the provider's settings). */
export function esignWebhookBase(appUrl: string, accountId: string): string {
  return `${appUrl.replace(/\/+$/, "")}/api/webhooks/integrations/esign/${accountId}`;
}
