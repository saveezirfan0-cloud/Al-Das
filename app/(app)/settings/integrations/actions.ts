"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import {
  loadAccount,
  loadView,
  patchConfig,
  readSecrets,
  recordFailure,
  recordOk,
  saveSettings,
  setEnabled,
} from "@/lib/integrations/accounts";
import {
  allFields,
  integrationDef,
  isIntegrationKind,
  providerDef,
  validateFields,
} from "@/lib/integrations/catalog";
import { extraValidation } from "@/lib/integrations/extra-validate";
import { PAYMENT_VALUE_SOURCES } from "@/lib/integrations/payments/config";
import { PROBE_CONTEXT, paymentValues } from "@/lib/integrations/payments/message";
import { buildPaymentProvider } from "@/lib/integrations/payments/provider";
import { loadPaymentTemplate } from "@/lib/integrations/payments/request-server";
import { confirmationMatches, readinessProblems } from "@/lib/integrations/readiness";
import { loadReadinessInput } from "@/lib/integrations/readiness-server";
import { buildCapiClientFor } from "@/lib/integrations/capi/server";
import { clearAllBusyBlocks } from "@/lib/integrations/gcal/server";
import { buildMessagingClientFor } from "@/lib/integrations/meta-messaging/server";
import { buildSmsProvider } from "@/lib/integrations/sms/provider";
import { buildEsignProvider } from "@/lib/integrations/esign/server";
import { buildTelehealthProvider } from "@/lib/integrations/telehealth/server";
import { checkRateLimit, RATE_RULES, waitText } from "@/lib/rate-limit";
import { checkSealSecrets } from "@/lib/signing/seal";
import { createAdminClient } from "@/lib/supabase/admin";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

export type ActionResult = { ok: true; message: string } | { ok: false; error: string };

const kindSchema = z.string().refine(isIntegrationKind, "Unknown integration");

const saveSchema = z.object({
  kind: kindSchema,
  provider: z.string().max(40).nullable(),
  values: z.record(z.string(), z.union([z.string(), z.number()])),
});

/** Saves credentials and settings. Secret fields left blank keep their stored value. Does not switch anything on. */
export async function saveIntegrationSettings(
  input: z.input<typeof saveSchema>,
): Promise<ActionResult> {
  const member = await requirePerm("integrations.manage");
  const p = saveSchema.safeParse(input);
  if (!p.success || !isIntegrationKind(p.data.kind))
    return { ok: false, error: "Invalid request." };
  const kind = p.data.kind;
  const def = integrationDef(kind);
  const providerId = def.providers.length === 1 ? def.providers[0].id : p.data.provider;
  if (!providerDef(kind, providerId)) return { ok: false, error: "Choose a provider." };

  const admin = createAdminClient(member.userId);
  const view = await loadView(admin, member.orgId, kind);
  const sameProvider = view.provider === providerId;
  const checked = validateFields(
    allFields(kind, providerId),
    p.data.values,
    sameProvider ? view.secretsStored : {},
  );
  if (!checked.ok) return { ok: false, error: checked.error };
  const extra = extraValidation(kind, providerId, checked.config);
  if (extra) return { ok: false, error: extra };
  if (kind === "document_seal") {
    // A certificate that cannot be opened with its password is refused now (expiry and key usage show as readiness problems).
    const stored = sameProvider ? readSecrets(await loadAccount(admin, member.orgId, kind)) : {};
    const merged = { ...stored, ...checked.secrets };
    if (merged.certificate && merged.passphrase) {
      const seal = checkSealSecrets(merged, new Date());
      if (!seal.ok && seal.info === null) return { ok: false, error: seal.problems[0] };
    }
  }
  const saved = await saveSettings(admin, {
    orgId: member.orgId,
    kind,
    provider: providerId,
    secrets: checked.secrets,
    config: checked.config,
  });
  if (!saved.ok) return saved;
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "integration.settings_saved",
    entity: "integration",
    entityId: kind,
    // Field names only: never a value, and never a secret.
    diff: {
      provider: providerId,
      fields: Object.keys(checked.config),
      secrets_changed: Object.keys(checked.secrets),
    },
  });
  revalidatePath("/settings/integrations", "layout");
  return { ok: true, message: "Saved." };
}

const enableSchema = z.object({
  kind: kindSchema,
  enabled: z.boolean(),
  confirm: z.string().max(60).default(""),
});

/** Switches an integration on or off. Switching on anything that messages patients or takes money needs the typed words. */
export async function setIntegrationEnabled(
  input: z.input<typeof enableSchema>,
): Promise<ActionResult> {
  const member = await requirePerm("integrations.manage");
  const p = enableSchema.safeParse(input);
  if (!p.success || !isIntegrationKind(p.data.kind))
    return { ok: false, error: "Invalid request." };
  const { kind, enabled } = p.data;
  const admin = createAdminClient(member.userId);

  if (enabled) {
    const view = await loadView(admin, member.orgId, kind);
    const problems = readinessProblems(await loadReadinessInput(admin, member.orgId, kind, view));
    if (problems.length > 0) return { ok: false, error: problems[0] };
    if (!confirmationMatches(kind, p.data.confirm))
      return { ok: false, error: "Type the confirmation words exactly to switch this on." };
  }
  const done = await setEnabled(admin, {
    orgId: member.orgId,
    kind,
    userId: member.userId,
    enabled,
  });
  if (!done.ok) return done;
  // Phase 20e: busy times mirrored from Google must not keep blocking bookings once the sync is off.
  if (!enabled && kind === "google_calendar") await clearAllBusyBlocks(admin, member.orgId);
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: enabled ? "integration.enabled" : "integration.disabled",
    entity: "integration",
    entityId: kind,
  });
  revalidatePath("/settings/integrations", "layout");
  return { ok: true, message: enabled ? "Switched on." : "Switched off." };
}

/** A read-only call that proves the saved credentials work. Never sends a message or creates a payment. */
export async function testIntegration(kindInput: string): Promise<ActionResult> {
  const member = await requirePerm("integrations.manage");
  if (!isIntegrationKind(kindInput)) return { ok: false, error: "Invalid request." };
  const kind = kindInput;
  const admin = createAdminClient(member.userId);
  const limit = await checkRateLimit(
    admin,
    "integration-test",
    member.userId,
    RATE_RULES.integrationTestPerUser,
  );
  if (!limit.allowed)
    return { ok: false, error: `Too many tests. Try again in ${waitText(limit.retryAfter)}.` };
  const account = await loadAccount(admin, member.orgId, kind);
  if (!account) return { ok: false, error: "Save the settings first." };

  let result: { ok: boolean; code?: string } | null = null;
  if (kind === "sms")
    result = (await buildSmsProvider(admin, account)?.verify()) ?? {
      ok: false,
      code: "incomplete",
    };
  else if (kind === "payments") {
    const provider = buildPaymentProvider(admin, account);
    result = !provider
      ? { ok: false, code: "incomplete" }
      : provider.verify
        ? await provider.verify()
        : { ok: false, code: "unsupported" };
  } else if (kind === "meta_capi") {
    result = (await buildCapiClientFor(admin, account)?.verify()) ?? {
      ok: false,
      code: "incomplete",
    };
  } else if (kind === "esign") {
    result = (await buildEsignProvider(admin, account)?.verify()) ?? {
      ok: false,
      code: "incomplete",
    };
  } else if (kind === "telehealth") {
    const provider = buildTelehealthProvider(admin, account);
    result = provider?.verify ? await provider.verify() : { ok: false, code: "incomplete" };
  } else if (kind === "instagram" || kind === "messenger") {
    result = (await buildMessagingClientFor(admin, account, kind)?.verify()) ?? {
      ok: false,
      code: "incomplete",
    };
  } else return { ok: false, error: "Nothing to test for this integration." };

  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "integration.tested",
    entity: "integration",
    entityId: kind,
    diff: { ok: result.ok, code: result.code ?? null },
  });
  if (result.code === "unsupported")
    return {
      ok: false,
      error:
        kind === "sms"
          ? "There is no safe test without a check address (a test send would text someone). Add the gateway's read-only check address, or send a test from the gateway's own dashboard to a number the clinic owns."
          : "This gateway has no safe test call. Create a small payment in the gateway's test mode instead.",
    };
  if (result.ok) {
    if (account.enabled) await recordOk(admin, member.orgId, kind);
    return { ok: true, message: "The provider accepted the credentials." };
  }
  if (account.enabled)
    await recordFailure(admin, member.orgId, kind, `test failed ${result.code ?? ""}`);
  return {
    ok: false,
    error:
      result.code === "auth"
        ? "The provider rejected the credentials."
        : "The provider could not be reached or did not accept the request.",
  };
}

const templateSchema = z.object({
  templateId: z.string().uuid().nullable(),
  variableMap: z.record(z.string().max(40), z.string().max(40)),
});

/** Chooses the WhatsApp template used for payment messages and maps its variables. */
export async function savePaymentTemplate(
  input: z.input<typeof templateSchema>,
): Promise<ActionResult> {
  const member = await requirePerm("integrations.manage");
  const p = templateSchema.safeParse(input);
  if (!p.success) return { ok: false, error: "Invalid request." };
  const admin = createAdminClient(member.userId);
  const known = new Set<string>(PAYMENT_VALUE_SOURCES.map((s) => s.key));
  const map: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.data.variableMap)) if (v && known.has(v)) map[k] = v;
  if (p.data.templateId) {
    const tpl = await loadPaymentTemplate(admin, member.orgId, p.data.templateId);
    if (!tpl) return { ok: false, error: "Template not found." };
    // keep only variables the template actually has
    const probe = paymentValues(tpl.components as MetaTemplateComponent[], map, PROBE_CONTEXT);
    for (const k of Object.keys(map)) if (!(k in probe.values)) delete map[k];
  }
  const saved = await patchConfig(admin, member.orgId, "payments", {
    template_id: p.data.templateId,
    variable_map: p.data.templateId ? JSON.stringify(map) : null,
  });
  if (!saved.ok) return saved;
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "integration.payment_template_saved",
    entity: "integration",
    entityId: "payments",
    diff: { template_id: p.data.templateId, mapped: Object.keys(map).length },
  });
  revalidatePath("/settings/integrations", "layout");
  return { ok: true, message: "Template saved." };
}
