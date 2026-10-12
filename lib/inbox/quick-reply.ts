/**
 * Quick replies (pure): bilingual text and {{variables}}.
 *
 * A quick reply has an English text and an optional Arabic one. The one used follows the patient's language;
 * an Arabic-speaking patient with no Arabic version gets the English text rather than nothing. Variables are
 * filled from what the desk knows about the conversation. A variable with no value is left as it is so the
 * person typing sees `{{doctor}}` and fixes it instead of sending a blank.
 */
export const QUICK_REPLY_VARIABLES = [
  { key: "first_name", label: "Patient first name" },
  { key: "last_name", label: "Patient last name" },
  { key: "full_name", label: "Patient full name" },
  { key: "agent_name", label: "Your name" },
  { key: "clinic_name", label: "Clinic name" },
  { key: "doctor", label: "Doctor of the next appointment" },
  { key: "appointment_date", label: "Date of the next appointment" },
  { key: "appointment_time", label: "Time of the next appointment" },
  { key: "location", label: "Clinic location of the next appointment" },
] as const;

export type QuickReplyVariable = (typeof QUICK_REPLY_VARIABLES)[number]["key"];

export type QuickReplyContext = Partial<Record<QuickReplyVariable, string | null>>;

const VARIABLE_RE = /\{\{\s*([a-z_]+)\s*\}\}/gi;

export type QuickReplyText = { text: string; text_ar?: string | null };

export function isArabic(language: string | null | undefined): boolean {
  return (language ?? "").trim().toLowerCase().startsWith("ar");
}

/** The wording for this patient's language. */
export function pickQuickReplyText(
  reply: QuickReplyText,
  language: string | null | undefined,
): string {
  const ar = reply.text_ar?.trim();
  if (isArabic(language) && ar) return ar;
  return reply.text.trim() ? reply.text : (ar ?? "");
}

export function renderQuickReply(
  template: string,
  ctx: QuickReplyContext,
): { text: string; unresolved: string[] } {
  const unresolved = new Set<string>();
  const text = template.replace(VARIABLE_RE, (whole, raw: string) => {
    const key = raw.toLowerCase();
    const value = (ctx as Record<string, string | null | undefined>)[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    unresolved.add(key);
    return whole;
  });
  return { text, unresolved: [...unresolved] };
}

/** The variable names used in a text (for the settings form's hint and validation). */
export function variablesIn(template: string): string[] {
  const out = new Set<string>();
  for (const m of template.matchAll(VARIABLE_RE)) out.add(m[1].toLowerCase());
  return [...out];
}

/** Names in a template that are not supported variables (a typo such as {{docter}}). */
export function unknownVariables(template: string): string[] {
  const known = new Set<string>(QUICK_REPLY_VARIABLES.map((v) => v.key));
  return variablesIn(template).filter((v) => !known.has(v));
}

/** Slash-command matching used by the composer: "/res" lists shortcuts that start with "res". */
export function matchShortcuts<T extends { shortcut: string }>(
  replies: readonly T[],
  typed: string,
  limit = 8,
): T[] {
  if (!typed.startsWith("/") || typed.includes("\n")) return [];
  const q = typed.slice(1).toLowerCase();
  return replies.filter((r) => r.shortcut.startsWith(q)).slice(0, limit);
}
