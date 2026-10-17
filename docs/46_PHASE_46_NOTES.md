# Phase 46: Unite records, patient links and matching engine v2

Built from `docs/46_FINANCE_RECORDS_AND_MATCHING.md` (17 Oct 2026). Migrations `20261221000100` and `20261221000200`.

## What is built

**Saved Unite export as a raw batch (W1).** `/finance/upload`, third card, `finance.revenue.import` plus the typed word UPLOAD.
The JSON file (one response envelope, or a bare array of invoices) goes browser, Storage, server, and the Storage object is always deleted.
It is split into chunks of 200 records; every chunk is stored in `fin_raw_unite_batches` (`source = 'file'`, unique per org and payload hash)
BEFORE any is processed, then `processBatch` runs unchanged, stopping at the first failure (`pnpm finance:replay` recovers the rest).
`requested_at` is the "pulled on" date the uploader enters (00:00 UTC), so `fin_apply_invoices` treats the file as older than any later API data
(the staleness rule). Nothing in this path imports the Unite client.

**Links (W2).** `v_fin_invoice_links` (`security_invoker`): invoice to contact (by PIN, merged contacts followed) and to the Unite appointment row.
`link_state`: `no_patient`, `direct`, `no_appointment`, `linked`. Used by the Patient 360 Invoices tab and a lazy Invoices section in the appointment
drawer (both need `finance.invoices.view`; no hint without it).

**Matching v2 (W3), insurer money.** Page `/finance/matching` (tab of Bank). Items are insurer payments by payment reference
(`fin_receipts`, the receipt register, merged with `ins_remittance_batches`); money is the credits of the `receives_insurance` account.
- `match-keys.ts` (reference keys, narrative search, payer-name proposals), `match-v2.ts` (items and the three rules), `match-rule-gate.ts` (history and the gate).
- Rules: 1 reference on the bank line; 2 payer (approved name) plus the amount of one payment or of a small set; 3 amount and date (proposal only).
  A partial payment allocates what was paid and leaves the remainder open. Several credits can pay one item and one credit several items.
- Every decision is a row of `fin_match_decisions` (allocation or rejection), undoable, never edited. Sums are enforced by triggers.
- Learning is under control: a confirmed match PROPOSES a payer name; a Finance Manager approves it (`finance.matching.approve`).
  Each automatic rule is off until a Finance Manager switches it on, and only when its own record passes
  (`match_auto_min_precision`, `_months`, `_decisions` in `fin_ref_finance_settings`). `amount_date` never matches automatically.
- Open items leave the register only by full allocation, write-off (exactly the remainder, with a reason) or cancellation.
- The monthly bank run (20C) is unchanged except that it ignores lines and remittances that v2 already allocated or closed.
- Permissions: `finance.matching.view` / `.manage` (Finance, Finance Manager, Revenue & Collections; CEO view), `.approve` (Finance Manager only).
- Receipt register import: kind `receipt_register` in the generic import engine (layout under Bank settings), file not kept.

## Not built (needs input that does not exist yet)
- **E-claim XML import** (needs sample submission and remittance advice files).
- **Answer key from the September/October manual reconciliation.** The gate measures each rule on the decisions made in Pulse. Hardik's and
  Vineetha's history can be entered as manual allocations (`allocateManually`) so the rules can be measured on it.
- **Known bank-charge rules** (level 4 of the spec): a difference stays open as a remainder with its reason; no charge table until the charges are agreed.
- **Insurance control matrix** (spec 3.5: Diligence receivable vs Finance receivable per month, one status per claim) and **claim lines** in the register.
- **Card, cash and Tabby items** stay in the monthly run; the v2 register is insurer money only.

## Known limits
- No database guard stops a monthly-run match and a v2 allocation of the same line in the same instant (the loader prevents it at read time).
- A payer is recognised only when `fin_receipts.payer_key` and `ins_remittance_batches.payer_id` use the same code.
- Types in `lib/supabase/types.ts` were edited by hand (no Supabase CLI here); regenerate with `pnpm db:migrate` when convenient.
- Not rendered in a browser here: please click through Upload, Insurer payments, a Patient 360 Invoices tab and an appointment drawer once on a dev stack.
