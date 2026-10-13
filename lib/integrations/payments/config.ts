import type { Config } from "@/lib/integrations/accounts";

/** The non-secret payment settings. The WhatsApp template and its variable map are set by the payments panel, not the generic form. */
export type PaymentsConfig = {
  provider: "stripe" | "paytabs";
  currency: string;
  expiryHours: number;
  returnUrl: string | null;
  profileId: string;
  regionHost: string;
  templateId: string | null;
  /** {"body.1": "first_name", ...}: which value fills which template variable. */
  variableMap: Record<string, string>;
};

export const PAYMENT_VALUE_SOURCES = [
  { key: "first_name", label: "First name of the person receiving the message" },
  { key: "patient_first_name", label: "First name of the patient" },
  { key: "amount_due", label: "Amount (for example AED 150.00)" },
  { key: "invoice_ref", label: "Invoice number" },
  { key: "clinic_name", label: "Clinic name" },
  { key: "payment_link", label: "The payment link" },
  { key: "expires_on", label: "Date the link expires" },
] as const;
export type PaymentValueSource = (typeof PAYMENT_VALUE_SOURCES)[number]["key"];

export function parseVariableMap(raw: unknown): Record<string, string> {
  if (typeof raw !== "string" || !raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && PAYMENT_VALUE_SOURCES.some((s) => s.key === v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function readPaymentsConfig(config: Config): PaymentsConfig {
  const hours = Number(config.link_expiry_hours);
  return {
    provider: config.provider === "paytabs" ? "paytabs" : "stripe",
    currency: typeof config.currency === "string" && config.currency ? config.currency : "AED",
    expiryHours: Number.isInteger(hours) && hours >= 1 && hours <= 24 ? hours : 24,
    returnUrl:
      typeof config.return_url === "string" && config.return_url ? config.return_url : null,
    profileId: String(config.profile_id ?? ""),
    regionHost:
      typeof config.region_host === "string" && config.region_host
        ? config.region_host
        : "secure.paytabs.com",
    templateId:
      typeof config.template_id === "string" && config.template_id ? config.template_id : null,
    variableMap: parseVariableMap(config.variable_map),
  };
}

export function paymentWebhookBase(appUrl: string, accountId: string): string {
  return `${appUrl.replace(/\/+$/, "")}/api/webhooks/integrations/payments/${accountId}`;
}

export function paymentReturnUrl(appUrl: string, configured: string | null): string {
  return configured ?? `${appUrl.replace(/\/+$/, "")}/pay/done`;
}
