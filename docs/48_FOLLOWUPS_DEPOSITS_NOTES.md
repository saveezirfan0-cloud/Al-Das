# W3 follow-ups: deposits of several references, paid_before, unmatched deposits

Follow-ups 1, 2 and the unmatched-deposit part of 4 from `docs/47_W3_W5_INSURANCE_NOTES.md`. Migrations `20261223000100_finance_deposit_groups.sql` and `20261223000150_finance_unmatched_deposit_rule.sql` (paste copies `deploy/supabase-paste/102_*` and `103_*`). No new table, no new permission.

## 1. One deposit = several payment references (monthly bank run, 20C)

| Piece | Where |
| --- | --- |
| Insurance items per payment REFERENCE: a remittance file whose committed lines carry several references (or payers) is split | `splitRemittanceByReference` in `lib/finance/deposit-groups.ts`; sums from `fin_bank_insurance_payments` (SQL, service role) |
| Group proposals for credits no single item fits | `depositGroupSearch` (calls the W3 `matchDeposit`), wired into `reconcileRun` through `RunInput.proposeGroups` by `loadRun` |
| A saved group | ONE `fin_bank_matches` row, `expected_key = insg|<member key>+<member key>...` (`depositGroupKey`, `depositGroupMembers` in `bank-recon.ts`); the key column now allows 1000 characters |
| Settings (data, not code) | `fin_ref_finance_settings.bank_deposit_max_parts` (default 5, 1 to 10; 1 = groups off) and `bank_deposit_max_pool` (default 40, 2 to 60); Bank settings page |

Rules:
- Keys: a file with one reference keeps `ins|<batch id>` (saved matches and the W5 case C10 stay valid); a split part is `ins|<batch id>|<8 hex>` (FNV-1a of reference and payer, so it does not depend on the other parts). The split fails closed: parts that do not add up to the file's `sum_paid` to the cent, a part that is not positive (a take-back), or two parts with the same id keep the file as one item.
- Only items with NO single candidate and credits with NO single candidate are grouped. A group is always a proposal (never `autoReady`), even when every reference is on the bank line. It is "Several fit" when several groups fit the credit, when one of its payments is also offered to another credit, when a single payment might also explain the credit, or when the group fits several credits.
- A person accepts or rejects it through `decideMatch` -> `applyMatchDecision` (the existing path: recomputes the run, refuses a pair that is no longer a candidate, audit row). A rejected group is not offered for that credit again. An accepted group covers its members: they leave the open lists; if a member disappears the match is an orphan to undo; an item matched both alone and in a group is a review blocker ("matched twice").
- The AI reviewer (20H) never sees group proposals (its `item_key` column stays 160 and a group is a person's decision).
- `maxPool` caps the search per payer in the date window; above it the credit shows "Too many insurer payments in range to try combinations" (`RunResult.groupSearchSkipped`). The search stops a branch once its total passes the deposit plus tolerance (same results as a full walk; 40 payments take about 20 ms).
- The v2 footprint check (matching page allocations or closures) now also skips a part when the whole file (`ins|batch:<id>`) was allocated or closed there.

## 2. paid_before

`ins_claims_for_remittance(p_org_id, p_numbers, p_invoice_keys, p_exclude_file_id default null)` (redefined from its last definition, the 3-argument version dropped) adds `paid_before` per claim: the sum of `paid_amount` of COMMITTED `ins_remittance_lines` on that claim, take-backs netted, never below 0, null when the claim was never on committed advice, leaving out lines whose batch came from `p_exclude_file_id`. `claimsFor` in `remittance-service.ts` passes the file being previewed or committed. The pure `reconcileRemittance` already subtracts it: a completing payment is not short (case C04), a second full payment is `overpaid` (C08).

## 4 (part). Unmatched deposits as exceptions (E15)

`ops_exceptions.entity_type` allows `deposit` (the existing list is read from the constraint and kept). Rule **E15** "Insurer deposit not matched" (owner `finance`, threshold 10 days in `fin_ref_exception_rules`, seeded for every org and by `seed_finance_reference`). `fin_run_exception_rules` is redefined from its last definition (`20261021000100`) with every earlier rule unchanged. One exception per bank line (`entity_key` = line id; detail: account id, value date, amount, days; never the reference or description) when:
- the line is a credit on the account that `receives_insurance`, `match_status = 'unmatched'` (no reconciliation match and no bank entry), no live accepted allocation in `fin_match_decisions`, and no reason given in any reconciliation (`fin_bank_rec_notes` `bank|<line id>`);
- its value date is older than the threshold (and never inside `bank_date_window_days`).

Start-up guards: skipped when the threshold is blank or no remittance advice was ever loaded; a line before the first remittance date or before the account's first reconciliation period is never flagged. Idempotent through `app.fin_reconcile` (auto-closed when a reason is given or the line is matched). The exception page links "Open deposit" to `/finance/bank` for members with `finance.bank.view`.

## Tests

- `tests/unit/finance/deposit-groups.test.ts` (19): keys, the split and its fail-closed cases, the run wiring (proposal only, C09 ties, shared payments, payers never mixed, singles first, rejection, acceptance, orphan, matched twice, pool too large, determinism, unchanged without the hook).
- `tests/unit/finance/remittance-paid-before.test.ts` (4): the preview passes the file id to exclude; completing payment, second full payment, no earlier payment.
- `tests/db/finance-deposit-followups.test.ts` (11): `paid_before` (earlier file, excluded file, take-back, never below 0, other org), `fin_bank_insurance_payments`, the widened key, E15 (guards, idempotent, cleared, blank threshold, seeded).
- Updated: `tests/db/finance-rls.test.ts` (15 rules), `tests/db/security-guard.test.ts` (new function), `tests/unit/finance/rules-digest-summary.test.ts` (E15).

## Assumptions and open points

- An insurer pays per payment reference (W3 notes). Unverified on a real statement; the split falls back to the file when parts do not add up.
- A file with a take-back reference stays one item (an insurer may net the take-back in the transfer or not; unknown).
- E15 treats any credit on the insurance account as "insurer-looking"; a reason in the reconciliation (for example "Other income") clears it. Threshold 10 days is a proposal for Finance (Vineetha) to confirm under Reference data.
- No database guard stops the same item being matched alone and in a group at the same instant; the run shows it as a blocker.
- The member items of a pending group proposal stay in "Expected but not found" until the group is accepted.
- `lib/supabase/types.ts` edited by hand; regenerate with `pnpm db:migrate` when convenient.
- Not clicked through in a browser here.

Still open from docs/47: follow-up 3 (`claimStatus` on the claims page), and from 4 the receivable comparison in the close pack and origin/avoidable on the denial pages.
