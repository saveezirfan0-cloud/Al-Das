# What to ask Sharaf for (safe to share: headers only)

> **Answered 16 Oct 2026.** The clinic sent a real "ACTIVTY" export (sheet `DataSheet`, 70 columns, service months Jan–Sep 2026). It was analysed in the session scratchpad only; nothing from it is in the repo. What it showed and what changed:
>
> - Every required column is present and the file parses as it is.
> - Diligence spells the last denial code header **`LastDenailCode`**. It is now an alias of `last_denial_code`; before this, no denial case would have been opened from the real file.
> - `PrimaryDiagnosis` is an alias of `principal_diagnosis` (ICD code only). `Diagnosis` stays unread until the clinic decides whether diagnosis codes are stored (see open-questions).
> - `PatientID`, `IDPayer`, the clinician name columns and the two free-text comment columns are on the dropped-sensitive list.
> - `Payer_Name` fills a blank insurer name in the payer reference list at commit (never overwrites a name Finance typed).
> - `SettledAmt` is an amount, not the yes/no `Settled` flag; it is not read (mapping it to `settled` would fail every row). `InitialDateSettlement`, `SettledAmt` and `ReceiptStatus` are candidates for a later cash-receipt view.
> - `InvoiceNo` looks like `ADMC/nnnnn` (not `ADMC/C/nnnnn`); matching uses the normalised invoice key.
> - The tests carry the real header row with synthetic values (`tests/unit/finance/parse-diligence.test.ts`).

We need the exact column names of the Diligence "Claim Details with Activity" export so the importer can be checked against the real file. **Do not send the file itself**: it contains patient names, Emirates IDs and member IDs.

## What to send

1. Open the unfiltered export in Excel.
2. Copy **row 1 only** (the column headings) into an email or message. Nothing from any other row.
3. Tell us the **sheet name** (we expect `DataSheet`) and how many columns there are (we expect 70).
4. For each of these columns, type one example of the _kind_ of value (not a real one), for example `Settled: Yes/No or 1/0?`:
   - `Settled`, `WriteOffStatus` (what value means "approved"?), `ClaimStatus`, `PaymentStatus`, `ReceiptStatus`
   - Date columns: are they dates or text, and what format (`dd/MM/yyyy`?)
   - `InvoiceNo`: does it look like the Unite invoice number, for example `ADMC/C/12345`?

## What happens next

Claude compares the headings with `lib/finance/diligence-mapping.ts` and updates the aliases. Any heading the importer does not recognise is listed on the upload screen, so a mismatch can never silently drop data: required columns that are missing make the upload fail with a clear message.

## Rules for the production file

- Unfiltered: all claims, all statuses, from 01-01-2026 (the sample was a filtered rejection list).
- Upload weekly and at month end (Finance → Insurance upload).
- The original file is deleted by the platform right after it is read; names, Emirates IDs and member IDs are never stored.
