# Phase 23B — Doctor performance and month comparison

Plan: `docs/39_UNITE_REPORTS_PLAN.md` §4 (23B) and `docs/40_MANAGEMENT_PLATFORM_PLAN.md` §2 (shared measures). This page
replaces the clinic's hand-built "Revenue comparison" workbook (docs/39 §1.3) with the same figures, corrected.

## What was built

| Piece          | Where                                                                                                                                                                                                                                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page           | `/finance/doctor-performance` (`app/(app)/finance/doctor-performance/page.tsx`), needs `finance.revenue.view`                                                                                                                                                                                                                                                       |
| Excel download | `GET /api/finance/doctor-performance?month=yyyy-mm&branch=CODE` (sheets Doctors, Departments, Definitions; values only; `recordAudit` + `recordExport`)                                                                                                                                                                                                             |
| SQL            | `public.fin_doctor_performance_inputs(p_org_id uuid, p_month date, p_branch text default null, p_branches text[] default null) returns jsonb` and `public.fin_report_latest_month(p_org_id uuid, p_branches text[] default null) returns date` (migration `20261126000300_finance_doctor_performance.sql`); SECURITY DEFINER, `search_path = ''`, service role only |
| Pure rules     | `lib/finance/doctor-performance.ts` (`buildDoctorPerformance`, `bandOf`, `perfSettingsSchema`, `allowedBranchCodes`)                                                                                                                                                                                                                                                |
| Loader         | `lib/finance/doctor-performance-server.ts` (service role after the caller's `can()`)                                                                                                                                                                                                                                                                                |
| Workbook       | `lib/finance/doctor-performance-xlsx.ts`                                                                                                                                                                                                                                                                                                                            |
| Thresholds     | Finance, Targets and report lines (`/finance/flash/settings#performance`, `finance.targets.manage`, audited as `finance.doctor_performance.bands_saved`)                                                                                                                                                                                                            |
| Dashboard      | Management dashboard, "Revenue (Unite report)" tiles for members with `finance.revenue.view`; each tile links to the page for that month                                                                                                                                                                                                                            |
| Menu and help  | Finance, Overview, Doctor performance (quick-search words: ARPP, revenue per patient, doctor comparison); guide `finance-doctor-performance`                                                                                                                                                                                                                        |

## Source

Amounts: Unite keeps some amounts to three decimals, so `fin_report_visits` stores them as numeric(14,3). The SQL
sums them unrounded; the pure rules only strip binary float noise at 0.001 and never round to the fil; the page and the
workbook round to 2 decimals for display only.

Only the current rows of the Unite collection report (`fin_report_visits where is_current`, from committed uploads,
Phase 23A), grouped by `report_date` (invoice date, else visit date). The finance capture tables are not read: the
report has no DHA doctor id, so mixing them would give every doctor two identities (see the 23A migration).

## Definitions

Per department and doctor (grouped by `doctor_key`, the normalised Unite name) for a calendar month M and for M−1:

| Measure              | Definition                                                                                                                                                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Revenue              | sum of Unite Net Billing (after discount, before VAT). Cancelled rows count: Unite's totals include them and revenue must equal Unite's                                                                                                                                                                |
| Visits               | report rows                                                                                                                                                                                                                                                                                            |
| Patients             | distinct patients, patient = `coalesce(patient_ref, patient_pin)` (a row with neither counts as its own patient)                                                                                                                                                                                       |
| Unbilled             | patients whose summed net for that doctor and department in the month is ≤ 0                                                                                                                                                                                                                           |
| New                  | visits Unite marks New                                                                                                                                                                                                                                                                                 |
| Follow-ups           | visits − patients (repeat visits in the month), never negative                                                                                                                                                                                                                                         |
| Revenue / patient    | revenue ÷ patients, exact; null with no patients. Screens and the workbook show it to 2 decimals; the band is judged on that 2-decimal figure (half up, via millionths so float noise cannot move an edge), so the badge always agrees with the number shown: 649.9985 shows as 650.00 and is Moderate |
| Band                 | ≥ target Achieved; ≥ near Near Target; ≥ moderate Moderate; else Below Target. Half-open, no gaps                                                                                                                                                                                                      |
| Expected             | patients × target; Gap = revenue − expected; Achievement = revenue ÷ expected (null when expected is 0)                                                                                                                                                                                                |
| Change, change %     | revenue(M) − revenue(M−1); change % = change ÷ revenue(M−1), null when M−1 had no revenue                                                                                                                                                                                                              |
| Patients change %    | likewise, over the previous month's patients                                                                                                                                                                                                                                                           |
| Follow-ups / patient | follow-ups ÷ patients                                                                                                                                                                                                                                                                                  |

- A department row sums revenue, visits and new visits, but its patients (and unbilled patients) are distinct patients
  within the department, counted in SQL. The clinic total counts each patient once over all rows. Neither is ever a sum
  of doctors.
- A doctor who works in two departments appears under both. The display name is the doctor key's most frequent
  spelling over the two months shown (ties: alphabetical, byte order). A department stored blank shows as Unassigned.
- Departments are listed by this month's revenue (then last month's, then name), doctors the same within each.
- Footer: the month's total net over every current row in scope, the covered dates (the union of committed upload
  ranges that meet the month, e.g. "1–30 Sep 2026"; a warning shows when this month or the previous one is only partly
  covered), and the reconciliation line "departments = total", which must hold exactly.

## Differences from the old workbook (docs/39 §1.3)

- Change % divides by the previous month, not the current one (error 1); follow-up % uses this month's follow-ups
  (error 2).
- Bands are half-open with no gaps; exactly 650 is Moderate, exactly 700 Near Target, exactly 750 Achieved (error 3).
- Totals never add up ratios: revenue per patient, achievement and change % of a department or the clinic are worked
  out from that level's own revenue and distinct patients (errors 4 and 13).
- Every doctor row reads its own month's figures; there are no typed cells or hand doctor counts (errors 5 to 12).
- Chiropractic, Physiotherapy and Longevity are shown as their own departments (whatever Unite calls them), not left
  out; the footer reconciles the shown total to all revenue.

## Thresholds

`fin_ref_finance_settings.perf_arpp_target` (750), `perf_band_near` (700) and `perf_band_moderate` (650), with the check
`0 < moderate < near < target` in the database and the same rule in `perfSettingsSchema`. Nothing is hardcoded: the
SQL returns the org's values (defaults when the org has no settings row) and the pure rules read them. Which revenue per
patient carries the 750 target is still OQ-138; the flash keeps its own visit-based "ARPP".

## Branches (Phase B)

`fin_report_visits.branch_code` is branch-bound. The loader takes the member's branch view (`branchView()`: access plus
the switcher), maps the visible locations to finance codes through `locations.branch_code` (`allowedBranchCodes`) and
passes them as `p_branches` (null = unrestricted). The branch of a row is worked out when it is read, from its Unite
clinic and the CURRENT `fin_ref_branches` mapping (the code stored at commit is only the fallback), so mapping a clinic
later fixes earlier uploads. A row whose branch is still unknown is shown only to members who see every branch: here no
branch means "not yet mapped", so it fails closed (unlike `app.location_visible_to()`). The page's
branch filter offers only the member's codes and, when chosen, shows exactly that code (`p_branch`). The Excel download
and the dashboard tiles use the same scope.

## Privacy

The function returns counts and sums only: no PIN, no patient ref, no names other than the doctor's. The page logs a
sampled list access (`recordAccess`, entity `finance_invoice`), the download logs the export. Fixtures are synthetic
(`tests/unit/finance/fixtures/phase23-doctor-performance.synthetic.json`, doctors "Dr Demo-0n", PINs 9000000nn).

## Tests

- `tests/unit/finance/doctor-performance.test.ts`: band edges with default and custom thresholds, zero patients,
  previous month 0, follow-ups never negative, distinct department and clinic patients, sort order, coverage labels,
  parameters, branch-code mapping, settings validation; the fixture is checked against an independent reference
  aggregator (`doctor-performance-reference.ts`).
- `tests/unit/finance/doctor-performance-server.test.ts`: a member limited to one branch, the switcher, branches with
  no finance code.
- `tests/unit/finance/doctor-performance-xlsx.test.ts`: sheets, values, no formulas, no PIN.
- `tests/db/finance-doctor-performance.test.ts`: SQL output equals the fixture exactly (parity), branch filter and
  allowed branches against the reference, months without data, only current rows, the settings check, service role
  only, no PIN or patient ref in the output.

## Deferred

- **23C Longevity and service lines** (blocked on OQ-139): a service-line dimension and the Longevity split per
  practitioner. Until then Longevity shows as whatever department Unite gives it.
- **M2 cost and contribution** (docs/40): doctor contribution (L3) and department contribution (L4) need the cost
  register; this page shows revenue measures only, never profit or compensation.
- Reporting-line inclusion (docs/39 §4 mentions `fin_ref_report_lines`): not applied here. Every department is shown
  and the total is all revenue, so nothing is silently left out; a "main total excluding Chiro" can follow once the
  lines are confirmed for report data.
- The management digest e-mail does not carry these figures (finance permission per recipient); the tiles are on the
  dashboard page only.
- Mixed patient ids: if the Vault key is added after some rows were stored, a patient's older rows (PIN) and newer rows
  (ref) count as two patients until the older rows are re-uploaded.
