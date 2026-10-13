import { extractJson } from "@/lib/ai/copilot/json";
import type { CopilotCall } from "@/lib/ai/flow-copilot/generate";
import type { Llm } from "@/lib/ai/llm";
import {
  bankReviewRepairPrompt,
  bankReviewSystemPrompt,
  bankReviewUserPrompt,
} from "@/lib/ai/prompts/bank-review";
import {
  bankItemKey,
  modeKey,
  type BankLine,
  type BankSettings,
  type Candidate,
  type ExpectedItem,
  type RunResult,
} from "@/lib/finance/bank-recon";
import { redactStatementText } from "@/lib/redact";

/**
 * The AI reviewer for one open bank reconciliation run (Phase 20H). Pure: it builds what the model sees, checks what the
 * model answers, and repairs at most once. AI reviews, people decide:
 *
 *   - The model sees short aliases (E1, L1), amounts, dates, payment modes, lags, reference TOKENS (only the parts of a
 *     reference that contain a digit) and the deterministic shortlist from bank-recon.ts with its scores and reasons.
 *     Never a bank description (it can hold a payer's name), a database id or anything about a patient.
 *   - Its reply is untrusted: size-capped and parsed by extractJson, then every field is checked against a closed list.
 *     A candidate must come from THAT item's shortlist, so the model can never invent a pair. Any problem sends the
 *     reasons back once; a second failure rejects the whole answer with the reasons (none of which echo the model's text).
 *   - Nothing here writes. A suggestion becomes a match only when a person accepts it through 20C's own decision path.
 */

export const AI_REASON_CODES = {
  amount_and_date: "Amount and date agree",
  fee_deducted: "Processor fee deducted",
  split_settlement: "Paid in parts, or with other days",
  timing_weekend: "Timing: weekend, holiday or slow payout",
  reference_match: "Reference matches",
  no_match_likely_missing: "No match: probably not received",
  needs_person: "Needs a person to look",
} as const;
export type AiReasonCode = keyof typeof AI_REASON_CODES;
export const AI_CONFIDENCE = ["low", "medium", "high"] as const;
export type AiConfidence = (typeof AI_CONFIDENCE)[number];

/** Reasons that only make sense with a candidate, and the one that only makes sense without. */
const NEEDS_CANDIDATE: readonly AiReasonCode[] = ["amount_and_date", "reference_match"];
const NO_CANDIDATE: readonly AiReasonCode[] = ["no_match_likely_missing"];

export const BANK_AI_LIMITS = {
  maxItems: 150, // expected items plus open bank lines sent in one review
  maxCandidates: 5, // per expected item, best score first
  maxSummaryChars: 800,
  maxReplyChars: 40_000,
  maxTokens: 8192,
} as const;

const isReason = (v: unknown): v is AiReasonCode =>
  typeof v === "string" && Object.prototype.hasOwnProperty.call(AI_REASON_CODES, v);
const isConfidence = (v: unknown): v is AiConfidence =>
  typeof v === "string" && (AI_CONFIDENCE as readonly string[]).includes(v);

/**
 * Whether a reference token holds something shaped like a phone number: digits (ignoring - and /) that form a UAE number
 * with 971 / 00971, or a local number with the trunk 0 (9 to 11 digits). Invoice and transfer references (RA-55501,
 * INV-2026-0042, FT2628312345) do not.
 */
export function looksLikePhone(token: string): boolean {
  const compact = token.replace(/[-/]/g, "");
  return (compact.match(/\d+/g) ?? []).some(
    (run) => /^(?:00)?971\d{8,9}$/.test(run) || /^0\d{8,10}$/.test(run),
  );
}

/**
 * The parts of a reference that contain a digit (RA-55501, TBY-7781), upper-cased; words (which could be names) and
 * anything that looks like a phone number are dropped.
 */
export function referenceTokens(ref: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const t of (ref ?? "").toUpperCase().split(/[^A-Z0-9/-]+/)) {
    const tok = t.replace(/^[-/]+|[-/]+$/g, "");
    if (tok.length >= 3 && tok.length <= 24 && /\d/.test(tok) && !looksLikePhone(tok)) out.add(tok);
    if (out.size >= 5) break;
  }
  return [...out];
}

// ---- what the model sees ---------------------------------------------------------

type ExpectedData = {
  id: string;
  kind: ExpectedItem["kind"];
  payment_mode: string | null;
  source_date: string;
  expected_date: string;
  lag_working_days: number | null;
  gross: number;
  fee: number;
  amount: number;
  references: string[];
  age: string | null;
  candidates: Array<{
    line: string;
    score: number;
    reasons: string[];
    amount_diff: number;
    day_diff: number;
    several_fit: boolean;
  }>;
};
type LineData = {
  id: string;
  value_date: string;
  amount: number;
  references: string[];
  open: boolean;
};
export type ReviewData = {
  period: { start: string; end: string };
  statement_to: string | null;
  rules: {
    date_window_days: number;
    amount_tolerance: number;
    amount_tolerance_pct: number;
    weekend_days: number[];
  };
  expected: ExpectedData[];
  bank_lines: LineData[];
  not_sent: number;
};

/** One reviewable item: its run key and its shortlist (line alias -> bank line id). */
export type ReviewItem = { key: string; shortlist: ReadonlyMap<string, string> };
export type ReviewInput = {
  data: ReviewData;
  items: ReadonlyMap<string, ReviewItem>; // alias -> item
};

export function buildReviewInput(args: {
  result: RunResult;
  lines: ReadonlyMap<string, BankLine>;
  lagByMode: ReadonlyMap<string, number | null>; // keyed by modeKey()
  settings: BankSettings;
  period: { start: string; end: string };
}): ReviewInput {
  const { result: r } = args;
  const lineAlias = new Map<string, string>(); // bank line id -> alias
  const lineData: LineData[] = [];
  const aliasOf = (lineId: string, open: boolean): string | null => {
    const known = lineAlias.get(lineId);
    if (known) return known;
    const line = args.lines.get(lineId);
    if (!line) return null;
    const alias = `L${lineAlias.size + 1}`;
    lineAlias.set(lineId, alias);
    lineData.push({
      id: alias,
      value_date: line.valueDate,
      amount: line.amount,
      references: referenceTokens(line.reference),
      open,
    });
    return alias;
  };

  type Entry = { item: ExpectedItem; candidates: readonly Candidate[]; age: string | null };
  const entries: Entry[] = [
    ...r.proposals.map((p) => ({ item: p.item, candidates: p.candidates, age: null })),
    ...r.unmatched.map((u) => ({ item: u.item, candidates: [] as Candidate[], age: u.bucket })),
  ].sort(
    (a, b) =>
      a.item.expectedDate.localeCompare(b.item.expectedDate) ||
      a.item.key.localeCompare(b.item.key),
  );
  const openLines = r.bankUnmatched.map((b) => b.line);
  const total = entries.length + openLines.length;
  const keepEntries = entries.slice(0, BANK_AI_LIMITS.maxItems);
  const keepLines = openLines.slice(0, Math.max(0, BANK_AI_LIMITS.maxItems - keepEntries.length));

  const items = new Map<string, ReviewItem>();
  const expected: ExpectedData[] = keepEntries.map(({ item, candidates, age }, i) => {
    const alias = `E${i + 1}`;
    const shortlist = new Map<string, string>();
    const cands: ExpectedData["candidates"] = [];
    for (const c of candidates.slice(0, BANK_AI_LIMITS.maxCandidates)) {
      const la = aliasOf(c.lineId, false);
      if (!la) continue;
      shortlist.set(la, c.lineId);
      cands.push({
        line: la,
        score: c.score,
        reasons: [...c.reasons],
        amount_diff: c.amountDiff,
        day_diff: c.dayDiff,
        several_fit: c.ambiguous,
      });
    }
    items.set(alias, { key: item.key, shortlist });
    return {
      id: alias,
      kind: item.kind,
      payment_mode: item.mode,
      source_date: item.sourceDate,
      expected_date: item.expectedDate,
      lag_working_days: item.mode ? (args.lagByMode.get(modeKey(item.mode)) ?? null) : null,
      gross: item.gross,
      fee: item.fee,
      amount: item.amount,
      references: item.references.flatMap(referenceTokens),
      age,
      candidates: cands,
    };
  });
  for (const line of keepLines) {
    const alias = aliasOf(line.id, true);
    if (alias) items.set(alias, { key: bankItemKey(line.id), shortlist: new Map() });
  }

  return {
    data: {
      period: args.period,
      statement_to: r.asOf,
      rules: {
        date_window_days: args.settings.windowDays,
        amount_tolerance: args.settings.toleranceAmount,
        amount_tolerance_pct: args.settings.tolerancePct,
        weekend_days: [...args.settings.weekendDays],
      },
      expected,
      bank_lines: lineData,
      not_sent: total - items.size,
    },
    items,
  };
}

// ---- what the model answers ------------------------------------------------------------

export type ValidSuggestion = {
  itemKey: string;
  lineId: string | null;
  reason: AiReasonCode;
  confidence: AiConfidence;
};
export type ReviewValidation =
  { ok: true; suggestions: ValidSuggestion[]; summary: string } | { ok: false; errors: string[] };

const MAX_ERRORS = 20;

/** Checks the model's reply against the items that were sent. Error texts never repeat what the model wrote. */
export function validateReview(raw: string, input: ReviewInput): ReviewValidation {
  const parsed = extractJson(raw, BANK_AI_LIMITS.maxReplyChars);
  if (!parsed.ok) return { ok: false, errors: [parsed.reason] };
  const v = parsed.value;
  if (!v || typeof v !== "object" || Array.isArray(v))
    return { ok: false, errors: ["The answer must be one JSON object."] };
  const obj = v as Record<string, unknown>;
  const errors: string[] = [];

  const summary = typeof obj.summary === "string" ? obj.summary.trim() : null;
  if (!summary) errors.push('"summary" is missing or empty.');
  else if (summary.length > BANK_AI_LIMITS.maxSummaryChars)
    errors.push(`"summary" is longer than ${BANK_AI_LIMITS.maxSummaryChars} characters.`);

  const list = obj.suggestions;
  const suggestions: ValidSuggestion[] = [];
  if (!Array.isArray(list)) errors.push('"suggestions" must be a list.');
  else if (list.length > input.items.size)
    errors.push(`There are more suggestions than items (${input.items.size}).`);
  else {
    const seenItems = new Set<string>();
    const seenLines = new Set<string>();
    list.forEach((s, i) => {
      const at = `Suggestion ${i + 1}`;
      if (!s || typeof s !== "object" || Array.isArray(s)) {
        errors.push(`${at} is not an object.`);
        return;
      }
      const e = s as Record<string, unknown>;
      const item = typeof e.item === "string" ? input.items.get(e.item) : undefined;
      if (!item) {
        errors.push(`${at} names an item that was not sent.`);
        return;
      }
      if (seenItems.has(e.item as string)) {
        errors.push(`${at} repeats an item; give at most one suggestion per item.`);
        return;
      }
      seenItems.add(e.item as string);
      let lineId: string | null = null;
      if (e.candidate !== null && e.candidate !== undefined && e.candidate !== "") {
        lineId = typeof e.candidate === "string" ? (item.shortlist.get(e.candidate) ?? null) : null;
        if (!lineId) {
          errors.push(`${at}: the candidate is not on that item's own candidate list.`);
          return;
        }
        if (seenLines.has(lineId)) {
          errors.push(`${at}: that bank line is already suggested for another item.`);
          return;
        }
        seenLines.add(lineId);
      }
      if (!isReason(e.reason)) {
        errors.push(`${at}: the reason is not one of the allowed codes.`);
        return;
      }
      if (!isConfidence(e.confidence)) {
        errors.push(`${at}: the confidence must be low, medium or high.`);
        return;
      }
      if (lineId === null && NEEDS_CANDIDATE.includes(e.reason)) {
        errors.push(`${at}: the reason ${e.reason} needs a candidate.`);
        return;
      }
      if (lineId !== null && NO_CANDIDATE.includes(e.reason)) {
        errors.push(`${at}: the reason ${e.reason} cannot have a candidate.`);
        return;
      }
      suggestions.push({
        itemKey: item.key,
        lineId,
        reason: e.reason,
        confidence: e.confidence,
      });
    });
  }

  if (errors.length > 0) return { ok: false, errors: errors.slice(0, MAX_ERRORS) };
  // masks account and card numbers, phone numbers and e-mail addresses (none should be there; belt and braces)
  return {
    ok: true,
    suggestions,
    summary: redactStatementText(summary, BANK_AI_LIMITS.maxSummaryChars) ?? "",
  };
}

// ---- one review: ask, check, repair at most once ----------------------------------------

export type BankReviewResult =
  | {
      ok: true;
      suggestions: ValidSuggestion[];
      summary: string;
      repaired: boolean;
      calls: CopilotCall[];
    }
  | { ok: false; errors: string[]; refused: boolean; calls: CopilotCall[] };

const REPAIR_ECHO_CHARS = 20_000;

export async function reviewBankRun(
  deps: { llm: Llm; now?: () => number },
  input: ReviewInput,
): Promise<BankReviewResult> {
  const now = deps.now ?? Date.now;
  const system = bankReviewSystemPrompt({
    reasons: Object.keys(AI_REASON_CODES),
    confidences: AI_CONFIDENCE,
    maxSummaryChars: BANK_AI_LIMITS.maxSummaryChars,
  });
  const data = JSON.stringify(input.data);
  const calls: CopilotCall[] = [];

  async function ask(user: string): Promise<{ text: string; refused: boolean }> {
    const started = now();
    const res = await deps.llm.complete({
      system,
      user,
      maxTokens: BANK_AI_LIMITS.maxTokens,
      effort: "medium",
    });
    const refused = res.refused || !res.text;
    calls.push({
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      latencyMs: Math.max(0, now() - started),
      model: res.servedBy || deps.llm.model,
      status: refused ? "refused" : "ok",
    });
    return { text: res.text, refused };
  }

  const first = await ask(bankReviewUserPrompt(data));
  if (first.refused)
    return {
      ok: false,
      errors: ["The assistant declined to review this reconciliation."],
      refused: true,
      calls,
    };
  const v1 = validateReview(first.text, input);
  if (v1.ok) return { ...v1, repaired: false, calls };

  calls[0] = { ...calls[0]!, status: "needs_review" };
  const second = await ask(
    bankReviewRepairPrompt(data, first.text.slice(0, REPAIR_ECHO_CHARS), v1.errors),
  );
  if (second.refused) return { ok: false, errors: v1.errors, refused: false, calls };
  const v2 = validateReview(second.text, input);
  if (v2.ok) return { ...v2, repaired: true, calls };
  calls[calls.length - 1] = { ...calls[calls.length - 1]!, status: "needs_review" };
  return { ok: false, errors: v2.errors, refused: false, calls };
}

// ---- the quality line on the run page -----------------------------------------------------

export type SuggestionDecision = "pending" | "accepted" | "rejected";

/**
 * How the AI's suggestions have fared on one run: accepted and rejected across every review of the run, still waiting in
 * the latest review, and never decided in earlier reviews (superseded by a newer review).
 */
export function suggestionQuality(
  rows: ReadonlyArray<{ reviewId: string; decision: SuggestionDecision }>,
  latestReviewId: string | null,
): { accepted: number; rejected: number; pending: number; superseded: number } {
  const q = { accepted: 0, rejected: 0, pending: 0, superseded: 0 };
  for (const r of rows) {
    if (r.decision === "accepted") q.accepted++;
    else if (r.decision === "rejected") q.rejected++;
    else if (r.reviewId === latestReviewId) q.pending++;
    else q.superseded++;
  }
  return q;
}
