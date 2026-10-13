/**
 * Question-node answer checks (Phase 20b, G4). PURE: no I/O, deterministic, unit-tested. Used by the engine when a reply
 * arrives (lib/flow-engine/run.ts) and by the builder checks. A reply that does not pass is re-asked (up to the node's
 * limit) and then follows the fallback edge; it is never stored.
 */
import { patternProblem, type AnswerType } from "@/lib/flow-engine/node-options";
import { normalizePhone } from "@/lib/phone";

export {
  ANSWER_TYPES,
  ANSWER_TYPE_LABELS,
  MAX_PATTERN_CHARS,
  patternProblem,
  type AnswerType,
} from "@/lib/flow-engine/node-options";

/** Longest reply that is checked or stored at all. A longer one is refused (and re-asked). */
export const MAX_ANSWER_CHARS = 500;

export type AnswerRule = {
  type: AnswerType;
  min?: number;
  max?: number;
  pattern?: string;
};

export type AnswerCheck = { ok: true; value: string } | { ok: false; reason: string };

/** Replaces Arabic-Indic and Persian digits with ASCII digits. */
function asciiDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

function parseDate(raw: string): string | null {
  const s = asciiDigits(raw.trim());
  let y: number, m: number, d: number;
  let r = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (r) {
    y = Number(r[1]);
    m = Number(r[2]);
    d = Number(r[3]);
  } else {
    // Day first, as written in the UAE: 31/12/2026, 31-12-2026, 31.12.2026
    r = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
    if (!r) return null;
    d = Number(r[1]);
    m = Number(r[2]);
    y = Number(r[3]);
  }
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null; // 31/02 and friends
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Checks one free-text reply against the node's rule and returns the value to store (normalised where it helps). */
export function checkAnswer(rule: AnswerRule, raw: string): AnswerCheck {
  const text = raw.trim();
  if (!text) return { ok: false, reason: "empty" };
  if (text.length > MAX_ANSWER_CHARS) return { ok: false, reason: "too_long" };
  switch (rule.type) {
    case "text":
      return { ok: true, value: text };
    case "number": {
      const s = asciiDigits(text).replace(/[\s,]/g, "");
      if (!/^-?\d+(\.\d+)?$/.test(s)) return { ok: false, reason: "not_a_number" };
      const n = Number(s);
      if (!Number.isFinite(n)) return { ok: false, reason: "not_a_number" };
      if (rule.min !== undefined && n < rule.min) return { ok: false, reason: "too_small" };
      if (rule.max !== undefined && n > rule.max) return { ok: false, reason: "too_large" };
      return { ok: true, value: String(n) };
    }
    case "phone": {
      const p = normalizePhone(asciiDigits(text));
      return p ? { ok: true, value: p.e164 } : { ok: false, reason: "not_a_phone" };
    }
    case "email": {
      const e = text.toLowerCase();
      return /^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$/.test(e) && e.length <= 254
        ? { ok: true, value: e }
        : { ok: false, reason: "not_an_email" };
    }
    case "date": {
      const d = parseDate(text);
      return d ? { ok: true, value: d } : { ok: false, reason: "not_a_date" };
    }
    case "regex": {
      // A pattern that would not pass the builder check never matches (fail closed).
      if (!rule.pattern || patternProblem(rule.pattern))
        return { ok: false, reason: "bad_pattern" };
      return new RegExp(rule.pattern, "u").test(text)
        ? { ok: true, value: text }
        : { ok: false, reason: "no_match" };
    }
  }
}

/** Matches a reply to one of the offered options: the tapped id first, then the title (case-insensitive), then "1", "2"… */
export function matchOption<T extends { id: string; title: string }>(
  options: readonly T[],
  reply: { text: string; optionId?: string | null },
): T | undefined {
  if (reply.optionId) {
    const byId = options.find((o) => o.id === reply.optionId);
    if (byId) return byId;
  }
  const t = reply.text.trim().toLowerCase();
  const byTitle = options.find((o) => o.title.trim().toLowerCase() === t);
  if (byTitle) return byTitle;
  const n = /^\d{1,2}$/.test(asciiDigits(t)) ? Number(asciiDigits(t)) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= options.length ? options[n - 1] : undefined;
}
