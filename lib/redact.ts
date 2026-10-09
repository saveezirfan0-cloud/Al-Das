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

/** Redacts the string values of a flat log-metadata object; other values pass through. */
export function redactMeta<T extends Record<string, unknown> | undefined>(meta: T): T {
  if (!meta) return meta;
  return Object.fromEntries(
    Object.entries(meta).map(([k, v]) => [k, typeof v === "string" ? redactText(v) : v]),
  ) as T;
}
