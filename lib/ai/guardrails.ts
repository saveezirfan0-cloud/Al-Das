import { STAFF_MARKER } from "@/lib/ai/prompts/guardrail";

/**
 * Output checks on patient-facing drafts (suggested replies and rewrites). The system prompt does
 * the heavy lifting; this is the belt-and-braces layer that makes sure a risky draft is flagged for
 * a human instead of looking routine. Flags never block a draft: staff always review before sending.
 */

const DOSE = /\b\d+(?:[.,]\d+)?\s?(?:mg|mcg|µg|ug|g|ml|iu|units?|tablets?|pills?|capsules?|drops?|puffs?)\b/i;
const MED_INSTRUCTION = /\b(?:take|taking|increase|decrease|double|stop|skip|start)\s+(?:your\s+|the\s+|a\s+|an\s+)?(?:medication|medicine|tablets?|pills?|dose|doses|antibiotic|insulin|inhaler|painkiller)\b/i;
const DIAGNOSIS = /\b(?:you\s+(?:probably|likely|may|might)\s+have|you\s+have\s+(?:an?\s+)?(?:infection|diabetes|cancer|flu|covid)|this\s+(?:is|sounds\s+like|looks\s+like|could\s+be)\s+(?:an?\s+)?(?:infection|allergy|virus|condition)|(?:i|we)\s+diagnos)/i;
const ARABIC_DOSE = /\d+\s?(?:ملغ|مجم|ملجم|مل|حبة|حبوب|قرص|أقراص)/;

export type OutputCheck = {
  /** Draft with every staff marker removed. */
  text: string;
  /** Human-readable reasons the draft needs a careful read. */
  flags: string[];
};

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>")\]]+/gi;
const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g;
const LONG_NUMBER_RE = /\+?\d[\d\s().-]{6,}\d/g;

const squash = (s: string) => s.toLowerCase().replace(/[\s().-]+/g, "");

/**
 * Links, bank accounts and phone-like numbers that appear in a draft but NOT in the conversation or
 * the knowledge passages the model was given. A patient can try to steer a "reply" into carrying a
 * payment link or someone else's number; staff must see that before it goes out.
 */
export function unsupportedReferences(draft: string, sourceText: string): string[] {
  const source = sourceText.toLowerCase();
  const sourceSquashed = squash(sourceText);
  const found: string[] = [];
  for (const m of draft.match(URL_RE) ?? []) {
    const url = m.replace(/[.,;:!?]+$/, "").toLowerCase();
    if (!source.includes(url)) found.push("a link");
  }
  for (const m of draft.match(IBAN_RE) ?? []) if (!sourceSquashed.includes(squash(m))) found.push("a bank account number");
  // Numbers inside an account number were already reported as one.
  for (const m of draft.replace(IBAN_RE, " ").match(LONG_NUMBER_RE) ?? []) {
    if (m.replace(/\D/g, "").length >= 8 && !sourceSquashed.includes(squash(m))) found.push("a phone or reference number");
  }
  return [...new Set(found)];
}

export function checkDraft(raw: string, opts: { sourceText?: string } = {}): OutputCheck {
  let text = raw;
  const flags: string[] = [];

  // The marker is an instruction to staff, never content for the patient: remove it wherever it appears
  // (a model steered by a patient message could put it mid-text, where a prefix check would miss it).
  if (text.includes(STAFF_MARKER)) {
    text = text.split(STAFF_MARKER).join("");
    flags.push("Clinical or urgent content: hand to a clinician before replying.");
  }
  text = text.trim();

  if (DOSE.test(text) || ARABIC_DOSE.test(text) || MED_INSTRUCTION.test(text)) {
    flags.push("Mentions a dose or medication instruction. Remove it or have a clinician confirm.");
  }
  if (DIAGNOSIS.test(text)) {
    flags.push("Sounds like a diagnosis. Staff must not diagnose.");
  }
  if (opts.sourceText !== undefined) {
    const extra = unsupportedReferences(text, opts.sourceText);
    if (extra.length) flags.push(`Contains ${extra.join(" and ")} that is not in the conversation or your knowledge base. Check it before sending.`);
  }
  return { text, flags };
}
