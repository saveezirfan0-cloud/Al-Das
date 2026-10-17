import { createHash } from "node:crypto";

import { z } from "zod";

/**
 * The health-data rule for campaign audiences (docs/45 P5), as a document two people sign.
 *
 * The code already enforces the strict version (lib/campaigns/audience-purpose.ts, SQL: campaign_snapshot_segment), so
 * nothing here switches the rule on or off. The sign-off records that the clinical lead and management accepted THIS
 * wording: each signature is bound to the SHA-256 of the text, so changing the wording (a new RULE_VERSION) makes
 * every earlier signature void until it is signed again. A consent-based exception would need its own purpose and a
 * per-patient consent record; it does not exist, and signing this rule does not create one.
 */
export const CONSENT_RULE_VERSION = "2026-10-v1";

export const CONSENT_RULE_TEXT = [
  "Information about a patient's health is used for their care, not to sell to them.",
  "1. Recall and follow-up programmes may use visits, doctors, departments, diagnoses, chronic conditions and the patient's life stage.",
  '2. Marketing campaigns may not use any of that, and may not use a segment marked "care programmes only".',
  '3. A hand-picked list filled from a filter that uses health information is marked "care programmes only" automatically.',
  "4. Only an administrator can release that mark, and every release is recorded.",
  "5. Appointment doctor, department, service, notes, enquiry doctor and AI tags count as health information.",
  "6. No exception for patient consent exists yet. Adding one needs a new signed rule and a per-patient consent record.",
].join("\n");

export const SIGNER_CAPACITIES = ["clinical_lead", "management"] as const;
export type SignerCapacity = (typeof SIGNER_CAPACITIES)[number];
export const CAPACITY_LABEL: Record<SignerCapacity, string> = {
  clinical_lead: "Clinical lead",
  management: "Management",
};

export function consentRuleHash(text: string = CONSENT_RULE_TEXT): string {
  return createHash("sha256").update(`${CONSENT_RULE_VERSION}\n${text}`).digest("hex");
}

const signoffSchema = z.object({
  user_id: z.string().uuid(),
  at: z.string().min(10).max(40),
  rule_hash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ConsentSignoff = z.infer<typeof signoffSchema>;

const settingsSchema = z.object({
  clinical_lead: signoffSchema.optional(),
  management: signoffSchema.optional(),
});
export type ConsentRuleSettings = z.infer<typeof settingsSchema>;

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Reads orgs.settings.consent_rule; anything unreadable counts as no signatures (fail closed). */
export function readConsentRule(orgSettings: unknown): ConsentRuleSettings {
  const parsed = settingsSchema.safeParse(asObject(orgSettings).consent_rule ?? {});
  return parsed.success ? parsed.data : {};
}

export function writeConsentRule(
  orgSettings: unknown,
  next: ConsentRuleSettings,
): Record<string, unknown> {
  return { ...asObject(orgSettings), consent_rule: settingsSchema.parse(next) };
}

export type ConsentRuleStatus =
  | { state: "unsigned" }
  | { state: "partly_signed"; missing: SignerCapacity }
  | { state: "signed" }
  /** A signature exists but was given for other wording (or by the same person twice): it does not count. */
  | { state: "outdated"; stale: SignerCapacity[] };

/**
 * Signed means both capacities hold a signature for the CURRENT wording, given by two different people.
 * A signature for older wording counts for nothing.
 */
export function consentRuleStatus(
  settings: ConsentRuleSettings,
  hash: string = consentRuleHash(),
): ConsentRuleStatus {
  const valid = SIGNER_CAPACITIES.filter((c) => settings[c]?.rule_hash === hash);
  const stale = SIGNER_CAPACITIES.filter((c) => settings[c] && settings[c]!.rule_hash !== hash);
  if (stale.length > 0) return { state: "outdated", stale };
  if (valid.length === 0) return { state: "unsigned" };
  if (valid.length === 1)
    return {
      state: "partly_signed",
      missing: valid[0] === "clinical_lead" ? "management" : "clinical_lead",
    };
  if (settings.clinical_lead!.user_id === settings.management!.user_id)
    return { state: "outdated", stale: ["management"] };
  return { state: "signed" };
}

/** May this person add their signature in this capacity? (A second signature by the same person is refused.) */
export function signProblem(
  settings: ConsentRuleSettings,
  capacity: SignerCapacity,
  userId: string,
  hash: string = consentRuleHash(),
): string | null {
  const other: SignerCapacity = capacity === "clinical_lead" ? "management" : "clinical_lead";
  const o = settings[other];
  if (o && o.rule_hash === hash && o.user_id === userId)
    return "Two different people must sign: the clinical lead and management.";
  return null;
}
