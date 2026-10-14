# Phase 22A notes: accounting ledger core

_Built 13 Oct 2026 on the 22A worktree branch (based on `claude/funny-clarke-6t7gee` at `e677e37`). Plan: `docs/22_ACCOUNTING_PLAN.md`, sections 1, 2, 4, 5 and the 22A row. Owner decisions of 13 Oct applied: one legal entity with three branches, the fiscal year July to June, everything imported from Tally and Tally kept connected until cut-over._

## What it is

The double-entry general ledger every later accounting slice builds on. Every financial event ends as a balanced journal (`acc_journals` + `acc_journal_lines`); reports read only the ledger. Manual journals are prepared by one person and posted by another; automatic postings from the finance sub-ledgers (22D onwards) arrive through one function, `acc_post_from_source()`, which is idempotent and replaces a changed source by reversal. A posted journal never changes.

## What exists

| Piece | Where |
|---|---|
| Migration (paste file 41, needs 40 first) | `supabase/migrations/20261108000100_accounting_core.sql`, `deploy/supabase-paste/41_accounting_core.sql` |
| Pages (in-page menu from `ACCOUNTING_NAV`) | `app/(app)/accounting/`: dashboard, accounts (chart), journals (list, new, `[id]`, `[id]/edit`), day-book, ledger, trial-balance, periods, entities, tax-codes, cost-centres |
| Trial balance workbook | `GET /api/accounting/trial-balance?from&to[&entity]`, `lib/accounting/tb-xlsx.ts` |
| Pure rules (unit-tested) | `lib/accounting/journal.ts` (validation, rounding, totals, narration masking), `canonical.ts` (+ `journal-hash.ts`), `numbering.ts` (fiscal years, numbers), `accounts.ts` (tree, natures, control kinds, emirates), `tally-groups.ts`, `reports.ts` (trial balance tree, ledger checks), `tax.ts`, `errors.ts`, `nav.ts` |
| Server loaders | `lib/accounting/accounting-server.ts` |
| Shell | "Accounting" in `components/shell/nav.ts` (icon `accounting`, group "Insight & back office", visible with any `accounting.*` key); no Settings page was added |
| Help | guides `accounting`, `accounting-journals`, `accounting-chart`, `accounting-reports`, `accounting-close` in `lib/help/guides.ts`; release note at the top of `lib/help/whats-new.ts` |

## Permissions and presets

The 15 keys of plan §4 in a new "Accounting" group of `lib/auth/permissions.ts`. Presets (`ACCOUNTING_ROLES`, part of `SYSTEM_ROLES`, also seeded by `pnpm finance:seed`): **Accountant** (view, ledger, reports, prepare, sales, receipts, banking, assets, budgets), **Chief Accountant** (all 15), **Auditor** (view, ledger, reports; read-only). The **Finance Manager** gains view, ledger, reports and approve; the **CEO** gains view and reports. The migration creates the three roles in every existing org and grants the extra keys to the existing system Finance Manager and CEO roles (additive, idempotent; a database test checks the result equals the code presets).

Who reads what (row level security): the reference tables (entities, branch mapping, fiscal years, periods, accounts, tax codes, cost centres, number series) for anyone holding any `accounting.*` key (`app.acc_can_view`); journals and lines for `accounting.ledger.view`, `.journals.prepare` or `.journals.approve` (`app.acc_can_read_journals`). The CEO reads the chart and the trial balance (a service-role function after `can()`), not journal lines. No table has a write policy: every write is a server action or a SECURITY DEFINER function (service role only, `search_path = ''`) after `can()`.

## Tables

All `public.acc_*`, `org_id` on every row, RLS on.

- `acc_entities` (name, TRN, base currency AED, `fiscal_year_start_month` default **7**, `is_default`, active): exactly one default per org. `acc_entity_branches` (branch code unique per org, entity, `emirate` default Dubai: VAT 201 box 1 splits by emirate).
- `acc_fiscal_years` (start, end, label "FY 2026-27" or "FY 2026", status open/closed; closed is for the year-end close, 22I) and `acc_periods` (entity, year, month 1 to 12, or **13 = the adjustment period** dated the year's last day, status open / closed / locked). Both are created on demand by `acc_ensure_period()`; never deleted; dates never change; a locked period stays locked.
- `acc_accounts`: one **org-wide** tree (decision: every entity uses the same chart; `entity_id`, when set, narrows an account to one entity). `parent_id`, `is_group`, `code` (unique per org), `name` (unique per org, case-insensitive, as Tally requires), `nature` (asset, liability, equity, income, expense; inherited from the parent and checked), `tally_group`, **`affects_gross_profit`** (Tally's flag; true for Direct Incomes / Expenses and Sales / Purchase Accounts, inherited), `control` (receivable, payable, bank, cash, vat_output, vat_input, clearing, retained_earnings), `is_active`, `is_system`, `allow_manual`, `currency`, `description`, **`tally_guid`** (unique per org) and **`tally_alter_id`** for the Tally import and sync.
- `acc_tax_codes` (code, name, rate, kind standard / zero / exempt / out_of_scope / reverse_charge / **blocked**, output and input VAT accounts), `acc_cost_centres`.
- `acc_number_series` (entity, voucher type, fiscal year, prefix, next number): created at the first posting; the next number only goes up.
- `acc_journals` (entity, voucher type, number, date, period, fiscal year, narration, status draft / posted / reversed, source kind / id / version, `reversal_of` / `reversed_by`, maker fields `prepared_by`, `submitted_by/at`, `returned_by/at/remarks`, `approved_by` (null = the system), `posted_at`, `sha256`, `total`, **`is_adjustment`**, **`auto_reverse_on`**, **`tally_guid`** / `tally_alter_id`) and `acc_journal_lines` (account, debit, credit, description, tax code; dimensions branch, department, doctor (`fin_ref_doctors.dha_id`), payer (`fin_ref_payers.payer_id`), supplier, cost centre, generic `party_kind` / `party_id`; foreign currency `currency`, `fx_rate`, `amount_fx`, informative only).
- `record_history` on `acc_accounts` and `acc_journals`; `record_access_log` accepts `accounting_journal` (journal opens always, list screens sampled).

## The rules (all in SQL, for every role)

- **Balanced**: at least two lines, every line exactly one side above zero, amounts positive with at most two decimals (refused, never rounded, in SQL), debits equal credits and above zero. Lines only on active ledgers (not groups) of the org and of the journal's entity scope.
- **Control accounts** take lines only from a source posting or an opening-balance journal; an account with `allow_manual = false` takes no manual lines either.
- **Dimensions** are checked at posting: branch exists (and books into the journal's entity), doctor and payer exist, supplier, tax code and cost centre belong to the org and are active.
- **Maker and checker** (manual journals): saved as a draft by `accounting.journals.prepare`, submitted (validated), then posted by `accounting.journals.approve` held by a **different person** from the preparer and the submitter, quoting the **sha256 of the content they reviewed** (refused otherwise, `hash_mismatch`). Editing a draft makes the editor its preparer and takes it out of the queue; the checker can send it back with a reason. CHECK constraints repeat the different-person rule on the table. Opening-balance journals also need `accounting.import`.
- **Posted is permanent**: a trigger refuses any change to a posted journal or its lines and any delete, for every role including the service role and the database owner; the only change is posted -> reversed with `reversed_by`, made inside the reversal function. A draft cannot be marked posted except inside the posting function.
- **Numbers** are allocated at posting, gap-free per entity, voucher type and fiscal year, under a row lock in the posting transaction: `JV/2026-27/00001` (prefixes JV, CTR, PMT, RCT, SAL, PUR, CRN, DBN, OPB; the year part is "2026" for a calendar year). A refused or rolled-back posting gives its number back.
- **Periods**: a locked period refuses every posting; a closed period accepts postings only from someone with `accounting.periods.manage` (so automatic postings into a closed period are refused); a month the CEO signed off in Finance (`app.fin_month_is_locked`, the Phase 18 lock) refuses every posting. Open <-> closed; closed -> locked is final (typed word LOCK in the UI).
- **Adjustment period**: a journal marked `is_adjustment` must be dated the fiscal year's last day, is posted only by someone with `accounting.periods.manage`, and lands in the year's 13th period, so auditors' adjustments do not reopen month 12. **Decision:** the CEO month lock does not apply to the adjustment period (it is the designed way to adjust a signed-off year); every other rule does.
- **Reversals** (`acc_reverse_journal`, `accounting.journals.approve`): a posted, not yet reversed journal that is not itself a reversal; dated on or after the original, with a reason; the mirror journal (debits and credits swapped, same dimensions) is posted with `source_kind = 'reversal'` and both are linked.
- **Automatic reversals**: a posted journal with `auto_reverse_on` is reversed on that date by `acc_run_auto_reversals(p_org, p_today)` (idempotent; each journal succeeds or fails on its own, with the failure code). The scheduled job that calls it comes with the posting engine (22D).
- **Fiscal years** follow each entity's start month (July by default): 30 June and 1 July are in different years and different number series. The start month cannot change once a fiscal year exists.

## The contract for later slices: `acc_post_from_source`

```sql
public.acc_post_from_source(
  p_org_id uuid,
  p_entity_id uuid,          -- null = the org's default entity
  p_source_kind text,        -- unite_invoice, unite_payment, supplier_invoice, voucher, remittance, denial, revshare_run,
                             -- lab_charge, cashup, settlement, bank_line, opening, tally_import, fixed_asset, depreciation,
                             -- sales_invoice, receipt, payroll (CHECK list; extend by migration)
  p_source_id text,          -- the item's id (1 to 200 characters); for tally_import, the Tally GUID
  p_source_version integer,  -- >= 1; bump it whenever the item's accounting changes
  p_date date,
  p_voucher_type text,       -- journal, contra, payment, receipt, sales, purchase, credit_note, debit_note, opening
  p_narration text,          -- 1 to 300 characters; ids and amounts, never a patient's name (redact first)
  p_lines jsonb              -- see below
) returns jsonb              -- { id, number, status, sha256, total, journal_date, created, replaced }
```

Service role only; the caller has run `can()` (or is a job). One transaction, serialised per source item (advisory lock):

1. The same `(kind, id, version)` already exists: returns it with `created: false` (whatever its status). Never posts twice.
2. A higher version exists: refused, `stale_version`.
3. A lower version is posted: it is reversed first (dated the later of `p_date` and its own date, reason "replaced by version N"), then the new version is posted; `replaced` is the old journal's id. At most one posted journal per source item (unique index).
4. Posted by the system (`approved_by` null): every rule above applies except maker / checker; a closed period refuses it (the posting engine queues and retries), as do a locked period and the CEO month lock.

A `tally_import` journal carries its GUID in `tally_guid` (unique among live journals of the org). Errors carry a stable code in the HINT (`lib/accounting/errors.ts`).

**Line shape** (`p_lines`, an array, line numbers follow the array order, at most 500):

```json
{
  "account_code": "4100",        // or "account_id": "<uuid>" (one of the two)
  "debit": 100.00,               // exactly one of debit / credit above zero; at most 2 decimals (round first: roundMoney)
  "credit": 0,
  "description": "short text",   // optional, at most 200 characters, redacted by the caller
  "tax_code": "VAT5",            // optional; or "tax_code_id"
  "branch_code": "P",            // optional; must exist in fin_ref_branches and book into the entity
  "department": "Dermatology",   // optional, at most 60
  "doctor_id": "DHA-...",        // optional; fin_ref_doctors.dha_id
  "payer_id": "...",             // optional; fin_ref_payers.payer_id
  "supplier_id": "<uuid>",       // optional; fin_suppliers.id
  "cost_centre": "LEASE",        // optional; or "cost_centre_id"
  "party_kind": "customer",      // optional with party_id: customer, supplier, payer, doctor, employee, other
  "party_id": "...",
  "currency": "USD", "fx_rate": 3.6725, "amount_fx": 27.23   // optional, all three together; base amounts rule
}
```

`lib/accounting/journal.ts` exports `JournalLineInput` (the same shape), `roundMoney`, `validateJournal` (the same codes, to check before calling) and `cleanNarration` / `cleanDescription`.

## Reports

`acc_trial_balance(org, entity|null, from, to)`, `acc_ledger(org, account, from, to, limit, offset)` and `acc_day_book(org, entity|null, from, to)` aggregate in SQL and return jsonb. Posted and reversed journals both count (a reversal is its own journal). Balances are debit minus credit. Balance-sheet accounts open with everything before `from`; **income and expense accounts open at the start of the fiscal year holding `from`** (each entity's own year), and earlier years' profit or loss is one figure (`earlier_years_pl`) until the year-end close (22I) moves it to retained earnings; the totals still net to zero. The ledger of a group covers every ledger under it, and its running balance covers the whole range even when paged. The day book returns at most 1,000 journals (`truncated`).

## The default chart (`acc_seed_chart`)

Idempotent (skips existing codes and names), run for every existing org by the migration, for every new org by the `orgs_seed_finance_phase22` trigger (after the finance reference seed, which creates the branches), and again when a branch is added (`fin_ref_branches_acc_seed`, only once the chart exists). It creates:

- the default entity (named after the org, July fiscal year) mapping every branch (emirate Dubai);
- **all 28 Tally predefined groups** as system groups (15 primary, 13 sub-groups; codes `G-CAP`, `G-CA`, ... in `lib/accounting/tally-groups.ts`). Tally has four natures and puts Capital Account under liabilities; Pulse keeps five and calls Capital Account and Reserves & Surplus equity, storing the Tally name in `tally_group`, so the import maps either way. Suspense A/c and Branch / Divisions are liabilities, Misc. Expenses (ASSET) an asset, as in Tally;
- a UAE clinic ledger set: share capital, retained earnings (control), bank, insurance and patient receivables (control), card / Tabby / EPG clearing (control), prepayments, deposits, equipment, furniture, accumulated depreciation, supplier and doctor revenue-share payables (control), VAT output 5% and VAT input (control), accrued expenses, consultation / procedure / laboratory / pharmacy / other medical revenue, other income, lab and referral costs, doctor revenue share, consumables, salaries, rent, utilities, depreciation, bank and card charges, discounts allowed, bad debts, rounding off, suspense, opening balance difference, and one cash ledger per branch (`1100-<branch>`, control cash);
- tax codes VAT5 (standard 5%, output and input VAT), ZR, EX, OOS, RC5 (reverse charge 5%, both accounts) and BLK5 (blocked input VAT 5%, no VAT account: it is a cost).

## Decisions worth knowing

- **Accounts are org-wide**, shared by every entity (`entity_id` optional). Al Das is one entity; entity pickers are hidden while there is one.
- **The adjustment period bypasses the CEO month lock** (see above). Flagged for the Finance Manager's confirmation.
- **A locked period is final.** There is no unlock, by design (the UI asks for the typed word). A mistaken lock needs a migration.
- **Reversals keep the original's voucher type** and number series (a reversed sale is numbered SAL/...).
- The default entity cannot be switched to another one in 22A (no UI; the guard refuses removing the default flag).
- **Parties** are only the generic `party_kind` / `party_id` columns on lines; the customer master comes with receivables (22E).
- Narrations, descriptions and reasons pass through `redactStatementText` in the server actions (IBAN, card, account and phone numbers and e-mails masked); the posting engine must do the same.
- `app.record_history_capture()` now skips deletes made by the org cascade (every org holds tracked accounts, and the history row would fail its foreign key). Otherwise unchanged.

## How it was verified

- Unit (`tests/unit/accounting/`): validation, rounding and totals, narration masking, error sentences; fiscal years for July, January and March starts (30 June vs 1 July, leap February), numbers and prefixes; the canonical text (exact shape and escaping) and its hash; the account tree, Tally catalogue (28 groups, gross-profit flags, natures), trial-balance shaping with group subtotals, Dr/Cr, ledger consistency, date ranges, VAT; navigation, presets and the shell item. `tests/unit/permissions.test.ts` (new presets).
- Database (`tests/db/accounting-core.test.ts`, Postgres 16): seeding (groups equal the TypeScript catalogue, ledgers, cash per branch, tax codes, idempotent, new-org and new-branch triggers); who reads what for Accountant, Chief Accountant, Finance Manager, Auditor, CEO, Finance, a user without membership and another org's admin; nobody writes directly; functions service-role only; unbalanced / one-line / two-sided / over-precise / group / unknown account, branch, doctor and tax code refused with nothing left behind; control accounts and opening balances; maker and checker, hash binding, send back, editor becomes maker, the table CHECK; posted journals and lines immutable for the service role and the owner; gap-free numbering (a refused posting gives its number back; 24 concurrent posts get exactly 1 to 24); July vs January fiscal years and `fy_in_use`; closed and locked periods and the CEO month lock; the adjustment period; `acc_post_from_source` idempotence, version replacement, stale versions, the Tally GUID; reversals and their links; automatic reversals; the trial balance nets to zero and every closing equals the account's ledger; earlier years' profit; the day book; SQL vs TypeScript canonical text and hash parity; the chart guard (system groups, natures, cycles, used ledgers, history); the migration's role grants equal to the code presets (idempotent). `tests/db/security-guard.test.ts`: the new tables in the cross-org sweep (`PHASE22_TABLES`, `seedPhase22Rows`) and the 14 functions service-role only.
- Typecheck, lint, `pnpm audit:security` and the full unit and database suites.

## Not verified

- **Not clicked through in a browser** (no Supabase auth stack here): pages, forms and the Excel download were typechecked and linted only. `pnpm build` and the bundle budget were not run.
- The default ledger set and tax codes are a sensible starting point, not the clinic's Tally chart; 22I imports Tally's own ledgers (OQ-118 decided: as they are) and maps them by `tally_group`.
- Which service categories are zero-rated, exempt or standard-rated is still OQ-120; nothing in 22A assigns a tax code to a service.

## Before first use

1. Apply `deploy/supabase-paste/41_accounting_core.sql` (after 40). It seeds the chart for the existing workspace and creates the three roles.
2. Settings, Users: give the accountants **Accountant**, the head of accounts **Chief Accountant**, external auditors **Auditor**. The Finance Manager can already post journals.
3. Accounting, Entities and fiscal years: enter the TRN; check the fiscal year start (July) before the first posting, it cannot change afterwards.
4. Review the chart and the VAT codes with the accountant before 22I imports Tally.
