import "server-only";

import { readDocumentSettings } from "@/lib/documents/settings";
import { loadAccount, readSecrets, type AccountView } from "@/lib/integrations/accounts";
import type { IntegrationKind } from "@/lib/integrations/catalog";
import { readPaymentsConfig } from "@/lib/integrations/payments/config";
import { loadPaymentTemplate, templateReadiness } from "@/lib/integrations/payments/request-server";
import type { ReadinessInput } from "@/lib/integrations/readiness";
import { readReviewConfig } from "@/lib/integrations/reviews/config";
import {
  countLocationsWithLink,
  loadReviewTemplate,
  reviewTemplateReadiness,
} from "@/lib/integrations/reviews/server";
import { checkSealSecrets } from "@/lib/signing/seal";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Everything readinessProblems() needs that lives in the database (the chosen WhatsApp template, locations with a link, ...), for the
 * settings page and for the action that switches an integration on, so the two can never disagree.
 */
export async function loadReadinessInput(
  admin: AdminClient,
  orgId: string,
  kind: IntegrationKind,
  view: AccountView,
): Promise<ReadinessInput> {
  const base: ReadinessInput = {
    kind,
    provider: view.provider,
    config: view.config,
    secretsStored: view.secretsStored,
  };
  if (kind === "payments") {
    const cfg = readPaymentsConfig(view.config);
    return {
      ...base,
      template: templateReadiness(await loadPaymentTemplate(admin, orgId, cfg.templateId), cfg),
    };
  }
  if (kind === "google_reviews") {
    const cfg = readReviewConfig(view.config);
    const [template, locationsWithLink] = await Promise.all([
      loadReviewTemplate(admin, orgId, cfg.templateId),
      countLocationsWithLink(admin, orgId),
    ]);
    return {
      ...base,
      reviews: { template: reviewTemplateReadiness(template, cfg), locationsWithLink },
    };
  }
  if (kind === "document_seal") {
    if (!view.secretsStored.certificate || !view.secretsStored.passphrase) return base;
    // Opens the stored .p12 with its password (in memory only) and checks validity and key usage.
    const check = checkSealSecrets(readSecrets(await loadAccount(admin, orgId, kind)), new Date());
    return { ...base, seal: { problems: check.ok ? [] : check.problems } };
  }
  if (kind === "esign") {
    const { data } = await admin.from("orgs").select("settings").eq("id", orgId).maybeSingle();
    return { ...base, documentsEnabled: readDocumentSettings(data?.settings).enabled };
  }
  return base;
}
