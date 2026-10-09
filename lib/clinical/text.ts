/**
 * Text helpers for the clinical rules. Mirrors Airtable's LEN(TRIM()) / SEARCH() semantics but
 * with sane boundaries: a term matches from the start of a word (so "infect" finds "infection" and
 * "uti" does not find "routine"), and very short terms must also end a word ("uti", "pid", "aub").
 */
export function txt(value: string | null | undefined): string {
  return (value ?? "").toLowerCase();
}

export function isBlank(value: string | null | undefined): boolean {
  return (value ?? "").trim().length === 0;
}

const cache = new Map<string, RegExp>();

export function termRegex(term: string): RegExp {
  const key = term.trim().toLowerCase();
  const hit = cache.get(key);
  if (hit) return hit;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const start = /^[a-z0-9]/.test(key) ? "(?<![a-z0-9])" : "";
  const shortWord = /[a-z0-9]$/.test(key) && key.replace(/\s/g, "").length <= 3;
  const re = new RegExp(start + escaped + (shortWord ? "(?![a-z0-9])" : ""), "i");
  cache.set(key, re);
  return re;
}

export function containsTerm(text: string | null | undefined, term: string): boolean {
  const t = term.trim();
  return t !== "" && termRegex(t).test(text ?? "");
}

export function containsAny(text: string | null | undefined, terms: readonly string[]): boolean {
  return terms.some((t) => containsTerm(text, t));
}

/** Which of the terms occur (used to show a reviewer why something flagged). */
export function matchedTerms(text: string | null | undefined, terms: readonly string[]): string[] {
  return terms.filter((t) => containsTerm(text, t));
}
