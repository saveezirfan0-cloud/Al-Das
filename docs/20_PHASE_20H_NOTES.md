# Phase 20H notes: the AI reviewer for bank reconciliation

_Built 4 Nov 2026 on `claude/funny-clarke-6t7gee`. Plan: `docs/20_FINANCE_CONTROL_PLAN.md`, slice 20H and section 4.1 ("AI reviews, people decide")._

## What it does

The finance meeting asked for an agent that says "this is probably something you need to look into", that a person then simply accepts or rejects, and that reports how well it reconciled. On an open bank reconciliation (20C) Finance presses **Ask AI to review**. For each open item (a proposed match, an expected receipt not found, a bank credit nothing explains) the AI suggests at most one bank line **from Pulse's own candidate list for that item**, or no match, with a reason code and a confidence, and writes a short summary. Each suggestion has Accept and Reject. Accepting a pair saves the match exactly as if the person had accepted the 20C proposal; rejecting records the decision. A quality line on the page counts suggestions accepted, rejected and still waiting. The AI never changes a figure, never matches anything itself and never signs.

Scope is the bank reconciliation only. Lab, referral and insurance reconciliations (the rest of the plan's 20H row) wait for 20E; the same pattern applies to them.

## What exists

| Piece | Where |
|---|---|
| AI review panel: button (disabled with the reason when gated), the AI summary labelled "AI draft, check before relying on it", the suggestions with Accept / Reject, the quality line | `/finance/bank/[id]` (`[id]/page.tsx`, `[id]/run-forms.tsx`) |
| Server actions `askAiReview`, `decideAiSuggestion`; the shared `applyMatchDecision` (also behind 20C's `decideMatch`) | `app/(app)/finance/bank/actions.ts` |
| What the model sees, the closed checks, repair once, the quality count (pure) | `lib/finance/bank-ai.ts` |
| Prompt (system, user, repair; data wrapped with `wrapData`) | `lib/ai/prompts/bank-review.ts` |
| Load the run, ask, store the review and suggestions (service role after the checks) | `lib/finance/bank-ai-server.ts` |
| Migration | `supabase/migrations/20261104000100_finance_bank_ai.sql`, paste file `deploy/supabase-paste/34_finance_bank_ai.sql` |

**Permission.** `finance.bank.ai` (Finance and Finance Manager; in the shared Finance preset). Every AI action checks `finance.bank.manage` **and** `finance.bank.ai` with `can()`, then the workspace AI gates through `openCopilot()` (master switch OFF by default, per-person limit, daily cap, provider key) and records each model call with `recordCalls()` (feature `bank_review`, tokens and outcome only). The model comes from `ANTHROPIC_MODEL` through the existing `Llm` seam. The CEO (view) sees the panel and the quality line but no buttons.

**Tables** (`public.fin_*`, RLS with a select policy for the three bank keys, no write policy; every write is a server action with `recordAudit`):

- `fin_bank_ai_reviews`: one row per press of the button: run, status `ok` (the checks passed) or `rejected` (with the checker's reasons, which never repeat the model's text), model, the draft summary (at most 800 characters, account and card numbers, phone numbers and e-mails masked), items reviewed, suggestions, whether a repair was needed, who asked. Never the prompt or the raw reply.
- `fin_bank_ai_suggestions`: review, run, item key (an expected item key or `bank|<line id>`), candidate bank line or none, reason code, confidence, decision `pending` -> `accepted` / `rejected` (once), who decided and when.

**Database guards** (every role, including the service role): a suggestion belongs to an `ok` review of the same run and org; what the AI said never changes; a decision is made once and needs its time; reason codes and confidences are closed lists, and the reasons that need a candidate (`amount_and_date`, `reference_match`) or forbid one (`no_match_likely_missing`) are enforced. New reviews and decisions use 20C's `fin_bank_decision_guard`: only while the run is open and its month is not locked.

## The rules

- **What the model sees.** The run's open items reduced to aliases (`E1`, `L1`): kind, payment mode (or the payer code for insurance), source and expected dates, the rule's lag in working days, gross, fee and expected amount, age bucket, and for each expected item its 20C shortlist (up to 5 candidates, best score first, including those below the auto-accept score) with score, reasons, amount and day difference and "several fit"; the bank lines involved with date, amount and **reference tokens** (only the parts of a reference that contain a digit, so a payer's name in a reference never reaches the prompt; a token holding a phone-shaped number, `971...` / `00971...` or a 9 to 11 digit number starting with 0, is dropped too: `looksLikePhone` in `bank-ai.ts`); the date window, tolerances and weekend. **Never** a bank description, a database id, a name or anything about a patient. At most 150 items per review; the rest are counted (`not_sent`). Items ready to match automatically are not sent: the person saves those with the 20C button.
- **What the model returns.** One JSON object: `suggestions` (item, candidate or null, reason, confidence) and `summary`. The reply is size-capped and parsed by `extractJson`; then: unknown item, a repeated item, a candidate not on **that item's own** shortlist (so the model can never invent a pair), the same bank line for two items, an unknown reason or confidence, a reason that contradicts the candidate, a missing or over-long summary, or too many suggestions is an error. Any error sends the reasons back **once**; a second failure stores the review as rejected with the reasons and suggests nothing.
- **Reason codes**: `amount_and_date`, `fee_deducted`, `split_settlement`, `timing_weekend`, `reference_match`, `no_match_likely_missing`, `needs_person`. Confidence: low, medium, high.
- **Accepting.** A suggested pair goes through `applyMatchDecision`, the same function 20C's Accept uses: the run is recomputed, the pair must still be a candidate, the match row and its audit are the same, and the database still refuses a locked month, a run that is not open, and a line or item matched twice. A "no match" suggestion accepted changes nothing else; the reason is still given in the 20C list. Rejecting records the decision only; the pair stays open for a person.
- **Quality line.** Accepted and rejected count across every review of the run; "waiting" counts the latest review's pending suggestions; pending ones from earlier reviews are shown apart as never decided.

## How it was verified

- `tests/unit/finance/bank-ai.test.ts` (14 tests) on the 20C synthetic October: the items and shortlists sent, no description, database id or automatic match in the prompt, reference tokens drop names, the caps; the checks (out-of-shortlist candidates including another item's line, an open bank line with a candidate, unknown items, codes and confidences, contradictions, duplicates, over-long summary, non-JSON, oversized reply, error texts that never echo the model, summary masking); one call, repair once, reject after the second failure with no third call, refusal; the quality count. Fake `Llm` only.
- `tests/unit/finance-bank-ai-actions.test.ts` (9 tests, session, database, AI gates and model faked): both actions refuse without `finance.bank.manage` and `finance.bank.ai` before the service role exists; AI off and a run that is not open are refused without calling the model or writing; end to end, the checked answer becomes a draft review with pending suggestions mapped back to keys and bank lines, calls recorded as `bank_review`, audited, and nothing touches matches, reasons or the run; a twice-invalid answer is stored as rejected with the reason; accepting a pair writes the same `fin_bank_matches` row and `finance.bank.match_accepted` audit as 20C, a stale pair or a closed run is refused and nothing is marked; rejecting only records the decision. The 20C action tests still pass with `decideMatch` on the shared path.
- `tests/db/finance-bank-ai.test.ts` (8 tests, Postgres 16): who reads (Finance, Finance Manager, CEO; not Billing; org B only its own), nobody writes directly, the grant block (Finance and Finance Manager only, idempotent, matching the code presets), `ai_usage` accepts `bank_review`, the suggestion rules, decided once, an accepted pair is an ordinary 20C match (an item matched once), the preparer cannot sign, a reviewed or signed run refuses new reviews and decisions, a locked month refuses reviews, decisions and the match. The cross-org insert sweep in `tests/db/security-guard.test.ts` covers both tables (an incomplete probe row is left to RLS).
- Typecheck, lint, the unit suite, the database suite and `pnpm audit:security` (0 unguarded; see the commit).

## Not verified

- Not run against the real model: prompts and the closed checks are tested with a fake `Llm` only. How often the real model's answers pass the checks first time, and how useful its suggestions are, is unknown until Finance uses it on a real month (the quality line is the measure).
- Not clicked through in a browser (no Supabase auth stack here).
- "Train the AI on how they match" is not model training: the AI is given each run's shortlist with 20C's scores and reasons, and the accepted / rejected record is kept. Feeding past decisions back into the prompt as examples is a possible next step once there is a real history to judge it by.

## Before first use

1. Apply `deploy/supabase-paste/34_finance_bank_ai.sql` to the **Pulse** project (not THC Portal), after `27_finance_bank_recon.sql`.
2. AI must be on for the workspace (Settings, AI & knowledge base) with a provider key and `ANTHROPIC_MODEL` set; the daily cap applies to these reviews too.
3. Give `finance.bank.ai` to anyone else who should use it (Finance and Finance Manager have it).

## Decisions worth knowing

- **Strict checks, not partial acceptance.** One bad suggestion fails the whole answer (then one repair). Keeping the good half of a bad answer would hide how often the model goes wrong; the stored rejected reviews make that visible.
- **Aliases instead of ids.** The model never sees a database id, and a candidate is resolved only through the item's own shortlist, so a made-up or borrowed id cannot become a pair.
- **Deciding a suggestion needs `finance.bank.ai` too**, so the AI's work is acted on by the people chosen to use it; anyone with `finance.bank.manage` can still accept the same pair from the 20C proposals list.
- **Reviews are kept, including rejected ones**, for the quality record; nothing in them identifies a person.
