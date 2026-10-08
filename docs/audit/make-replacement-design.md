# Make.com replacement design (Phase 0)

Native design for each of the 7 active Make scenarios, reconstructed from the blueprints (4 in `make-raw/`, 3 read live and summarised in `make-raw/*_summary.md`). Each section: as-built behaviour, defects found, native design, parallel-run comparison, cut-over. Table/column names refer to docs/02 §3 and `supabase/drafts/`. Everything runs as pg_cron → `/api/jobs/<queue>` handlers or as domain-event handlers; nothing runs on a timer in memory.

Shared building blocks used below:
- **`integration_accounts`** row `kind='unite'` with `config_enc` (app_id, app_key, cached access/refresh token, `token_expires_at`). `lib/unite/auth.ts` refreshes **on demand** when < 30 s remain (tokens live 240 s), serialised with an advisory lock so concurrent handlers share one token. Every call logged to `unite_api_calls(endpoint, status, duration_ms, batch_id)`; no bodies, no PHI.
- **`recall_programmes` / `recall_programme_templates` / `recall_sends`** (draft 0104): one engine for chronic, birthday, screenings, dormant and the appointment reminder. Each programme has an eligibility SQL view, a cadence (pg_cron expression), `send_mode` (test/live), a template map by `segment_key`, and `repeat_policy` (`once`, `per_cycle`).
- **Outbound only via `outbound` queue** with the 24 h window guard and per-number rate limit (CLAUDE.md rule 4). Test mode rewrites the recipient to `clinical_settings.test_recipient_numbers` and stamps `recall_sends.sent_to_phone_e164`.
- **Parallel run**: native side runs in Test mode for 7 days; a nightly job writes `parallel_run_diffs(scenario, date, make_count, native_count, only_in_make[], only_in_native[])` using IDs only (Unite appointment id / patient PIN hash). The Make side's output is read from the Airtable log tables through the importer in `--since` mode.

---

## 1. Token (3576415)

**As built.** 3×/day: read the token pair from data store 61544, call `authorize` with a Bearer of the *old* access token, store the new pair; on body `Message = "Token Expired"` call `refreshtoken`. Status is in the JSON body, HTTP is always 200. Tokens expire in 240 s, so the stored token is stale almost all the time; the consumer scenarios survive because `authorize` re-issues freely. Three credential pairs exist in the blueprint (one orphaned).

**Defects.** Secrets in plain text; stale token by design; no error alerting; dead orphan module.

**Native design.**
- `lib/unite/auth.ts`: `getToken()` → if cached token valid for ≥ 30 s return it, else `POST/GET authorize` (app_id/app_key from `integration_accounts.config_enc`, decrypted server-side only), store `{access_token, refresh_token, expires_at}` back encrypted. `refreshtoken` is used only when `authorize` returns `Token Expired` (keeps parity with the vendor's expectations). Advisory lock `pg_advisory_xact_lock(hashtext('unite_token'))` around refresh.
- `lib/unite/client.ts`: wraps every call with the token, 1 retry on `Invalid Token` after forced refresh, exponential back-off on 5xx/timeouts, global concurrency 1, min 250 ms between calls (setting `unite_min_interval_ms`), circuit breaker after 5 consecutive failures → `job_runs.error` + email alert.
- No cron. The scenario disappears; its data store is deleted at cut-over.
- **Rotate keys** with Unite at cut-over (OQ-26).

**Parallel run.** None needed (no output). Verify by `unite_api_calls` success rate ≥ 99 % over the week.

---

## 2 + 3. Appointment Reminders (3613818) and Appointment Reminders – 6PM (3913219)

**As built.** At 12:00 and again at 18:00 (Make org timezone, OQ-20): `Date = tomorrow (DD-MM-YYYY)`; for each branch (`DHA-F-6456618` Golden Mile, `DHA-F-2116734` Meadows, `DHA-F-0000419` Palm Jumeirah) `GET getallappointments?clinic_id=…&from_date=Date&to_date=Date`; for every appointment not matching the exclusion filters (patient name ≠ SHORELINE/block/break/golden mile/meadows; doctor ∉ {Tod Cahil, Mariam Abdel Malek, Luka Ciglic, Mariam Hermina, Patricia Oliveira}) send Sanoflow template **11885** (`appointment_reminder_48h`) with variables `[first name | "Patient", appointmentstarttime, doctorname]`, then create an Appointment Messages row (status "Appointment", Unite appointment id, clinic id, doctor id, start/end, remarks, created-by, nationality). The 6PM variant first searches the log by `Appointment ID` and skips already-sent rows. On send error, both write a fallback row to Google Sheet "Appointment Reminders" (name, phone, message text, wa.me link, "Pending").

**Defects.** Lead time is ~18–30 h, not 48 h (OQ-19). The noon run has **no** dedupe (the 6PM one does), so an appointment re-fetched at noon on two consecutive days (e.g. rescheduled) can be messaged twice. Exclusions are hard-coded (OQ-21). Raw appointment start string is sent as-is (Unite format, not patient-friendly). Appointment status codes are logged but never acted on (cancelled appointments still get reminders unless Unite drops them from the feed; OQ-23). Fallback list lives in a Google Sheet nobody owns (OQ-42).

**Native design.**
1. **Unite appointments sync job** (`unite_sync` queue, pg_cron every 15 min 07:00–22:00 Asia/Dubai, plus a nightly full pull for `from_date = today … today+7`): per `locations.external_id` call `getallappointments`, upsert `appointments` (`source='unite'`, `external_id = appointmentid`, `external_status = status`, `status` via `unite_appointment_status_map`, `starts_at/ends_at` parsed in Asia/Dubai → UTC, `specialist_id` by `external_id = doctor_id` else exact name, `contact_id` by PIN → phone → name+DOB with `sync_review` fallback), `sync_cursors` per clinic. Changes emit `appointment.created|updated|status_changed` domain events.
2. **Reminder scheduling** (`lib/appointments/reminders.ts`): on `appointment.created|updated`, (re)compute `appointment_reminders` rows from the org's booking rules (docs/02: 3 reminders relative to start; seed `48h`, `24h`, `3h`, only `24h` enabled at cut-over to mirror today's behaviour), each with `dedupe_key (appointment_id, idx)` and a `scheduled_jobs` row. Cancelled/no-show → pending reminders cancelled.
3. **Exclusions** from `reminder_exclusions` (kind `placeholder_name` / `doctor` / `department`) evaluated at send time; excluded rows get `exclusion_reason` and no message.
4. **Send** via `outbound` queue, template `appointment_reminder` (recreated natively in Phase 4 with the same 3 variables; the Sanoflow id 11885 kept in `external_refs`). Interactive buttons Confirm / Reschedule / Cancel update `appointments.status` (Phase 6).
5. **Failure handling**: a failed send is a `messages.status='failed'` row → Failed Messages log + a `tasks` row for reception ("call patient, reminder not delivered"). This replaces the Google Sheet.
6. Reporting view `v_appointment_reminder_stats` reproduces the Airtable dashboards (messages per doctor/clinic, % patients contacted, no-show rate by doctor once OQ-23 is answered).

**Parallel run.** Compare per day: set of Unite appointment ids messaged by Make (Appointment Messages rows with Message Sent On = D) vs native `appointment_reminders.sent_at::date = D` (test mode). Expect equality except for the intentional dedupe and exclusion differences, which are listed by reason.

**Cut-over.** Switch native to Live for one branch first; turn off both Make scenarios for that branch's clinic_id filter route; repeat per branch.

---

## 4. Agewise Birthday Message (4049277)

**As built.** Daily 12:00: search Unite patients with `DOB (DD-MM) = today` (max 1000); skip `Birthday Message = Sent`; route by gender then age band with a 15 s sleep per branch; send Sanoflow template (v1 API) with variable `[Last Name | First Name]`:

| Gender | Age band | Template |
|---|---|---|
| M | 20–29 | 12294 |
| M | 30–39 | 12295 |
| M | ≥ 40 | 12296 |
| F | 18–35 | 12289 |
| F | 36–45 | 12291 |
| F | 46–65 | 12291 |

then set `Birthday Message = Sent`, look up the Sanoflow contact, add tag **3590** (keeping existing tags), and log to Birthday Messages (name, PIN, Sanoflow id, phone, DOB DD-MM, first/last, age, sent date as `DD/MM/YYYY`).

**Defects.** One message ever per patient (flag never reset); uncovered bands (M < 20, F < 18, F > 65, gender U); two female bands share one template; sleeps as rate limiting; the sent date is written as a day-first string into a date field; no opt-out check (OQ-17).

**Native design.**
- `recall_programmes` row `birthday` (kind `birthday`, cadence daily 09:00 Asia/Dubai, `repeat_policy = per_cycle`, `cycle_key = year`), eligibility view `v_birthday_today`: `to_char(dob,'MM-DD') = to_char(today,'MM-DD')` (29 Feb per OQ-18), `phone_e164 not null`, `not stop_marketing`, `promotions_opt_in` as the org decides (marketing category template → requires opt-in), `not is_test_record`, no `recall_sends` row for `(birthday, contact, year)`.
- `recall_programme_templates`: `segment_key` = `gender_band` (`m_20_29`, `m_30_39`, `m_40_plus`, `f_18_35`, `f_36_45`, `f_46_65`) → `wa_template_id`; `legacy_sanoflow_template_id` kept. Uncovered bands are **not sent** and counted in `recall_sends.status='skipped_no_template'` so marketing can see the gap.
- Fan-out through `campaign_fanout`/`outbound` (rate limit replaces sleeps). On sent: `recall_sends` row + native tag `birthday_sent_<year>`; "Birthday Offer Update" webhook becomes a template-button-reply flow that sets `recall_sends.outcome='offer_redeemed'`.
- Dashboard: `v_recall_weekly` + per-band counts (reproduces the "Birthday Campaign Tracking" interface).

**Parallel run.** Daily: PIN set messaged by Make vs native eligible set; differences will be exactly the "already Sent once" patients and the uncovered bands — report them as a count, not names.

---

## 5. Chronic Recall – 90 Day (5882746)

**As built.** Daily 12:15: Airtable view `Chronic` filtered `{Chronic Recall Eligible} = 1` (max 100/run); send the per-condition Sanoflow template (`Chronic Recall Template ID`) with variable `[first name | "Patient"]`; log to Chronic Recall Messages (`Send Mode = Live`, `Send Status = Sent`, snapshot of last visit date / days since / condition / template); set `Chronic Recall Sent On = today` and `Chronic Recall Condition`; add Sanoflow tag **4654** and label **1800** to the contact. Test/Live is a scenario variable, not data.

**Defects.** Eligibility is ≥ 30 days in the formula vs 90 in the description (OQ-01). Default template 13170 for unmapped groups (OQ-24). Sent-once-forever (`Sent On` never clears): a patient recalled this quarter is never recalled again. Logged `Notes = "Sent to: <phone>"` (PHI in free text). Max 100/run with no ordering, so the backlog is drained arbitrarily.

**Native design.**
- `recall_programmes` row `chronic_90d` (cadence daily 12:15 Asia/Dubai, `repeat_policy = per_cycle` with `cycle_key = last_visit_date`, so a new visit opens a new cycle; `min_days_since_visit` from `clinical_settings.chronic_recall_min_days`; `max_per_run` 100 ordered by `days_since_last_visit desc`).
- Eligibility view `v_chronic_recall_eligibility` (R-20…R-22): messageable primary condition group via `contact_chronic_conditions → ref_diagnoses → ref_condition_groups`, days since `max(visits.visit_date)`, phone present, `not stop_marketing`, `not is_test_record`, clinical consent if the org requires it, and no open `recall_sends` for the cycle.
- Template map `recall_programme_templates(programme='chronic_90d', segment_key=<condition group key>)`; **no default row** → group without a template is `skipped_no_template` (fail closed, OQ-24).
- On sent: `recall_sends` row (snapshots: `last_visit_date_at_send`, `days_since_last_visit_at_send`, `segment_key`, `send_mode`, `sent_to_phone_e164`), native tag `chronic_recall_sent`.
- Inbound reply handling replaces scenario 6 (below). Booking attribution: when an `appointment.created` event arrives for the contact within `setting('recall_booking_attribution_days')` (OQ-33) of an open send → `booked_at`, `appointment_id`.
- Portal "Chronic Recall Call List" = `v_recall_call_list` (R-24, R-25) with `follow_up_status` editing and the constraint that `booked` requires `booked_at`. Weekly chart = `v_recall_weekly`. KPIs: reply rate, booking rate (target 30 %), avg days since last visit, >120 cohort, failures by condition, template coverage.

**Parallel run.** Daily PIN sets (eligible/sent) Make vs native with the threshold set to the live 30 days for the comparison week; then switch the setting to the signed-off value.

---

## 6. Chronic Update (5916036)

**As built.** Sanoflow flow → Make webhook `{Mobile, Status ∈ Replied|Booked, Trigger Data}`; search Chronic Recall Messages by phone (max 10) and set `Patient Replied = Yes, Reply Date = today` or `Appointment Booked = Yes, Booking Date = today` on every match. `Follow Up Status` untouched.

**Defects.** Attribution by phone to all rows (OQ-22); "Booked" depends on a human/flow pressing a button, not on a real appointment; no idempotency; no auth beyond the obscure URL.

**Native design.** No webhook hop at all:
- Inbound message handler (Phase 3) already resolves the contact. `lib/recall/replies.ts` subscribes to `message.inbound`: if the contact has an open `recall_sends` row (`sent_at` within `setting('recall_reply_attribution_days')`, default 14, newest first) and `replied_at is null` → set `replied_at`, link `reply_message_id`. Button replies on the recall template (e.g. "Book now") set `outcome='wants_booking'` and open an enquiry in the booking pipeline.
- `appointment.created` (from Unite sync or portal) → `booked_at`/`appointment_id` on the newest open send for that contact (see §5).
- Staff can still override from the call-list drawer (`follow_up_status`, `booked_at`).
- The Sanoflow flow's API Action node is deleted at cut-over; the hook is removed from Make.

**Parallel run.** Count of recall rows with `Reply Date` set by Make vs `replied_at` set natively over the week (expect native ≥ Make because native also catches free-text replies).

---

## 7. Acute Follow-Up — MRD Sync (5990863)

**As built.** Daily 23:55, max 10 visits/run: unsynced MRD rows from the last 30 days → create an Acute Visit (vitals parsed, department mapped by substring, notes concatenated, Pap "Not available in Unite") → mark `Acute Sync On` → for each linked medication (≤ 20) create a Prescription (class by text heuristic, probiotics 10 d, status Not started). Airtable formulas on the Acute Visit then compute Department Effective, triggers, category, due date, dedupe key; **no automation currently creates Follow-Up Queue rows or sends messages** (the base has no Airtable automations), so today the engine stops at "rules fired" columns.

**Defects.** No negation scrubbing despite the description (OQ-31); heuristic drug class (OQ-13); ≤ 10 visits/night cannot keep up with the visit volume (11.6k MRD rows, 1.8k Acute visits); visits without a patient link retry forever; comma-split of dosage fields; Secondary Diagnosis Codes, Symptomatic and Patient link never set.

**Native design.**
1. **Unite visits sync** (`unite_sync` queue, hourly during clinic hours + nightly catch-up): incremental by `sync_cursors`; upsert `visits` (+ `visit_diagnoses`, `visit_items`, `prescriptions`) via `external_refs`. The Airtable MRD table is only an import source for history; the live feed comes from Unite directly (endpoints and payload shapes to be confirmed against the Make scenarios `medical records sync` 6251023 / `Update Chronic` 4210055 in Phase 6 — they are the heavy historical pullers).
2. **Ingest** (`lib/unite/mappers.ts` + `lib/clinical/ingest.ts`): R-01…R-05 (BP parse, numeric guard, negation scrub with `scrub_version`, department mapping, class lookup by code). Writes `observation_notes_scrubbed`, `vitals_raw`.
3. **Evaluate** (`lib/clinical/evaluate.ts`, triggered by `visit.created|updated` and by `clinical_settings` changes): R-06…R-11 → `visit_rule_evaluations` (idempotent on `dedupe_key`; re-evaluation on settings change writes a new `engine_version` row and keeps history). When a category is produced → `clinical_followups` row (internal task, priority per OQ-30) and `clinical_message_log` *would-send* rows while `clinical_messaging_enabled = false`.
4. **Sequence engine** (`lib/clinical/sequence.ts`, `scheduled_jobs`): per antibiotic prescription → `prescription_sequences`; schedules `ABX_DAY3`, `PROBIOTIC_START` (guarded by status), `TREATMENT_OUTCOME`; reply parser R-16; red flag R-18/R-19. All sends go through `outbound` with idempotency key `<prescription external_key>:<template_key>`.
5. **Portal screens**: Follow-Up Queue (clinical_followups), Clinical Settings (with sign-off fields and "allow unsigned defaults" switch), Unclassified Medications (prescriptions with class `unclassified` + suggestion from the legacy heuristic), Data Quality Exceptions (`vitals_complete = false`, parse failures), Test Plan runner results.

**Parallel run.** For every Acute Visit row created by Make during the week, compare `Trigger Rules Fired`, `Trigger Category`, `Follow-Up Due Date`, `Dedupe Key` and each Prescription's `Medication Class` with the native `visit_rule_evaluations` / `prescriptions` for the same MRD id. Differences are expected exactly where the native engine fixes a defect (scrubbing, code-based class, workday calendar) and must be explained per row in `parallel_run_diffs.reason`.

---

## 8. Implicit dependencies and what happens to them

| Dependency | Today | Native |
|---|---|---|
| Make data store "Token" (61544) | Unite token pair, plain text | `integration_accounts` (encrypted), deleted at cut-over |
| Sanoflow API (`send-template`, `contacts/list`, `contacts/edit`) | Used by 4 scenarios | Gone; WhatsApp Cloud API native; tags native |
| Sanoflow tag 3590 (birthday), tag 4654 + label 1800 (chronic recall) | Set via `contacts/edit` | `tags` rows `birthday_sent_<year>`, `chronic_recall_sent`; label → conversation label (OQ-43) |
| Google Sheet "Appointment Reminders" (spreadsheet id ends `…yzR0jvrfc`) | Failed-send fallback list | Failed Messages log + reception task |
| Airtable native automations on the Unite base (2) | record created → update; enters view "Chronic" → Google Sheets row | Document in Phase 8, then switch off (OQ-41) |
| Sanoflow flows calling Make webhooks (Chronic Update; doctor-specific booking flow API Action nodes) | Webhook hop | Native flow nodes / event handlers |
| Make Pro plan (80k ops) | ~2.5k ops/day | Cancelled after the parallel-run checklist is complete |

## 9. Inactive scenarios → native home (carried from make-scenarios.md §2, with Phase)

| Group | Native home | Phase |
|---|---|---|
| Unite data syncs (`medical records sync`, `Update Chronic`, `Old-Unite > Airtable`, `med-chronic-unite`, `Unite > Sano Appointment Sync`, `Clinics & Appts`, `Sano Id's`) | One incremental sync (§7 step 1 + §2 step 1) with cursors; read their blueprints in Phase 6 for the exact Unite endpoints/payloads | 6 |
| Unite Finance API test | Feature-flagged job writing `unite_raw_payloads` first; off by default (OQ-37) | 2 (post-MVP) |
| Screening reminders (Annual Checkup 330 d, Dental, Pap, Colonoscopy, Skin, Menopause, Pre-Menopause, Dormant, Lab Test Reminder) | `recall_programmes` rows with eligibility views; the 9 Unite select flags become `recall_sends` history | 8 |
| Birthday legacy (Birthday_Campaign, Follow Ups, Offer Update webhook) | §4; offer webhook → button-reply flow | 8 |
| Labs (Result Ready, Follow-up Required, Test Reminder) | `lab_orders` + verified-only gate (template LAB_READY) | 2 |
| Post-appointment / no-show (4 scenarios + 2 DRAFT tables) | Programme `post_visit` (D0/D1/D3/D7 steps), flow on `appointment.status_changed = no_show` | 2 |
| DRAFT clinic ops (Antibiotic Follow-Up Conditional, Daily Conversation Analytics, Insurance Verification Express, Patient Retention Alert, Payment Collection, Symptom Triage) | Sequence engine (§7); reports layer; enquiry pipelines "Insurance review" / "Retention"; payment links (P2); clinic-specific routing flow with no diagnosis | 6 / 10 / 5 / 2 |
| Search New Contact | Not needed (single CRM) | — |
| "Integration …" scratch scenarios (×9) | Drop | — |

## 10. Parallel-run checklist (replaces make-scenarios.md §4)

| Scenario | Native built | Test-mode parallel 7 days | Diffs explained | Make off |
|---|---|---|---|---|
| Token | ☐ (auth module) | n/a | n/a | ☐ |
| Appointment Reminders (12:00) | ☐ | ☐ | ☐ | ☐ |
| Appointment Reminders – 6PM | ☐ | ☐ | ☐ | ☐ |
| Agewise Birthday Message | ☐ | ☐ | ☐ | ☐ |
| Chronic Recall – 90 Day | ☐ | ☐ | ☐ | ☐ |
| Chronic Update (webhook) | ☐ | ☐ | ☐ | ☐ (also delete the Sanoflow API Action node) |
| Acute Follow-Up — MRD Sync | ☐ | ☐ | ☐ | ☐ |
| Airtable native automations (Unite base) | ☐ documented | — | — | ☐ |

Native side must stay in **Test send mode** for the whole parallel week so no patient receives a duplicate.
