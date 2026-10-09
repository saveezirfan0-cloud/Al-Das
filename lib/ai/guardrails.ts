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
  /** Draft with the staff marker removed. */
  text: string;
  /** Human-readable reasons the draft needs a careful read. */
  flags: string[];
};

export function checkDraft(raw: string): OutputCheck {
  let text = raw.trim();
  const flags: string[] = [];

  if (text.startsWith(STAFF_MARKER)) {
    text = text.slice(STAFF_MARKER.length).trim();
    flags.push("Clinical or urgent content: hand to a clinician before replying.");
  }
  if (DOSE.test(text) || ARABIC_DOSE.test(text) || MED_INSTRUCTION.test(text)) {
    flags.push("Mentions a dose or medication instruction. Remove it or have a clinician confirm.");
  }
  if (DIAGNOSIS.test(text)) {
    flags.push("Sounds like a diagnosis. Staff must not diagnose.");
  }
  return { text, flags };
}
