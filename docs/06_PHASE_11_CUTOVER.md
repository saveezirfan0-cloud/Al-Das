# Phase 11 — Cut-over runbook

How Al Das moves from **Sanoflow + Airtable + Make** to **Pulse**, one WhatsApp number at a time, with a go/no-go gate at every step. This document is for people. The code behind it is `pnpm reconcile`, `pnpm cutover:preflight`, `pnpm import:airtable`, `pnpm import:sanoflow` and the two load tests (`docs/load-test.md`).

> **Nothing in this runbook has been executed.** It needs real credentials, real patient data and changes to systems Pulse does not own, so the build session only produced the tooling and this plan. Run every step on staging first.

## 0. Read this first: three things that change the order

1. **Make sends through Sanoflow.** The appointment-reminder, birthday and chronic-recall scenarios call the Sanoflow API. The moment a number leaves Sanoflow, those scenarios can no longer send from it. So the plan's order ("cut over numbers, then run Make in parallel for a week") does not work for any number Make uses. Do the parallel week **first** for those numbers, then move the number and turn Make off the same night (section 7). Numbers that only carry inbound conversations can move at any time. *Decision needed:* which numbers does Make send from? (Read it off the Sanoflow credentials in the Make connections.)
2. **Phases 4–10 are not built yet.** Templates UI, enquiries, appointments/Unite sync, campaigns, flows (the Make replacements), the back-office portal and reporting do not exist in the repository at the time of writing. Section 1 lists what must exist before each stage. Until then only the **inbox-only** part of the plan is possible (stages A–C for conversations), and Airtable/Make/Sanoflow must stay on.
3. **Several answers are still open** (docs/audit/open-questions.md): WABA ownership (OQ-38), data residency for UAE health data (OQ-49), the Unite and Meta credentials (OQ-26, OQ-50), and the clinical sign-offs (OQ-01…06, OQ-36). They are gates, not paperwork.

## 1. Gates

A stage may start only when every gate above it is green. "Evidence" is something a reviewer can open.

| # | Gate | Owner | Evidence |
|---|---|---|---|
| G1 | Al Das owns the WABA and holds admin access in Meta Business Manager (OQ-38) | Saeed | Screenshot of Business Settings → WhatsApp accounts → People, kept outside the repo |
| G2 | Legal opinion on hosting health data outside the UAE; Supabase region confirmed (OQ-49) | Management / legal | Signed opinion, region noted in `docs/07_PHASE_11_NOTES.md` |
| G3 | Meta app live, System User token created with `whatsapp_business_management` + `whatsapp_business_messaging`, webhook verify token set (OQ-50) | Saveez | `pnpm cutover:preflight --stage pre-cutover` environment section green |
| G4 | Production Supabase has pgmq, pg_cron, pg_net, Vault secrets `app_url` and `job_secret` | Engineering | preflight "Jobs" section green (cron ran in the last 2 minutes) |
| G5 | `pnpm test`, `pnpm test:db`, `pnpm audit:security` green on the release commit; load tests run on staging and attached | Engineering | CI link + `docs/load-test.md` results table updated with the staging numbers |
| G6 | Final import reconciled and signed (section 5) | Operations + Clinical + Engineering | `docs/audit/reconciliation-<ts>.md` + `reconciliation-signoff.json` |
| G7 | Approved templates exist in the WABA and are mirrored (Settings → Channels → sync) | Operations | preflight "WhatsApp" section green |
| G8 | Clinical messaging stays **off** until the clinical lead signs the validation period (OQ-16, `clinical_messaging_enabled`) | Clinical lead | Setting value + sign-off |
| G9 | Staff trained; front desk knows the out-of-hours window and the rollback phone tree | Operations | Attendance list |
| G10 | For numbers Make uses: the native replacements ran 7 days in Test send mode and every diff is explained (`audit/make-replacement-design.md` §10) | Engineering + Operations | Filled checklist |
| G11 | Unite remains read-only; the Finance API job is feature-flagged off (CLAUDE.md rule 7) | Engineering | preflight and a read of the flag |

**Not yet satisfiable from the repository:** G10 and everything under section 7 need Phase 8; patient reminders and recall need Phases 6 and 8; reporting parity needs Phase 10.

## 2. Roles

| Role | Does |
|---|---|
| Cut-over lead (Engineering) | Runs the commands, owns the timeline, calls rollback |
| Operations lead | Staff communication, Sanoflow/Meta account actions, signs reconciliation |
| Clinical lead | Signs reconciliation and the clinical-messaging switch |
| Scribe | Writes the timeline into the cut-over log (no patient names, phone numbers or message text) |

## 3. Timeline

| When | Stage |
|---|---|
| T−14 d | A. Rehearsal on staging with a copy of the Meta test number |
| T−7 d | Start the Make parallel week for the numbers Make uses (section 7) |
| T−1 d | B. Freeze sources, final import, reconcile, sign-off |
| T-0 (out of hours, one number per night) | C. WhatsApp number cut-over |
| T+0…T+7 | Hyper-care; native automations flip to Live as each parallel check passes |
| T+7 d | D. Retire Make |
| T+14 d | E. Retire Airtable (read-only archive first) |
| T+21 d | F. Retire Sanoflow after its export is archived |

## 4. Stage A — rehearsal (staging only)

1. Deploy the release commit to a Vercel preview and a separate Supabase staging project. Apply migrations with `pnpm db:migrate`. Set the Vault secrets.
2. `pnpm audit:security` and `pnpm test:db` against staging. `pnpm load:webhook --yes-staging --rate 1000 --minutes 1` and `pnpm load:outbound --yes-staging --count 20000 --rate 20` (mock Graph; see `docs/load-test.md`). Attach both reports.
3. Import a **copy** of production data into staging: `pnpm import:airtable --dry-run`, then for real, then `pnpm import:sanoflow --file=<export> --dry-run`. Staging holds real patient data, so treat it as production for access and retention.
4. `pnpm reconcile --live-airtable --freeze-at <now>` and rehearse the sign-off.
5. Add the Meta **test** number as a channel, move its webhook, and rehearse section 6 end to end including rollback. Time each step.
6. Delete synthetic load-test data (`--cleanup`), and confirm `pnpm cutover:preflight` reports no load-test contacts.

## 5. Stage B — freeze, final import, reconcile (T−1)

Do this once per cut-over wave. Everything is idempotent through `external_refs`; a re-run updates, never duplicates.

1. **Freeze the sources** at an announced time (record it as `FREEZE_AT`, ISO UTC):
   - Airtable: switch staff to read-only permissions on the five bases and pause every Make scenario and Airtable automation that writes to them. Airtable has no freeze switch; permissions are the control.
   - Sanoflow: ask staff to stop editing contacts. Export contacts (CSV) after the freeze.
2. **Dry run, then real run** (the importers never write to the sources):
   ```bash
   pnpm import:airtable --org <slug> --dry-run          # counts + mapping coverage, writes nothing
   pnpm import:airtable --org <slug> --since <last-import-time>   # delta; omit --since for a full run
   pnpm import:sanoflow --file exports/contacts.csv --org <slug> --dry-run
   pnpm import:sanoflow --file exports/contacts.csv --org <slug>
   ```
   Each run writes `docs/audit/import-report-*.md` and `import-summary-*.json` (ids and counts only). **Do not commit them from a machine that has real data unless you have read them**; they should contain no names or phone numbers, and `pnpm reconcile` refuses to write a report that does.
3. **Resolve ambiguous matches.** Every record the importer could not match with confidence is a `sync_reviews` row (never auto-merged). Work the queue until it is empty or each remaining row has an owner and a reason.
4. **Reconcile:**
   ```bash
   pnpm reconcile --org <slug> --live-airtable --freeze-at <FREEZE_AT> --write-source-counts docs/audit/source-counts.json
   ```
   It proves, per source table, that `source total = imported + open reviews + dismissed reviews + test records + unidentifiable + failed` (gap 0), that the latest import ran after the freeze, that no `external_refs` point at missing contacts, that no phone number belongs to two live contacts, and that the importer runs add up. Exit code 1 means not ready.
5. **Sign-off.** Copy `docs/audit/reconciliation-signoff.example.json` to `reconciliation-signoff.json`, set `report` to the new report's file name, `decision` to `GO` only if the report says READY, and add name + date for Operations lead, Clinical lead and Engineering. `pnpm cutover:preflight` rejects a sign-off for an older report or one missing a signature.
6. Anything imported after the freeze is a delta: repeat steps 2–5.

Tables that need later phases (visits, prescriptions, appointment messages, recall logs, portal objects) are reconciled by their own importers when those exist; the report lists them as "not yet importable" so nobody assumes they were covered.

## 6. Stage C — per-number WhatsApp cut-over (§5.9)

One number per night, outside clinic hours. Keep the previous number's hyper-care period (24 h) clear before starting the next.

**T−2 h — preflight**

```bash
pnpm cutover:preflight --org <slug> --stage pre-cutover --number <phone_number_id> --report docs/audit/preflight-pre-<number>.md
```
Must be GO. It checks the environment, queues and cron, the channel (active, token, quality not RED, approved templates mirrored), a read-only Graph call proving the token works and listing which apps are subscribed to the WABA (Sanoflow appears here), the reconciliation sign-off, no open review rows and no leftover load-test data. Fix blockers; warnings need an owner's note in the log.

**T−30 min — announce.** Front desk stops answering from Sanoflow. Anything still open there is handled after the move.

**T0 — move the number**

1. In Pulse: Settings → Channels → *Add number* with the `phone_number_id` and WABA id (token left empty to use `META_SYSTEM_USER_TOKEN`, or paste a per-number token). The app probes Meta, mirrors templates and shows quality and tier.
2. Remove Sanoflow's access to the WABA: in Meta Business Manager → WhatsApp accounts → Partners, or by asking Sanoflow to unsubscribe their app. The Graph API only lets an app unsubscribe **itself**, so this step is done in the Meta UI or by Sanoflow. Confirm the exact current UI path in Meta's documentation on the night; do not rely on this sentence.
3. In Pulse: Settings → Channels → *Subscribe webhook* on the card (calls `POST /{waba_id}/subscribed_apps`).
4. In the Meta app dashboard → WhatsApp → Configuration: callback URL `${APP_URL}/api/webhooks/meta`, verify token = `META_WEBHOOK_VERIFY_TOKEN`; subscribe the fields listed on Settings → Channels (`messages`, `message_template_status_update`, `template_category_update`, `message_template_quality_update`, `phone_number_quality_update`, `account_update`, `user_id_update`, `business_username_updates`).
   The callback URL belongs to the **Meta app**, not the number: every WABA subscribed to the app delivers to it. If one Meta app serves several numbers they move together on this step, so plan the waves around that.

**T+10 min — verify**

- A staff phone sends "test" to the number: it appears in Inbox → Open within ~10 s with an unread badge.
- Reply from the composer: ticks go sent → delivered → read.
- Send an approved template to the staff phone from the composer (outside the 24 h window the composer forces a template).
- `pnpm cutover:preflight --org <slug> --stage post-cutover --number <phone_number_id>`: GO means our app is subscribed, no other app is, no queue backlog, cron ran.
- Settings → System health: no dead letters; Inbox → Failed messages: nothing unexpected.

**Hyper-care (24 h):** watch the webhook backlog (`webhook_events_in` unprocessed), the quality rating on the channel card, Sentry, and the failed-message log. Escalate on: a message older than 5 minutes in `meta_events` or `outbound_priority`, quality moving to YELLOW/RED, error 131050 on more than a handful of contacts, or any unexpected 4xx from Meta.

**Rollback (any time within hyper-care)**

1. Ask Sanoflow (or re-add them under Partners) to resubscribe their app.
2. In Pulse, unsubscribe ours: `DELETE https://graph.facebook.com/<version>/<waba_id>/subscribed_apps` with the System User token (Pulse has no button for this on purpose; run it from the cut-over lead's terminal and log it).
3. Messages received in Pulse stay in Pulse; messages received in Sanoflow afterwards stay there. Record the window in the log; contacts and conversations created in Pulse are not lost. No data is ever deleted by a rollback.
4. Re-open the questions that caused it before trying again.

## 7. Make parallel week (before moving a number Make sends from)

Source of truth: `docs/audit/make-replacement-design.md` §9–10 and `make-scenarios.md`. Built in Phase 8: the page is **Flows → Parallel run** (`/flows/parallel`, details in `docs/09_PHASE_8_NOTES.md`).

1. Native automations run in **Test mode**: recall programmes reach only internal validation patients (`contacts.is_test_record`), and appointment reminders reach only the numbers listed in the booking rules' test list. Make stays **live**. No patient receives a duplicate.
2. For Birthday and Chronic recall switch on "Record who this would message" so each run also stores the Unite PINs it would have messaged (ids only, never a send). Each day paste what Make did (ids from its Airtable log tables) and press **Compare**. Every difference gets a one-line reason.
3. After 7 days, per scenario: the page only allows **Sign off** when seven days are compared, differences are explained and the native version is marked built. The token scenario is judged by the Unite call success rate. The medical-record sync (scenario 7) cannot be signed off: it is not built.
4. **Switch night** (same night as the number's move): turn the Make scenario **off**, set the native automation to **Live**, then move the number (section 6). Never leave both live.
5. Make's recall threshold stays at its live value for the comparison week; the clinically signed-off value is applied afterwards (OQ-01).

## 8. Retirement

| Order | System | Pre-conditions | Do | Keep |
|---|---|---|---|---|
| 1 | **Make** (T+7 d) | Every scenario ticked off the checklist; native automations Live for 7 days with `job_runs` clean | Deactivate all scenarios, then cancel the plan after a further week of silence | Redacted blueprints (`docs/audit/make-raw`); never the originals, they hold plain-text credentials |
| 2 | **Airtable** (T+14 d) | All staff working in Pulse for 14 days; reconciliation signed; no Make scenario touches it | Set the five bases read-only, export CSV + attachments from each base, then downgrade/cancel | Encrypted archive of the exports under the clinic's retention policy; they contain patient data |
| 3 | **Sanoflow** (T+21 d) | Every number moved and stable; conversations history exported | Export contacts, conversations and templates; revoke API keys; cancel | Encrypted archive of the export. Message history is **not** imported into Pulse by any current tool; decide whether it must be (legal retention) before cancelling |

Remove `AIRTABLE_PAT` and `MAKE_API_TOKEN` from every environment and delete `scripts/import-*`, `scripts/export-*` and the Airtable/Make audit raw folders from the working tree once the archives are verified (the preflight warns while the variables remain).

## 9. Credentials to rotate at cut-over

| Credential | Why | Action |
|---|---|---|
| Unite `app_id` / `app_key` (three pairs live in the Make "Token" scenario) | Plain text in Make blueprints | Ask Unite for new pair(s) for Pulse; store encrypted; ask Unite to revoke the old ones (OQ-26) |
| Sanoflow API key | Plain text in Make blueprints | Revoke when Sanoflow is retired |
| Meta System User token | Created for Pulse only | Rotate if it was ever pasted into a chat, ticket or shared document |
| `JOB_SECRET`, `ENCRYPTION_KEY`, `META_APP_SECRET` | Production values | Generate fresh production values; never reuse staging's. Rotating `ENCRYPTION_KEY` requires re-encrypting `channel_secrets` (re-save each token) |
| Airtable PAT, Make API token | Migration-only | Revoke after retirement |
| Supabase service-role key | Used by Vercel only | Rotate if exposed; confirm it is not in any client bundle (`pnpm audit:security`) |

## 10. Cut-over log template

Keep outside the repository if it names people. Never record patient names, phone numbers or message text.

```
Number: <phone_number_id>   Window: <start–end>   Lead: <name>
T-2h  preflight: GO / NO-GO   blockers: …
T0    add number: ok   sanoflow removed: ok (by whom)   webhook subscribed: ok   callback set: ok
T+10m inbound test: ok   reply ticks: ok   template: ok   post-cutover preflight: GO
T+24h backlog max: …   quality: GREEN   failed messages: …   incidents: none / …
Decision: stable → next number / rollback
```

## 11. What Pulse guarantees during the move, and what it does not

- Inbound events are stored raw before anything else happens and acknowledged fast; if a downstream job fails, the housekeeping sweep re-queues stored rows. Duplicate deliveries are harmless (unique `wa_message_id`).
- Outbound goes only through queues, with the 24 h window guard and the per-number rate limit; bulk sends are paced at 80 % of `send_rate_per_sec`, leaving the rest for live chat.
- Contacts with `stop_marketing` are never sent marketing; error 131050 sets it automatically.
- It does **not** copy Sanoflow's conversation history, or the Airtable tables that need Phases 6 and 9.
- It does **not** turn on clinical messaging; that stays behind `clinical_messaging_enabled` and the clinical lead.
