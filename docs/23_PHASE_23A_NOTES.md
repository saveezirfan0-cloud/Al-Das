# Phase 23A notes: the Unite collection report upload

_Built 14 Oct 2026 from `docs/39_UNITE_REPORTS_PLAN.md` §4 23A and `docs/40_MANAGEMENT_PLATFORM_PLAN.md` (M1). Migrations
`20261126000100_finance_unite_report.sql` (tables, permission; first numbered `20261123000100`) and
`20261126000200_finance_unite_report_functions.sql` (stage, commit, discard, summary)._

## Why

The Unite Finance capture stays OFF (OQ-94), so every revenue page is empty. Finance already exports the Unite "Daily
Collection Multi-Clinic Report" every month. 23A turns that export into sanitised rows Pulse can trust: the rows must add
up to the report's own Invoice Total row to the fils, and only then can they be committed. The doctor performance page
(23B) reads `fin_report_visits` where `is_current`.

Deliberate difference from the plan in `docs/39`: the rows are NOT written into `fin_invoices` / `fin_invoice_lines` /
`fin_payments`. The report has no DHA doctor id and one row per visit (self-pay and insurance invoice numbers on one row),
so mixing it into the capture tables would give every doctor a second identity and could count revenue twice when capture
is switched on (OQ-142). Everything lives in `fin_report_uploads` and `fin_report_visits`, service role only.

## What was built

| Piece                                                                                                    | Where                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Column names, closed lists, doctor key, amount and status helpers (the ONLY place that knows the layout) | `lib/finance/unite-report-mapping.ts`                                                                                                                                                                                    |
| Parser: workbook -> rows, report totals, row totals, reconciliation, problems; fails closed              | `lib/finance/parse-unite-report.ts` (`parseUniteReport`, `parseUniteReportTables`, `UniteReportError`)                                                                                                                   |
| Database calls and safe messages (server only)                                                           | `lib/finance/unite-report-service.ts`                                                                                                                                                                                    |
| Server actions (`finance.revenue.import`, audited)                                                       | `app/(app)/finance/upload/unite-report-actions.ts`: `createUniteReportUpload`, `processUniteReportUpload`, `getUniteReportUpload`, `commitUniteReportUpload`, `discardUniteReportUpload`                                 |
| Card "Unite collection report" (upload, preview, commit / discard, recent uploads)                       | `app/(app)/finance/upload/unite-report-flow.tsx` on `/finance/upload`                                                                                                                                                    |
| SQL (SECURITY DEFINER, `search_path = ''`, service role only)                                            | `fin_report_stage(org, user, meta jsonb, rows jsonb)`, `fin_report_commit(org, upload, user)`, `fin_report_discard(org, upload)`, `fin_report_upload_summary(org, upload)`; private `app.fin_report_upload_json(upload)` |

### Reading the file

- Only two sheets are opened: `Clinic Summary` and `RawData`. The ` Cash Receipt Details` sheet is never read.
- `Clinic Summary`: column A of the first rows holds the title `Daily Collection from 01-Sep-2026  to 30-Sep-2026 | ...`
  (spacing tolerated); that is the upload's date range. The header row is the one with `Doctor Name`, `Gross Amount` and
  `Net Billing`; the ONLY data row read is the one whose column B is exactly `Invoice Total` (exactly one).
- `RawData`: row 1 is the header row; a row is data when `S.NO` is not blank. Headers are matched exactly after trimming
  and case-sensitively (`STATUS` is the visit status, `Status` the record status). `PAYMENT GATEWAY` and `OTHERS` repeat:
  the first occurrence (before `PATIENT SHARE`) is read, and the parser refuses a file where it is not in that section.
- The service-category block is every column strictly between `INSURANCE CARD NO` and `GROSS AMT`; the header is the label,
  the values are amounts, non-zero ones go in `categories`. A known personal or other column inside the block, or the same
  category twice, refuses the file. Untitled columns are skipped.
- Never read: patient name, insurance card number, insurer, remarks, insurance remarks (the site tag), referral doctor and
  clinic, invoiced by, modified by, the payment-mode text, the advance / outstanding / collection columns other than those
  mapped, DD amount, special discount.

### Values

- Amounts are read as integer fils (`Math.round(x * 100)`): a number, a numeric string or blank (0). Anything else
  refuses the file naming the column and row, never the cell.
- `VISIT DATE` is a datetime in Dubai wall-clock time; exceljs gives it in the UTC fields, so `visit_at` = that wall
  clock minus 4 hours. `INVOICE DATE` is the UTC Y-M-D of the cell. `report_date` = the invoice date, else the visit's
  Dubai date. A row with neither, or a date cell holding text, refuses the file. Every `report_date` must fall inside the
  title's range (`N rows dated outside the report range`).
- `PIN NO` is kept as trimmed text (a number keeps its digits); `patient_ref` is set by the trigger from the Vault key.
- Visit status: New, Revisit, Followup / Follow up / Follow-up (any case), blank; anything else refuses the file.
  Record status: Active or blank (kept), Cancel (kept, `is_cancelled`; it is in Unite's totals); anything else refuses.
- Doctor: display name trimmed with whitespace collapsed; `doctor_key` = `normaliseDoctorKey` (lowercase, NBSP to space,
  a leading `dr` / `dr.` token removed, dots removed, whitespace collapsed), so `Dr. Latife cilli`, `Dr.Latife Cilli` and
  `dr latife  cilli` are one doctor. A blank doctor (direct sale) is kept as `(no doctor)` so the totals still reconcile,
  and the preview says how many.

### Reconciliation

Twelve columns: Gross Amount, Discount, VATAmount, Net Billing, Total, Cash, Card, Bank Transfer, Payment Gateway, Others,
Patient Share, Insurance Claim. The sum of every row (cancelled included) must equal the Invoice Total row exactly in
fils. TOTAL ADVANCE CONSUMPTION is on a different basis in Unite and is not reconciled. The parser checks it, and
`fin_report_stage` sums the stored rows again: `reconciled` is true only when both agree. A difference is listed as a
problem naming the column. An upload that does not reconcile can be looked at and discarded, never committed.

### Stage, commit, discard

- **Upload.** The browser puts the `.xlsx` (25 MB cap) in the private `finance-files` bucket through a signed URL
  (`<org>/unite-report/<uuid>.xlsx`), the same pattern as the Diligence upload. The server downloads it and deletes it
  before parsing (again in `finally`); only its sha256 is kept.
- **Stage** inserts the upload (`staged`) and all rows in one transaction, rows not current. The same file again (org,
  sha256) returns the earlier upload unchanged (`existing`).
- **Commit** (staged and reconciled only; one commit per org at a time): `branch_code` from `fin_ref_branches` where
  `active and unite_clinic_long_name = clinic_name` (null = unknown, counted); current rows of OTHER uploads whose
  `report_date` is inside this upload's range become `is_current = false` (nothing is deleted; rows outside the range stay
  current); this upload's rows become current; status `committed`, `committed_by/at`. A second commit is refused.
- **Discard** deletes a staged upload and its rows. A committed upload is never deleted.
- Error keywords from SQL (`report_not_found`, `report_not_staged`, `report_not_reconciled`, `report_rows_out_of_range`,
  `report_bad_input`) are turned into fixed sentences by the service.
- Audit rows: `finance.unite_report.staged | committed | discarded` with ids, dates and counts only.

## How to use

1. Unite: export the Daily Collection Multi-Clinic Report for one month (all clinics) as .xlsx.
2. Pulse, Finance, Insurance upload (`/finance/upload`), card "Unite collection report", Choose .xlsx file.
3. Check the preview: dates, rows, doctors, clinics, cancelled rows, rows with no branch, and the 12 totals side by side.
4. Commit (only when Reconciled), or Discard. A staged upload can be reviewed again from "Recent collection report
   uploads". Uploading a later or corrected export for the same dates replaces the earlier rows for those dates.
5. "Rows with no branch": map the Unite clinic name to a branch under Finance, Reference data (`fin_ref_branches`) and commit the
   next upload.

## Integration notes

- The `/finance/upload` page now opens for `finance.claims.import` OR `finance.revenue.import`, and shows each card only to
  the holder of its permission. The menu entry in `lib/finance/nav.ts` still lists `finance.claims.import` only (left for
  the nav owner; Finance and Finance Manager hold both).
- No help guide existed for `/finance/upload`, so none was added.

## Deferred

- The ` Cash Receipt Details` sheet (advance and outstanding receipts; it carries names): not read.
- The INSURANCE REMARKS site tag as a branch (OQ-141): not read; branch comes only from the Unite clinic name.
- The Longevity split (23C) and anything that posts revenue to the ledger (OQ-142).
- `revenue_source` (report vs capture) for when capture is switched on: the report rows are a separate table, so nothing is
  counted twice today; 23B reads only `fin_report_visits`.

## Tests

- `tests/unit/finance/parse-unite-report.test.ts` with the synthetic builder
  `tests/unit/finance/fixtures/unite-report-workbook.ts` (repeated headers, `NO` / `Package` / `PACKAGES`, a cancelled row,
  an unbilled visit after midnight Dubai time, an invoice-only row, NBSP and `Dr.` variants, sentinels in every column that
  must not be read).
- `tests/db/finance-unite-report.test.ts`: stage, idempotent re-stage, commit with branch codes, double commit refused,
  overlapping upload supersedes in range only, not reconciled (and the database's own re-check), out-of-range rows,
  discard (staged only), org isolation, no sentinel stored, service role only, the permission grant.

## After the review (14 Oct 2026)

- Report totals are read in thousandths and rounded to the fils once, exactly like the rows' sum, in the parser and in
  `fin_report_stage`; a half-fils total can no longer be accepted by one and refused by the other.
- `fin_report_commit` supersedes only the rows of the clinics the new upload contains: a one-clinic export never hides
  the other clinics. When two exports of the same dates are committed, the last commit wins.
- A sheet wider than 300 columns is refused (the real export has 74).
- Not adopted: requiring each row's categories to add up to GROSS AMT. On the real September export 123 of 2,401 rows
  differ (by up to AED 4,774), so the check would refuse genuine files.
- Known gap (same as the Diligence upload): if the browser uploads the file and the page closes before processing, the
  file stays in `finance-files/<org>/unite-report/` until removed; a storage sweep is a follow-up.
