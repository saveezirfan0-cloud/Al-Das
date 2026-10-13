import "server-only";

import { describeProviderFailure } from "@/lib/ai/copilot/server";
import type { CopilotCall } from "@/lib/ai/flow-copilot/generate";
import type { Llm } from "@/lib/ai/llm";
import { buildReviewInput, reviewBankRun } from "@/lib/finance/bank-ai";
import { modeKey } from "@/lib/finance/bank-recon";
import { loadRun, loadSettlementRules } from "@/lib/finance/bank-server";
import { redactText } from "@/lib/redact";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Runs the AI reviewer over one OPEN bank reconciliation and stores what it said (Phase 20H). The caller has already run
 * requirePerm / can (finance.bank.manage and finance.bank.ai) and openCopilot(); it records the calls with recordCalls()
 * and audits. The review is stored whether the checks passed (status ok: a draft summary and the suggestions, all
 * pending) or not (status rejected, with the checker's reasons), so the run page can show how well the AI did. Nothing
 * here touches a match, a reason or the run itself.
 */

export type BankAiOutcome = { calls: CopilotCall[] } & (
  | { ok: true; reviewId: string; suggestions: number; repaired: boolean }
  | { ok: false; error: string; reviewId: string | null }
);

export async function runBankAiReview(
  deps: { admin: AdminClient; llm: Llm },
  req: { orgId: string; userId: string; recId: string; today: string },
): Promise<BankAiOutcome> {
  const { admin, llm } = deps;
  const run = await loadRun(admin, req.orgId, req.recId, req.today);
  if (!run) return { ok: false, error: "Reconciliation not found.", reviewId: null, calls: [] };
  if (run.rec.status !== "open")
    return { ok: false, error: "This reconciliation is not open.", reviewId: null, calls: [] };
  const rules = await loadSettlementRules(admin, req.orgId);
  const input = buildReviewInput({
    result: run.result,
    lines: run.lines,
    lagByMode: new Map(rules.map((r) => [modeKey(r.mode), r.lagDays])),
    settings: run.settings,
    period: { start: run.rec.period_start, end: run.rec.period_end },
  });
  if (input.items.size === 0)
    return {
      ok: false,
      error: "Nothing is open to review: no proposals, missing receipts or unexplained credits.",
      reviewId: null,
      calls: [],
    };

  let result;
  try {
    result = await reviewBankRun({ llm }, input);
  } catch (err) {
    return {
      ok: false,
      error: describeProviderFailure(err, "bank_review"),
      reviewId: null,
      calls: [{ inputTokens: 0, outputTokens: 0, latencyMs: 0, model: llm.model, status: "error" }],
    };
  }
  const model = result.calls[result.calls.length - 1]?.model ?? llm.model;

  const { data: review, error } = await admin
    .from("fin_bank_ai_reviews")
    .insert({
      org_id: req.orgId,
      rec_id: run.rec.id,
      status: result.ok ? "ok" : "rejected",
      model,
      summary: result.ok ? result.summary : null,
      reject_reason: result.ok ? null : result.errors.slice(0, 5).join(" ").slice(0, 1000),
      item_count: input.items.size,
      suggestion_count: result.ok ? result.suggestions.length : 0,
      repaired: result.ok ? result.repaired : false,
      created_by: req.userId,
    })
    .select("id")
    .single();
  if (error || !review) {
    console.error("[finance] bank AI review not saved", {
      code: error?.code,
      detail: redactText(error?.message ?? "", 80),
    });
    return {
      ok: false,
      error: "The review could not be saved (is the reconciliation still open?).",
      reviewId: null,
      calls: result.calls,
    };
  }

  if (!result.ok)
    return {
      ok: false,
      error: result.refused
        ? "The assistant declined to review this reconciliation. Nothing was changed."
        : `The assistant's answer was rejected by the checks, so nothing was suggested. ${result.errors.slice(0, 3).join(" ")}`,
      reviewId: review.id,
      calls: result.calls,
    };

  if (result.suggestions.length > 0) {
    const { error: sErr } = await admin.from("fin_bank_ai_suggestions").insert(
      result.suggestions.map((s) => ({
        org_id: req.orgId,
        rec_id: run.rec.id,
        review_id: review.id,
        item_key: s.itemKey,
        candidate_line_id: s.lineId,
        reason_code: s.reason,
        confidence: s.confidence,
      })),
    );
    if (sErr) {
      // keep the record consistent: a review without its suggestions is removed
      await admin.from("fin_bank_ai_reviews").delete().eq("org_id", req.orgId).eq("id", review.id);
      console.error("[finance] bank AI suggestions not saved", { code: sErr.code });
      return {
        ok: false,
        error: "The suggestions could not be saved. Try again.",
        reviewId: null,
        calls: result.calls,
      };
    }
  }
  return {
    ok: true,
    reviewId: review.id,
    suggestions: result.suggestions.length,
    repaired: result.repaired,
    calls: result.calls,
  };
}
