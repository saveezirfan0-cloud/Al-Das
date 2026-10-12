import { checkDraft } from "@/lib/ai/guardrails";
import { appealSystemPrompt } from "@/lib/ai/prompts/appeal";
import type { Llm } from "@/lib/ai/llm";
import { CATEGORY_LABELS, type DenialCategory } from "@/lib/finance/denials";
import { money } from "@/lib/finance/format";

/** A plain space (not the non-breaking one the screens use), so the letter pastes cleanly into a portal. */
const aed = (n: number) => `AED ${money(n)}`;

/**
 * Appeal letters (pure + one injected LLM call). Always a DRAFT: every body begins with the banner below, which the
 * application adds (never the model), and Pulse has no code path that sends it. The facts are identifiers, codes, amounts
 * and dates; there is no field that could carry a patient name, so none can reach the prompt or the letter.
 */

export const DRAFT_BANNER =
  "DRAFT. NOT SENT. Check every detail, complete the [bracketed] parts and send it yourself through the payer's own channel. Pulse never sends this letter.";

export type AppealFacts = {
  clinicName: string;
  claimNumber: string;
  invoiceNo: string | null;
  cptCode: string | null;
  payerId: string | null;
  reasonCode: string | null;
  reasonDescription: string | null;
  category: DenialCategory;
  claimedAmount: number | null;
  deniedAmount: number;
  deniedOn: string;
  deadlineOn: string;
  priorAuthId?: string | null;
};

const CATEGORY_PARAGRAPH: Record<DenialCategory, string> = {
  authorization:
    "Our records show the service was authorised in advance. [Authorisation reference and date: add them and attach the approval.]",
  eligibility:
    "The patient's cover was active on the service date. [Attach the eligibility confirmation and the cover dates.]",
  medical_necessity:
    "[Clinical justification: to be written by the treating clinician, with the supporting clinical records attached.]",
  coding:
    "[State the correct code, quantity or modifier if the original needs correcting, and attach the corrected claim if required.]",
  documentation:
    "[List the documents attached to this letter, for example the report, order and consent.]",
  duplicate:
    "This is not a duplicate of an earlier submission. [Explain what distinguishes it, for example a different date or a separate visit.]",
  timely_filing: "[Attach proof of the original submission date and any payer acknowledgement.]",
  pricing:
    "The amount billed is the price agreed with your organisation for this service. [Attach the relevant page of the agreed price list.]",
  other: "[State the grounds for the appeal and attach the supporting documents.]",
};

/** The deterministic letter used when AI is off, unavailable or refuses. */
export function templateAppealLetter(facts: AppealFacts, today: string): string {
  const lines: string[] = [
    DRAFT_BANNER,
    "",
    `Date: ${today}`,
    `To: [Appeals department]${facts.payerId ? ` (payer ID ${facts.payerId})` : ""}`,
    `Subject: Appeal against denial. Claim activity ${facts.claimNumber}${facts.invoiceNo ? `, invoice ${facts.invoiceNo}` : ""}`,
    "",
    "Dear Claims Review Team,",
    "",
    `${facts.clinicName} requests a review of the denial described below.`,
    "",
    `Claim activity: ${facts.claimNumber}`,
    ...(facts.invoiceNo ? [`Invoice: ${facts.invoiceNo}`] : []),
    ...(facts.cptCode ? [`Service code: ${facts.cptCode}`] : []),
    ...(facts.claimedAmount !== null ? [`Amount claimed: ${aed(facts.claimedAmount)}`] : []),
    `Amount denied: ${aed(facts.deniedAmount)}`,
    `Denial code: ${facts.reasonCode ?? "not stated"}${facts.reasonDescription ? `, ${facts.reasonDescription}` : ""} (${CATEGORY_LABELS[facts.category]})`,
    `Denied on: ${facts.deniedOn}`,
    `Resubmission deadline: ${facts.deadlineOn}`,
    ...(facts.priorAuthId ? [`Authorisation reference on the claim: ${facts.priorAuthId}`] : []),
    "Patient: [Patient name and member ID: add before sending]",
    "Treating clinician: [Name and licence number: add before sending]",
    "",
    "Grounds for the appeal:",
    CATEGORY_PARAGRAPH[facts.category],
    "",
    `We ask that the denial is overturned and the denied amount of ${aed(facts.deniedAmount)} is paid, or that you tell us what further information you need.`,
    "",
    "Yours faithfully,",
    "[Name and role of the person signing]",
    facts.clinicName,
  ];
  return lines.join("\n");
}

/** The user message for the model: tagged data only. Exported so tests can prove what leaves the system. */
export function appealUserPrompt(facts: AppealFacts, today: string, language: "en" | "ar"): string {
  const row = (k: string, v: string | number | null | undefined) =>
    v === null || v === undefined || v === "" ? null : `${k}: ${v}`;
  const data = [
    row("claim_activity_number", facts.claimNumber),
    row("invoice_number", facts.invoiceNo),
    row("service_code_cpt", facts.cptCode),
    row("payer_id", facts.payerId),
    row("denial_code", facts.reasonCode),
    row("denial_meaning", facts.reasonDescription),
    row("denial_category", CATEGORY_LABELS[facts.category]),
    row("amount_claimed_aed", facts.claimedAmount === null ? null : facts.claimedAmount.toFixed(2)),
    row("amount_denied_aed", facts.deniedAmount.toFixed(2)),
    row("denied_on", facts.deniedOn),
    row("resubmission_deadline", facts.deadlineOn),
    row("authorisation_reference", facts.priorAuthId),
  ].filter((x): x is string => x !== null);
  return `Write the appeal letter. Letter date: ${today}. Language: ${language === "ar" ? "Arabic" : "English"}.\n<claim>\n${data.join("\n")}\n</claim>`;
}

export type AppealDraft = {
  body: string;
  kind: "ai" | "template";
  language: "en" | "ar";
  model: string | null;
  flags: string[];
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  refused: boolean;
};

/**
 * Cleans a model reply: drops any banner the model wrote, adds ours, runs the clinical checks (dose, diagnosis, links or
 * numbers that were not in the prompt) and flags a letter that has no placeholder for the clinical justification.
 */
export function finalizeAiDraft(
  raw: string,
  promptText: string,
): { body: string; flags: string[] } {
  const checked = checkDraft(raw, { sourceText: promptText });
  let text = checked.text.replace(/^\s*draft[^\n]*\n+/i, "").trim();
  const flags = [...checked.flags];
  if (!/\[[^\]]+\]/.test(text))
    flags.push(
      "The letter has no [bracketed] part to complete. Add the patient details and the clinical reasoning before sending.",
    );
  if (!/clinical justification/i.test(text) && !/clinician/i.test(text))
    flags.push("There is no place for the treating clinician's reasoning. Add it before sending.");
  text = `${DRAFT_BANNER}\n\n${text}`;
  return { body: text, flags };
}

/**
 * AI draft with the deterministic template as the fallback. `llm` is null when AI is off or not configured.
 * Never throws for a model refusal or an empty reply; a provider error propagates to the caller (which records it).
 */
export async function draftAppeal(deps: {
  llm: Llm | null;
  facts: AppealFacts;
  today: string;
  language: "en" | "ar";
  now?: () => number;
}): Promise<AppealDraft> {
  const { llm, facts, today, language } = deps;
  const template = (): AppealDraft => ({
    body: templateAppealLetter(facts, today),
    kind: "template",
    language: "en",
    model: null,
    flags: [],
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 0,
    refused: false,
  });
  if (!llm) return template();
  const now = deps.now ?? Date.now;
  const started = now();
  const user = appealUserPrompt(facts, today, language);
  const res = await llm.complete({
    system: appealSystemPrompt({ clinicName: facts.clinicName }),
    user,
    effort: "medium",
    maxTokens: 2500,
  });
  const latencyMs = Math.max(0, now() - started);
  if (res.refused || !res.text.trim()) {
    return {
      ...template(),
      refused: res.refused,
      latencyMs,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
    };
  }
  const { body, flags } = finalizeAiDraft(res.text, user);
  return {
    body,
    kind: "ai",
    language,
    model: res.servedBy || llm.model,
    flags,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
    latencyMs,
    refused: false,
  };
}
