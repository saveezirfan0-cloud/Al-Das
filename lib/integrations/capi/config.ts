import type { Config } from "@/lib/integrations/accounts";
import { isConsentBasis, type ConsentBasis } from "@/lib/integrations/capi/consent";

/** report_only records which ad brought each conversation and sends nothing; send_events also sends Contact, Lead and Schedule. */
export type CapiMode = "report_only" | "send_events";

export type CapiConfig = {
  mode: CapiMode;
  datasetId: string;
  graphVersion: string | null;
  testEventCode: string | null;
  windowDays: number;
  includePhone: boolean;
  consentBasis: ConsentBasis;
  consentBasisAt: string | null;
};

export const CAPI_HOST = "graph.facebook.com";

export function readCapiConfig(config: Config): CapiConfig {
  const win = Number(config.window_days);
  const version = typeof config.graph_version === "string" ? config.graph_version.trim() : "";
  const test = typeof config.test_event_code === "string" ? config.test_event_code.trim() : "";
  return {
    mode: config.mode === "send_events" ? "send_events" : "report_only",
    datasetId: String(config.dataset_id ?? "").trim(),
    graphVersion: /^v\d{1,2}\.\d$/.test(version) ? version : null,
    testEventCode: test || null,
    windowDays: Number.isInteger(win) && win >= 1 && win <= 28 ? win : 7,
    includePhone: config.include_phone === "yes",
    consentBasis: isConsentBasis(config.ad_attribution_consent_basis)
      ? config.ad_attribution_consent_basis
      : "contact_opt_in",
    consentBasisAt:
      typeof config.ad_attribution_consent_basis_at === "string"
        ? config.ad_attribution_consent_basis_at
        : null,
  };
}
