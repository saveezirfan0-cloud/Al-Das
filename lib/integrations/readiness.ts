import {
  allFields,
  integrationDef,
  providerDef,
  type IntegrationKind,
} from "@/lib/integrations/catalog";

/**
 * Why an integration cannot be switched on yet (pure; empty = ready). The settings page shows these next to the switch and the
 * action that switches it on checks them again, so a stale page can never turn on a half-configured integration.
 */

export type TemplateReadiness = {
  status: string;
  category: string;
  /** Every body variable is mapped to a value. */
  mappedAll: boolean;
  /** The template has a variable mapped to the payment link. */
  hasLinkVariable: boolean;
  /** A media header or button variable, which a payment message cannot fill. */
  unsupported: boolean;
};

export type ReadinessInput = {
  kind: IntegrationKind;
  provider: string | null;
  config: Record<string, unknown>;
  secretsStored: Readonly<Record<string, boolean>>;
  /** Payments only: the WhatsApp template chosen for the payment message (null = none chosen). */
  template?: TemplateReadiness | null;
  /** Google review requests only. */
  reviews?: { template: TemplateReadiness | null; locationsWithLink: number };
};

export function readinessProblems(input: ReadinessInput): string[] {
  const def = integrationDef(input.kind);
  const problems: string[] = [];
  if (def.providers.length > 1 && !providerDef(input.kind, input.provider)) {
    return ["Choose a provider."];
  }
  for (const f of allFields(input.kind, input.provider)) {
    if (!f.required) continue;
    if (f.secret) {
      if (!input.secretsStored[f.key]) problems.push(`${f.label} is missing.`);
    } else {
      const v = input.config[f.key];
      if ((v === undefined || v === null || v === "") && f.default === undefined)
        problems.push(`${f.label} is missing.`);
    }
  }
  if (input.kind === "payments") {
    const t = input.template;
    if (!t) problems.push("Choose the WhatsApp template used for the payment message.");
    else {
      if (t.status !== "APPROVED") problems.push("The payment template is not approved by Meta.");
      if (t.category !== "UTILITY")
        problems.push("The payment template must be in the Utility category.");
      if (t.unsupported)
        problems.push(
          "The payment template has a media header or a button variable, which cannot be filled.",
        );
      if (!t.mappedAll) problems.push("Map every variable of the payment template.");
      if (!t.hasLinkVariable)
        problems.push("Map one variable of the payment template to the payment link.");
    }
  }
  if (input.kind === "meta_capi" && input.config.mode === "send_events") {
    if (!String(input.config.dataset_id ?? "").trim()) problems.push("Dataset ID is missing.");
    if (!input.secretsStored.access_token) problems.push("Access token is missing.");
  }
  if (input.kind === "google_reviews") {
    const r = input.reviews;
    const t = r?.template ?? null;
    if (!t) problems.push("Choose the WhatsApp template used for the review request.");
    else {
      if (t.status !== "APPROVED") problems.push("The review template is not approved by Meta.");
      if (t.unsupported)
        problems.push(
          "The review template has a media header or a button variable, which cannot be filled.",
        );
      if (!t.mappedAll) problems.push("Map every variable of the review template.");
      if (!t.hasLinkVariable)
        problems.push("Map one variable of the review template to the review link.");
    }
    if (!r || r.locationsWithLink < 1)
      problems.push("Add the Google review link of at least one location.");
  }
  return problems;
}

/** The exact words a person types to switch an integration on, or null when none are needed. */
export function confirmationFor(kind: IntegrationKind): string | null {
  return integrationDef(kind).confirmWord;
}

export function confirmationMatches(kind: IntegrationKind, typed: string): boolean {
  const word = confirmationFor(kind);
  return word === null || typed.trim() === word;
}
