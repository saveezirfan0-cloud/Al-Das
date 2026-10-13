"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { loadAccount, patchConfig } from "@/lib/integrations/accounts";
import { CONSENT_BASES, CONSENT_BASIS_PHRASE } from "@/lib/integrations/capi/consent";
import { createAdminClient } from "@/lib/supabase/admin";

export type ActionResult = { ok: true; message: string } | { ok: false; error: string };

const schema = z.object({
  basis: z.enum(CONSENT_BASES),
  confirm: z.string().max(80).default(""),
});

/**
 * Chooses which patients' ad events may be sent to Meta: only those who opted in to marketing messages (default), or everyone who is
 * not marked 'stop marketing' on the basis the administrator confirms here. Going to the second needs the typed sentence; who
 * confirmed and when is stored and audited. Going back to opt-in needs nothing.
 */
export async function setAdConsentBasis(input: z.input<typeof schema>): Promise<ActionResult> {
  const member = await requirePerm("integrations.manage");
  const p = schema.safeParse(input);
  if (!p.success) return { ok: false, error: "Invalid request." };
  const admin = createAdminClient(member.userId);
  const account = await loadAccount(admin, member.orgId, "meta_capi");
  if (!account) return { ok: false, error: "Save the settings first." };
  if (p.data.basis === "admin_declared" && p.data.confirm.trim() !== CONSENT_BASIS_PHRASE)
    return { ok: false, error: "Type the confirmation sentence exactly." };
  const now = new Date().toISOString();
  const saved = await patchConfig(admin, member.orgId, "meta_capi", {
    ad_attribution_consent_basis: p.data.basis,
    ad_attribution_consent_basis_at: now,
    ad_attribution_consent_basis_by: member.userId,
  });
  if (!saved.ok) return saved;
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "integration.ad_consent_basis_set",
    entity: "integration",
    entityId: "meta_capi",
    diff: { basis: p.data.basis },
  });
  revalidatePath("/settings/integrations", "layout");
  return {
    ok: true,
    message:
      p.data.basis === "admin_declared"
        ? "Recorded. Ad events may now be sent for patients who have not stopped marketing."
        : "Only patients who opted in to marketing messages will be included.",
  };
}
