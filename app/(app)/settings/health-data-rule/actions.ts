"use server";

import { revalidatePath } from "next/cache";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import {
  consentRuleHash,
  readConsentRule,
  SIGNER_CAPACITIES,
  signProblem,
  writeConsentRule,
  type SignerCapacity,
} from "@/lib/campaigns/consent-rule";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

export type HealthRuleResult = { ok: true; message: string } | { ok: false; error: string };

/**
 * Adds or withdraws the signature of the clinical lead or of management on the current wording of the health-data
 * rule. The signature is the signed-in person's own (never typed for someone else) and is bound to the wording's hash.
 */
export async function signHealthDataRuleAction(input: {
  capacity: SignerCapacity;
  withdraw?: boolean;
  confirm: string;
}): Promise<HealthRuleResult> {
  const member = await requirePerm("settings.manage");
  if (!SIGNER_CAPACITIES.includes(input.capacity))
    return { ok: false, error: "Choose who is signing." };
  if (!input.withdraw && input.confirm.trim().toUpperCase() !== "SIGN")
    return { ok: false, error: "Type SIGN to confirm." };
  const admin = createAdminClient(member.userId);
  const { data: org } = await admin.from("orgs").select("settings").eq("id", member.orgId).single();
  const current = readConsentRule(org?.settings);
  const hash = consentRuleHash();
  const next = { ...current };
  if (input.withdraw) {
    delete next[input.capacity];
  } else {
    const problem = signProblem(current, input.capacity, member.userId, hash);
    if (problem) return { ok: false, error: problem };
    next[input.capacity] = {
      user_id: member.userId,
      at: new Date().toISOString(),
      rule_hash: hash,
    };
  }
  const { error } = await admin
    .from("orgs")
    .update({ settings: writeConsentRule(org?.settings, next) as NonNullable<Json> })
    .eq("id", member.orgId);
  if (error) return { ok: false, error: "Could not save the signature." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: input.withdraw ? "health_rule.signature_withdrawn" : "health_rule.signed",
    entity: "org",
    entityId: member.orgId,
    diff: { capacity: input.capacity, rule_hash: hash } as Json,
  });
  revalidatePath("/settings/health-data-rule");
  return { ok: true, message: input.withdraw ? "Signature withdrawn." : "Signed." };
}
