# Make.com audit — Al Das Clinic org (team "My Team", id 1494412, zone us2)

Pulled live through the Make connection on 8 Oct 2026.
- **Plan:** Make **Pro**, 80,000 operations/month.
- **Scenarios:** 49 in total. **7 active**, 42 inactive (drafts, one-offs and legacy).
- **Raw files:**
  - `make-raw/scenarios_list.json`: full list metadata.
  - `make-raw/*.blueprint.redacted.json`: blueprints with secrets and sample data stripped.
  - `make-raw/*.summary.md`: module-by-module flow for each blueprint.

Re-pull everything with `scripts/export-make.ts`.

> ⚠️ **Security finding.** Unite `app_id`/`app_key` values, bearer tokens and the Sanoflow API key are stored **in plain text inside Make blueprints**, and the Token data store keeps Unite access/refresh tokens. In the new platform they go into Supabase Vault / encrypted env. **Plan to rotate the Unite keys at cut-over.**

---

## 1. Active scenarios (must be replaced natively)

| # | Scenario (id) | Trigger | What it does | Native replacement |
|---|---|---|---|---|
| 1 | **Token** (3576415) | Schedule 3×/day (11:55, 17:55, 23:55) | Reads Unite access + refresh tokens from data store "Token" (61544), calls Unite `/gateway/authorize`, refreshes via `/gateway/refreshtoken` on "Token Expired", writes them back | `lib/unite/auth.ts`: token cache in an encrypted DB row, **refresh on demand**. Unite tokens expire in **~240 s**, so refresh per call batch, not on a fixed schedule |
| 2 | **Appointment Reminders** (3613818) | Schedule (every 15 min window) | Gets Unite token → for each branch (**Golden Mile DHA-F-6456618, Meadows DHA-F-2116734, Palm Jumeirah DHA-F-0000419**) calls Unite `getallappointments?clinic_id=…&from_date=` → sends Sanoflow template **`appointment_reminder_48h`** → logs to Campaigns.Appointment Messages | Unite appointments sync job (per clinic_id) → `appointments` → `appointment_reminders` scheduled jobs → WhatsApp template via our Cloud API |
| 3 | **Appointment Reminders – 6PM** (3913219) | Daily | Same as #2, plus an Airtable lookup first to skip already-sent | Same job. Dedupe built in via `appointment_reminders` unique (appointment_id, idx) |
| 4 | **Agewise Birthday Message** (4049277) | Schedule | Searches Unite patients with birthday → routes by gender + age band (Men / Women; age bands like 18–25…) → sends Sanoflow birthday template (v1 API) → marks patient → looks up Sanoflow contact → **updates contact tag** → logs to Birthday Messages. Uses sleeps (20–50 s) for pacing | Recall programme "Birthday" (daily cron) with segment rules by gender/age band → template per band → tag via our CRM. Pacing is handled by the outbound queue |
| 5 | **Chronic Recall – 90 Day** (5882746) | Schedule | Finds patients in view "due for chronic recall" (`Chronic Recall Eligible`) → sends the per-condition template → logs to Chronic Recall Messages → marks Sent On (Live only) → updates the Sanoflow contact tag. SEND_MODE Test/Live variable | Recall programme "Chronic 90-day": eligibility as a SQL view (rules in airtable-schema.md §1), Test/Live mode in `clinical_settings`, per-condition template map |
| 6 | **Chronic Update** (5916036) | **Webhook from Sanoflow flow** (`workflow_id`, Mobile, Status) | On Status = Replied → sets Patient Replied = Yes + Reply Date. On Status = Booked → Appointment Booked = Yes + Booking Date (matched by phone) | Native: an inbound reply / template-button event on a recall send updates `recall_sends` directly (no webhook hop). "Booked" comes from appointment creation |
| 7 | **Acute Follow-Up — MRD Sync** (5990863) | Daily 23:55 (on-demand intent) | Finds unsynced Medical Records Data from the last 30 days (max 10/run) → gets patient (DOB, department) → creates a Visit in the Acute base: **parses BP "sys/dia"**, numeric vitals, joins notes, maps department (paed/gyn/derma/GP/other) → marks "Acute Sync On" → iterates medications → classifies drug (antibiotic / steroid / probiotic / supplement / UNCLASSIFIED) → creates Prescriptions (probiotic 10 days default, sequence "Not started") | Unite visits sync → `visits` + `prescriptions` with typed parsing in `lib/unite/mappers.ts` + the clinical rules engine (`lib/clinical/`). Idempotent via `external_refs` |

**Implicit dependencies of active scenarios**
- Data store **Token (61544)**: Unite tokens.
- **Google Sheets** modules appear in the reminder scenarios. Identify the sheet's purpose in Phase 0 (likely a doctor/clinic mapping or template list) and turn it into a DB table.
- **Sanoflow API** (`developers.sanoflow.io` v1 / v1.1): `messages/whatsapp/send-template`, `contacts/list`, `contacts/edit` (tags). All of it disappears once WhatsApp is native.
- Sanoflow flows **call Make webhooks** (Chronic Update; also flow API Action nodes such as the doctor-specific booking flow). Those become native flow nodes.

---

## 2. Inactive / draft scenarios (decide: rebuild, backlog, drop)

| Group | Scenarios | Recommendation |
|---|---|---|
| **Unite data syncs (heavy)** | `medical records sync` (6251023, **70,873 ops** historically), `Update Chronic` (4210055, **36,090 ops**), `Old-Unite > Airtable` (3758764), `med-chronic-unite` (4354177), `Unite > Sano Appointment Sync` (5480742), `Clinics & Appts` (3576553), `Sano Id's` (3882448) | **Rebuild as ONE native incremental sync** (patients, visits, diagnoses, meds, appointments) with cursors. This is what currently burns Make operations |
| **Unite Finance API** | `TEST - Unite Finance API` (6555877) | ⚠️ **The Finance API is sync-once: every call permanently removes the returned records from Unite's queue.** Never call it without a durable landing table + transaction. Phase 2, behind a feature flag, with a write-ahead log of raw payloads |
| **Screening / recall reminders** | Annual Checkup (330 days), Annual Dental, Pap Smear, Colonoscopy, Skin Cancer & Mole Check, Menopause, Pre-Menopause, Dormant Patient Reactivation, Lab Test Reminder | **Rebuild as configurable "Recall programmes"** (eligibility rule + template + cadence + Test/Live). One engine, many programmes |
| **Birthday legacy** | Birthday_Campaign, Birthday Follow Ups, Birthday Offer Update (webhook) | Superseded by #4. Fold the "offer redeemed" webhook into a flow trigger |
| **Labs** | Lab Result Ready, Lab Follow-up Required (webhooks), Lab Test Reminder | Phase 2 with `lab_orders` |
| **Post-appointment / no-show** | Post-Appointment Follow-up, NoShow_Recovery, DRAFT No-Show Recovery Outreach, DRAFT Post-Visit Follow-Up | Phase 2 recall programmes (D0/D1/D3/D7; no-show next day) |
| **DRAFT clinic ops** | Antibiotic Follow-Up Conditional, Daily Conversation Analytics, Insurance Verification Express, Patient Retention Alert System, Payment Collection Sequence, Symptom Triage and Routing | Map to native features: analytics → reports. Insurance / retention / triage → flows + AI tagging (clinic-specific, no diagnosis). Payments → Phase 2 payment links. Antibiotic → clinical sequence engine |
| **Search New Contact** (3630414) | Webhook → Airtable + Sanoflow lookups | Not needed (single CRM) |
| **"Integration …" scratch scenarios** (×9) | Empty/test integrations (Airtable, Google Sheets, HTTP, Webhooks) | Drop |

---

## 3. Operations & cost signal
- Active scenarios currently use a few thousand ops per cycle (reminders ~2–2.5k, birthday ~2k, MRD sync ~1.1k). The historical Unite syncs used **70k + 36k** ops, which is why the org is on Pro with 80k ops.
- After migration, **Make can be cancelled entirely**. All of the above runs as Supabase cron + queue jobs with no per-operation cost.

## 4. Parallel-run checklist (Phase 8)
> Tracked in Pulse at **Flows → Parallel run** (`/flows/parallel`), with daily comparisons and a server-checked sign-off; see `docs/09_PHASE_8_NOTES.md`. The table below is the paper version.

| Scenario | Native version built | Ran in parallel 7 days | Outputs matched | Make scenario turned off |
|---|---|---|---|---|
| Token | ☐ | ☐ | ☐ | ☐ |
| Appointment Reminders (+6PM) | ☐ | ☐ | ☐ | ☐ |
| Agewise Birthday Message | ☐ | ☐ | ☐ | ☐ |
| Chronic Recall – 90 Day | ☐ | ☐ | ☐ | ☐ |
| Chronic Update | ☐ | ☐ | ☐ | ☐ |
| Acute Follow-Up — MRD Sync | ☐ | ☐ | ☐ | ☐ |

> In parallel runs, the native side must run in **Test send mode** (internal numbers only) so patients never get duplicate messages.

---

## 5. Corrections found in Phase 0 (8 Oct 2026, blueprints read live)

The three active blueprints missing from `make-raw/` (Token, Chronic Update, MRD Sync) were read through the Make connector and summarised in `make-raw/*_summary.md` (redacted; the Token blueprint holds three Unite credential pairs and the Chronic Update sample holds a real patient, so neither raw blueprint is committed).

1. **Reminders are ~24 h, not 48 h.** Both reminder scenarios query `from_date = to_date = tomorrow` and run at 12:00 and 18:00; only the 18:00 run dedupes by Appointment ID (OQ-19).
2. **Hard-coded exclusions** in the reminder filters: placeholder names (SHORELINE, block, break, golden mile, meadows) and five doctors (OQ-21). Seeded into `reminder_exclusions` in the drafts.
3. **The Google Sheet "Appointment Reminders"** is written only in the Sanoflow-send **error handler**: it is a failed-send fallback list with wa.me links (OQ-42), not a doctor/template mapping.
4. **Birthday** bands/templates: M 20–29 → 12294, 30–39 → 12295, ≥ 40 → 12296; F 18–35 → 12289, 36–45 → 12291, 46–65 → 12291. `Birthday Message = Sent` is never reset (one message ever per patient); uncovered bands get nothing (OQ-17).
5. **Chronic Update** matches by phone and updates every recall row for that number (OQ-22). Its sample payload: `{Mobile, Status ∈ Replied|Booked, Trigger Data}`.
6. **MRD Sync** performs no negation scrubbing despite its description; classifies drugs by `contains()` on the Unite medicine-type text; caps at 10 visits/night and 20 medications/visit; never sets Secondary Diagnosis Codes, Symptomatic or the Patient link; Pap Result is the constant "Not available in Unite".
7. **Token** scenario cannot keep a 240 s token valid on a 3×/day schedule; consumers rely on `authorize` re-issuing. Response status is in the JSON body (HTTP always 200).
8. The replacement design, parallel-run method and cut-over per scenario are in `make-replacement-design.md`; §4 above is superseded by its checklist (§10).
