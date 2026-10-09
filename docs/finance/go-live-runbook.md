# Finance module go-live runbook (Make, Unite, Supabase, Vercel)

Written for the person doing the setup (Saveez). Steps marked **[you]** need your accounts; steps marked **[code]** are already built. Do the sections in order. Nothing here switches capture on until section 5.

Why so careful: the Unite Finance API hands each record over **once**. If a response is lost before it is stored, only Unite can give those records back. The platform stores the raw response before it does anything else, but the first live run is still the moment to go slowly.

---

## 1. Platform setup [you]

1. **Supabase project.** Create it in the region the legal opinion allows (open question OQ-49: UAE patient data, Supabase has no UAE region). Enable the extensions `pgmq`, `pg_cron`, `pg_net`, `vector`, `pgcrypto`, `pg_trgm`.
2. **Migrations.** From the repo: `supabase link --project-ref <ref>` then `supabase db push` (or `pnpm db:migrate` locally). The finance migrations are `20261009000100` to `…600` and later ones.
3. **Vercel environment variables** (Production and Preview):
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
   - `JOB_SECRET` (32+ random characters), `APP_URL` (the production URL)
   - `ENCRYPTION_KEY`: generate once with `openssl rand -base64 32` and **back it up somewhere safe**. If it is lost, the saved Unite credentials cannot be decrypted and must be re-entered. Never change it casually.
   - `UNITE_BASE_URL` only if Unite gives a different gateway; the default is `https://ucexternalapiprod.uniteuae.care/gateway/`.
4. **Cron secrets (Supabase Vault).** In the SQL editor, once:
   ```sql
   select vault.create_secret('https://<your-app-url>', 'app_url');
   select vault.create_secret('<same value as JOB_SECRET>', 'job_secret');
   ```
   Until both exist, the cron jobs print a notice and do nothing.
5. **Check cron is alive.** In the app: Settings → System health. The `finance_capture` queue should show "Idle"/"OK" with a handler registered. The hourly `pulse:finance_capture_tick` will enqueue nothing while capture is off.
6. **Roles and reference data.** Run `pnpm finance:seed --org=<your-org-slug>` (adds Finance, Billing, Insurance, CEO, Medical Director roles and the branch / rule rows). Then Settings → Users: invite Sharaf (Insurance), Billing and Finance staff, the CEO and the Medical Director with the matching role.
7. **Branch names.** Branches P / M / G exist, but their Unite clinic names are blank. They are filled in section 5 after the first batch shows what Unite calls them.

## 2. Make: what exists and what to do about it [you]

What the audit found (read-only look at Make on 9 Oct 2026):

| Item                                            | State                                                                                                                                                                                                                                                                   |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scenario **Token** (3576415)                    | Active, runs 3 times a day (11:55, 17:55, 23:55). Writes the token pair into data store 61544.                                                                                                                                                                          |
| Data store **Token** (61544)                    | 2 records. Read by **10 scenarios**: Clinics & Appts, Post-Appointment Follow-up, NoShow_Recovery, Token, Unite > Sano Appointment Sync, Old-Unite > Airtable, Appointment Reminders, medical records sync, Appointment Reminders - 6PM, and the TEST finance scenario. |
| Scenario **TEST - Unite Finance API** (6555877) | **Do not run.** Each run consumes Unite records. Deactivate it (see 2.4).                                                                                                                                                                                               |
| Data store 167670 "TEST finance sample"         | 16 records. Holds sample invoices (contains patient data). Delete after 2.4.                                                                                                                                                                                            |
| Data structure 527821                           | Flattened sample structure only. Delete with the data store.                                                                                                                                                                                                            |

### 2.1 The question to settle: does a platform token break Make's token?

Make's scenarios share one token pair. If Unite keeps **one valid token per app credential** (or globally), then when the platform calls `authorize` or `refreshtoken` it could invalidate the token Make is using, and your appointment reminders and medical-record sync would start failing with "Invalid Token". We do not know yet. Three ways out, best first:

- **A. Separate credentials for the platform (recommended).** Ask Unite for a _new_ `app_id`/`app_key` pair(s) dedicated to the platform (the email draft in `unite-request-email.md` asks for this). If Unite confirms tokens are independent per credential, Make is never affected. This also fixes the open security item that three credential pairs sit in plain text inside Make (rotate those at cut-over).
- **B. Platform owns the token and feeds Make.** Only if Unite says tokens are global. The platform would write each new token into data store 61544 through the Make API so Make always sees the current one. Not built; build only if A is impossible.
- **C. Platform reads Make's token.** The platform would read data store 61544 instead of issuing its own. Not recommended: Make refreshes only 3 times a day, so the token is often stale (the audit notes tokens last about 240 s).

### 2.2 How to test safely if Unite cannot answer (do this only with Unite's credentials for the platform)

1. Pick a quiet window away from Make's schedule: after the 12:00 reminder run and well before 17:55 (for example 14:00 to 15:30 Dubai time). Tell the team.
2. In Make, open scenario **Clinics & Appts** (3576553) and click _Run once_. Confirm it succeeds. This is your "before".
3. From the Data health page, save the platform credentials and the initial token pair (see 3.3), **but do not enable capture.**
4. Trigger one `authorize` call with the platform's own credentials (the quickest way is a single `curl` of the `authorize` URL from your laptop; it is not the finance endpoint, so it consumes nothing).
5. Back in Make, _Run once_ on **Clinics & Appts** again. Success = Make's token is unaffected: tokens are independent per credential. "Invalid Token" = tokens are shared: switch to option A (separate credentials) or B, and let the Token scenario run once to repair Make's store.
6. Write the result in `docs/finance/open-items.md` (token coexistence row).

### 2.3 Initial token for the platform

How the very first token is obtained is not documented. Ask Unite (email question 4). If they say "call authorize with the app credentials and no bearer", the platform can do it by itself. If a starting token is required, Unite must issue one for the platform's credentials. **Do not copy the Make data-store token into the platform if you chose option A**: that would couple the two.

### 2.4 Clean up the test artefacts (after the sample shapes are no longer needed)

1. Make → Scenarios → _TEST - Unite Finance API_ → switch off, then delete.
2. Data stores → _TEST finance sample (temp - delete)_ → delete (it holds patient data).
3. Data structures → 527821 → delete.
   Ask Claude to do it, or do it by hand; deletion is permanent, so it needs your explicit go-ahead.

## 3. Unite: what to ask, what to configure [you]

1. Send the questions in `docs/finance/unite-request-email.md`. The ones that block go-live: separate credentials, token behaviour, field list and sample, re-queue of the 12 test invoices, IP allow-listing, and how to request a re-queue if a response is lost.
2. **IP allow-listing.** Vercel does not have fixed outbound IPs. If Unite restricts by IP, either Vercel static IPs (a paid add-on) or a small fixed-IP relay is needed. Find out _before_ the first run, not during it.
3. **Credentials.** In the app: Finance → Data health → Unite credentials. Enter the authorize pair and the refresh pair (and, if Unite gave one, the starting token pair). They are encrypted and never shown again.
4. **Field names.** When Unite sends the field list, edit the aliases in `lib/finance/unite-mapping.ts`. Fields marked required (invoice number, transaction date, gross, net, total, IsDeleted, and per line the item code and net) make a batch fail closed if missing, which is intended.

## 4. Before the first live run: checklist

- [ ] Section 1 done; System health green.
- [ ] Token coexistence settled (2.1/2.2) and written down.
- [ ] Unite re-queued the 12 test invoices (ADMC/C/44447 to 44458) and told you the 2026 queue size (so you know how many batches to expect).
- [ ] Unite's field list received and the aliases updated; unit tests pass (`pnpm test`).
- [ ] IP allow-listing sorted out.
- [ ] Credentials saved; **capture still off**.
- [ ] Someone who can read the Unite UI is available to spot-check invoices during the run.
- [ ] Settings: batch size 50, **batches per run = 1** (already the default for new setups), pull from `2026-01-01`.

## 5. The first live run (watched, one batch)

1. Data health → type `ENABLE` → _Switch capture ON_. The next hourly tick (5 past the hour) makes one call. To run it sooner, use Settings → System health → run `finance_capture` now.
2. Open the Batch log. Expect one row, `processed`, with a record count and a "Remaining" number. The remaining number should roughly match what Unite told you.
3. If the row says **failed**: read the error. It names the invoice and field (never the value), for example `invoice ADMC/C/44447: net is missing`. Fix the alias, press _Reprocess unprocessed batches_. Nothing is lost; the raw response is stored. Capture will not pull again until every earlier batch is processed.
4. Check, against the Unite UI, 20 invoices: amounts, lines, payments, branch. Look at the Invoice number gaps panel; gaps usually mean records not delivered yet.
5. **Unknown clinics (E07).** Invoices from clinic names that are not mapped appear with no branch. Finance → Reference data (arrives in phase F5; until then ask Claude, or update `fin_ref_branches.unite_clinic_long_name` in SQL), then press _Re-derive branches_.
6. When one batch is right, raise _batches per run_ (for example 10) and let the hourly job drain the 2026 backlog. Watch "Remaining at Unite" fall to 0.
7. Then verify (phase 2 exit): one amended invoice comes back as version 2, Meadows and Golden Mile are present, insurance invoices are present.

**To stop at any time:** Data health → _Switch capture OFF_. The queue keeps its position at Unite.

## 6. If something goes wrong

| What you see                                      | What it means                                            | What to do                                                            |
| ------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------- |
| Batch `failed`, error names a field               | Mapping does not match Unite's real field names          | Fix `lib/finance/unite-mapping.ts`, deploy, _Reprocess_               |
| Critical exception "lost response"                | A request may have been consumed but not stored          | Switch capture off. Tell Unite the time window; ask them to re-queue. |
| Critical "raw insert failed"                      | Response arrived but the database refused it             | Check Supabase health, then ask Unite to re-queue that window         |
| Critical "stalled balance"                        | Records come back but the remaining number does not drop | Switch capture off; check the batch log; raise with Unite             |
| Make scenarios start failing with "Invalid Token" | Platform and Make share a token                          | Switch capture off; run Make's Token scenario once; go to option A    |
| "no Unite credentials"                            | Credentials not saved or `ENCRYPTION_KEY` changed        | Re-enter credentials                                                  |

## 7. Insurance side: the Diligence upload [you / Sharaf]

1. Send Sharaf `docs/finance/diligence-header-request.md`. He sends **only the header row**; Claude aligns `lib/finance/diligence-mapping.ts` with it.
2. Give Sharaf the _Insurance_ role (Settings → Users). He opens Finance → Insurance upload.
3. First upload: the **unfiltered** report, all claims, all statuses, from 01-01-2026.
4. Read the check screen: counts of new / changed / unchanged / missing, totals, and the lists of "not imported (sensitive)" and "not recognised" columns. A rejected file explains why (missing column, a bad date in row N, a duplicate claim number); fix the export and upload again.
5. Confirm. Claims appear under Finance → Claims. Claims whose invoice has not been captured yet show "no invoice" and attach automatically once the invoice arrives (daily, and after every upload).
6. Repeat weekly and at month end. If the screen warns "this looks like a filtered export", do not tick the missing-claims box; get the unfiltered file instead.
