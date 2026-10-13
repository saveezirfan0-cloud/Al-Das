/**
 * Log hygiene (CLAUDE.md rule 9): never write tokens, full phone numbers or message
 * bodies to logs. Use `redactText` for any free-form string that reaches console.*
 * (third-party error messages can echo request data) and `redactPhone` when an
 * identifier is genuinely needed.
 */

/** "+971501234567" → "+•••••••••567". Keeps only the last 3 digits. */
export function redactPhone(phone: string | null | undefined): string {
  if (!phone) return "";
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 3) return "•••";
  return `${phone.trim().startsWith("+") ? "+" : ""}${"•".repeat(digits.length - 3)}${digits.slice(-3)}`;
}

const PATTERNS: Array<[RegExp, string | ((m: string) => string)]> = [
  // Meta/Graph access tokens (EAA…), bearer headers, JWTs, sk-/key-style secrets.
  [/\bEAA[A-Za-z0-9]{20,}\b/g, "[token]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [token]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[jwt]"],
  [/\b(?:sk|pk|key|re)_[A-Za-z0-9]{16,}\b/g, "[token]"],
  [/\b(access_token|app_secret|client_secret|api_key|apikey|password)=([^&\s]+)/gi, "$1=[redacted]"],
  [/\bv1:[A-Za-z0-9+/=]{8,}:[A-Za-z0-9+/=]{8,}:[A-Za-z0-9+/=]{4,}/g, "[encrypted]"],
  // E.164-ish and local phone numbers: 9+ digits, optionally separated.
  [/\+?\d[\d\s().-]{7,}\d/g, (m) => (m.replace(/\D/g, "").length >= 9 ? redactPhone(m) : m)],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]"],
];

export function redactText(input: unknown, maxLength = 300): string {
  const text = input instanceof Error ? input.message : typeof input === "string" ? input : String(input ?? "");
  let out = text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep as string);
  return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out;
}

const lastFour = (m: string) => `•••• ${m.replace(/\D/g, "").slice(-4)}`;

const STATEMENT_PATTERNS: Array<[RegExp, string | ((m: string) => string)]> = [
  // IBAN (AE07 0331 2345 6789 0123 456): country, check digits, then at least 16 letters or digits, optionally grouped.
  [/\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]{4}){4,7}(?:[ -]?[A-Z0-9]{1,4})?\b/g, "[iban]"],
  // Card numbers already masked by the bank (411111******1111, 4111 XXXX XXXX 1111).
  [/\b\d{4,6}(?:[ -]?[X*•]{2,6}){1,3}[ -]?\d{4}\b/gi, lastFour],
  // Card and account numbers: 12 to 19 digits, optionally separated by single spaces or dashes.
  [/\b\d(?:[ -]?\d){11,18}\b/g, lastFour],
  // International phone numbers and e-mail addresses.
  [/\+\d[\d\s().-]{7,}\d/g, (m) => redactPhone(m)],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]"],
];

/**
 * Bank statement and settlement text (description, reference) before it is stored: masks IBANs, card and account numbers
 * (keeping the last 4 digits), international phone numbers and e-mail addresses. Shorter references (up to 11 digits,
 * such as a remittance or batch number) are kept so they can still be matched. Whitespace is collapsed.
 */
export function redactStatementText(input: string | null | undefined, maxLength = 200): string | null {
  if (input == null) return null;
  let out = String(input).replace(/\s+/g, " ").trim();
  for (const [re, rep] of STATEMENT_PATTERNS) out = out.replace(re, rep as string);
  out = out.slice(0, maxLength).trim();
  return out === "" ? null : out;
}

/** Redacts the string values of a flat log-metadata object; other values pass through. */
export function redactMeta<T extends Record<string, unknown> | undefined>(meta: T): T {
  if (!meta) return meta;
  return Object.fromEntries(
    Object.entries(meta).map(([k, v]) => [k, typeof v === "string" ? redactText(v) : v]),
  ) as T;
}
