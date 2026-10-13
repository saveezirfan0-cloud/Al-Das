# Phase 20F notes: doctor revenue share with a complete trail

_Built 13 Oct 2026 (what's-new dated 1 Nov, the planned release) on a worktree of `claude/funny-clarke-6t7gee` at `bbbd7db`. Plan: `docs/20_FINANCE_CONTROL_PLAN.md`, slice 20F; deck slide 7._

## What it replaces

Hardik's biggest manual job (finance meeting): doctor incentives, where "each calculation or each offer has been designed uniquely", worked out in spreadsheets each month. The deck asks that every calculation leaves a complete trail (source data, approved formula, exclusions and adjustments, calculation, finance verification, approval, accounting, payment, payment reference) so that "nobody should have to ask six months later how we arrived at this number". Lab and external-referral costs are charged to the doctor's account before the share is finalised (by working day 7).

## What exists

| Piece | Where |
|---|---|
| Monthly runs: build or rebuild the draft after the month ends, the nine-step trail with who and when, every doctor's calculation step by step, verify (Finance), approve (CEO, a different person), the accounting reference, each doctor's payment date and reference, the liability (approved, not yet paid), recent months | `/finance/revenue-share` (`app/(app)/finance/revenue-share/page.tsx`, `controls.tsx`, `actions.ts`) |
| Schemes: per doctor, every version with its rule in words, fingerprint, who verified and approved; new draft / edit with a simple form (share %, category rates, deduction % per charge kind, threshold, guarantee); verify, approve, retire, delete a draft | `/finance/revenue-share/schemes` |
| Doctor charges: per month, totals per doctor and kind, the list with source and reference, add one, delete one, CSV upload with template | `/finance/revenue-share/charges` |
| Trail CSV (one row per step per doctor, the sign-offs, the accounting reference and each payment), rendered from the stored snapshot, audited with `recordAudit` and `recordExport` | `GET /api/finance/revenue-share?month=yyyy-mm` |
| The rule vocabulary and the calculator (pure, unit-tested); trail CSV; charges CSV parser; the scheme form | `lib/finance/revshare.ts` |
| Service-role reads (inputs, liability, names, categories) | `lib/finance/revshare-server.ts` |
| Migration | `supabase/migrations/20261101000100_finance_revenue_share.sql`, paste file `deploy/supabase-paste/31_finance_revenue_share.sql` |

**Permissions.** `finance.revshare.view` (Finance, CEO), `finance.revshare.manage` (Finance: schemes, charges, the draft run, accounting and payment references), `finance.revshare.verify` (Finance), `finance.revshare.approve` (CEO). Payouts are doctor compensation: the Medical Director, Billing, Insurance and Cost / Payroll get none of these keys and see neither the pages nor the rows. The migration grants the keys to the existing system Finance and CEO roles. The Finance preset holds both `manage` and `verify`; to keep the preparer and the verifier apart, give `verify` only to the Finance Manager (a custom role) and take it out of the Finance role (see "Decisions").

**Tables** (RLS on all four, a select policy on the four revshare keys, no write policy; writes are the service role after `can()`):

- `fin_doctor_charges`: org, month, doctor DHA id, kind (`lab`, `referral`, `consumables`, `other`), amount above 0, source (`manual`, `upload`, later `lab_recon` / `referral_recon` from 20E), reference, note (masked with `redactText`), created by. The input the lab and referral slice will fill.
- `fin_revshare_schemes`: org, doctor, version, start month, status (`draft`, `verified`, `approved`, `retired`), rule (jsonb, shape checked by `app.fin_revshare_rule_valid` as a CHECK and by Zod), `rule_hash` (sha256 of the rule, set by the trigger), note, who verified, approved and retired and when. At most one version in preparation per doctor.
- `fin_revshare_runs`: org, month, status (`draft`, `verified`, `approved`, `posted`, `paid`), snapshot (jsonb: every input, the scheme version and its hash per doctor, every calculation step, the result) and `snapshot_hash` (set by the trigger), total payout, built / verified / approved / posted by and at, accounting reference, paid at.
- `fin_revshare_lines`: one per doctor of a run: scheme id and version used, payout, payment date, payment reference, recorded by and at.

**SQL** (SECURITY DEFINER, `search_path = ''`, service role only, in `PHASE20_SERVICE_FUNCTIONS`): `fin_revshare_inputs(org, month)`, `fin_revshare_scheme_save`, `fin_revshare_scheme_step` (verify / approve / retire / delete), `fin_doctor_charges_replace_upload`, `fin_revshare_store_draft`, `fin_revshare_run_step` (verify / withdraw / approve), `fin_revshare_post`, `fin_revshare_record_payment`, `fin_revshare_liability(org)` (for the board pack, 20G).

## The rule (closed vocabulary; nothing is evaluated)

```
{ basis: "net_revenue", default_rate: 0..1, category_rates?: { "<service category>": 0..1 },
  deductions: { lab?: 0..1, referral?: 0..1, consumables?: 0..1, other?: 0..1 },
  threshold?: amount, minimum_guarantee?: amount }
```

Rates have at most 4 decimals (a percentage with 2), amounts at most 2 and at most 1,000,000,000. Any other key, basis or shape is refused, by Zod in the form and by the database CHECK (a database test feeds the same 18 cases to both). A new scheme starts with lab and referral deducted at 100 %.

**Payout** = max(minimum guarantee or 0, Σ category rate × category net × eligible − Σ deduction share × charges of that kind, 0), where:

- **Revenue** is the net of current invoice lines of invoices not deleted, by transaction date within the month, on the configured doctor basis (ordering / performing, else the invoice doctor; the same rule as the Doctors page, the flash report and the billing mix), by service category from reference data (Unmapped when the item has none). Doctor ids are compared trimmed and upper case.
- **Category rate**: the category's own rate if the scheme names it (exact category name, from the reference list), otherwise the default rate.
- **Threshold** (monthly): eligible = (base − threshold) / base when the base exceeds it, else 0; without a threshold, 1. It is applied pro rata to every category.
- **Deductions**: each charge kind's total for the month × its share in the rule (a kind the rule does not name is not deducted, and the step says so).
- **Guarantee**: the payout is never below it; never below zero either (a shortfall is not carried forward, OQ-115).
- **Rounding**: each category's earned amount and each deduction is rounded to 2 decimals half away from zero, with exact integer arithmetic; the share is the sum of the rounded amounts, so the steps shown always add up to the payout.
- **Which version**: the newest approved version (by start month, then version) whose start month has begun; if that newest one is retired, the doctor has no scheme from its start month (an older version is never revived).

Doctors with revenue or charges but no approved scheme, and revenue with no doctor, are listed under "Not in this run" so totals can be reconciled; they get no line.

## The trail, and what the database guarantees

1. **Source data.** `fin_revshare_inputs` returns the month's revenue by doctor and category (with line and invoice counts), every charge row (id, kind, amount, source, reference), the applicable scheme version per doctor (id, version, start, rule, rule hash, who verified and approved) and the doctor names. The server computes the run from exactly that JSON; `fin_revshare_store_draft` refuses the snapshot unless its inputs equal what the function returns at that moment and every doctor with an approved scheme has exactly one result on that scheme version. Rebuilding a draft replaces it and its lines.
2. **Approved formula.** A scheme version is drafted (manage), verified (verify) and approved (approve) by two different people, each bound to the rule's sha256 they saw; editing a verified draft returns it to draft. An approved version never changes and cannot be deleted (trigger, every role); a change is a new version.
3. **Exclusions and adjustments.** The month's doctor charges, deducted per the scheme; deleted invoices and superseded lines are excluded by the input query.
4. **Calculation.** `lib/finance/revshare.ts` (`revshare-1`); every step is in the snapshot and on the page.
5. **Finance verification** (draft → verified) is bound to the snapshot sha256 and refused if the inputs changed since the draft was built ("rebuild it, then verify"). From then on the snapshot, its hash and the lines can never change, and the month's charges are frozen with it. Finance can return a verified run to draft until the CEO approves.
6. **Approval** (verified → approved) by a different person (function and CHECK constraint), on the same hash.
7. **Accounting** (approved → posted): the Tally journal or voucher reference.
8, 9. **Payment and reference** per doctor (posted only; a line with nothing to pay needs none). A payment can be corrected while the run is posted; once every payout is paid the run is `paid` and frozen. Recording payments is allowed after the month is locked (see below).

**Liability**: lines of approved or posted runs with a payout and no payment reference, per month and in total (`fin_revshare_liability`), shown on the page and ready for the board pack.

**Locked month** (the month-end close's CEO sign-off): charges for the month cannot change; a draft cannot be built, rebuilt or returned to draft. Verifying, approving, posting and paying only sign or record facts about figures that are already frozen and stay possible.

**Drift**: when invoices, charges or schemes of the month change after the draft was built, the page says so (draft: rebuild before verifying; verified or later: the run does not change).

## How it was verified

- `tests/unit/finance/revshare.test.ts` (33): the synthetic month (`fixtures/revshare.synthetic.json`, six doctors worked out by hand: plain rate with lab and referral deductions, category override with a threshold pro rata, guarantee, charges above the share, threshold above the base, guarantee with no revenue; one doctor without a scheme; revenue without a doctor), default and category rates (also 0 % and exact name match), threshold edges (at, below, one cent above, 0, none, negative base), deductions (partial, unnamed kinds, default rule), guarantee (applies, equal, higher, zero guarantee), never negative, rounding (halves away from zero, credits, sums tie, 1e9 amounts exact), the closed vocabulary (unknown keys, bases, ranges, decimals, category names, 30 categories, null), the form (percentages, unknown or repeated category), the charges CSV, the trail CSV (formula cells neutralised).
- `tests/db/finance-revenue-share.test.ts` (20, Postgres 16): inputs are service-role only; parity of the SQL inputs with the fixture rules (deleted invoice, other months, superseded line, unmapped item, other org excluded); version selection (old, current, future, retired not reviving the older one); doctor basis; the stored draft equals the hand-worked payouts and its hash is the sha256 of the snapshot; tampered inputs, missing or wrong results, another month, an unfinished month and another org's snapshot refused; RLS (Finance, CEO and the admin read; Medical Director, Billing, Insurance, Cost / Payroll, another org and a stranger read nothing; nobody writes directly); verify bound to the hash and to current inputs; frozen run, lines and charges after verification; two people and the hash for approval (also via the CHECK); posting, payments (order, dates, references, nothing to pay, correction, paid), liability; cross-org refusals; locked month (charges, build, rebuild, return to draft refused; verify and approve allowed); schemes (approved immutable, one draft per doctor, edit resets verification, two people, hash, versioning, delete); the SQL rule check agrees with Zod; the charges upload replaces only the same month and kind and is all-or-nothing; service-role-only functions; the grant block (right roles, idempotent, matches the presets).
- `tests/unit/finance-revshare-actions.test.ts` (3): each of the 14 actions refuses without its own key (every other key is not enough) before the service role is created, validates before touching data; the CSV route answers 401 / 403 / 400.
- `tests/db/security-guard.test.ts`: the four tables are in the Phase 20 cross-org sweep (`PHASE20_TABLES`, `seedPhase20Rows`) and the nine functions in `PHASE20_SERVICE_FUNCTIONS`; `tests/db/finance-phase18-rls.test.ts` knows the keys arrived later; `tests/unit/finance/nav.test.ts`: who sees the page and that verify and approve are split.
- Typecheck, lint, the unit suite (195 files, 2,682 tests), the database suite (46 files, 663 tests; the PostgREST suites skip), `pnpm audit:security` (458 entry points, 0 unguarded). The paste file applied in one transaction on a database built from the earlier migrations gives the same `pg_dump` schema as the full build.

## Not verified

- Not clicked through in a browser (no Supabase auth stack here): the three pages, the forms and the drawers were typechecked and linted only.
- No real contract or calculation sheet yet (D10): the vocabulary was built from the meeting and the deck. **Send one real contract per scheme type (D10) to confirm the rule vocabulary covers it**, and one month's calculation sheet so the first Pulse run can be compared line by line.
- No real Unite data (capture is OFF, OQ-94), so the revenue base has only been exercised on synthetic invoices.

## Before first use

1. Apply `deploy/supabase-paste/31_finance_revenue_share.sql` to the **Pulse** project (not THC Portal), after `29_finance_analytics_mix.sql`.
2. Settings, Roles: decide who verifies. By default every Finance member holds `finance.revshare.verify`; to match maker / checker, create a "Finance Manager" role with it (Hardik) and remove it from the Finance role. Only the CEO approves.
3. Finance, Workflow settings: check the doctor basis (it decides whose revenue a lab or radiology line is), and Finance, Reference data: give billed items a service category (category rates match on it).
4. Enter one scheme per doctor from the contracts, verify, and have the CEO approve. Then enter the month's charges (until 20E feeds lab and referral costs), build the draft after month end and compare it with the spreadsheet before verifying.

## Decisions worth knowing

- The calculation is in TypeScript (one pure function, exhaustively tested); the database guarantees the inputs it was given are the real ones (equality check at store and verify time) and freezes the result. No formula language, no `eval`: a contract that needs more is a new, reviewed rule key (OQ-115).
- Two people are enforced for verification and approval (scheme and run). The preparer may also be the verifier when they hold both keys (the Finance preset does); see "Before first use" to separate them.
- Payment and accounting references may be recorded after the close locks the month, because payments are usually made after the close; the figures themselves cannot change.
- A charge upload replaces the earlier uploaded charges of the same month and kind, so a corrected file can be re-uploaded without double-counting; typed-in charges are untouched.
- Retiring a version means "no scheme from its start month"; retire after the doctor's last month is approved (approved runs are frozen and unaffected).
- Audit rows hold months, ids, counts and hashes, never a payout or a rule; payouts stay in the RLS-protected tables.
- No record-history trigger on these tables: the trail is in the rows themselves (who and when at each step), the frozen snapshot and the audit log.
