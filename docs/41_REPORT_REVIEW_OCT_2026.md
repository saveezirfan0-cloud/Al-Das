# Report review, October 2026: insurance, lab, daily revenue and operations files

The clinic sent four sets of its own reports on 15 and 16 October 2026 for the finance decisions meeting. They were analysed in the session scratchpad only. **Nothing from them is in the repo**: this note holds counts, totals and column names, never a patient, member or staff value. The decisions they feed are in `docs/audit/open-questions.md` (evidence added to OQ-132 to OQ-158, new questions OQ-161 to OQ-181).

## 1. Insurance (Diligence exports, facility DHA-F-0000419)

| File | What it is | Size |
|---|---|---|
| ACTIVTY | Claim Details with Activity, one row per claim line, 70 columns, service months Jan to Sep 2026 | 19,341 lines, 6,995 claims |
| Claim Summary - Monthwise | Claimed, remitted, rejected, taken back and pending per month | control totals |
| Remittance Receipt Report (New) format | One row per payment advice with the bank receipt columns | 3 sample rows |

Totals (ACTIVTY): net AED 4,178,802; remitted 2,799,531; rejected 578,412; unprocessed 800,859. The Claim Summary agrees with it month by month.

Evidence:
- **Provision (OQ-152).** Mature months (Jan to Jun, 2.6% still open): paid 82.1% and rejected 15.4% of net. Rejected share by payer runs from 4.3% to 35.0%; two payers are above 30%. Monthly rejection ranges 12.7% to 20.6%.
- **When insurance money arrives (OQ-148).** Visit to settlement: median 47 days (p90 62). By value 2.2% settles in the service month, 41.7% in month +1, 53.4% in month +2, about 3% later. Claims are submitted about 15 days after the visit (median).
- **Resubmission.** 6,129 lines were resubmitted; initial rejections fell from 782.6k to 578.4k (about 26% recovered).
- **Insurer and patient share (OQ-132).** Neither file has a gross amount or a patient share; Diligence net is the payer's share only.
- **Bank receipt.** About AED 384.6k is remitted but its bank receipt is still Pending (OQ-166).

## 2. Daily and monthly revenue (Unite collection export and the hand-built reports)

- The Unite collection export for one day (14 Oct) reconciles to its Invoice Total row to the fils on all 12 money columns (net 52,237.06). Its title reads "Daily Collection for 14-Oct-2026", which Pulse refused before this change.
- The hand-built Daily Financial Report and the October revenue report use Unite NET BILLING by invoice date, so their totals equal the Unite export exactly (14 Oct and 1 to 14 Oct).
- **ARPP (OQ-138).** Both reports divide revenue by billed visits. For 1 to 14 Oct core: 779.10 per billed visit, 803.04 per patient-day, 897.24 per unique billed patient, 820.91 per unique patient including unbilled. The 750 target is applied per visit.
- **Follow-ups (OQ-140).** Neither report measures follow-ups; Unite marks visits New or Revisit only (14 Oct: Revisit 66, New 11, blank 11).
- **Branch (OQ-141, OQ-161).** The branch is typed by hand per visit. Neither the Unite clinic name nor the site tag in the insurance remarks reproduces it, and the branch is not fixed per doctor per day.
- **Longevity (OQ-139).** A core line with 6% of the budget. 72% of its October revenue comes from three dedicated departments; the rest from visits tagged by hand.
- **Budget.** October target AED 1,760,000, split by ratio (Shoreline 0.56, Golden Mile 0.16, Meadows 0.22, Longevity 0.06), 58,667 a day. Month to date (1 to 14 Oct) core is 23.6% under target.
- **Faults in the hand reports** (they explain differences, not errors in Unite): doctor tables sum including VAT while branch totals use net; one percentage divides by the wrong total; a stale pivot; the daily target is ÷ 30 in a 31-day month (OQ-163, OQ-165).

## 3. Laboratory (September 2026)

| File | What it is |
|---|---|
| Unite Period Wise Investigations (RawData sheet) | Every investigation billed, with item code, department, PIN, amounts |
| FML internal activity | Tests run by the in-house lab under the fixed fee (list value only) |
| FML external sales book | Tests sent out, with CPT, branch, rate and VAT; plus the fixed-fee voucher |
| In-house test list, lab cost and FML price list | Reference lists |

- Unite TEST revenue: AED 512,770 (2,215 lines). Lab cost: fixed fee 25,000 plus external tests 69,588 = 94,588, **18.4% of TEST revenue** (13.6% without the fixed fee) (OQ-150).
- Matching by PIN + CPT + date within 3 days pairs 774 of 1,966 internal and 467 of 994 external lines; same day only finds about two thirds of those (OQ-171). Panels (Unite bills one line, the lab lists the parts) and seven code differences explain most of the rest.
- After that, 342 external lines (AED 31,254) are candidates for "done, not billed", and 629 Unite TEST lines (AED 194,467) are on no lab file: clinic bundles, rapid tests the lab does not perform, in-house tests and cytology (likely the histopathology lab, whose invoice was not in the set).
- In-house tests sent external: 178 lines, AED 6,269 (OQ-172). 22 external lines were billed below the price list (OQ-173). No file has a result date, so turnaround cannot be measured (OQ-175).
- Lab lines are billed under the treating department; the referring doctor is filled on 18 of 2,215 lines, so the invoice doctor is in effect the ordering doctor (OQ-157).
- Lab invoices dated 30 Sep arrived about 15 Oct: accrue the fixed fee monthly (OQ-133).

## 4. Operations (Unite exports, 1 to 16 Oct)

- Visits 1 to 15 Oct: 1,156 visits, 863 patients, 19% new; insured 583 of 1,156.
- Open seven days; visits from 08:00 to about 18:30; appointments at the main site run 08:00 to 19:00 (OQ-158).
- Appointment statuses: Awaiting Confirmation, Confirmed, Honoured, Cancelled. 25 of 50 same-day appointments on 16 Oct were still awaiting confirmation (OQ-178).
- 24 cancellations in two weeks, median 1.1 hours after booking, mostly booking corrections (OQ-179).
- "How did you hear about us" has about 60 spellings (OQ-180).
- Doctor directory: 29 doctors in 14 departments, two DHA facility licences that do not map to sites, Golden Mile doctors missing (OQ-177).
- Prescriptions 1 to 16 Oct: AED 107,544 over 370 prescriptions.

## 5. Changes made in Pulse

| Change | Why | Where |
|---|---|---|
| `LastDenailCode` accepted as the last denial code | Diligence misspells the header; without it no denial case would ever open from the real file | `lib/finance/diligence-mapping.ts` |
| `PrimaryDiagnosis` read as the principal diagnosis code | The real file's name for it | same |
| PatientID, IDPayer, clinician names and two comment columns listed as dropped-sensitive | They are in the real file; never read | same |
| Insurer name fills a blank payer name at commit | Pages showed payer ids only; never overwrites a name Finance typed | `parse-diligence.ts`, `diligence-service.ts`, `diligence-db.ts` |
| One-day Unite collection export accepted ("Daily Collection for …") | Daily uploads were refused | `lib/finance/unite-report-mapping.ts`, `parse-unite-report.ts` |
| Lab files: composite codes ("87177+87209") and voucher numbers with ":" ("Req:19998") | The send-out lab's file was refused as a whole | `parse-import.ts`, migration `20261209000100` |

Tests: the real 70-column Diligence header row with synthetic values; a one-day title; lab code shapes.

## 6. Build backlog the evidence supports (not built yet)

1. **Branch aliases** (OQ-162): several Unite clinic names per branch, so the rename after 10 Nov does not turn September and October into "unknown branch". Needed before the rename.
2. **Branch per visit** (OQ-161): default from the doctor's rota, corrected by Finance.
3. **Flash report on the uploaded report** while Unite capture stays off; per-line Unite vs cash-up tie and a patient-count grid; branch + department line rules (OQ-164).
4. **Unite investigations upload** (the Period Wise Investigations RawData sheet) so lab reconciliation has a billed side while capture is off; a lab code crosswalk with panels; "in-house test sent out" and duplicate exceptions; a price list that allows more than one price per code; the fixed-fee line skipped as a fee.
5. **Insurance receipt register** as an import kind (one row per payment advice with bank receipt columns) feeding bank reconciliation (OQ-166); settled amount and date from ACTIVTY for the cash view.
6. **Insurance cohort grid** (paid, rejected, open % by service month and payer) and the resubmission recovery rate.
