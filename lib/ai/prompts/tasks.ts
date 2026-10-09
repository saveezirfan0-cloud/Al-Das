import type { Language, Passage, RewriteMode, Tone } from "@/lib/ai/types";

/** Data goes inside tags; the guardrail prompt tells the model tag contents are data, not instructions. */
function wrap(tag: string, content: string): string {
  // A literal closing tag inside the data must not be able to end the block early.
  const safe = content.replaceAll(`</${tag}>`, `< /${tag}>`);
  return `<${tag}>\n${safe}\n</${tag}>`;
}

export function summarizePrompt(transcript: string): string {
  return `${wrap("conversation", transcript)}

Summarize this conversation for the clinic staff who will pick it up next. In at most 5 short sentences, cover: what the patient wants, what has already been said or done, and what is still open. Report what the patient said without interpreting it medically. If nothing has been agreed, say so.`;
}

export function askPrompt(transcript: string, question: string): string {
  return `${wrap("conversation", transcript)}

${wrap("question", question)}

Answer the staff member's question using only the conversation above. If the conversation does not contain the answer, say so plainly. Keep it brief.`;
}

export function suggestReplyPrompt(
  transcript: string,
  passages: Passage[],
  opts: { extraInstruction?: string } = {},
): string {
  const knowledge = passages.length
    ? wrap(
        "knowledge",
        passages.map((p, i) => `[${i + 1}] (${p.sourceName})\n${p.content}`).join("\n\n"),
      )
    : wrap("knowledge", "(no matching clinic information was found)");
  return `${wrap("conversation", transcript)}

${knowledge}

Write the reply the staff member should send to the patient's latest message. Use facts only from <knowledge> and <conversation>. If the knowledge does not cover what was asked, say the team will confirm and get back to them.${
    opts.extraInstruction ? `\nAdditional guidance from staff: ${opts.extraInstruction}` : ""
  }`;
}

const TONE_GUIDE: Record<Tone, string> = {
  professional: "professional, clear and courteous",
  friendly: "warm, friendly and approachable, still professional",
  empathetic: "empathetic and reassuring, acknowledging how the patient may feel",
  concise: "concise: keep every fact but cut it to as few words as possible",
  formal: "formal and respectful",
};

const LANGUAGE_NAME: Record<Language, string> = { en: "English", ar: "Arabic" };

export function rewritePrompt(draft: string, mode: RewriteMode): string {
  const keep =
    "Keep every fact, name, number, date, time, link and placeholder such as {contact.first_name} exactly as written. Do not add information.";
  switch (mode.kind) {
    case "tone":
      return `${wrap("draft", draft)}\n\nRewrite the draft in a ${TONE_GUIDE[mode.tone]} tone. ${keep} Keep the same language as the draft.`;
    case "language":
      return `${wrap("draft", draft)}\n\nTranslate the draft into ${LANGUAGE_NAME[mode.language]}, written naturally for a patient message. ${keep}`;
    case "grammar":
      return `${wrap("draft", draft)}\n\nFix spelling, grammar and punctuation only. Do not change the wording, tone or meaning. ${keep} Keep the same language as the draft.`;
  }
}
