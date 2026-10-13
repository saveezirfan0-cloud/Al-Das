import type { Config } from "@/lib/integrations/accounts";

/** The non-secret SMS settings, with the defaults the catalogue declares. */
export type SmsConfig = {
  provider: string;
  sender: string;
  accountSid: string;
  clinicName: string;
  callbackPhone: string;
  ratePerSec: number;
  dailyCap: number;
  /** Optional price of one message part, for the estimated spend. */
  segmentPrice: number | null;
};

const num = (v: unknown, fallback: number) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

export function readSmsConfig(config: Config): SmsConfig {
  const price = Number(config.segment_price);
  return {
    provider: typeof config.provider === "string" ? config.provider : "twilio",
    sender: String(config.sender ?? ""),
    accountSid: String(config.account_sid ?? ""),
    clinicName: String(config.clinic_name ?? ""),
    callbackPhone: String(config.callback_phone ?? ""),
    ratePerSec: num(config.rate_per_sec, 5),
    dailyCap: num(config.daily_cap, 200),
    segmentPrice: Number.isFinite(price) && price > 0 ? price : null,
  };
}

/** Where the provider reports delivery. The sms id travels in the query string so a receipt that races our own update still matches. */
export function smsCallbackBase(appUrl: string, accountId: string): string {
  return `${appUrl.replace(/\/+$/, "")}/api/webhooks/integrations/sms/${accountId}`;
}

export function smsCallbackUrl(appUrl: string, accountId: string, smsId: string): string {
  return `${smsCallbackBase(appUrl, accountId)}?m=${smsId}`;
}
