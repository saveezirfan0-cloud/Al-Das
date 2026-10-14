# Phase M4A — Recruitment viability calculator (first M4 scenario)

Plan: `docs/40_MANAGEMENT_PLATFORM_PLAN.md` §4 (M4, "recruitment: the May calculator on the shared engine") and §5
(rules for scenarios). It replaces the owner's May workbook "03_AlDas_Department_Benchmarking_Recruitment_Updated" and
fixes its defects. Pay rules follow `docs/finance/contract-rules-alignment.md`.

Everything the page shows is a **Scenario**: a candidate's claimed revenue run through one cost model. It never writes
to actual tables, is never posted, and is never pay.

## What was built

| Piece | Where |
|---|---|
| Page | `/finance/recruitment` (`app/(app)/finance/recruitment/`), needs `finance.profit.view` **and** `finance.costs.compensation` (the pay inputs are compensation data) |
| Save / delete a scenario | server actions `saveScenario`, `deleteScenario`: the page's two keys plus `finance.costs.manage`; audited (`finance.recruitment.scenario_saved` / `_deleted`, ids, contract type, viability and benchmark source only, never the title or amounts) |
| Seasonal calendar | same page, bottom card; `saveCalendarEvent`, `deleteCalendarEvent`: `finance.profit.view` + `finance.costs.manage`; audited |
| Excel | `GET /api/finance/recruitment/<id>`: one "Scenario" sheet, banner, values only, built from the stored scenario; `recordAudit` + `recordExport` |
| Defaults | `/finance/flash/settings#recruitment` (the page where the 23B bands live), card shown to `finance.costs.manage`; `saveRecruitDefaults`, audited as `finance.recruitment.defaults_saved` |
| Pure engine | `lib/finance/recruitment.ts` (`computeRecruitment`, `buildScenarioReport`, `pickBenchmark`, `recruitBand`, `eventsInWindow`, the input and settings schemas) |
| Loader | `lib/finance/recruitment-server.ts` (service role after `can()`; branch scope from `loadPerfScope`) |
| Workbook | `lib/finance/recruitment-xlsx.ts` |
| SQL | migration `20261203000600_finance_recruitment_scenarios.sql` |
| Menu and help | Finance, Overview, Recruitment calculator (visible only with both keys: `FinanceNavEntry.allow`); guide `finance-recruitment` |

## Database

- `fin_ref_finance_settings`: `recruit_conservative_pct` 70, `recruit_consumables_pct` 12, `recruit_gateway_pct` 1.5,
  `recruit_min_peer_months` 6. Check: conservative in (0, 100], consumables and gateway ≥ 0 and together < 100,
  months 1 to 1000. The same rule is `recruitSettingsSchema`.
- `fin_ref_calendar_events (org_id, starts_on, ends_on, kind, label, approximate, created_by)`; kind in ramadan, eid,
  school_holiday, summer, other; unique (org, kind, start). RLS select: `finance.profit.view`. No write policy.
- `fin_recruitment_scenarios (org_id, title, inputs, result, created_by, created_at)`. RLS select:
  `finance.costs.compensation` **and** `finance.profit.view`. No write policy.
- `public.fin_recruitment_benchmarks(p_org_id, p_branches)` and `public.fin_seed_calendar_events(p_org_id)`: SECURITY
  DEFINER, `search_path = ''`, service role only. A trigger (`orgs_seed_finance_m4a`) seeds the calendar for new orgs;
  existing orgs are seeded by the migration and by `pnpm finance:seed`.

## The engine

Revenue = claimed × conservative % + equipment revenue + nurse/coordinator revenue. The factor applies to the claimed
figure only, as in the May model. Then:

| Line | Formula |
|---|---|
| Consumables, gateway | revenue × % (VARIABLE) |
| Gross margin | revenue − consumables − gateway |
| Doctor pay | by contract type, below |
| Net margin | gross margin − doctor pay |
| Indirect | Σ amount ÷ months covered, 15 lines (DHA licence, visa, medical insurance, malpractice, OCH certificate, MOHRE, gratuity, cancellation provision, room rent, admin overhead, nurse, coordinator, equipment maintenance, marketing, utilities) (FIXED) |
| Profit | net margin − indirect; annual = × 12 |
| Cost to company | doctor pay + the doctor's own lines (licence, visa, insurance, malpractice, OCH, MOHRE, gratuity) |
| Viability | Viable if profit > 0; Marginal if net margin > 0 and profit ≤ 0; otherwise Not viable |
| Months to recover setup | ⌈setup ÷ profit⌉; 0 with no setup cost; never when profit ≤ 0 |

Pay (one engine, `V = share% × (revenue − consumables − gateway)`, or `share% × revenue` when "gross" is chosen):

| Contract type | Generator type | Pay |
|---|---|---|
| Fixed salary | `fixed-salary` (ordinary) | S, a fixed cost |
| Salary-backed revenue sharing | `revenue-sharing` | max(S, V), never S + V |
| Share only | `revenue-sharing` + `revenueShareOnly` | V |
| Practitioner share | `revenue-sharing-practitioner`, aesthetics, dental | V, always on net revenue |

Not modelled: the GP and Gynaecology incentive profiles (threshold basis open, OQ-149), the insurance provision, the
collected-revenue basis (OQ-148) and the clinic commitment. `minimumGuaranteeAed` is a clinic target and has no input.

**Breakeven** is the smallest monthly revenue at which profit reaches 0. Pay is written as stretches of
`fixed + rate × revenue`; on each stretch profit = revenue × (1 − variable % − rate) − (fixed + indirect). Fixed
salary: (S + indirect) ÷ (1 − v). Share: indirect ÷ ((1 − v)(1 − s)) on net, indirect ÷ (1 − v − s) on gross.
Salary-backed: the share overtakes the salary at S ÷ k (k = pay per AED in the share regime); the solver tries the
salary stretch first, then the share stretch. A contribution ratio ≤ 0 on the stretch that matters gives "never".
Breakeven % = breakeven ÷ revenue, safety margin = (revenue − breakeven) ÷ revenue. Both are blank with no revenue
or no breakeven. A brute-force test checks profit = 0 at breakeven for 72 combinations of pay model, salary, share
and basis.

## Benchmarks

From the current Unite collection report rows (`fin_report_visits`, 23A), branch-scoped like doctor performance:

- A doctor-month is one doctor's net in one calendar month that committed uploads cover **completely**, so part months
  do not read as weak doctors. Doctor-months of 0 or less are left out.
- Department figures group by (department, doctor, month). Clinic figures group by (doctor, month), so a doctor
  working in two departments counts once per month clinic-wide.
- The output is the median and 75th percentile (continuous), the doctor-months and the doctors. Amounts and counts
  only; no doctor and no PIN.
- **Band** of the scenario's revenue: A at or above p75, B at or above the median, otherwise below.
- A department is used only with at least `recruit_min_peer_months` doctor-months **from at least two doctors**.
  Otherwise the clinic-wide figures are used and the page says why. With too little clinic data there is no band.

## Seasonality

No seasonal factor is applied: about a year of history cannot separate a season from a trend, and the page says so.
The page lists the calendar events that overlap the candidate's first three months (`SEASON_WINDOW_MONTHS`, the plan's
window).

The seed holds Ramadan and Eid in the UAE for 2026 and 2027 (Eid rows span the public holiday; Eid al Adha includes
Arafat Day):

| Event | Dates |
|---|---|
| Ramadan 1447 | 18 Feb to 19 Mar 2026 |
| Eid al Fitr 1447 | 20 to 22 Mar 2026 |
| Arafat Day and Eid al Adha 1447 | 26 to 29 May 2026 |
| Ramadan 1448 | 8 Feb to 9 Mar 2027 |
| Eid al Fitr 1448 | 10 to 12 Mar 2027 |
| Arafat Day and Eid al Adha 1448 | 15 to 18 May 2027 |

Source: the Emirates Astronomical Society and International Astronomical Center forecasts, as reported by The
National and Gulf News. Every row is marked **approximate**: lunar dates move by a day with the moon sighting. Finance
should check each against the UAE announcement, correct it on the page and untick approximate. The 2026 rows are the
published forecasts, not checked against the final announcements.

## May-model defects fixed (docs/40 §1)

| # | Defect | Fix |
|---|---|---|
| 1 | Two pay engines: the Dental and Aesthetic sheets paid share × (revenue − consumables − gateway) with "revenue share" typed as 0; the GP sheet paid salary plus share on gross margin | One engine, chosen by the generator's contract type. The share basis is explicit (net by default, gross by choice). Salary-backed pay is max(S, V), never S + V |
| 2 | Breakeven = indirect ÷ net margin %, with salary treated as variable | Fixed salary and indirect costs are fixed; only consumables, gateway and a share vary. Salary-backed breakeven is solved piecewise. "Never" when the contribution ratio is ≤ 0. A test shows the old formula's answer is not the breakeven |
| 3 | "Department average" was 0; in single-doctor departments band A was that doctor's own average and B = 0.7 × A | Median and p75 of the clinic's own doctor-months, full months only. A department needs `recruit_min_peer_months` doctor-months from at least two doctors, else the clinic-wide figures are used and the page says so; no band without enough data |
| 4 | Fixed month labels ("May: Ramadan impact", wrong for 2026 and 2027) | A dated, editable calendar with the 2026 and 2027 Hijri dates, marked approximate until announced. No invented seasonal factor |

Also: every default is a setting (no constants), and each saved scenario stores its inputs and the result as
calculated (`engine: recruitment-v1`). Saving recomputes on the server; the browser's figures are never stored.

## Privacy and access

- The title is free text, and the page tells people to use a role label, never a name. Audit rows carry ids and
  codes, never the title.
- The Cost / Payroll role holds compensation but no profit, so it cannot open the page or read scenarios (F8: no
  revenue or profit for payroll). The CEO holds profit but no compensation, so the same applies.
- Benchmarks are percentiles of amounts; the browser never receives a doctor name or a PIN.

## Tests

- `tests/unit/finance/recruitment.test.ts` (26): every pay model with hand-checked figures; piecewise breakeven on
  both stretches; zero revenue, share 0 %, margin ≤ 0, nothing fixed, variable costs above 100 %; brute-force profit = 0
  at breakeven; input normalisation and validation; settings; benchmark choice, the fallback reasons and band edges;
  the seasonal window across a year end.
- `tests/unit/finance/recruitment-xlsx.test.ts`: banner, no formulas, stored figures.
- `tests/unit/finance/nav.test.ts`: visible only with both keys.
- `tests/db/finance-recruitment.test.ts` (10): full months only (September from two uploads; part October left out),
  doctor rows summed, 0 doctor-months and superseded rows left out, a doctor in two departments, branch scope, org
  isolation, settings and their check, the calendar seed (idempotent), calendar and scenario RLS (Finance yes; CEO,
  Cost / Payroll and the other org no; no browser writes), service-role-only functions.
- `tests/db/security-guard.test.ts`: both tables in the cross-org sweep (`M4A_TABLES`, `seedM4aRows`).

## Deferred

- Ramp-up from past hires (docs/40 M4) needs the hire dates of current doctors (`fin_ref_doctors` has none yet).
- Contribution levels from the metric register (docs/40 §2): this calculator is the first scenario on its own pure
  engine; when the register lands, L3 doctor contribution should read the same pay rules.
- Paste file: `deploy/supabase-paste/74_finance_recruitment.sql`.
