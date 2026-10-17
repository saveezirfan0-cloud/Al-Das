import { describe, expect, it } from "vitest";

import {
  CONSENT_RULE_TEXT,
  consentRuleHash,
  consentRuleStatus,
  readConsentRule,
  signProblem,
  writeConsentRule,
} from "@/lib/campaigns/consent-rule";

const HASH = consentRuleHash();
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const sig = (user_id: string, rule_hash = HASH) => ({
  user_id,
  at: "2026-10-17T09:00:00Z",
  rule_hash,
});

describe("health-data rule sign-off", () => {
  it("is unsigned until both capacities sign the current wording", () => {
    expect(consentRuleStatus({})).toEqual({ state: "unsigned" });
    expect(consentRuleStatus({ clinical_lead: sig(A) })).toEqual({
      state: "partly_signed",
      missing: "management",
    });
    expect(consentRuleStatus({ management: sig(B) })).toEqual({
      state: "partly_signed",
      missing: "clinical_lead",
    });
    expect(consentRuleStatus({ clinical_lead: sig(A), management: sig(B) })).toEqual({
      state: "signed",
    });
  });

  it("a signature for other wording does not count", () => {
    const old = "0".repeat(64);
    expect(consentRuleStatus({ clinical_lead: sig(A, old), management: sig(B) })).toEqual({
      state: "outdated",
      stale: ["clinical_lead"],
    });
  });

  it("the same person cannot be both signers", () => {
    expect(consentRuleStatus({ clinical_lead: sig(A), management: sig(A) }).state).toBe("outdated");
    expect(signProblem({ clinical_lead: sig(A) }, "management", A)).toMatch(/Two different people/);
    expect(signProblem({ clinical_lead: sig(A) }, "management", B)).toBeNull();
    // Their earlier signature for old wording does not block them signing the new wording.
    expect(signProblem({ clinical_lead: sig(A, "0".repeat(64)) }, "management", A)).toBeNull();
  });

  it("the fingerprint follows the wording", () => {
    expect(consentRuleHash()).toBe(consentRuleHash(CONSENT_RULE_TEXT));
    expect(consentRuleHash(CONSENT_RULE_TEXT + " ")).not.toBe(HASH);
  });

  it("reads and writes the org settings block, keeping other keys, failing closed on junk", () => {
    const written = writeConsentRule(
      { lifecycle: { newPatientDays: 90 } },
      { clinical_lead: sig(A) },
    );
    expect(written.lifecycle).toEqual({ newPatientDays: 90 });
    expect(readConsentRule(written)).toEqual({ clinical_lead: sig(A) });
    expect(readConsentRule({ consent_rule: { clinical_lead: { user_id: "x" } } })).toEqual({});
    expect(readConsentRule(null)).toEqual({});
    expect(consentRuleStatus(readConsentRule("junk"))).toEqual({ state: "unsigned" });
  });
});
