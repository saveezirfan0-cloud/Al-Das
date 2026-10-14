# Phase M2A — Contribution by doctor, department and clinic

Plan: `docs/40_MANAGEMENT_PLATFORM_PLAN.md` §2 (profit levels L1 to L6). This is the first slice of M2 (costs and
contribution). It puts the costs Finance already loads next to the Unite report revenue of Phase 23B. **No pay is
calculated**: contract-rule pay waits for Finance's answers to OQ-148 to OQ-157 (`docs/finance/contract-rules-alignment.md`).

## What was built

| Piece          | Where                                                                                                                                                                                                                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page           | `/finance/contribution` (`app/(app)/finance/contribution/page.tsx`), needs `finance.profit.view`; the doctor-pay column also needs `finance.costs.compensation`                                                                                                                         |
| Doctor links   | On the same page, "Link report doctors to DHA ids" (`finance.costs.manage`, on a page that needs `finance.profit.view`; the actions check both): server actions `linkReportDoctor` / `unlinkReportDoctor` (`actions.ts`), audited as `finance.contribution.doctor_linked` / `_unlinked` |
| Excel download | `GET /api/finance/contribution?month=yyyy-mm&branch=CODE` (sheets Contribution, Definitions; values only; `recordAudit` `finance.contribution.exported` + `recordExport` `finance:contribution`)                                                                                        |
| SQL            | Migration `20261203000400_finance_contribution.sql`: table `fin_report_doctor_map` and `public.fin_contribution_inputs(p_org_id uuid, p_month date, p_branch text default null, p_branches text[] default null) returns jsonb`                                                          |
| Pure rules     | `lib/finance/contribution.ts` (`buildContribution`, `parseContributionInputs`, `MIN_PAID_DOCTORS`); reuses `allocateOverheads` and `PROVISIONAL_LABEL` from `lib/finance/profitability.ts`                                                                                              |
| Loader         | `lib/finance/contribution-server.ts` (service role after the caller's `can()`); branch scope and default month reuse 23B's `loadPerfScope` / `latestReportMonth`                                                                                                                        |
| Workbook       | `lib/finance/contribution-xlsx.ts`                                                                                                                                                                                                                                                      |
| Menu and help  | Finance, Overview, Contribution (after Profitability); guide `finance-contribution`                                                                                                                                                                                                     |

No new permission keys: the page follows `finance.profit.view` (Finance, Finance Manager, CEO). Cost / Payroll (no
revenue), Billing, Insurance and the Medical Director (no cost data) do not get it.

## Definitions

For one calendar month, per (branch, department, doctor) as 23B groups the report (`doctor_key`, current rows of
`fin_report_visits`, branch worked out when read):

| Level                  | Definition                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Revenue                | Unite Net Billing, as 23B                                                                                                        |
| Doctor pay             | `fin_cost_doctor_comp` for the month and the doctor's DHA id, as loaded. Never calculated                                        |
| Charges                | `fin_doctor_charges` for the month and DHA id (lab, referral, consumables, other)                                                |
| L3 doctor contribution | revenue − pay − charges                                                                                                          |
| Department             | Σ its doctors' L3 (L4 department costs do not exist yet, so department = sum of doctors; the page says so)                       |
| L5 clinic contribution | Σ its doctors' L3 − the branch's own overheads (`fin_cost_overheads` with that `branch_code`)                                    |
| Allocated              | shared pools (`branch_code` null) split by their basis with `allocateOverheads` (revenue, visits as "invoices", equal); own line |
| L6 after allocation    | L5 − allocated                                                                                                                   |
| Pay coverage           | share of revenue whose doctor is linked to a DHA id AND has pay loaded for the month                                             |

- **Doctor identity.** The report has no DHA id. `fin_report_doctor_map (org_id, doctor_key → dha_id)` links them; the
  DHA id must be one of the org's `fin_ref_doctors` (composite foreign key, `on delete cascade`, so removing a reference
  doctor removes the link and the doctor falls back to "pay not linked"). Several report spellings may link to one DHA
  id. Service role only (RLS on, no policies; in the security guard's service-only list): the page reads the links
  through `fin_contribution_inputs()` and changes them only through the two audited actions.
- **Never zero pay.** An unlinked doctor shows revenue with "Pay not linked"; a linked doctor with no pay row for the
  month, or a row of 0 (0 means unavailable, F8), shows "Pay not loaded". Neither is in any contribution; pay, charges
  and contribution of a department, clinic or the total add up only the doctors whose pay is loaded, and coverage shows
  how much revenue that is. A level with no such doctor shows no contribution.
- **No double counting.** A doctor's pay and charges are split over ALL that DHA id's rows in the month (every branch,
  department and linked spelling) by non-negative revenue (equal split when that is 0). The weights come from every
  branch, so a member limited to one branch sees that branch's share, never the doctor's whole pay. Charges are a real
  cost to the clinic and are not part of loaded pay (if the revenue-share payout already deducted them, the payout is
  smaller; the charge is still paid to the lab), so subtracting both is correct and each is subtracted once.
- **Shared pools** are allocated over every branch with revenue that month (unknown branch included), whatever the
  viewer may see; the viewer gets only their branches' shares.
- **Provisional** (`PROVISIONAL_LABEL`) unless Finance approved the month in `fin_cost_periods` AND every doctor with
  non-zero revenue has pay loaded (coverage 100%) AND the report covers the whole month. Overhead that cannot be
  allocated, and branch overheads of a branch with no report revenue, are named as reasons too.

## Compensation visibility

Without `finance.costs.compensation`, `buildContribution(…, { canSeePay: false })` removes individual pay from the
result itself (not just from the screen), so the page and the workbook cannot leak it:

- no pay column at any level, and no doctor's L3 (revenue − L3 − charges would give the pay);
- a department, clinic or total that includes pay is shown only when its pay comes from at least `MIN_PAID_DOCTORS` (2)
  doctors; a department with pay from one doctor withholds every department of that clinic (otherwise clinic − the
  others gives it away), a clinic with pay from one doctor is withheld, and the total is withheld when any clinic is.
  The rule is a disclosure control, not a business threshold, so it is a constant rather than a setting. Revenue,
  charges, branch overheads and the allocated line stay visible.

## Branches and privacy

Branch access exactly as 23B (`branchView()` → finance codes; a row with an unknown branch only for members who see
every branch; the page filter offers only the member's codes). The function returns amounts, doctor names and DHA ids
only: no PIN, no patient ref. The page logs a sampled list access, the download logs the export.

## Tests

- `tests/unit/finance/contribution.test.ts` (15): the hand-worked fixture at doctor, department, clinic and total level;
  sums reconcile; a doctor across two branches and two spellings is split, not double counted; allocation is its own
  line; unmapped doctor; zero pay = not loaded; a month without pay is Provisional; final only with approval + full
  coverage + full month; strict parsing; pay and doctor L3 absent without the permission; totals withheld when one
  doctor's pay would show; one-branch scope keeps the doctor's and pools' shares.
- `tests/unit/finance/contribution-xlsx.test.ts` (2): sheets, values, no formulas, Provisional line, L5 / allocated / L6
  lines, no PIN; without the permission no pay column and no pay value.
- `tests/db/finance-contribution.test.ts` (8): SQL output equals the fixture exactly (parity) and the pure rules on it
  give the fixture's levels; allowed branches, page filter, empty scope, unknown branch; weights over every branch;
  zero costs, other months, other orgs and superseded rows left out; approval flag; no PIN; links only to the org's own
  reference doctors, once per doctor, removed with the doctor; service role only (function privileges, no policies,
  signed-in users read nothing and cannot write).
- Fixture: `tests/unit/finance/fixtures/m2a-contribution.synthetic.json` (doctors "Dr Demo-0n", DHA ids D000n, PINs
  9000000nn).
- `tests/db/security-guard.test.ts` lists `fin_report_doctor_map` as service-only; `tests/unit/finance/nav.test.ts`
  checks the CEO sees the page and Billing, Insurance and the Medical Director do not.

## What M2 still needs

- **Contract-rule pay** (L3 "doctor pay (contract)"): blocked on OQ-148 to OQ-157. Until Finance approves the basis,
  only loaded compensation counts; nothing here calculates pay from contract terms, revenue-share schemes or the
  Contract Generator's `minimumGuaranteeAed` (a clinic revenue target, never a guarantee).
- **L2 expected revenue**: L1 less an expected-denials provision by payer (`fin_payer_scorecard` denial rates). The
  report rows carry no payer today, so this needs either the payer on the report or the Unite invoice mirror.
- **L4 department cost pools**: a department cost table (or overhead pools with a department key) and its basis.
  Department contribution is the sum of doctors until then.
- **Doctor fixed cost** (licence, visa, insurance, malpractice spread monthly) and variable service cost / gateway fees
  in L3.
- **Tally cost-centre mapping** (OQ-144): once costs come from the ledger instead of the cost CSVs, branch and
  department cost centres must map to the same codes as `fin_ref_branches` and the departments here.
- **Group view and drill-down** (docs/40 §2.4), the metric register entry with a SQL twin for each level, and the
  doctor directory link (`specialists` ↔ `fin_ref_doctors.dha_id`) that could replace the manual report-doctor links.
