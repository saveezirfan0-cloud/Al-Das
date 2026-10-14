import type { Config } from "@/lib/integrations/types";

/** Settings of the Meta ads spend integration (kind "meta_ads"), read from integration_accounts.config. Pure. */
export type MetaAdsConfig = {
  /** Digits only (the "act_" prefix is added by the adapter); "" when missing or malformed. */
  adAccountId: string;
  lookbackDays: number;
  graphVersion: string | null;
};

export const META_ADS_HOST = "graph.facebook.com";
export const DEFAULT_LOOKBACK_DAYS = 7;
export const MAX_LOOKBACK_DAYS = 28;

export function normalizeAdAccountId(raw: unknown): string {
  const text = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
  const m = /^(?:act_)?(\d{5,25})$/.exec(text);
  return m ? m[1] : "";
}

export function readMetaAdsConfig(config: Config): MetaAdsConfig {
  const days = Number(config.lookback_days);
  const version = typeof config.graph_version === "string" ? config.graph_version.trim() : "";
  return {
    adAccountId: normalizeAdAccountId(config.ad_account_id),
    lookbackDays:
      Number.isInteger(days) && days >= 1 && days <= MAX_LOOKBACK_DAYS
        ? days
        : DEFAULT_LOOKBACK_DAYS,
    graphVersion: /^v\d{1,2}\.\d$/.test(version) ? version : null,
  };
}
