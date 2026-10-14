# Backup and restore drill

Pulse keeps everything in one Supabase project: Postgres (patients, messages, finance, the ledger), Storage (files), Vault (three secrets) and pg_cron (scheduled jobs). Supabase's backups cover the database only. This page says what is backed up, what is not, and how to rehearse a restore without touching production. Run the drill **before go-live and then once a year**, and after any change to the plan or region.

## What protects what

| Part | Where it lives | Covered by Supabase backups | What else you need |
|---|---|---|---|
| Database (all `public`, `app`, `auth`, `vault`, `cron`, `pgmq` data) | Postgres | Yes: daily backups on Pro (7 days), point-in-time recovery when the PITR add-on is on (to the second, 7–28 days) | Turn PITR on (status doc §3.1, item 1) |
| Files: `media-library`, `patient-documents`, `wa-media`, `finance-documents`, `finance-files`, `portal-files`, `kb-files`, `accounting-imports` | Storage | **No.** A database restore brings back the rows that point at files, not the files | A scheduled copy of the buckets (below) |
| Vault secrets `app_url`, `job_secret`, `finance_ref_key` | Vault, inside the database | Yes, encrypted | A restore into a **new** project may not decrypt them: check `select name from vault.decrypted_secrets` there and re-create any that read back empty (values from your password manager) |
| App secrets (`ENCRYPTION_KEY`, `JOB_SECRET`, Meta, Unite, Resend, VAPID…) | Vercel environment | No | Keep them in the clinic's password manager. **Without `ENCRYPTION_KEY` the encrypted integration credentials, channel tokens and push subscriptions cannot be read**; integrations then have to be re-entered |
| Scheduled jobs (56 `cron.job` rows) | `cron` schema | Yes | After a restore into a new project, check they point at the right `app_url` |
| Code | GitHub `main` | n/a | Redeploy from `main` |

## Keeping the files

Supabase does not version Storage. Until a managed option is chosen, copy the buckets weekly to storage the clinic controls in the same region (data residency, OQ-49), for example with the S3-compatible endpoint (`rclone sync` per bucket, server-side encryption on). `patient-documents` holds health data: the copy needs the same access rules (named people only) and must be covered by the erasure process: when a patient is erased, Pulse removes their files from Storage, so the next sync must delete them from the copy too (`rclone sync`, not `copy`).

## The drill (about two hours, no patient data leaves the project)

1. **Pick a point in time** a few hours back and write it down.
2. **Restore into a new, temporary project**, never over production. In the Supabase dashboard: Database, Backups, "Restore to new project" (PITR) or download the latest daily backup and restore it into a new project with `pg_restore`. Same region as production. Name it with `restore-drill` and the date.
3. **Lock it down first:** in the new project, pause the cron jobs (`update cron.job set active = false;`) so nothing calls the live app or sends messages, and do not set any Meta, SMS or payment credentials.
4. **Re-create the Vault secrets** with drill values: `app_url` = a URL that goes nowhere, `job_secret` = a fresh random value. `finance_ref_key` must be the production value (from the password manager) or the patient reference hashes will not match.
5. **Check the data** (counts only; never export rows):
   - `select max(version) from supabase_migrations.schema_migrations;` matches production.
   - Row counts of `contacts`, `messages`, `appointments`, `fin_invoices`, `acc_journal_lines` match production at the chosen time (within what changed since).
   - The ledger balances: the trial balance for the last closed month in Accounting equals the signed close pack.
   - A locked month is still locked (`app.fin_month_is_locked`).
6. **Check the app against it:** point a Vercel preview at the drill project (its URL and keys only; `APP_URL` = the preview URL, `ENCRYPTION_KEY` = production's so encrypted settings read back), sign in as an administrator and open a patient, a conversation, an invoice and a sealed close pack. Files opened from the restored rows will be missing unless you also restored the bucket copy; note which.
7. **Restore one file** from the bucket copy into the drill project and open it from its record.
8. **Record the result** in the security log (date, restore point, time taken, what was missing, who did it), then **delete the drill project** and the preview's environment values the same day.

Success means: restore finished, counts and trial balance match, encrypted settings readable, at least one file restored, total time written down (this is the clinic's real recovery time).

## If it is real

1. Stop writes: put the app in maintenance (Vercel: redeploy with the maintenance page) and pause cron in the damaged project.
2. Restore to a new project at the last good point (PITR), steps 2–5 above but with production secrets and cron re-enabled at the end.
3. Point Vercel's Supabase environment values at the new project, redeploy, and re-register the Meta webhook URL only if the domain changed.
4. Re-sync files from the bucket copy.
5. Data that arrived after the restore point: WhatsApp messages Pulse had already acknowledged are not sent again by Meta and are lost from Pulse (staff should check the phone app's chat list for that window); the Unite sync catches up by itself; the Unite Finance API is deliver-once, so check `fin_raw_unite_batches` against the capture log before switching capture back on (docs/finance/go-live-runbook.md).
6. Tell the people affected and record it as an incident.
