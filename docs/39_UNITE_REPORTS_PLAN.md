# 39 — Unite collection report and revenue comparison: analysis and plan (Phase 23)

Date: 14 Oct 2026. Sources: two files from Al Das, analysed in a scratch area and **not kept in the repository**.
- **A.** Unite "Daily Collection Multi-Clinic Report", 1 to 30 Sep 2026 (generated 14 Oct). Sheets: Clinic Summary, RawData,
  Cash Receipt Details. This is data request **D1**, and it covers **D2** (the daily collection per branch).
- **B.** "Revenue comparison Sep 12.10.2026", built by hand from A. Sheets: Rev Aug–Sep 2026, Doctor-wise performance,
  Department wise, Comparison Departments, Longevity.

**PHI warning.** A holds patient names, PINs, insurance card numbers, free-text remarks and a Cash Receipt sheet that lists
patients by name. Nothing from it may be committed, used as a fixture, or pasted into a prompt (rules 10 and 16). This
note gives totals and department figures only. Test data for Phase 23 is synthetic.

## 1. What the two files tell us

### 1.1 Report A: September 2026 at a glance

| Measure | AED / count |
|---|---|
| Gross billing | 1,914,317.93 |
| Discount | 75,312.13 (3.9% of gross) |
| **Net billing** (after discount, before VAT) | **1,839,005.80** |
| VAT | 25,932.08 |
| Insurance claim / patient share | 588,445.75 / 22,818.58 |
| Collected: card / cash / payment gateway / bank transfer | ~1,124k / ~53k / small / small |
| Visits / invoices | 1,933 / 2,227 |
| New / revisit visits (Unite status) | 231 / 1,702; Unite's "Followup" column is 0 everywhere |
| Distinct patients (PIN) / with any billing | 1,362 / 1,255 |
| Net by Unite clinic: Palm Jumeirah / Golden Mile / Meadows | 1,255,216 / 455,792 / 127,998 |

Service-category share of gross: Procedures 36%, Test 28%, Service 16%, Package + PACKAGES 7%, Vaccine 5%, Radiology 4%,
Dental 3%, the rest under 1% each.

Daily net ranged from about 28.5k to 140k. Golden Mile's revenue sits almost entirely with one practitioner.

### 1.2 Report A: data-quality findings (each one becomes a check in 23D)

1. **The branch is unreliable.**
   - Staff type the real site into the *INSURANCE REMARKS* column as free text. There are more than 20 spellings: Shoreline,
     meadows, MEADOWS, Meaadows, GM, golden mile and so on.
   - That remark disagrees with Unite's CLINIC NAME on about 365 rows. For example, 218 Palm Jumeirah rows say Meadows and
     85 Meadows rows say Shoreline. Another 418 rows are blank.
   - The Unite clinic is therefore not the site where the patient was seen. This matches OQ-101, the 10 Nov branch
     separation.
2. **Billing without a visit.** Two practitioners show invoices but 0 visits in the summary (81 and 20 invoices), and a
   third shows 2 invoices and 0 visits.
3. **Visits without billing.** 448 of 2,401 rows have net 0. 131 rows have no invoice number at all. One radiology
   practitioner has 39 visits and no revenue, because radiology is billed under the referring doctor.
4. **Late and back-dated invoices.**
   - About 150 invoices were raised 1 to 10+ days after the visit.
   - 18 September invoices belong to visits from earlier months, going back to January 2025.
5. **Categories.**
   - Unite has both "Package" and "PACKAGES".
   - It also has a category literally named "NO" (26 rows), which is an unmapped item type.
6. **Payers.** The insurer field joins TPA, insurer and plan with inconsistent separators ("NEURON LLC, NEURON LLC" and
   "NEURON LLCNEURON - CIGNA…"). One TPA group holds about 54% of claim value.
7. **Repeated headers.** RawData repeats the headers PAYMENT GATEWAY, OTHERS and OTHERS PAYMENT MODE: once for the
   invoice's payment and once for the collection. A parser must read columns by section and position, not by name alone.
8. **Other rows.**
   - 4 rows are cancelled (968 net).
   - 35 rows have no New/Revisit status.
   - 330 rows with net > 0 have a blank invoice type.

### 1.3 Workbook B: how it is built, and its errors

**How it is built.**
- Revenue is Unite **net billing** per doctor.
- "Unique p count" is the number of distinct PINs per doctor, *including* patients with no billing.
- **ARPP = revenue / unique patients**, against a 750 target with bands: Achieved ≥750, Near Target 700–749, Moderate
  650–699, Below <650.
- "Expected revenue" = unique patients × 750.
- "Follow-up" = visits minus unique patients, which is repeat visits in the month. This matches A for the doctors checked.
- **Longevity** is split out of three doctors' revenue and shown with three Longevity practitioners.
- Chiropractic and Physiotherapy are left out.

**It reconciles to A to the fils:**

| | AED |
|---|---|
| Doctor comparison | 1,467,284.86 |
| Longevity | 131,984.97 |
| Chiropractic | 158,957.64 |
| Physiotherapy | 80,778.34 |
| **Total** | **1,839,005.81 = A's net billing** |

**Errors found.** The cell references are to B's sheets.

| # | Where | Error | Effect |
|---|---|---|---|
| 1 | Rev Aug–Sep, column E | "Percentage difference" = (Sep − Aug) / **Sep** | A rise from 14,859 to 431,525 shows +96.6% instead of +2,804%; a fall of 58.5% shows −140.9% |
| 2 | Rev Aug–Sep, column Q | Sep follow-up % uses **Aug** follow-ups (N) over Sep patients | e.g. 6.4% shown instead of 41.9% |
| 3 | Rev Aug–Sep, column R and Doctor-wise H | Band formula has gaps (749–750 and 699–700 return FALSE); exactly 650 lands in Below, though the key says Moderate | Wrong or blank band at the edges |
| 4 | Rev Aug–Sep, row 23 | Totals add up ARPPs and percentages (L23, M23, O23) | Meaningless totals (ARPP "24,094") |
| 5 | Doctor-wise rows 24 and 38 | One row pulls another doctor's **August** revenue and patients. The Aesthetic Dermatology row uses the clinic total patients (H23) and the summed ARPP (M23) | A phantom doctor appears in Ob-Gyne; Aesthetic shows "Achieved" with −57.8% |
| 6 | Doctor-wise B5/B6 | Nutrition is `#REF!`; B6 repeats the Aesthetic revenue | Broken cell, double listing |
| 7 | Doctor-wise H34/H36/H38 | Band formulas point at the wrong rows (E31, E33, E35); E34 is typed as 0 | Sports Medicine shows Below Target at ARPP 1,224 |
| 8 | Department wise F15 | Variance total = SUM(F4:F12), which leaves out two departments | 378,337 shown; the real figure is **793,628.40** |
| 9 | Department wise C | Doctor counts typed by hand and inconsistent with the formulas (General 3 but four rows summed; Pediatrician 1 but two summed) | Wrong doctor counts |
| 10 | Comparison Departments | Header says August, values are September; Sports Medicine % typed as 0 | Mislabelled |
| 11 | Longevity | Column says "Aug", title says Sep | Mislabelled |
| 12 | "Unique p w/o Amt" | One doctor shows 9; the raw data gives 17 | Hand count drift |
| 13 | Summed unique patients | Sum of per-doctor uniques = 1,362, but 204 patients saw 2 or more practitioners | Clinic ARPP understated slightly |

A corrected workbook (formulas only, same inputs, a Reconciliation sheet back to A) was handed to the owner in the session
and is **not** in the repository.

**Signals worth a look once the numbers are right (September vs August):**
- Revenue in the comparison is up 117.8%, from 673,656 to 1,467,285.
- Dental is down 58.3%.
- General's ARPP is 649, just under Moderate. Two General doctors are Below Target (533 and 607).
- One doctor's 431k is 29% of the comparison total, with 0 visits recorded.

## 2. Definitions that disagree today

| Measure | Workbook B | Pulse today (20A flash, `lib/finance/flash.ts`) | Pulse doctors/analytics pages |
|---|---|---|---|
| Revenue | Unite net billing | invoice `net` (same) | line or invoice net (same) |
| ARPP denominator | **unique patients** in the month, including unbilled | **patient visits** (distinct patient per day, branch, department and doctor, summed) | unique patients with an invoice |
| ARPP target | 750 per doctor, 4 bands | one ARPP target per line or total, variance only, no bands | none |
| Follow-up | visits − unique patients | not present (`followup.ts` is insurance-claim follow-up) | not present |
| New / revisit | Unite visit status | not present | "new" = first invoice ever |
| Longevity | split per practitioner by service (rule unknown) | a reporting line by branch or department only | none |
| Department | hand mapping, doctor → department | invoice department, else `fin_ref_doctors` | same |
| Branch | Unite clinic (unreliable, §1.2) | `fin_invoices.branch_code` from `fin_ref_branches` | same |

The two ARPPs measure different things. Visit-based ARPP rewards a high spend per visit. Patient-based ARPP rewards a high
spend per patient across the month, so repeat visits raise it. **Both stay, with different names on screen:**
"Revenue per visit" (flash) and "Revenue per patient" (doctor performance). The 750 target and its bands apply to
whichever one management confirms (OQ-138).

## 3. What Pulse already has, and what is missing

**Have**
- Daily flash with targets, month-to-date scaling, reporting lines, core vs non-core (Chiro), doctor ranking and previous
  month same-days per line (20A).
- Revenue breakdown by doctor, department, branch, service and category, with share and previous period
  (`fin_revenue_breakdown`).
- Doctor measures with unique patients and per-patient revenue (`fin_doctor_measures`).
- Billing mix by service category and payer type (20K).
- Cash-up by payment mode per branch per day.
- Doctor → department reference (`fin_ref_doctors`).

**Blocking gap: no data.** Every one of these reads `fin_invoices` / `fin_invoice_lines` / `fin_payments`, which only the
Unite Finance capture fills, and the owner keeps capture OFF (OQ-94). The "Unite daily revenue upload" planned in 20B was
never built. So on the live system all revenue pages are empty today, while finance staff rebuild the same numbers by hand
every month.

**Other gaps**
- Doctor month vs previous month.
- Revenue per patient against 750 with bands.
- Expected revenue and gap.
- Patients without billing.
- New / revisit / follow-up visits.
- Longevity split.
- Payment modes per doctor, normalised.
- Patient share vs insurance claim.
- Advance and credit-note consumption.
- Overdue and previous-due collections.
- Visits vs invoices.
- A data-quality view of the export itself.

## 4. Plan: Phase 23 (four slices, one session each, Plan Mode first)

Order: 23A unblocks everything, 23B replaces workbook B, 23C and 23D can follow in either order. Each slice follows CLAUDE.md
(finance rules, rule 17 security guards, synthetic fixtures only) and adds its notes file `docs/23_PHASE_23X_NOTES.md`.

### 23A — Unite Daily Collection report import (the bridge while capture is OFF) · P0

> **As built (14 Oct 2026):** the report rows go to their own sanitised table `fin_report_visits`, not into `fin_invoices`. The report has no DHA doctor id and one row per visit (self-pay and insurance numbers together), so writing it into the capture tables would give every doctor a second identity and risk posting revenue twice. Amounts keep Unite's three decimals. Details: `docs/23_PHASE_23A_NOTES.md`; the text below is the original plan.

**Upload.** Finance uploads A's .xlsx at `/finance/upload` (new card "Unite daily collection"). It needs a new permission,
`finance.revenue.import`, granted to Finance and Finance Manager. The migration also grants it and adds it to `later()`
in `tests/db/finance-phase18-rls.test.ts`.

**What is read**
- The file is parsed server-side, and only RawData and the Clinic Summary totals are read.
- Column names live ONLY in `lib/finance/unite-report-mapping.ts`. They are read by section and position because of the
  repeated headers.
- Unknown columns are never read.
- **Never read:**
  - patient name
  - insurance card number
  - REMARKS
  - the Cash Receipt sheet's NAME column
- The INSURANCE REMARKS site tag is read only through a closed normaliser to a branch code (Shoreline, Meadows,
  Golden Mile, or none), and only if OQ-141 says so. The raw text is never stored.
- The original file is deleted at once; only its sha256 is kept.

**What is written**
- The PIN is kept, as the finance rules allow.
- Rows are written as `fin_invoices` with `source = 'unite_report'`, keyed by invoice number and type. A row has
  separate self-pay and insurance numbers, which become two invoices.
- Each non-zero category column becomes one synthetic `fin_invoice_lines` row (`item_type` = the category,
  `item_code` = `CAT:<category>`), so billing mix works.
- Payment-mode columns become `fin_payments` rows with a normalised mode. The mode list lives in the mapping file.
- New nullable columns:
  - `visit_date`
  - `visit_status` (new / revisit / blank)
  - `patient_share` and `insurance_claim`
  - `advance_consumed` and `credit_note_consumed`
  - `outstanding_credit`
  - `site_code`
- Visits without an invoice number go to a small `fin_report_visits` table: PIN, date, doctor, department, branch and
  status only. This feeds the follow-up count and the visits-vs-invoices check.

**Replace rules**
- An upload covers a date range. Re-uploading the same range replaces it idempotently: invoices that are gone become
  `is_deleted`, and lines become `is_current = false`. Nothing is ever deleted.
- **When capture is switched on**, API rows win. An invoice number present from both sources keeps the API version.
  A setting `revenue_source` ('report' | 'capture' | 'both_prefer_capture') decides what reports read, so nothing is
  counted twice.

**Checks and reports**
- **Reconciliation on upload:** the sum of imported net, gross, discount, VAT, visits and invoices must equal the Clinic
  Summary "Invoice Total" row, or the upload stays in "needs review" and nothing posts.
- The dry run shows the counts and the reconciliation.
- Reports are counts only and pass `findPii`.

**Accounting**
- Report-sourced invoices post to the ledger only after OQ-142 is answered (default: they do not post, and capture stays
  the posting source).
- The ledger start-date refusal is handled by holding the item, as 22A requires.

**Tests**
- Synthetic workbook builder in `tests/unit/finance/fixtures`, including the repeated headers, a "NO" category and a
  visit without an invoice.
- Parser and mapper unit tests.
- DB tests: RLS, idempotent re-upload, the capture-wins rule, and a test proving a row with a name column never stores
  the name.

### 23B — Doctor performance and month comparison (replaces workbook B) · P0

New page `/finance/doctor-performance` under Finance, Revenue, gated by `finance.revenue.view`. It has an Excel download
(values only, audited with `recordExport`).

**Pure rules** in `lib/finance/doctor-performance.ts`, parity-tested against a SECURITY DEFINER SQL function
`fin_doctor_performance(org, month)` with a shared `phase23-*.synthetic.json` fixture.

**Per doctor, for this month vs the previous month:**
- revenue, change and change % (**over the previous month**)
- unique patients, patients without billing and the patient change %
- revenue per patient and its band
- expected revenue (patients × target), gap and achievement %
- new / revisit visits, follow-up visits (visits − unique patients) and follow-ups per patient

**Department roll-up**
- Doctor count is taken from the data.
- Department share of the total.
- The clinic total counts distinct patients once, not the sum of doctors.

**Thresholds** live in `fin_ref_finance_settings`: `perf_arpp_target` 750, `perf_band_near` 700, `perf_band_moderate`
650. They are never hardcoded. Bands are half-open intervals with no gaps.

**Inclusion and exclusion** (Chiro, Physio, Longevity, radiology reporting) uses the existing `fin_ref_report_lines`. A
footer reconciles the shown total back to all revenue, line by line, as the corrected workbook does.

**Not shown**
- No profit figures.
- No comparison across doctors' compensation.
- Medical Director access follows the existing `finance.revenue.view` preset.

### 23C — Longevity and service lines · P1 (blocked on OQ-139)

- Add `fin_ref_service_lines`: code and label, plus match rules by item code, item type, department or doctor; first
  match wins; unmatched means no line.
- A "service line" dimension in `fin_revenue_breakdown`, the flash lines and 23B.
- Longevity revenue per practitioner.
- **This needs item-level data.** A's category columns cannot identify Longevity (checked against three doctors' split).
  So 23C works on captured lines, or on a Unite item-wise export if Al Das can provide one (D15). Until then the
  Longevity line stays matched by department and practitioner, as today.

### 23D — Collections and data-quality view · P1

**Collections** (`/finance/collections`, `finance.view`):
- payment mode per day, branch and doctor (normalised)
- patient share vs insurance claim
- advance and credit-note consumption
- previous-due collections and outstanding credit
- advances, refunds and PIN transfers (Cash Receipt sheet: date, PIN, type, mode, amount only)

**Data quality**, as `fin_run_exception_rules` entries with thresholds in `fin_ref_exception_rules` (review signals,
never proof):
- invoices without a visit
- visits without an invoice after N days
- invoices raised more than N days after the visit
- invoices for visits in an earlier month
- site tag vs Unite clinic mismatch (if OQ-141)
- unmapped category ("NO")
- blank visit status
- blank invoice type with net > 0

Each signal links to the invoice list filter it uses.

### What the owner can do now, before any of this ships

1. Use the corrected workbook for September and October.
2. Answer OQ-138 to OQ-142.
3. Enter the October targets on the Flash settings page, including ARPP 750, once 23A gives Pulse data.
4. Keep sending A monthly (or daily). Each file becomes a test of 23A's reconciliation on the clinic's side, never in the
   repository.

## 5. Open questions added (register: `docs/audit/open-questions.md`)

- **OQ-138** ARPP: per visit or per unique patient; which one carries the 750 target and bands; do unbilled patients
  count.
- **OQ-139** Longevity: which services (item codes) and practitioners make up Longevity, and how a doctor's revenue is
  split.
- **OQ-140** Follow-up: is "visits − unique patients in the month" the intended follow-up measure, and should Unite's own
  Followup status be used instead (it is 0 everywhere today).
- **OQ-141** Site: is the free-text site tag in INSURANCE REMARKS the truth for branch reporting until the 10 Nov
  separation (OQ-101), and may Pulse read it through a closed list.
- **OQ-142** Report-sourced revenue: may invoices imported from the report post to the ledger, or only feed management
  reports until capture is switched on.
