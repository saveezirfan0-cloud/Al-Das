# Finance module — open items and discrepancies

## Needs a human before F2 go-live

| Item                                                                                                                                                                                                                                                                                                                                           | Owner                    | Blocks                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ----------------------------------- |
| **Token coexistence with Make.** Make's live scenarios (appointment reminders, medical records) share the token in Make data store 61544. Does a platform authorize/refresh invalidate Make's token? If yes, the platform must become the single token owner and push the token to Make via its API, or Unite must issue separate credentials. | Saveez / Unite           | F2 go-live                          |
| Ask Unite to re-queue the 12 test records (ADMC/C/44447–44458)                                                                                                                                                                                                                                                                                 | Unite                    | completeness of 7 Oct               |
| Ask Unite for the 2026 queue size. **Make no test calls before the guarded pipeline is live**: every call, even `count` = 1, consumes records. The first live run reports `DataBalancetoSync` for 01-01-2026 → today.                                                                                                                          | Saveez                   | F2                                  |
| Final Unite field list and enums (`RefType`, `InvType`, `ItemType`, `PaymentMode`), payer/TPA/member/claim fields, invoice line ID, modified timestamp                                                                                                                                                                                         | Unite                    | F2 field mapping (enhancements)     |
| Exact Unite clinic long/short names for the three branches (from the first full pull)                                                                                                                                                                                                                                                          | Saveez                   | branch derivation (E07 until set)   |
| One unfiltered Diligence export (all claims, all statuses, from 01-01-2026)                                                                                                                                                                                                                                                                    | Sharaf                   | F4                                  |
| Billing and Finance user names                                                                                                                                                                                                                                                                                                                 | Saeed                    | F5 roles                            |
| Ordering vs performing doctor attribution                                                                                                                                                                                                                                                                                                      | Saeed / Medical Director | report default only                 |
| Exception thresholds (N days): seeded E01 30, E04 14, E05 60                                                                                                                                                                                                                                                                                   | Sharaf / Finance         | F5 tuning                           |
| Insurance invoice number format (assumed `ADMC/…`)                                                                                                                                                                                                                                                                                             | verify in F2             | F4 matching                         |
| `write_off_status` value that means approved (views assume `approved`, case-insensitive)                                                                                                                                                                                                                                                       | Sharaf                   | receivables ageing, monthly summary |
| `inv_type` values (views treat `SELF…` as self-pay)                                                                                                                                                                                                                                                                                            | Unite                    | self-pay collected                  |

## Discrepancies between the brief and the rest of the repo (decide before F2)

1. **Token lifetime.** The brief says `expires_in` = 240 **minutes**; CLAUDE.md rule 7 says tokens expire in about 240 **seconds**. The token manager must refresh on demand and must not assume either until checked against a real response.
2. **App id/key pairs.** The brief says authorize and refresh use two different pairs; `docs/audit/open-questions.md` OQ-26 found three pairs (plus the Sanoflow key) in the Make Token scenario. Request fresh keys for the platform (OQ-26) and list exactly which are needed.
3. **`line_key` stability.** `inv|item_code|occurrence` can shift if an amendment removes an earlier duplicate line; claim matches reference lines, so F2 must record `position` and flag shifts rather than silently re-pointing matches.
4. **Appointments table.** Decided: F3 reuses the platform `appointments` table. The Phase 6 Unite appointment sync (read-only, off until its flag is on) fills it, and rule E08 reads `appointments` rows with `source = 'unite'`. E08 stays silent until the first appointment has synced (item 25), so enable the appointment sync before the Finance backfill.
5. **`fin_payments.txn_ref_name`** (from the brief) may contain a cardholder name. Confirm with the first real payload; drop or hash it if it is personal data.
6. **Production Unite credentials in this environment** do not exist yet (OQ-50). F2 cannot be exercised end to end here; it will be built against synthetic fixtures and a mocked HTTP client.

## Added in F2

7. **Initial token.** How the very first access/refresh token is obtained is unknown. The credentials form accepts an initial pair (copy from the Make Token data store, store 61544); without one, the first `authorize` is sent with no bearer header and may be rejected. Decide with Unite.
8. **Field mapping.** `lib/finance/unite-mapping.ts` lists alias guesses for each Unite key (based on the field names in the brief). Until Unite confirms the field list, the first real batch will probably fail closed, with a message naming the missing field. That is intended: edit the aliases, then reprocess the batch; no data is lost because the raw payload is stored first. Also confirm which fields are required in practice.
9. **Duplicate invoice in one batch** is treated as an error (fails the batch). If Unite can deliver the same invoice twice in one response, change `mapBatch` to keep the last.
10. **Payment keys.** Two payments with the same instalment and receipt (both often blank) are keyed `…#2`, `…#3` in delivery order. Confirm that order is stable across re-deliveries once real data is seen.
11. **The first live run** must be deliberate and watched: batches per run = 1, then check the batch log, row counts against the Unite UI, and the invoice number gap report before raising it.
12. **Raw payload retention.** The 90-day PII strip of `fin_raw_unite_batches.payload` is not built yet (phase F6).
13. **IP allow-listing.** Vercel has no fixed outbound IPs. If Unite restricts by IP, a static-IP add-on or a fixed-IP relay is needed before the first run (email question 15).
14. **Make estate facts (read 9 Oct 2026).** Data store "Token" (61544) is used by 10 scenarios; the TEST finance data store (167670) holds 16 records (not 2) and must be deleted after use; see `go-live-runbook.md` section 2.

## Added in F2.1 / F4

15. **Resolved in F2.1:** duplicate invoice inside one batch (now keeps the last), payload retention (90-day strip built), reference-data editor (built), first run defaults to 1 batch.
16. **Diligence column names are unconfirmed.** `lib/finance/diligence-mapping.ts` uses the names from the brief. Ask Sharaf for the header row only (`diligence-header-request.md`); the exact-70-columns check becomes possible then.
17. **Original Diligence file is not retained.** The brief said to keep it in a private bucket; the platform deletes it after parsing because it holds patient names and Emirates IDs, keeping the sha256 and the sanitised rows. Say so if the clinic wants the file archived (it would need a retention and access decision first).
18. **Clinical free text.** `DiagnosisText` and `DenialComment` are imported as specified and can contain clinical wording. Treat the claims screens as health data (access is limited to `finance.claims.view`).
19. **Blank amounts stay null** (never 0). Views treat null as 0 in sums. Confirm with Sharaf that a blank remitted amount means nothing was remitted.
20. **Write-off "approved" value** is still assumed (`approved`, case-insensitive) in the ageing and summary views.
21. **Files above 30,000 rows** are rejected (one atomic commit). A full year of claims for a clinic of this size should fit; tell us if not.
22. **Not built yet:** a browser-driven check of the finance pages, and a fixed-IP route to Unite if Unite allow-lists addresses. (The appointments sync, the exception rule engine and the invoice / monthly summary screens are built; see the status table in `05_FINANCE_MODULE_PLAN.md`.)

## Added in F5

23. **Insurance invoice type.** `fin_is_insurance_type()` treats any `InvType` containing `INSUR` as insurance (self-pay summary uses `SELF…`). Confirm Unite's actual `InvType` values; change that one function.
24. **E02 owner.** The brief says "Insurance + Billing". A rule has one owner; E02 is owned by Insurance, and Finance / CEO can see it. Billing does not see E02 unless the owner is switched in `fin_ref_exception_rules`.
25. **Rule guards are deliberate.** E01 is silent unless a Diligence file was committed in the last 14 days; E02 and gap exceptions are silent until the Unite backlog is drained; E08 ignores invoices before the first synced appointment. They stop false alarms during start-up. Tell us if the 14 days should change (it is a constant in `fin_rules_context`).
26. **Thresholds are placeholders** (E01 30, E04 14, E05 60 days, due in 7 days). Agree them with Sharaf and Finance, then edit them at Finance → Reference data → Exception rules.
27. **Exception volume.** Up to 1,000 new exceptions per rule per run. If the first run after the backfill opens that many, work them in order or raise the thresholds.
28. **Digest** is off by default; switch it on at Finance → Data health → Capture controls.
29. **Pages not driven in a browser** (no auth stack in the build environment): please click through Exceptions, Invoices, Summary, Reference and Upload once on a dev stack with seeded data.

## Added in F6

30. **Alert thresholds are constants** in `lib/finance/alerts.ts` (silent capture 3 h / 6 h, no upload 8 days, overdue above 20, reminder every 24 h). Tell us if they should change.
31. **Alert recipients** are members whose role holds `finance.capture.manage` (Admin by default). E-mail goes through the existing notifications queue, so `RESEND_API_KEY` must be set for e-mail to leave the system; in-app notices work without it.
32. **Human step left from the brief:** review the monthly summary with Saeed against one closed month before relying on the numbers.
