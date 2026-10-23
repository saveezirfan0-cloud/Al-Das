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
  // UAE numbers written without "+": 971 / 00971 then the 8 or 9 digit national number (9714 123 4567, 971501234567).
  [/(?<!\d)(?:00)?971[ -]?\d(?:[ -]?\d){7,8}(?!\d)/g, (m) => redactPhone(m)],
  // Local numbers with the trunk 0: mobiles (050 123 4567, 0501234567) and landlines (04 123 4567). Letters may touch
  // them ("MOB0501234567"); other digits may not, so longer numbers and references are left to the rules above.
  [/(?<!\d)0\d(?:[ -]?\d){7,9}(?!\d)/g, (m) => redactPhone(m)],
  // International phone numbers and e-mail addresses.
  [/\+\d[\d\s().-]{7,}\d/g, (m) => redactPhone(m)],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]"],
];

/**
 * Bank statement and settlement text (description, reference) before it is stored: masks IBANs, card and account numbers
 * (keeping the last 4 digits), phone numbers (international, UAE without "+", and local ones starting with 0) and e-mail
 * addresses. Shorter references (up to 11 digits, such as a remittance or batch number, unless they start with 0 and look
 * like a local phone number) are kept so they can still be matched. Whitespace is collapsed.
 */
export function redactStatementText(input: string | null | undefined, maxLength = 200): string | null {
  if (input == null) return null;
  let out = String(input).replace(/\s+/g, " ").trim();
  for (const [re, rep] of STATEMENT_PATTERNS) out = out.replace(re, rep as string);
  out = out.slice(0, maxLength).trim();
  return out === "" ? null : out;
}

/** Luhn check digit test, used to tell a card number from a long reference number. */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let n = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

/** A card number as people write it: 13 to 19 digits run together, or in groups of four (Amex 4-6-5). */
const CARD_SHAPED = /^(?:\d{13,19}|\d{4}(?:[ -]\d{4}){2,3}(?:[ -]\d{1,3})?|\d{4}[ -]\d{6}[ -]\d{5})$/;

const REFERENCE_PATTERNS: Array<[RegExp, string | ((m: string) => string)]> = [
  STATEMENT_PATTERNS[0], // IBAN
  STATEMENT_PATTERNS[1], // card numbers already masked by the bank
  // phone numbers only when they stand on their own: a run of digits inside a letter code ("AB12_XY012345678Z") is
  // part of the reference
  [/(?<![A-Za-z0-9])(?:00)?971[ -]?\d(?:[ -]?\d){7,8}(?![A-Za-z0-9])/g, (m) => redactPhone(m)],
  [/(?<![A-Za-z0-9])0\d(?:[ -]?\d){7,9}(?![A-Za-z0-9])/g, (m) => redactPhone(m)],
  [/\+\d[\d\s().-]{7,}\d/g, (m) => redactPhone(m)],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]"],
];

/**
 * A payment reference from an insurer's remittance (Diligence `PaymentReference`, such as "1234567-12345" or
 * "AB12_34-123456789012-1-01"). Long numbers are part of the reference and are kept, because the same reference must
 * still meet itself on the remittance advice, which Pulse stores as written. Still masked: IBANs, cards the bank already
 * masked, phone numbers standing on their own, e-mail addresses, and a value that is itself a card number (card-shaped,
 * see CARD_SHAPED, and passing the Luhn check).
 */
export function redactReferenceText(input: string | null | undefined, maxLength = 80): string | null {
  if (input == null) return null;
  let out = String(input).replace(/\s+/g, " ").trim();
  if (CARD_SHAPED.test(out) && passesLuhn(out.replace(/\D/g, ""))) out = lastFour(out);
  for (const [re, rep] of REFERENCE_PATTERNS) out = out.replace(re, rep as string);
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
