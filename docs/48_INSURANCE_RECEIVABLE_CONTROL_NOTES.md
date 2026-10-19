# Insurance receivable control: Diligence against Tally

Follow-up to docs/47 W3 item (e) and follow-up 4. Built 19 Oct 2026. Migration `supabase/migrations/20261223000300_finance_ins_receivable_control.sql`, paste file `deploy/supabase-paste/106_finance_ins_receivable_control.sql`.

**Owner decision (19 Oct 2026):** Al Das stays on Tally. Tally is the book of record and Pulse integrates with it through the Tally connector; Pulse's own ledger is on hold, so `acc_entities.ledger_start_date` will not be set. The "Finance" side of this control is therefore **Tally's insurer receivable at the month end as Pulse mirrors it**, not a Pulse ledger balance. "Before the ledger start" is not treated as "not started"; that would leave the check empty for good.

## What it does

Every month-end close pack now holds, beside the other Board pack controls:

| Figure                         | Source                                                                                                                                                                                             | As at                                            |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Diligence insurance receivable | `ins_claim_activities`: net − remitted − approved write-off (not below 0), per Diligence payer id                                                                                                  | the month end (see "Diligence at the month end") |
| Tally insurer receivable       | the Tally mirror in `acc_journals` (sources `tally_import` and Tally `opening`, plus their reversals when a later Tally version replaced them), debit − credit on the insurer receivable ledger(s) | the month end                                    |
| Difference                     | Tally − Diligence                                                                                                                                                                                  |                                                  |
| Tolerance                      | `fin_ref_finance_settings.ins_receivable_tolerance` (default AED 1.00; set under Finance, Close timetable, Calendar and settings)                                                                  |                                                  |
| Status                         | Agrees / Differs / No Tally data / No Diligence data                                                                                                                                               |                                                  |

- **Per payer when both sides can be split**, otherwise in total. Diligence always carries a payer id per claim (a claim without one is "no payer"). On the Tally side a ledger is one payer's when every insurance receivable posting rule that points at it names that payer (Tally usually keeps one Sundry Debtors ledger per insurer; 22J maps posting rules to ledgers imported from Tally). Any amount without a payer on either side makes the comparison a total one, and the page says how much was unassigned on each side.
- **Agrees** = the total difference is within the tolerance AND, per payer, every payer is within it. **Differs** otherwise. **No Tally data** = no insurer receivable ledger is mapped (no active receivable posting rule for `insurance`, or for `*` as the posting engine's fallback) or nothing was mirrored from Tally on those ledgers up to the month end. **No Diligence data** = no Diligence claim dated on or before the month end. Neither "No ..." status needs an explanation.
- **Fails closed:** anything unreadable (an unknown Tally state, a list that is not a list, an amount that is not a number, a broken block in a snapshot) counts as Differs, so Finance cannot sign until it is explained.
- The figure is part of `fin_close_controls` (key `ins_receivable`), so it is **frozen in the close snapshot and covered by its sha256**; the Excel and PDF render it from the snapshot (the Controls sheet / section), and "Matters needing attention" lists a difference with its figures.
- **Freshness:** the Tally figure is only as fresh as the last Tally pull (22J connector, every 15 minutes while it runs) or the last 22I file import. The block carries `tally_last_mirrored_at` (when Pulse last posted a mirrored Tally voucher) and `tally_last_voucher_date` (the latest voucher date mirrored), and both are shown with the figure. A pull that brings no new vouchers does not move them.

## The close check (explanation before the finance sign-off)

- A month whose control **Differs** cannot be signed for Finance until the preparer (`finance.close.manage`) has written an explanation of **this build** of the pack (`fin_close_explain_ins_receivable`; 10 to 1,000 characters; stored on `fin_period_closes.ins_control_note` with the snapshot hash it explains, who and when).
- The person who signs for Finance reviews it as part of the existing finance sign-off and **must not be the person who wrote it**. The CEO signs as today. No new approval chain, no new permission.
- Enforced in SQL: `fin_close_sign_finance` (and so `fin_close_sign_signed`, which calls it) recomputes the status from the snapshot's own inputs with `app.fin_close_ins_status` (never trusting the stored result) and refuses with hint `ins_receivable_unexplained` (no explanation, or one written for an earlier build) or `ins_receivable_same_person`.
- The explanation can change only while the pack waits for the finance sign-off (trigger `fin_period_closes_ins_note_guard`, every role, hint `ins_receivable_note_frozen`); after the CEO lock the whole row is immutable as before. `app.fin_period_close_guard` was redefined only so a deleted explainer's id can be nulled on a locked row (the FK action), like the other people columns.
- Rebuilding the pack makes an earlier explanation stale (the hash changes); the page says so and the preparer explains again.
- The explanation text is never put in the audit row (`finance.close.ins_receivable_explained` carries the month, the field name and the length); `record_history` on `fin_period_closes` keeps the change as before. It appears on the close page, in the Excel Summary sheet and in the PDF sign-off section.
- Packs built before this control have no block: they sign exactly as before and show "Not captured in this pack".

## How

| Piece                        | File                                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure rule (TS)               | `lib/finance/insurance-receivable-control.ts` (`compareInsuranceReceivable`, `recompute`, `snapshotStatus`, `explanationState`)                                     |
| Pure rule (SQL twin)         | `app.fin_ins_receivable_compare`                                                                                                                                    |
| Shared cases (parity)        | `tests/unit/finance/fixtures/ins-receivable-control.synthetic.json` (unit and DB tests run the same cases)                                                          |
| Figures                      | `app.fin_ins_receivable_block(org, month_end)`, called from the redefined `fin_close_controls` (from its last definition, 20261107000100; every earlier block kept) |
| Snapshot status / sign check | `app.fin_close_ins_status`, `fin_close_sign_finance` (redefined from 20261016000600)                                                                                |
| Explanation                  | `fin_close_explain_ins_receivable`; action `explainInsReceivable` in `app/(app)/finance/close/actions.ts`                                                           |
| Pack rendering               | `insReceivableSection` and the matter in `lib/finance/close-controls.ts`; `insNoteText` in `lib/finance/close-xlsx.ts`, used by `close-pdf.ts`                      |
| Page                         | `app/(app)/finance/close/[month]/ins-receivable-control.tsx` (card above the Board pack controls; the generic grid skips that section)                              |
| Build cross-check            | `buildAndStorePack` refuses to freeze a pack when the TS twin disagrees with the SQL result                                                                         |
| Tolerance setting            | `app/(app)/finance/close/timetable/*` (Calendar and settings form)                                                                                                  |

No new table, no new permission, no new page (help guide `finance-workflows` updated).

### Diligence at the month end

Claims dated on or before the month end. Outstanding as in the close pack (net − remitted − approved write-off, not below zero) with one correction: a claim whose **first** remittance is dated after the month end has its remitted amount added back (it was still owed at the month end). Diligence keeps one remitted total per claim, so a claim remitted both before and after the month end has all of it deducted; those claims are counted and shown ("Remitted before and after the month end"). Write-offs carry no date in Diligence: an approved one counts whenever it was approved. The Diligence data is as it stands when the pack is built.

## Assumptions (to confirm)

1. The insurer receivable ledgers are the ones the `receivable / insurance` posting rules point at (seeded as 1200 Insurance receivable; mapped to Tally ledgers under Accounting, Posting rules). If the clinic's Tally keeps insurers somewhere the posting rules do not point, the figure is wrong until they are mapped.
2. A Tally ledger is one payer's only when every rule pointing at it names that payer; the payer id in the rule's qualifier must be the Diligence payer id (compared exactly, after trimming).
3. Only the Tally mirror counts (`tally_import`, Tally `opening`, their reversals). A journal posted by Pulse itself (it posts nothing while the ledger is on hold) or a typed opening journal is left out.
4. All accounting entities are summed (one Tally company each, W7); Diligence covers the whole organisation.
5. A month with both sides missing reads "No Tally data".

## Open questions

| #   | Question                                                                                                                                                                                                             | Owner                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| 1   | Is AED 1.00 the right default tolerance, and should it be a percentage as well?                                                                                                                                      | Hardik                      |
| 2   | Which Tally ledgers hold insurer receivables (one per insurer under Sundry Debtors, or one control ledger)? Map them in Posting rules with the Diligence payer id as the qualifier so the comparison runs per payer. | Hardik, Vineetha           |
| 3   | Does Diligence `remitted` already net take-backs, and is `first_remittance_date` reliable? The month-end correction depends on it (same question as docs/47 follow-up 3).                                            | Hardik                     |
| 4   | Diligence write-offs have no date: should an approved write-off after the month end be added back (needs a date from Diligence)?                                                                                     | Hardik, Mohammed           |
| 5   | Built: whoever explains must be someone other than the finance signer (any holder of `finance.close.manage` may explain). Is that the rule wanted, or must the explainer also be the person who built the pack?      | Hardik                      |
| 6   | Copay and the patient share: Tally's insurer ledgers should hold the insurer share only. Confirm nothing patient-side is posted there.                                                                               | Vineetha                   |
| 7   | How old may the last Tally pull be before the control should say "stale" instead of comparing? (Today it shows the time and compares.)                                                                               | Hardik                      |

## Tests

- `tests/unit/finance/insurance-receivable-control.test.ts`: the shared cases (agrees within tolerance, exactly at it, differs, per payer vs total, a payer on one side only, unassigned amounts, No Tally data, No Diligence data, fail-closed inputs, negative tolerance, cents), the frozen block (status recomputed, never read from the stored result), explanation states, the matter, the section rows, the Excel/PDF line.
- `tests/db/finance-ins-receivable-control.test.ts`: SQL twin parity on every shared case; Diligence at the month end (added back, straddling, write-offs, later claims, trimmed payer ids); No Tally data with nothing mirrored and with no ledger mapped; the Tally mirror (later vouchers excluded, an altered voucher counted once, another org never counted, a non-Tally journal excluded); per payer with one Tally ledger per insurer; the tolerance as data; the sign-off rules (unexplained, signed path, stale after a rebuild, same person, frozen after signing, agreeing pack, older pack, unreadable block, locked row with a deleted explainer); the new functions are not callable by signed-in users.
