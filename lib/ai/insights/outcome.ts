/**
 * Did the member of staff use the AI suggestion as it was, change it, or write their own? PURE.
 *
 * The comparison happens once, in memory, when a message is sent. Only the verdict and a similarity percentage are stored:
 * neither the suggestion nor the sent message is kept anywhere by this feature.
 */

/** Thresholds on the 0-100 similarity score. A starting point to tune with real use (docs/17). */
export const OUTCOME_THRESHOLDS = { accepted: 92, edited: 45 } as const;

export type SuggestionOutcome = "accepted" | "edited" | "rejected";

function words(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** 0-100: twice the longest common word sequence over the combined length. Order-aware, punctuation and case blind. */
export function similarityPercent(a: string, b: string): number {
  const x = words(a).slice(0, 400);
  const y = words(b).slice(0, 400);
  if (x.length === 0 && y.length === 0) return 100;
  if (x.length === 0 || y.length === 0) return 0;
  let prev = new Array<number>(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    const cur = new Array<number>(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j++) {
      cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    prev = cur;
  }
  return Math.round((2 * prev[y.length]! * 100) / (x.length + y.length));
}

export function classifySuggestionOutcome(
  suggestion: string,
  sent: string,
): { outcome: SuggestionOutcome; similarity: number } {
  const similarity = similarityPercent(suggestion, sent);
  const outcome: SuggestionOutcome =
    similarity >= OUTCOME_THRESHOLDS.accepted
      ? "accepted"
      : similarity >= OUTCOME_THRESHOLDS.edited
        ? "edited"
        : "rejected";
  return { outcome, similarity };
}
