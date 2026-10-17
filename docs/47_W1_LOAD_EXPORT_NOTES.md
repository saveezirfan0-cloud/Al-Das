# W1: loading the saved Unite Finance API export

Plan of 16 Oct 2026, row W1. The clinic already holds an export taken from the Unite Finance API. That API is
deliver-once, so those records can never reach Pulse's own capture. The file is the only copy, and it is loaded as raw
batches, never by calling Unite.

## How to load it

```
pnpm finance:load-export --org=<slug> --from=YYYY-MM-DD --to=YYYY-MM-DD [--dry-run] <file.json> [more files, oldest first]
```

1. **Dry run first.** It reads and checks every file, writes nothing, and prints invoices per month with their summed
   `total` (to compare with the collection report, below).
2. The file is split into batches of 500 invoices (the API's own page size), each stored **exactly as received** in
   `fin_raw_unite_batches` (`detail_message` says `saved export <file sha-256 prefix> part n/m`), then processed by the
   same `processBatch` as a live capture (`fin_apply_invoices`, idempotent).
3. **Safe to repeat.** A batch whose SHA-256 is already stored for the org and processed is skipped; one stored but not
   processed is processed again. Several files go in oldest first (a later copy of an invoice is a newer version).
4. If processing fails (a mapping problem), the raw batch stays and the command exits 1. Fix `lib/finance/unite-mapping.ts`
   or `map-invoice.ts`, then run `pnpm finance:replay --failed --org=<slug>`.

Accepted file shapes: the response envelope (`{ "MessageStatus": ..., "Data": [ ... ] }`) or a bare list of invoices.
It must be the JSON as Unite delivered it, not a copy re-typed in Excel. Nothing in this path imports the Unite client
(a unit test checks it), and `fin_capture_settings.enabled` is not touched.

`--from/--to` are the dates the person says the file covers; the API reports none back. They fill the batch's
`from_date`/`to_date` and nothing else reads them.

## What is not verified yet

- **"Agrees to the collection report to the fils".** Upload the same month's Unite collection report (23A, `fin_report_visits`)
  and compare its "Invoice Total" with the month line the loader prints. Which Unite invoice fields the report's twelve
  money columns add up to has not been checked against a real file: if the totals differ, the difference is in that
  definition, not necessarily in the load. Settle it with the first real month, then add the check as a page.
- The real export's field names are those already in `lib/finance/unite-mapping.ts`; the mapper fails a batch closed
  rather than guess, so an unexpected field shows up as a failed batch, never as a wrong number.

## Also changed

`finance:replay` built its own copy of the process dependencies and so skipped the ordering/performing doctor step the
app performs. Both scripts and the app now share `dbProcessDeps` (`lib/finance/process-deps.ts`, free of `server-only`).
