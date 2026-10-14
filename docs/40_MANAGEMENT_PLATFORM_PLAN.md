# 40 — Management platform: Doctor → Department → Clinic → Group (Phases M0 to M5)

Date: 14 Oct 2026. Written for build sessions. The owner-facing version is the doc
"Al Das Management Platform: Recommendations" (claude.ai). It has the same content in plain language, plus the diagrams.

## 0. Inputs

Two Excel models the owner sent to the Finance Manager in May 2026, analysed outside the repository. Staff names and
salaries in them are not reproduced here.

**"Clinic Turnaround Financial Analysis Template"** has 16 sheets, mostly empty templates:
- branch P&L keep/close
- KPI dashboard
- cost reduction
- doctor revenue
- revenue-share doctors
- department projections
- consolidation
- cash flow
- cash vs insurance
- insurance ageing
- room subleasing
- staffing ratios
- lab
- pharmacy launch

**"03_AlDas_Department_Benchmarking_Recruitment_Updated"** is a recruitment calculator per department. Its chain:
input → revenue (70% haircut) → direct cost → gross margin → revenue share → net margin → indirect cost → profit →
viability → breakeven. It also has A/B bands per department and a seasonal calendar.

The owner's eight capabilities are: doctor performance, departmental profitability, recruitment viability, room and
resource utilisation, seasonality and forecasting, financial accountability, automated alerts, and scenario-based
decision support.

## 1. Defects in the models (do not carry them into code)

| # | Model / sheet | Defect |
|---|---|---|
| 1 | Recruitment, Dental and Aesthetic | Doctor pay = (revenue − consumables − gateway) × share%, while "revenue share" is typed as 0. The GP sheet uses salary plus share on gross margin. Two engines for one idea. |
| 2 | Recruitment, all | Breakeven = indirect ÷ net margin %, with salary treated as variable. A fixed salary must be a fixed cost. |
| 3 | Recruitment, all | "Department average" is 0 everywhere. In single-doctor departments the A-band is that doctor's average and B = 0.7 × A. These are not peer benchmarks. |
| 4 | Recruitment, Seasonal Calendar | Fixed month labels; "May: Ramadan impact" is wrong for 2026 and 2027 (Ramadan was Feb–Mar 2026). Aesthetic's own data peaks in the Low season. |
| 5 | Turnaround, Branch P&L | Projection = YTD × 12/3 (no seasonality). Revenue share, other direct cost (22%) and B2B factor are typed into formulas. GM 2025 depreciation is overwritten from YTD (J22). G43 is `#REF!`. |
| 6 | Turnaround, Branch P&L | Keep/close is decided on profit after allocated indirect costs. Allocated group overhead does not disappear on closure; decide on contribution. |
| 7 | Turnaround, Cost Reduction | Category A sums D22:D27 and category B sums D26:D31, so two rows are counted twice. |
| 8 | Turnaround, KPI Dashboard | Daily revenue divides by 30 for two branches and 26 for GM. "Average days to insurance payment" and "claim processing time" pass when higher. Revenue per patient copies branch 1 into branches 2 and 3. |
| 9 | Turnaround, Doctor Revenue | Monthly average divisors are typed per row (/12, /2, /4, /8). |
| 10 | Turnaround, Revenue Share Doctors | Doctor share = % of gross revenue, not of gross margin (contradicts #1). Insurance mix 40%, collected 88% and overhead 0/5/10% are hard-coded. |
| 11 | Turnaround, Doctor Consolidation | Capacity = monthly hours × 2 is compared with daily patients (unit mismatch). |
| 12 | Turnaround, Cash Flow | Insurance buckets 30/30/20% sum to 80% with no denial line. The 90-day row reads January twice (B9 and C9 → B7). A gross margin % is applied to cash collections. |
| 13 | Turnaround, Room Subleasing | Sublease rate = room cost (P7 = O7, zero net), or ÷ an empty P4 (`#DIV/0!`). |

## 2. Architecture (fixed in M0 and M1, never duplicated later)

1. **Sources.** Unite finance API and the collection report (Phase 23A), Unite appointments, Diligence, remittance,
   bank, the Tally bridge or import, payroll and cost CSV, Pulse's own tables (schedules, rooms, budgets, CRM), and Meta
   ads.
2. **Data layer.** Raw copy kept (replayable), checked against source totals, tied to master data:
   - `specialists` ↔ `fin_ref_doctors.dha_id` (link missing today)
   - `departments`
   - `locations.branch_code` ↔ `fin_ref_branches` (Clinic OS Phase B)
   - new `rooms`
3. **Metric register.** One definition per measure, in `lib/metrics/` (pure TS) with a SQL twin per measure. Each
   entry has a formula, source, owner and `effective_from` (a dated rule; history keeps the rule in force). Parity
   tests cover the screen figure, the SQL figure and the Excel export on shared `metrics-*.synthetic.json` fixtures.
   Actuals, forecasts and scenarios all read the register. A scenario is a stored set of overrides; it is never written
   into actual tables.
4. **Views.** One layout for Group, Clinic, Department and Doctor, each drilling into the next. Alerts and digests go
   through `notify()` with generic text. KPI tiles link to filters the target page already reads.

### Profit levels (the register's spine)

| Level | Formula | Existing code to reuse |
|---|---|---|
| L1 Net revenue | gross − discount, before VAT, invoice date | `fin_invoices.net`, flash, `fin_revenue_breakdown` |
| L2 Expected revenue | L1 − expected denials (payer denial rate) | `fin_payer_scorecard` |
| L3 Doctor contribution | L2 − doctor pay (contract) − variable cost (service cost, `fin_doctor_charges`, gateway fees) − doctor fixed cost (licence, visa, insurance, malpractice, spread monthly) | `computeProfitability`, `revshare.ts`, `fin_cost_*` |
| L4 Department contribution | Σ L3 − department cost | new: department cost pool |
| L5 Clinic contribution | Σ L4 − branch cost | `fin_cost_overheads` (branch pools) |
| L6 Profit after allocation | L5 − group overhead by key | `allocateOverheads` (today branch-level only; add keys) |

Allocated cost is always its own line. Decisions are made on L3 to L5. "Provisional" holds until
`fin_cost_periods` is approved.

### Shared measures

- Patients: distinct PIN, with the clinic total counted once.
- Visits.
- Revenue per patient (the AED 750 target; OQ-138).
- Revenue per visit (flash).
- Revenue per available hour (`working_hours` minus blocks and leave).
- Appointment utilisation: booked ÷ available minutes.
- Room utilisation.
- Retention at 90 and 180 days.
- No-show and late-cancel rate.
- Collection rate at 30, 60, 90 and 120 days.
- Days to collect.
- Budget variance (`acc_budget_vs_actual`).

## 3. What exists vs what is new

**Exists but shows nothing (no revenue data while capture is OFF):**
- flash
- revenue breakdown
- doctor measures
- billing mix and year-on-year trend
- profitability (contribution, branch overhead, Provisional)
- revenue share
- receivables, denials, remittance and collections forecast
- P&L and budget against actual by branch and department (ledger)

**New:**
- Phase 23 (`docs/39`): the collection report import and doctor performance
- the metric register
- `specialists` ↔ `fin_ref_doctors` and `locations` ↔ branch links
- department cost pools and allocation keys
- `rooms` and a rota (doctor × room × weekday × time)
- available hours and utilisation
- patient retention from visits and appointments
- a revenue/profit/cash forecast with a dated event calendar (Ramadan and both Eids per Hijri year, school holidays)
  and per-department seasonal factors shrunk to the clinic pattern
- scenarios
- KPI alert rules (thresholds in `fin_ref_finance_settings` or a new `mgmt_alert_rules`, never constants; today's
  `lib/finance/alerts.ts` constants are pipeline alerts only)
- a finance row and drill-down on `/dashboard/management`

**Not available from any system:**
- Unite schedules, rooms and visits (no documented endpoint)
- payroll (CSV upload)
- room costs (setup)

## 4. Phases

Each phase starts in Plan Mode with its own notes file. Weeks are indicative for one builder.

| Phase | Weeks | Scope | Gate to the next |
|---|---|---|---|
| **M0** Turn on the data | 1–2 | Apply `deploy/supabase-paste` 21a… to the live project; Unite keys and status codes (OQ-26, OQ-23); definitions signed (OQ-138 to OQ-140, OQ-143); master-data links; Tally cost-centre structure (OQ-144) | Definitions signed, database live, every doctor tied to a department and a clinic |
| **M1** Revenue you can trust | 3–6 | 23A and 23B from `docs/39`; metric register v1 (L1, patients, visits, revenue per patient and per visit); finance row and drill-down on Management; alerts: revenue behind target, revenue per patient below band, data late | Sep and Oct reconcile to Unite to the fils → switch capture on with the January backfill (OQ-94) |
| **M2** Costs and contribution | 7–12 | Tally costs by branch × department; payroll and doctor fixed-cost upload; contract terms for every doctor; L2 to L6 with allocation keys (OQ-143); 23D collections; alerts: viability, declining doctor (seasonally adjusted), cost jump, budget variance, insurance cash | One month closed and approved |
| **M3** Capacity and rooms | 13–18 | `rooms`, rota, available hours, utilisation, revenue per available hour and per room-hour, retention, no-shows (needs Unite appointments on); alerts: under-booked doctor, under-used room, no-show spike | Unite appointments flowing; rota kept 4 weeks |
| **M4** Forecasts and decisions | 19–26 | 12-month forecast (run-rate × seasonality × capacity, low/expected/high, accuracy tracked); cash forecast from payer curves (`forecast.ts`); scenario types: hours, recruitment (the May calculator on the shared engine, ramp-up from past hires), rooms, equipment (payback), specialty, price/cost; forecast-risk alert | 13 months of history (Unite exports for 2025 via 23A) |
| **M5** Cockpit | ongoing | Role homes (Clinic OS Phase D), monthly board pack from the register, scheduled digests | — |

## 5. Rules for the build

- **No new calculation outside the register.** A page, alert, export or scenario that needs a figure reads it from
  the register.
- **Thresholds are settings** with an owner and a change date. Bands, the 750 target, viability floor, alert limits,
  consumables %, gateway % and the claimed-revenue haircut are never constants.
- **Doctor pay and doctor-level profit** stay behind `finance.costs.compensation` / `finance.profit.view`. Department
  heads see only their department's contribution. Cost/payroll roles never see revenue (existing F8 rule).
- **Scenarios** are labelled "Scenario" everywhere, carry their author and assumptions, and can never be posted,
  exported as actuals or sent.
- **Forecast output** always shows a range and last month's forecast against the actual.
- **No PHI** in any of it: PIN-level data only where the finance rules already allow it; analytics use `patient_ref`.

## 6. Status

- **M1 built (14 Oct 2026):** 23A and 23B (see `docs/23_PHASE_23A_NOTES.md`, `docs/23_PHASE_23B_NOTES.md`). Deferred from M1: KPI alerts (revenue behind target, data late), Longevity split (23C), collections and data-quality view (23D), the metric register as a shared module (the 23B rules are its first entries).
- **M2 input:** doctor pay comes from the HR Contract Generator terms; `docs/finance/contract-rules-alignment.md` maps each contract type onto Pulse's revenue-share rule and lists the gaps (OQ-148 to OQ-157).

## 7. Open questions added

OQ-143 to OQ-147, in `docs/audit/open-questions.md`.
