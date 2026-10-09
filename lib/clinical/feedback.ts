import { ClinicalSettings } from "@/lib/clinical/settings";
import { matchedTerms } from "@/lib/clinical/text";

/** Scores are asked for on a 1–10 scale (the scale itself, not a clinical threshold). */
const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";

function normaliseDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => String(ARABIC_INDIC.indexOf(d)));
}

/**
 * R-16: a reply to a score-expecting template. An explicit "n/10" or "n out of 10" wins; otherwise
 * the first standalone integer 1–10. Decimals ("7.5"), numbers inside other numbers, and replies with
 * no number at all give null: the raw text is kept and a person decides. NO score is ever guessed.
 */
export function parseScore(reply: string | null | undefined): number | null {
  const text = normaliseDigits(reply ?? "");
  const explicit = /(?<![\d.])(10|[1-9])\s*(?:\/|out of)\s*10(?![\d])/i.exec(text);
  if (explicit) return Number(explicit[1]);
  const standalone = /(?<![\d.\/])(10|[1-9])(?![\d]|\.\d|\/)/.exec(text);
  return standalone ? Number(standalone[1]) : null;
}

export type RedFlag = {
  redFlag: boolean;
  scoreFlag: boolean;
  keywordFlag: boolean;
  keywordsHit: string[];
  /** The threshold applied; null = it was not signed off, so the score could not be judged. */
  thresholdUsed: number | null;
  /** True whenever a person must look: a red flag, or something that could not be evaluated. */
  needsHumanReview: boolean;
  /** Which settings were unsigned (the evaluation was fail-closed on them). */
  missingSettings: string[];
};

/**
 * R-18: red flag = (score ≤ threshold) OR (a side-effect keyword appears). The two tests are
 * independent: "8 but I have a rash" must escalate. If the threshold or keyword list isn't signed
 * off, that half can't be evaluated and the reply goes to human review (BC-23 / BC-24).
 */
export function evaluateRedFlag(
  reply: { score: number | null; text: string | null | undefined },
  settings: ClinicalSettings,
): RedFlag {
  const threshold = settings.num("red_flag_score_threshold");
  const keywords = settings.list("side_effect_keywords");
  const missing: string[] = [];
  if (threshold === undefined) missing.push("red_flag_score_threshold");
  if (keywords === undefined) missing.push("side_effect_keywords");

  const scoreFlag = reply.score !== null && threshold !== undefined && reply.score <= threshold;
  const hits = keywords ? matchedTerms(reply.text, keywords) : [];
  const keywordFlag = hits.length > 0;
  const redFlag = scoreFlag || keywordFlag;
  return {
    redFlag,
    scoreFlag,
    keywordFlag,
    keywordsHit: hits,
    thresholdUsed: threshold ?? null,
    needsHumanReview: redFlag || missing.length > 0,
    missingSettings: missing,
  };
}

/** R-19: both parties are told; neither is skipped because the other succeeded. */
export function notificationTargets(flag: Pick<RedFlag, "redFlag">): {
  doctor: boolean;
  coordinator: boolean;
} {
  return { doctor: flag.redFlag, coordinator: flag.redFlag };
}
