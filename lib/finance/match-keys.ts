/**
 * Matching engine v2: the key and text helpers (pure). `refKey` mirrors SQL `public.fin_ref_key`
 * (supabase/migrations/20261210000200_finance_matching_v2.sql); a database test compares the two on REF_KEY_FIXTURES.
 */

/** Payment reference -> key: upper-case, only A-Z and 0-9, leading zeros dropped, empty -> null. */
export function refKey(s: string | null | undefined): string | null {
  const k = (s ?? "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase()
    .replace(/^0+/, "");
  return k === "" ? null : k;
}

/** Shared by the SQL parity test. [input, expected]. */
export const REF_KEY_FIXTURES: Array<[string | null, string | null]> = [
  ["INS/2026/0045", "INS20260045"],
  ["ins 2026 0045", "INS20260045"],
  ["  RA-0001 ", "RA0001"],
  ["000123", "123"],
  ["0", null],
  ["000", null],
  ["", null],
  [null, null],
  ["---", null],
  ["A0B", "A0B"],
  ["0A0", "A0"],
  ["0-0-7", "7"],
  ["reférence 12", "REFRENCE12"],
  ["١٢٣", null],
  ["ß12", "12"],
  ["a/b\\c.d_e", "ABCDE"],
  ["12 345", "12345"],
];

/** Narrative normaliser: upper-case letters and digits only. */
export function normalizeText(s: string): string {
  return (s ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

const isDigit = (c: string) => c >= "0" && c <= "9";

/**
 * Which of `keys` occur in the narrative. Both sides are normalised; a key shorter than `minLength` never matches.
 * An occurrence counts only at a boundary: the character before it (after skipping a run of zeros, so 0012345 matches
 * 12345) must not be of the same class (digit/letter) as the key's first character, and the character after must not
 * be of the same class as the key's last character. Distinct keys, in input order.
 */
export function findKeys(text: string, keys: readonly string[], minLength: number): string[] {
  const t = normalizeText(text);
  const out: string[] = [];
  for (const raw of keys) {
    const key = normalizeText(raw);
    if (key.length === 0 || key.length < minLength || out.includes(raw)) continue;
    const firstDigit = isDigit(key[0]);
    const lastDigit = isDigit(key[key.length - 1]);
    let from = 0;
    for (;;) {
      const at = t.indexOf(key, from);
      if (at < 0) break;
      from = at + 1;
      let b = at;
      while (b > 0 && t[b - 1] === "0") b--;
      const before = b > 0 ? t[b - 1] : null;
      const after = t[at + key.length] ?? null;
      if (before !== null && isDigit(before) === firstDigit) continue;
      if (after !== null && isDigit(after) === lastDigit) continue;
      out.push(raw);
      break;
    }
  }
  return out;
}

function spaced(s: string): string {
  return (s ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

/** Alias form: upper-case, letters, digits and single spaces, 3..60 characters, else null (the DB check). */
export function normalizeAlias(s: string): string | null {
  const a = spaced(s);
  return a.length >= 3 && a.length <= 60 ? a : null;
}

/** The alias words appear in the narrative as whole words, in that order, next to each other. */
export function aliasInText(text: string, alias: string): boolean {
  const a = normalizeAlias(alias);
  if (a === null) return false;
  return ` ${spaced(text)} `.includes(` ${a} `);
}

const GENERIC_WORDS = new Set([
  "TRANSFER", "CREDIT", "PAYMENT", "INWARD", "REMITTANCE", "SWIFT", "IBAN", "ADVICE", "REF", "BANK", "FUNDS",
  "AED", "FROM", "THE", "FOR", "AND", "VALUE", "DATE", "BEN", "ORD", "CHARGES", "OUR", "SHA",
]);

/** A suggested alias from a bank narrative: the first three non-generic words (letters only, 3+). Null when too short. */
export function proposeAlias(narrative: string, minLength: number): string | null {
  const words = (narrative ?? "")
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter((w) => w.length >= 3 && !GENERIC_WORDS.has(w))
    .slice(0, 3);
  const alias = words.join(" ").slice(0, 60).trim();
  return alias.length < minLength || alias.length === 0 ? null : alias;
}
