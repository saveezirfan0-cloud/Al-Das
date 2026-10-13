/** Closed option lists shared by the Phase 20b executors and the builder form. Framework-free and dependency-light (client-safe). */
import { INTENTS } from "@/lib/ai/intent/labels";

/** The AI router's labels: the intent pipeline's closed list WITHOUT emergency (an emergency is never routed, it goes to a person). */
export const ROUTABLE_INTENTS = INTENTS.filter((i) => i !== "emergency") as Array<
  Exclude<(typeof INTENTS)[number], "emergency">
>;

/** Same list as lib/integrations/capi/event.ts CAPI_EVENT_NAMES (a test keeps them equal; that module is server-side). */
export const META_EVENT_NAMES = ["Contact", "Lead", "Schedule"] as const;

// Question answer types (lib/flow-engine/answers.ts checks them; the builder and graph checks read these).
export const ANSWER_TYPES = ["text", "number", "phone", "email", "date", "regex"] as const;
export type AnswerType = (typeof ANSWER_TYPES)[number];

export const ANSWER_TYPE_LABELS: Record<AnswerType, string> = {
  text: "Any text",
  number: "A number",
  phone: "A phone number",
  email: "An e-mail address",
  date: "A date",
  regex: "Text matching a pattern",
};

/** A flow author's pattern: short, and without nested quantifiers that could take very long on a hostile reply. */
export const MAX_PATTERN_CHARS = 200;

/**
 * Rejects a pattern that does not compile, is too long, uses back-references, or repeats a group that already repeats
 * ("(a+)+", "(\d*)*"): the classic catastrophic-backtracking shape. A heuristic, not a proof: replies are also capped at
 * 500 characters before any pattern runs. Some harmless patterns are refused too; the author can rewrite them.
 */
export function patternProblem(pattern: string): string | null {
  if (!pattern.trim()) return "Enter a pattern";
  if (pattern.length > MAX_PATTERN_CHARS)
    return `Patterns are limited to ${MAX_PATTERN_CHARS} characters`;
  if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/.test(pattern))
    return "Repeating a group that already repeats is not allowed (it can be very slow)";
  if (/\\[1-9]/.test(pattern)) return "Back-references are not allowed";
  try {
    new RegExp(pattern, "u");
  } catch {
    return "The pattern is not valid";
  }
  return null;
}
