import { PAYMENT_VALUE_SOURCES, type PaymentValueSource } from "@/lib/integrations/payments/config";
import { templateVariables } from "@/lib/whatsapp/templates";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

/** The values a payment message can carry (pure). Every one is already formatted text. */
export type PaymentValueContext = Record<PaymentValueSource, string>;

/**
 * Template values from the payment variable map. Only text variables in the header or body are supported; a media header or a button
 * variable is reported in `unsupported`. Every other variable must be mapped, otherwise it is in `missing` and nothing is sent.
 */
export function paymentValues(
  components: MetaTemplateComponent[],
  variableMap: Record<string, string> | null | undefined,
  ctx: PaymentValueContext,
): { values: Record<string, string>; missing: string[]; unsupported: string[]; hasLink: boolean } {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  const unsupported: string[] = [];
  let hasLink = false;
  for (const v of templateVariables(components)) {
    if (v.kind !== "text" || v.component === "button") {
      unsupported.push(v.key);
      continue;
    }
    const source = variableMap?.[v.key];
    if (source && PAYMENT_VALUE_SOURCES.some((s) => s.key === source)) {
      values[v.key] = ctx[source as PaymentValueSource];
      if (source === "payment_link") hasLink = true;
    } else missing.push(v.key);
  }
  return { values, missing, unsupported, hasLink };
}

/** A context for checking a template mapping without any real data. */
export const PROBE_CONTEXT: PaymentValueContext = {
  first_name: "x",
  patient_first_name: "x",
  amount_due: "x",
  invoice_ref: "x",
  clinic_name: "x",
  payment_link: "x",
  expires_on: "x",
};
