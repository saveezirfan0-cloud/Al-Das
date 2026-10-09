# What to ask Sharaf for (safe to share: headers only)

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
