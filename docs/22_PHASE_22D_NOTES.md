# Phase 22D notes: the posting engine

_Built 13 Oct 2026 on the 22D worktree branch (based on `claude/funny-clarke-6t7gee` at `2d1fa54`). Plan: `docs/22_ACCOUNTING_PLAN.md`, principles 1 to 6, section 3 and the 22D row; ledger core: `docs/22_PHASE_22A_NOTES.md`. Open questions that apply: OQ-117 (cut-over date), OQ-120 (VAT per service), OQ-124 (summaries or invoice by invoice), OQ-126 (expected rejections), OQ-127 (packages and deposits)._

## What it is

Pulse writes the journals for the finance sub-ledgers itself. A job finds what changed in each sub-ledger, a pure builder turns each item and the posting rules into balanced journal lines (or the reasons it cannot), and the database posts them through `acc_post_from_source` (22A), idempotent on the item and its version. Before the **ledger start** nothing posts: Tally is the book of record, and the engine only stores a **preview** that Finance compares with the Tally mirror month by month. Nothing here writes a sub-ledger table or calls Unite.

## What exists

| Piece | Where |
|---|---|
| Migration (paste file 44, needs 43 and 41 first) | `supabase/migrations/20261109000100_accounting_posting.sql`, `deploy/supabase-paste/44_accounting_posting.sql` |
| Pure rules and builders (unit-tested) | `lib/accounting/posting/types.ts` (sources, rule kinds, reasons, context parser), `rules.ts` (rule catalogue `RULE_KINDS`, `findRule`, `Resolver`, `payerKindOf`, `missingMappings`), `lines.ts` (fils arithmetic, `LineSet`), `builders.ts` (one builder per source, `buildFor`, `applyItem`), `preview.ts` (the comparison) |
| Runner | `lib/accounting/posting/runner.ts` (`runAccountingPosting`, `runPostingForOrg`, `retryItems`, `buildJournalForSource`, `PostingPort` / `adminPort`), job `lib/jobs/handlers/accounting-post.ts` (task `accounting_post`, name `accounting.post`, pg_cron `pulse:accounting_post` at minutes 7, 22, 37, 52) |
| Loaders | `lib/accounting/posting/server.ts` |
| Pages | `/accounting/posting-rules` (Setup), `/accounting/waiting` (Overview), `/accounting/posting-preview` (Reports); the ledger start on `/accounting/entities` |
| Help | guide `accounting-posting` in `lib/help/guides.ts`; release note at the top of `lib/help/whats-new.ts`; error sentences in `lib/accounting/errors.ts` |

## The ledger start (central rule)

`acc_entities.ledger_start_date` (null = not set). **Every posting dated before it, or while it is null, is refused with hint `before_ledger_start`**, except `source_kind` `tally_import` and `opening` and the reversals of those journals. The check sits in `app.acc_post_internal` (redefined with the one added check), so manual journals, source postings, reversals and automatic reversals all pass it, and again early in `acc_post_from_source` (redefined, otherwise unchanged) so an older version is never reversed for a replacement that cannot post. A manual journal of voucher type opening is not exempt by itself: date it on or after the ledger start, or post opening balances as source `opening` (22I).

Set by `acc_set_ledger_start(org, entity, user, date)` (needs `accounting.settings.manage`, checked in SQL too); the Entities page asks for the typed word START and audits `accounting.ledger_start.set`. A trigger on `acc_entities` (every role) refuses, **once Pulse has posted any journal that is not a Tally import or opening journal (or their reversal)**: clearing the date, moving it earlier (Pulse would then post a stretch Tally already holds) and moving it past the first such journal (that journal would sit in Tally's stretch). Before Pulse has posted, the date moves freely. Setting it resets the runner's cursors so every item is looked at again (what was a preview may now post).

**Effect on other slices (22E to 22I):** call `acc_post_from_source` as before and treat `before_ledger_start` like `period_closed` (wait, show the sentence). Until the date is set, every non-import posting in every slice is refused.

## Posting rules (`acc_posting_rules`)

Data, not code: `(kind, key, qualifier) -> account` (and a tax code for `service_tax`, optionally for `expense` and `bank_charges`). `'*'` means any; the most specific rule wins: (key, qualifier), (key, *), (*, qualifier), (*, *). Keys match without case or repeated spaces; the trigger stores payment modes upper case and payer kinds lower case, and checks the account is a ledger (never a group) of the org and the tax code is the org's. A rule on an account deactivated later makes its items wait (`account_inactive`).

| Kind | Key / qualifier | Used for |
|---|---|---|
| revenue | service category / branch | invoice lines (gross) |
| service_tax | service category / payer kind | the VAT code of a line: **never guessed**; none means the invoice waits with `no_tax_code` (OQ-120). Payer kind lets a corporate recipient get 5% (VATP016) |
| receivable | insurance, self_pay, corporate / payer id | insurer share per payer, patient share, corporate invoices |
| patient_advance | - | advances left on a payment (contract liability) |
| payment_mode | Unite mode / branch | cash per branch, card, Tabby, EPG clearing; ADVANCE (paid from an advance) |
| discount, write_off, credit_note, rounding | - | invoice adjustments |
| vat_output, vat_input | - | fallback when a tax code has no VAT account |
| expense | supplier / voucher category / branch (+ tax code) | bills and payee-not-supplier vouchers; BLK5 = cost, RC5 = reverse charge |
| payable | supplier id | supplier control |
| bank | pay-from key, method or bank account id / branch | vouchers, payouts, remittances, settlements |
| revshare_expense, revshare_payable | doctor | revenue-share accrual and payout |
| provider_cost, provider_cost_offset | provider kind | lab and referral statements |
| cashup_over_short | - / branch | cash-up variances |
| bank_charges | payment mode (+ tax code) | settlement fees (a 5% code splits the fee into charge and input VAT) |
| denial_writeoff, denial_allowance | payer | final denials (the allowance only when the setting is on, OQ-126) |

**Seeding** (`acc_seed_posting_rules`, idempotent, never overwrites a rule; run by the migration for every org, for new orgs by `orgs_seed_finance_phase22d` after the 22A chart trigger, for a new branch by `fin_ref_branches_acc_seed_rules`, and by the "Add missing defaults" button): first from the old `fin_ref_account_map` (account by code or name) and `fin_ref_tally_ledgers` (account by ledger name; useful once 22I has imported Tally's ledgers), then defaults on the 22A chart: receivables 1200 / 1210 / 1220, payment modes CASH per branch (1100-<branch>), CARD 1300, TABBY 1310, EPG 1320, ADVANCE 2330, every mode Unite, the cash-ups or the settlement rules use (by name), discounts 6600, write-offs 6610, credit notes 4990, rounding 6900, VAT 2200 / 2210, payable 2100, bank 1150 (and "cash" per branch), revenue share 5110 / 2110, lab cost and offset 5100, cash over and short 6920, bank charges 6500, denials 6620, revenue per service category (a name guess: consult 4100, lab 4120, pharm 4130, procedure 4110, else 4190) and expense per category only where the name is clear (rent, utilities, salaries, consumables, lab, bank charges). It adds five ledgers to the chart: 1220 Corporate receivable (control), 2330 Patient advances and deposits, 4990 Sales credit notes, 6620 Insurance denials written off, 6920 Cash over and short. **No VAT code is ever seeded.** The old tables are read, never dropped.

**Settings** (`acc_posting_settings`): expected-rejection allowance (off), package invoices hold / post (hold), rounding tolerance (1.00), VAT tolerance (0.05), paused sources.

The **Posting rules page** shows "Not mapped yet": every service category (revenue per branch, VAT code per payer kind), payment mode (per branch), expense category, provider kind and single-account kind the sub-ledgers use today without a rule (`acc_posting_needed_keys` + `missingMappings`), each with a Map button.

## The builders (`lib/accounting/posting/builders.ts`)

Each takes the sanitised record `acc_posting_load` returns (ids, codes, dates, amounts: **never a PIN, name or free-text remark**) and returns post / reasons / nothing / withdraw. Dimensions not in the reference data (an unknown doctor, branch or payer) are left off the line rather than refusing the posting.

| Source (`source_kind`, `source_id`) | Journal | Withdrawn (reversed) when |
|---|---|---|
| Unite invoice (`unite_invoice`, invoice number), sales, transaction date | Cr revenue per line (category, branch; gross = net + discount) with the category's VAT code; Dr discount; Cr VAT output (Unite's VAT, checked against the code's rate within the tolerance, else `vat_mismatch`); Dr receivables: on an insurance invoice the claims matched to it in Diligence (per payer, `initial_net`) are the insurer share and the rest is the patient's; **before any claim is matched the whole total is the insurer's (payer unknown)**, and the invoice posts again when a claim matches; claims above the total wait (`claims_exceed_invoice`); total vs lines difference to rounding up to the tolerance, beyond it waits (`unbalanced`); Dr write-off and credit notes against the main receivable (the largest payer on an insurance invoice) | deleted in Unite |
| Unite payment (`unite_payment`, payment id; refunds `refund:<id>`), receipt / payment | Dr the mode's account (paid + advance); Cr patient (or corporate) receivable (paid), Cr patient advances (advance). Refund: Dr receivable, Cr the mode. A copay on an insurance invoice reduces the patient share | not current, or the invoice is deleted |
| Remittance (`remittance`, batch id), receipt, paid on | Dr bank (the account that receives insurance, else `*`); Cr each payer's insurance receivable | the batch is removed |
| Final denial (`denial`, case id), journal, resolved date | Dr denials written off (or the allowance), Cr the payer's receivable | the case is not lost / written off any more |
| Supplier invoice (`supplier_invoice`, id), purchase | Dr expense (net; blocked VAT: net + VAT); Dr input VAT; reverse charge: Dr input / Cr output 5% of net; Cr supplier payable. VAT on a zero / exempt / out-of-scope code waits; a foreign-currency bill waits | void |
| Voucher (`voucher`, id), payment, payment date | Dr supplier payable (part payments and advances simply reduce the supplier's balance) or the category's expense; Cr the bank / cash it was paid from | not paid |
| Revenue share (`revshare_run`, run id), journal, month end | Dr revenue share expense, Cr doctor payable, per doctor, once the run is approved (the CEO) | the run is back before approval |
| Revenue-share payout (`revshare_run`, `payout:<line id>`), payment, paid on | Dr doctor payable, Cr bank | the payment is undone |
| Lab and referral statement (`lab_charge`, statement id), journal, month end | Dr provider cost by doctor and branch (the frozen allocation), Cr the offset (by default the same cost account: the bill already booked the cost, the statement only spreads it; an accrual account changes that) | reopened |
| Cash-up (`cashup`, id), journal, business date | each mode's variance: the mode's account at the branch against cash over and short | reopened |
| Settlement (`settlement`, bank match id), receipt, bank value date | Dr bank (what arrived), Dr bank charges (gross minus arrived, split into charge and input VAT when the mode's charge rule has a 5% code), Cr the mode's clearing (gross: the Unite collections of that mode and day, or the processor's payout lines) | the match is undone, or the reconciliation is not signed |

A package invoice waits (`package_deferral`) while packages are held (OQ-127). Narrations carry ids only and pass through `cleanNarration`.

## The runner

Per org with a ledger and per source kind: `acc_posting_candidates` (changed since the cursor, oldest first, at most 100; items touched in the last 2 minutes wait for the next run because a late commit keeps its earlier timestamp; vanished settlements and remittances with a live journal come back so they are withdrawn), `acc_posting_load`, the builder, then `acc_posting_apply` (one sub-transaction per item):

- **post**, dated before the entity's ledger start (or none set): stored as a **preview** (`acc_posting_preview`, per item and account; replaced when the item changes, removed when it posts, waits or is withdrawn); nothing is posted. An item with a live journal whose date moved before the start waits with `before_ledger_start`.
- **post**, from the ledger start on: compared with the content hash of the live journal; unchanged is left alone; changed is posted as the next version through `acc_post_from_source` (the old version reversed there). A refusal makes the item wait with the database's code (`period_closed`, `month_locked`, `doctor_unknown`, ...).
- **reasons**: waits with the builder's first code and every detail ("Revenue: Dermatology (P)", "VAT code for Cosmetic").
- **nothing / withdraw**: a live journal is reversed (dated today or its own date if later), the preview removed.

Then it retries waiting items (oldest attempt first, at most 100, not those just handled) and runs the 22A automatic reversals (`acc_run_auto_reversals`), which needed this job. Counts only are logged. `acc_posting_status` holds one row per item (posted, waiting, preview, nothing, withdrawn) with the reason, detail, date, amount, version, content hash and journal.

**Waiting to post** (`accounting.ledger.view` or `.journals.approve`): counts by reason, the list, Try again per item, per reason or all (`accounting.journals.approve`, `retryWaiting`, audited with counts). **Posting preview** (`accounting.reports.view` or `.ledger.view`): account x month, Pulse preview against the ledger (the Tally mirror before the start) and the difference, differences only by default (`acc_posting_preview_report`, at most two years).

**For 22J:** `buildJournalForSource(admin, orgId, kind, id)` returns the lines Pulse would post for one item (or why it cannot) without posting, after the caller's `can()`.

## Database

All `public.acc_posting_*`, RLS on: rules and settings readable with any accounting key (`app.acc_can_view`); status with the journal keys (`app.acc_can_read_journals`); preview with the journal keys or `accounting.reports.view`; `acc_posting_cursors` service only (no policy). No write policy anywhere: server actions and SECURITY DEFINER functions (service role only, `search_path = ''`) after `can()`. New service functions: `acc_set_ledger_start`, `acc_seed_posting_rules`, `acc_posting_candidates`, `acc_posting_load`, `acc_posting_context`, `acc_posting_needed_keys`, `acc_posting_apply`, `acc_posting_set_cursor`, `acc_posting_preview_report` (in `PHASE22_SERVICE_FUNCTIONS`). Tables in `PHASE22_TABLES` / `seedPhase22Rows` and `PHASE22_SERVICE_ONLY_TABLES`. Four read indexes on `updated_at` of `fin_invoices`, `fin_invoice_lines`, `fin_payments`, `ins_claim_activities`. No new permission keys.

## Decisions worth knowing

- **Source version** = the engine's own counter per item, bumped when the built journal's content hash changes (not Unite's `version` alone): an invoice also changes when a claim is matched to it or a rule changes the split, and only a real change is reversed and posted again. The item's Unite version still drives the "changed since" scan.
- **Patient vs insurer share** comes from the Diligence claims matched to the invoice; Unite does not deliver a patient-share field. Until the claim is matched the whole insurance invoice sits with the insurer (payer unknown) and a copay paid at the desk shows as a credit on the patient receivable; both correct themselves when the claim matches. To be confirmed with Finance.
- **Write-offs and credit notes** on an insurance invoice reduce the largest payer's share. To be confirmed with Finance.
- **Lab statements reclassify** rather than add cost by default (offset = the same cost account), so a bill entered in 20D and the statement are not counted twice. Point the offset at an accrual account to accrue instead.
- **Vouchers** debit the supplier's payable with the whole amount (as the 20D Tally export does), so part payments and advances work without allocations.
- **Bills with VAT and no tax code on their category** take recoverable input VAT (as the 20D Tally export does); a code on the expense rule says otherwise (blocked, reverse charge). Sales VAT is never assumed.
- **Settlements post when the bank reconciliation is signed**, not when a match is made, so undoing a match in an open reconciliation does not churn the ledger.
- **Invoice by invoice, not daily summaries** (OQ-124 recommends summaries for the Tally push): the ledger keeps one journal per invoice so an amendment reverses exactly one journal; 22J can summarise what it pushes to Tally.
- **OQ-126**: only the hook exists (the setting routes final denials to the allowance account); the monthly expected-rejection estimate and its true-up are not built.
- **OQ-127**: package invoices wait by default; deferral per session and breakage are not built.

## How it was verified

- Unit (`tests/unit/accounting/posting/`, 33 tests, synthetic fixtures `context.synthetic.json` and `sources.synthetic.json`): rule specificity and normalisation, payer kinds, the context parser, missing mappings, fils rounding and netting, month ends; every builder: revenue by category and branch with VAT codes, discounts, VAT output, the insurer / patient split from claims, no claims yet, claims above the invoice, the corporate code, `no_tax_code` / `no_rule` / `vat_mismatch`, rounding and its limit, packages, deleted invoices, credit notes; payments, advances, refunds, superseded payments, unmapped modes; remittances, denials and the allowance setting; bills with recoverable, blocked and reverse-charge VAT and a mismatch, foreign currency, void; vouchers to the supplier or the expense, from the bank or the branch cash; the revenue-share accrual and payout; lab spreading and an accrual offset; cash-up variances; settlements with the fee and its VAT; dispatch; the nav, guide, release note and error sentences; the preview comparison.
- Database (`tests/db/accounting-posting.test.ts`, 17 tests): the ledger start (refused while unset, Tally imports, opening journals and their reversal allowed, the permission, refused before and allowed on the date, free to move before Pulse posts, then not cleared, not earlier, not past the first journal, even for the database owner); the default rules (new org, cash per branch, no VAT code, the old maps winning, idempotent, the guard); the runner end to end on every source (12 balanced journals with the expected lines, 2 previews, 2 waiting with reasons), idempotent re-runs and a full re-scan, an amended invoice reversed and posted as version 2, a deleted invoice reversed, waiting items posting once their rule and VAT code exist, a closed period waiting and posting after reopening, the preview rows and the comparison with a Tally-import journal, moving the start back refused, `buildJournalForSource`, the keys in use, RLS for the Accountant and another org's admin, nobody writes directly, per-org isolation. `tests/db/accounting-core.test.ts` now sets the ledger start for its orgs; `tests/db/security-guard.test.ts` sweeps the new tables and lists the functions.
- Typecheck, lint, `pnpm audit:security` (0 unguarded) and the full unit and database suites.

## Not verified

- Not clicked through in a browser (no Supabase auth stack here); the pages were typechecked and linted only. `pnpm build` and the bundle budget were not run.
- No real Unite data (capture is OFF, OQ-94): the invoice types (`INSURANCE`, `SELF PAID`, corporate), payment-mode names and the claim amounts as the insurer share are synthetic assumptions.
- The default revenue and expense accounts are name guesses on the 22A chart; Finance reviews them, and 22I's Tally ledgers replace them.

## Before first use

1. Apply `deploy/supabase-paste/44_accounting_posting.sql` (after 43). It seeds the rules for the existing workspace.
2. Accounting, Posting rules: work through "Not mapped yet". The **VAT code per service category** comes from the tax adviser (OQ-120); until then every invoice waits with "no VAT code" (and Waiting to post shows how many).
3. Leave the ledger start empty during the parallel run: Posting preview then compares Pulse with the Tally mirror (once 22I imports it).
4. At cut-over (OQ-117), set the ledger start under Entities and fiscal years (type START).
