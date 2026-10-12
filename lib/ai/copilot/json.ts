/**
 * Reads a JSON value out of a model reply. The reply is untrusted text: it is size-capped BEFORE parsing, and anything that
 * is not one well-formed JSON value is rejected (never "repaired" by guessing). Pure; no logging of the text.
 */

export type JsonExtract = { ok: true; value: unknown } | { ok: false; reason: string };

export const DEFAULT_MAX_JSON_CHARS = 60_000;

/** The text between the first opening brace and the last closing brace, after removing a markdown fence if the model added one. */
export function extractJson(raw: string, maxChars = DEFAULT_MAX_JSON_CHARS): JsonExtract {
  if (typeof raw !== "string" || raw.trim() === "")
    return { ok: false, reason: "The assistant returned nothing." };
  if (raw.length > maxChars)
    return { ok: false, reason: "The assistant's answer was too large to use." };
  let text = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fence?.[1]) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start)
    return { ok: false, reason: "The assistant's answer was not JSON." };
  try {
    return { ok: true, value: JSON.parse(text.slice(start, end + 1)) };
  } catch {
    return { ok: false, reason: "The assistant's answer was not valid JSON." };
  }
}

/** Wraps untrusted text as a data block. A closing tag inside the text (any case or spacing) is defused so it cannot end the block early. */
export function wrapData(tag: string, content: string): string {
  const safe = content.replace(new RegExp(`<\\s*/\\s*${tag}\\s*>`, "gi"), `< /${tag}>`);
  return `<${tag}>\n${safe}\n</${tag}>`;
}
