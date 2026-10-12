import { describe, expect, it } from "vitest";

import type { Llm, LlmRequest } from "@/lib/ai/llm";
import { appealSystemPrompt } from "@/lib/ai/prompts/appeal";
import {
  appealUserPrompt,
  draftAppeal,
  DRAFT_BANNER,
  finalizeAiDraft,
  templateAppealLetter,
  type AppealFacts,
} from "@/lib/finance/appeal";

const facts: AppealFacts = {
  clinicName: "Demo Clinic",
  claimNumber: "CA-TEST-1",
  invoiceNo: "ADMC/C/90001",
  cptCode: "99213",
  payerId: "PAYER-TEST",
  reasonCode: "AUTH-001",
  reasonDescription: "Prior authorisation missing",
  category: "authorization",
  claimedAmount: 100,
  deniedAmount: 40,
  deniedOn: "2026-03-20",
  deadlineOn: "2026-04-19",
  priorAuthId: null,
};

function fakeLlm(
  text: string,
  over: Partial<{ refused: boolean }> = {},
): Llm & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    model: "test-model",
    calls,
    async complete(req) {
      calls.push(req);
      return {
        text,
        inputTokens: 100,
        outputTokens: 50,
        refused: over.refused ?? false,
        servedBy: "test-model",
      };
    },
  };
}

describe("template appeal letter (AI off)", () => {
  const letter = templateAppealLetter(facts, "2026-10-20");
  it("starts with the DRAFT banner and says nothing was sent", () => {
    expect(letter.startsWith(DRAFT_BANNER)).toBe(true);
    expect(DRAFT_BANNER).toMatch(/NOT SENT/);
  });
  it("carries the identifiers, amounts and dates, and placeholders for everything personal", () => {
    expect(letter).toContain("CA-TEST-1");
    expect(letter).toContain("ADMC/C/90001");
    expect(letter).toContain("AED 40.00");
    expect(letter).toContain("2026-04-19");
    expect(letter).toContain("[Patient name and member ID");
    expect(letter).toContain("[Name and role of the person signing]");
  });
  it("is deterministic", () => {
    expect(templateAppealLetter(facts, "2026-10-20")).toBe(letter);
  });
  it("has a category-specific ground for each category", () => {
    for (const c of [
      "authorization",
      "eligibility",
      "medical_necessity",
      "coding",
      "documentation",
      "duplicate",
      "timely_filing",
      "pricing",
      "other",
    ] as const) {
      expect(templateAppealLetter({ ...facts, category: c }, "2026-10-20")).toContain(
        "Grounds for the appeal",
      );
    }
  });
});

describe("AI appeal draft", () => {
  it("sends only identifiers, codes, amounts and dates to the model", () => {
    const prompt = appealUserPrompt(facts, "2026-10-20", "en");
    expect(prompt).toContain("claim_activity_number: CA-TEST-1");
    expect(prompt).toContain("denial_code: AUTH-001");
    expect(prompt).toContain("amount_denied_aed: 40.00");
    // there is no field for personal data, so none can appear
    expect(prompt).not.toMatch(/patient|name|birth|emirates|member|diagnos/i);
    expect(appealSystemPrompt({ clinicName: "Demo Clinic" })).toMatch(
      /never write a patient name/i,
    );
  });

  it("returns the model's letter behind the app's own DRAFT banner and flags nothing when it has placeholders", async () => {
    const llm = fakeLlm(
      "DRAFT letter\nSubject: Appeal. Claim CA-TEST-1\nDear Claims Review Team,\n[Clinical justification: to be written by the treating clinician]\nYours faithfully,\n[Name and role of the signatory]",
    );
    const d = await draftAppeal({ llm, facts, today: "2026-10-20", language: "en" });
    expect(d.kind).toBe("ai");
    expect(d.body.startsWith(DRAFT_BANNER)).toBe(true);
    expect(d.body).not.toMatch(/^DRAFT letter/m);
    expect(d.flags).toEqual([]);
    expect(d.model).toBe("test-model");
    expect(llm.calls).toHaveLength(1);
  });

  it("flags a letter with no placeholders, a dose, a diagnosis or an invented link", () => {
    const prompt = appealUserPrompt(facts, "2026-10-20", "en");
    const a = finalizeAiDraft("Dear team, please pay.", prompt);
    expect(a.flags.join(" ")).toMatch(/bracketed/);
    const b = finalizeAiDraft(
      "The patient needs 500 mg daily. You probably have an infection. See https://evil.example/pay [Clinical justification]",
      prompt,
    );
    expect(b.flags.join(" ")).toMatch(/dose|medication/i);
    expect(b.flags.join(" ")).toMatch(/diagnosis/i);
    expect(b.flags.join(" ")).toMatch(/link/i);
  });

  it("removes a banner written by the model instead of duplicating it", () => {
    const { body } = finalizeAiDraft("DRAFT - not sent\nHello [Clinical justification]", "x");
    expect(body.match(/NOT SENT/g)).toHaveLength(1);
  });

  it("falls back to the template when AI is off, refuses or returns nothing", async () => {
    const off = await draftAppeal({ llm: null, facts, today: "2026-10-20", language: "ar" });
    expect(off).toMatchObject({ kind: "template", language: "en", model: null });
    const refused = await draftAppeal({
      llm: fakeLlm("", { refused: true }),
      facts,
      today: "2026-10-20",
      language: "en",
    });
    expect(refused).toMatchObject({ kind: "template", refused: true });
    const empty = await draftAppeal({
      llm: fakeLlm("   "),
      facts,
      today: "2026-10-20",
      language: "en",
    });
    expect(empty.kind).toBe("template");
  });
});
