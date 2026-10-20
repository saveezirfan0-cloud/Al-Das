# Make logic matrix: every Make filter and its Pulse equivalent (20 Oct 2026)

## 1. Purpose and how to read it

This document checks, step by step, that the logic and filters of the seven active Make scenarios are carried over into Pulse's own automations, and lists every difference. The owner decided on 20 Oct 2026 that **Sanoflow stays** (OQ-182): Pulse will send WhatsApp templates through the Sanoflow API, as Make does today. Only Make, the Airtable automations and the Airtable data move to Pulse. The document is also the pattern for building similar automations later (section 5).

Each scenario section has one table per Make module chain. The columns are: the Make step id (`[n]`, the module id in the blueprint), what it does, the Pulse equivalent (`path:line` or a setting name), and a verdict:

- **Same**: Pulse gives the same result for the same input.
- **Different**: Pulse does it, but the result can differ. The reason is in the row; open choices are in section 3.
- **Missing**: Pulse has no equivalent yet.

Sources: the redacted blueprints and summaries in `docs/audit/make-raw/` (parsed offline on 20 Oct 2026; nothing was fetched from Make or Airtable), `docs/audit/make-scenarios.md`, `docs/audit/make-replacement-design.md`, `docs/audit/airtable-schema.md`, `docs/audit/clinical-rules.md`, `docs/audit/open-questions.md`, and the Airtable "Chronic" view filter read through the Airtable connector on 20 Oct 2026 (OQ-104 (4)). Make schedules run in Asia/Dubai (OQ-20). Where a blueprint does not show something, the row says "Not determined from the redacted blueprint" and the point is in section 3.

Two things apply to every scenario:

- **Sending.** Make calls Sanoflow `send-template` (v1.1, or v1 for birthday). Pulse queues a template through `queueOutbound` (`lib/recall/supabase-deps.ts:195`, `lib/appointments/service.ts:173`) and the outbound job sends it. Pulse's Sanoflow sender (OQ-182) is being built now: it sends templates only, mapping Pulse's `body.1`, `body.2`, … values to Sanoflow's `mapper_value` list. Sanoflow contact writes (tags, labels, names, new contacts) are not part of it; see D11.
- **Pacing.** Make paces with `util:FunctionSleep` or not at all. Pulse has no sleeps: the outbound job takes a per-number send slot (`lib/jobs/handlers/outbound.ts:177`).

---

## 2. Active scenarios

### 2.1 Token (3576415)

**Trigger.** Schedule, three times a day at 11:55, 17:55 and 23:55 Dubai. **Pulse:** no schedule. A token is fetched when a Unite call needs one (`lib/unite/auth.ts:170`).

**Input.** Make data store "Token" (61544), key `token`: the Unite access and refresh tokens in plain text. **Pulse:** the encrypted `integration_accounts` row for Unite.

| Make step | Condition / action | Pulse equivalent | Verdict |
|---|---|---|---|
| [1] | Read the stored token pair | `TokenStore.load()` (`lib/unite/auth.ts:25`) | Same |
| [4] | `GET authorize?app_id&app_key` with `Bearer <stored access token>`; "evaluate all states as errors" on | `authorize()` with the same call (`lib/unite/auth.ts:125`) | Same |
| [6] route 1 | Body `Status = "Success"` → [5] store the new pair | `store()` after `Status === "Success"` | Same |
| [6] route 2 | Body `Message = "Token Expired"` → [2] `POST refreshtoken` with `Bearer <refresh token>` → [3] store | `isTokenRejected()` → `refresh()` (`lib/unite/auth.ts:66`, `:134`) | Different: Pulse also refreshes on "Invalid Token" |
| (none) | A run outside the schedule | Token reused while valid for 30 s more (`TOKEN_SAFETY_MARGIN_MS`, `lib/unite/auth.ts:47`); a rejected data call re-authorises (`renewToken`, `:177`) | Different: Pulse never holds a stale token |
| [7], [8] | Orphan refresh module with a third credential pair; unreachable | Not carried over | Same (dead code) |

**Message sent.** None. **Side effects.** Make overwrites the data store row. Pulse saves the pair encrypted and logs each call without tokens.

**Timing.** Make's three runs cannot keep a 240-second token valid; the consumer scenarios work because `authorize` re-issues on every call. Pulse refreshes on demand. **Open:** whether Pulse authorising with its own credentials breaks Make's token during the parallel run (D19).

### 2.2 Appointment Reminders (3613818, 12:00) and Appointment Reminders – 6PM (3913219, 18:00)

**Trigger.** 3613818: schedule every 15 minutes, restricted to 12:00–12:01 every day, so one run at 12:00 Dubai. 3913219: daily at 18:00 Dubai. **Pulse:** no fixed run. Each appointment gets reminder rows from the booking rules (48 h off, **24 h on**, 3 h off; `lib/appointments/settings.ts:25`–`27`), each with a `scheduled_jobs` row (`lib/appointments/service.ts:134`–`163`). The `appointments` queue is polled every 10 seconds and a sweep re-plans every 5 minutes (`supabase/migrations/20261009000930_appointment_jobs.sql:8`–`9`, `lib/jobs/handlers/appointments.ts:424`).

**Input.** Make calls Unite `getallappointments?clinic_id=…&from_date=D&to_date=D` with `D = tomorrow` (`DD-MM-YYYY`, Dubai) for the three clinics. **Pulse:** the Unite appointment sync writes `appointments` (every 15 minutes 07:00–21:45 Dubai for today to today+3, and nightly at 22:30 for today to today+7; `supabase/migrations/20261009000940_unite.sql:43`–`44`, `lib/unite/config.ts:39`–`41`). The sync waits for Unite credentials (OQ-26), so Pulse reminders for Unite bookings cannot start before that.

**Main path (both scenarios, per branch route).**

| Make step (12:00 / 6PM) | Condition / action | Pulse equivalent | Verdict |
|---|---|---|---|
| [1] / [1] | Read the Unite token from the data store | `lib/unite/auth.ts:170` | Same |
| [3] / [2] | `Date = formatDate(addDays(now; 1); "DD-MM-YYYY")` (tomorrow, Dubai) | Reminder due at `starts_at − 24 h` (`lib/appointments/reminders.ts:27`) | Different: see timing below and D8 |
| [4] / [3] router | Three routes named Golden Mile, Meadows, Palm Jumeirah. The route filters have names only, no conditions, so all three run | Sync per Unite clinic id (`locations.external_id`) | Same |
| [6] [7] [5] / [4] [15] [26] | `getallappointments` per clinic id | `syncAppointments` (`lib/jobs/handlers/unite-sync.ts:68`) | Same |
| [15] [17] [13] / [5] [16] [27] | Iterate `data.Data` | One `appointments` row per Unite appointment | Same |
| send filter, Golden Mile and Meadows | Patient name ≠ `SHORELINE`, ≠ `block`, ≠ `golden mile`, ≠ `meadows` (case-insensitive equals), does not contain `break`; doctor ≠ four named doctors (case-sensitive equals) and does not contain a fifth (OQ-21) | `is_reminder_excluded()` with the seeded list (`supabase/migrations/20261009000920_appointments_ext.sql:41`–`66`), checked when the reminder fires (`lib/jobs/handlers/appointments.ts:122`) | Same for these two branches |
| send filter, Palm Jumeirah | Patient name does **not contain** `SHORELINE` or `block`, ≠ `Break` (equals), ≠ `golden mile`, ≠ `meadows`; same doctor list | One global list: `SHORELINE` and `block` are "equals", `break` is "contains" | Different: Palm Jumeirah's own variant is not kept (D10) |
| name used by the filter | Unite `patientfullname` and `doctorname` as received | Pulse contact `full_name` and specialist `name` (`lib/jobs/handlers/appointments.ts:122`–`126`). A booking with no matched patient is excluded as `no_contact` (`:104`) | Different: a placeholder booking may never create a contact, so it is excluded earlier |
| 6PM only: [37] [38] [39] | Search Appointment Messages for any row with this `Appointment ID` (max 100). The exclusion filter sits on this module | Unique `(appointment_id, idx)` on `appointment_reminders`; a sent row is not sent again (`lib/jobs/handlers/appointments.ts:91`) | Same for one booking time |
| 6PM only: send filter | `{{37.id}}` does not exist (no earlier log row) | as above | Same |
| 12:00 only | No dedupe: an appointment fetched at noon on two days (for example, moved by a day) is reminded twice | A moved appointment gets a new due time and a new reminder (`lib/appointments/reminders.ts:61`–`78`, `lib/appointments/service.ts:134`) | Same in effect |
| (none) | Unite status is logged, never checked; a cancelled booking still in the feed is reminded | Cancelled, no-show and completed appointments get no reminder (`lib/jobs/handlers/appointments.ts:100`). Unite codes are unmapped until OQ-23, so every Unite booking stays `awaiting` (`lib/unite/sync.ts:455`–`461`) | Same until OQ-23 is answered |
| (none) | No consent check | Desk "no WhatsApp" refusal (`lib/jobs/handlers/appointments.ts:148`); reminder test mode (`:140`) | Different: Pulse adds guards |
| [14] [18] [16] / [6] [17] [28] | Sanoflow `send-template`, template **11885** (`appointment_reminder_48h`), phone = Unite `patientmobilephone` as received | Mapped `reminder` template in Settings, Appointments (`lib/appointments/settings.ts:69`, default none, `:74`); phone is E.164 from the sync (`lib/unite/mappers.ts:148`) | Different: Pulse sends nothing until a template is mapped (`lib/appointments/service.ts:196`–`198`); the phone is normalised |
| [30] [31] [29] / [14] [25] [36] | Create an Appointment Messages row: Message Type "Appointment", appointment id, clinic id, doctor id, status, start and end, remarks, created by, nationality, patient name, PIN, phone, sent time. The 12:00 run also writes the branch name; the 6PM run does not | `appointment_reminders` row (status, due, sent time, message id, exclusion reason) plus the synced `appointments` row | Different: no copy of name or phone (by design) |

**Variables of template 11885.**

| Variable | Make | Pulse (`lib/appointments/reminders.ts`) | Verdict |
|---|---|---|---|
| {{1}} | `ifempty(first(split(startcase(patientfullname); space)); "Patient")`: first word of the Unite full name, each word capitalised, else "Patient" | `contact.first_name`, first word, else "Patient" (`:116`); default order `:141`–`146` | Different: Pulse does not re-capitalise the stored name (D17) |
| {{2}} | Unite `appointmentstarttime` as received (raw string) | `appointment.datetime` = "Mon 12 Oct, 9:00 AM" in the branch time zone (`:85`, `:128`) | Different: the Make fallback text reads "scheduled tomorrow at {{2}}", so the full date may read oddly; map `body.2` to `appointment.time` (D18) |
| {{3}} | Unite `doctorname` | `appointment.specialist`, else "your doctor" (`:131`) | Same (with a fallback) |

**Error path (Make `onerror` on the send).** The Golden Mile and Meadows routes act only when Sanoflow answers `{"error":"Bad Request","message":"Invalid channel details."…}`; the Palm Jumeirah route acts on any error.

| Make step (12:00) | Action | Pulse equivalent | Verdict |
|---|---|---|---|
| [42] [48] [35] | Sanoflow `contacts/list?phone=<number after the "-">` | None | Missing (D9, D11) |
| [43] [49] [36] | Iterate the contacts found. With none found, Make passes no bundle on, so nothing below runs and nothing is logged | None | Missing |
| [44] [50] [38] | Sanoflow v1 `contacts/add` (first and last word of the Unite name, phone); on error a Google Sheet "Appointment Reminders" row (name, phone, message text, PIN, wa.me link, "Pending") | Failed reminder → notice to reception and a "Call patient" task (`lib/jobs/handlers/appointments.ts:161`, `:271`), SMS fallback when switched on | Different (D9) |
| [45] [51] [39] | Re-send template 11885. {{1}} has **no** "Patient" fallback on this path. On error a Google Sheet row (the 6PM Palm Jumeirah retry ignores the error instead) | No automatic re-send | Different |
| [46] [52] [41] | Log the Appointment Messages row | Reminder row status `sent` | Same |

**Implicit retry.** Make logs a row only after a send that worked. The 6PM run skips only appointments with a log row, so a failed noon send is tried again at 18:00. Pulse marks the reminder `failed` and raises a task instead (D9).

**Timing.** Make reminds every appointment of tomorrow at 12:00 today, plus bookings for tomorrow made between 12:00 and 18:00, at 18:00. The notice is 12 to 36 hours depending on the appointment time (OQ-19). Bookings for tomorrow made after 18:00 get nothing. Pulse sends exactly 24 hours before each start. A booking made less than 24 hours ahead gets no reminder, because a due time already passed is dropped (`lib/appointments/reminders.ts:38`). The 6PM run would have reached some of these (D8).

### 2.3 Agewise Birthday Message (4049277)

**Trigger.** Schedule every 15 minutes, restricted to 12:00–12:01 every day: one run at 12:00 Dubai. **Pulse:** recall programme `birthday`, cron `0 9 * * *` in Asia/Dubai (seed, `supabase/migrations/20261010000800_recall.sql:221`), run by `recall_run`, which pg_cron pings every minute (`supabase/migrations/20261010000900_recall_phase8.sql:109`, `lib/jobs/handlers/recall-run.ts:24`–`26`). Seeded as `draft`.

**Input.** Airtable Unite base (`app7QJ2pvhADHQeBP`), patients table `tbl9856qJP9S7OEqB`, formula `{DOB (DD-MM)} = "<today DD-MM>"` (today from Make's clock in Dubai), max 1000. **Pulse:** view `v_birthday_today` (`supabase/migrations/20261010000800_recall.sql:150`), max 1000 per run (`:221`).

The module names in the blueprint ("20s", "30s", "50s", "18-25", "26-35", "36-45") are labels only. The conditions below are what the filters test. Every sleep is 15 seconds.

| Make step | Condition / action | Pulse equivalent | Verdict |
|---|---|---|---|
| [1] | DOB day and month = today (Dubai) | `to_char(dob,'MM-DD') = today` in Dubai (`20261010000800_recall.sql:169`) | Same |
| [1] | 29 February birthdays never match in a non-leap year | Sent on 1 March in a non-leap year (`:170`–`174`) | Different (OQ-18) |
| [1] | No phone check; a blank phone fails at the send | `phone_e164 is not null` (`:165`) | Different (minor) |
| [1] | No opt-out or test-record check | `not stop_marketing`, `not is_test_record` (`:166`–`167`); then the programme needs `promotions_opt_in` (`requires_marketing_opt_in = true`, `:221`; `lib/recall/engine.ts:179`–`186`) and a Marketing template needs it again (`lib/recall/engine.ts:208`) | Different (D6) |
| [2] router filter | `Birthday Message` ≠ "Sent": one message ever per patient | One per patient per calendar year: `cycle_key` = year (`:162`), unique `(programme, contact, cycle)` (`:96`) | Different (OQ-17) |
| [3] filter "Men" | `Gender` equals `M` | `gender = 'male'` (the importer maps M/F/U, `scripts/import/mappers/airtable.unite-patients.ts:113`–`114`) | Same |
| [4] filter "Women" | `Gender` equals `F` | `gender = 'female'` | Same |
| (none) | Gender U, or anything else: no route | `segment_key` null → `skipped_no_template` row (`lib/recall/engine.ts:188`–`206`) | Same result (nothing sent); Pulse counts it |
| [5] | Age ≥ 20 and < 30 → 12294 | `m_20_29` (between 20 and 29, `:154`) → 12294 (`:251`) | Same |
| [19] | Age ≥ 30 and < 40 → 12295 | `m_30_39` → 12295 | Same |
| [45] | Age ≥ 40, no upper limit → 12296 | `m_40_plus` → 12296 | Same |
| [58] | Age ≥ 18 and ≤ 35 → 12289 | `f_18_35` → 12289 | Same |
| [71] | Age ≥ 36 and ≤ 45 → 12291 | `f_36_45` → 12291 | Same |
| [84] | Age ≥ 46 and ≤ 65 → 12291 (same template as 36–45) | `f_46_65` → 12291 | Same |
| (none) | Men under 20, women under 18 or over 65: nothing | `segment_key` null → `skipped_no_template` | Same result |
| orphans [32]–[39], [97]–[104] | Unconnected "40s" (40–49) and "46-65" branches | Not carried over | Same (dead code) |
| `Age` field | Airtable formula field; its formula is not in the blueprint | Whole years at today's Dubai date (`age()`, `:152`–`159`) | Not determined from the redacted blueprint (expected Same) |
| [5] [19] [45] [58] [71] [84] | Sleep 15 s before each send | Outbound send slot per number | Different (no sleeps by design) |
| [6] [20] [46] [59] [72] [85] | Sanoflow v1 `send-template`; `stopOnHttpError` on; no error handler | Template from the map; a failed send sets `failed` (`lib/recall/engine.ts:260`–`265`) | Same |
| [7] [21] [47] [60] [73] [86] | Set `Birthday Message = Sent` | `recall_sends` row inserted before the send (`lib/recall/engine.ts:227`) | Same (the row is the marker) |

**Message sent.** Template per band (above). One variable: `ifempty(Last Name; First Name)`: Make greets with the **last name** when there is one, else the first name, with no "Patient" fallback. **Pulse:** values come from `recall_programme_templates.variables_map` (`lib/recall/engine.ts:242`, `:274`). Since 20 Oct 2026 the seed sets `{"body.1": "contact.first_name|default:Patient"}` on every birthday and chronic row, and existing rows that were still `{}` are filled once (`supabase/migrations/20261224000200_recall_variables_map.sql`). The Recall page edits it per group (`saveTemplateVariables`, rules in `lib/recall/variables.ts`) and flags a group whose template has a variable with no value. **Same** for the name variable (D16, done); the seed uses the first name, so whether to keep Make's last-name rule is still D5.

**Side effects.**

| Make step | Action | Pulse equivalent | Verdict |
|---|---|---|---|
| [8] [22] [48] [61] [74] [87] | Only if `Sanoflow Contact Id` is set: Sanoflow `contacts/list?contact_id=…` | None (Pulse writes native tags) | Different (D11) |
| [9] [10] [11] … | Iterate the contact (filter: `contact_id` exists), join its tag ids with ", " | None | Different |
| [13]+[14], [16] … | Sanoflow `contacts/edit`: tags = existing + **3590** (or 3590 alone), and first and last name **overwritten** from Airtable | Native tag `birthday_sent_<year>`, Live mode only (`lib/recall/types.ts:161`–`164`, `lib/recall/engine.ts:256`–`259`) | Different (D11) |
| [15] [17] … | Birthday Messages row (Sanoflow id, last name, age, phone, first name, sent date as text `DD/MM/YYYY`, PIN, full name, DOB DD-MM). Written only on the tag path, so a patient without a Sanoflow contact id is messaged and marked Sent but not logged | `recall_sends` row for every patient listed, sent or skipped | Different (Pulse logs every send) |

**Timing.** Make: 12:00, then about 15 seconds per patient. Pulse: 09:00 by default (OQ-55), paced by the outbound queue.

### 2.4 Chronic Recall – 90 Day (5882746)

**Trigger.** Schedule every 15 minutes, restricted to 12:15–12:16 every day: one run at 12:15 Dubai. **Pulse:** programme `chronic_90d`, cron `15 12 * * *` in Asia/Dubai (`supabase/migrations/20261010000800_recall.sql:220`). Seeded as `draft`. Same.

The scenario description says "INACTIVE. Test/live controlled by SEND_MODE variable in module 1". The scenario is active, and module 1 is the Airtable search: there is **no** Test/Live variable in the blueprint. Every send is logged as Live.

**Input.** Airtable Unite base, patients table, **view "Chronic" (`viwXMAipcLg0wpcVt`)** plus formula `{Chronic Recall Eligible} = 1`, max 100. Both apply. The view (read 20 Oct 2026) filters `60 days >` = True AND `Last Visit Date` is before 85 days ago (time zone **Asia/Karachi**) AND `Chronic (from Medical Records Data)` is ticked, sorted by Last Visit Date, oldest first. The formula (R-22) is `Time Elapsed (Days) >= 30` AND `Chronic Recall Sent On` blank AND phone not blank AND a primary condition. **Pulse:** view `v_chronic_recall_eligibility` (`supabase/migrations/20261108000300_chronic_alignment.sql:165`), rows with `eligible = true` (`lib/recall/supabase-deps.ts:72`).

| Make step | Condition / action | Pulse equivalent | Verdict |
|---|---|---|---|
| view | `60 days >` = True (a visit medication with 60 or 90 dosage days, set by Airtable automation `wflJ8HcmP16BqEv7z`) | Not applied | **Missing** (D2, OQ-104 (4)) |
| view | Last Visit Date before 85 days ago, on the Asia/Karachi calendar (at least 86 days, if Airtable's "before" excludes the day itself) | `days_since_last_visit >= chronic_recall_min_days` (`20261108000300_chronic_alignment.sql:188`); proposed 90, live Airtable value recorded as 30, **not signed**, so the setting reads NULL and nobody is eligible (`20261009000950_clinical_core.sql:142`, `:261`) | Different (D1, OQ-01) |
| view | Day count on the Asia/Karachi calendar | `current_date` of the database (`20261108000300_chronic_alignment.sql:156`), UTC on Supabase | Different in principle; at 12:15 Dubai (08:15 UTC, 13:15 Karachi) all three calendars show the same date (D3) |
| view | Last Visit Date = Unite's patient-level date | The later of Unite's date (`contacts.unite_last_visit_date`) and the latest Pulse visit (`:155`) | Same until visits arrive from Unite |
| view | `Chronic (from Medical Records Data)` ticked: at least one visit with a Chronic-flagged diagnosis | Chronic-flagged diagnoses in `contact_chronic_conditions` (`:174`), imported from the patient-level list (Chronic-flagged links only). Nothing is derived from visits until `chronic_condition_min_visits` is signed (OQ-104 (1)) | Different (source); expected Same on imported data |
| formula | `Time Elapsed (Days) >= 30` | Superseded by the 85-day view filter in Make; Pulse has one threshold | Same intent |
| formula | `Chronic Recall Sent On` blank: once ever | No `recall_sends` row for the same last visit date (`:189`–`191`): once per last-visit cycle | Different (D4, OQ-104 (5)) |
| formula | Phone not blank | `phone_e164 is not null` (`:183`) | Same |
| formula | A primary condition (first messageable group, mental-health groups removed; R-20, R-21) | `primary_condition_group is not null` (`:169`, `:186`) | Same |
| (none) | No opt-out check | `not stop_marketing` (`:184`); `requires_marketing_opt_in = false` for this programme (`20261010000800_recall.sql:220`) | Different (Pulse adds the opt-out) |
| (none) | No test-record check | `not is_test_record` (`:185`) | Different (minor) |
| (none) | No consent check | In Live mode, `requires_clinical_consent = true` needs `clinical_messaging_consent` (`lib/recall/engine.ts:182`) | Different (D15, OQ-104 (6)) |
| (none) | No gate | In Live mode a clinical programme also needs the signed `clinical_messaging_enabled` (`lib/recall/engine.ts:101`–`108`) | Different (by design, R-26) |
| view sort | Oldest last visit first; max 100 | `order_by = days_since_last_visit desc`, `max_per_run` 100 (`20261010000800_recall.sql:220`, `lib/recall/engine.ts:126`) | Same |
| [2] filter | "Destination phone must not be empty": `{{1.Phone}}` exists | As above | Same |
| [2] | Sanoflow `send-template` with `template_id = {{1.Chronic Recall Template ID}}` | Map by `segment_key` = primary condition group (`lib/recall/engine.ts:188`–`207`), seeded 13159–13169 (`20261010000800_recall.sql:236`–`247`) | Same for the ten mapped groups |
| [2] | Template id SWITCH default **13170** for any other group | No default row: `skipped_no_template` | Different (D14, OQ-24) |

**Message sent.** One variable: `ifempty(first(split(startcase(lower(Patient Name)); space)); "Patient")`: first word of the full name in title case, else "Patient". **Pulse:** `variables_map`, seeded as `contact.first_name|default:Patient` and editable on the Recall page (D16, done). Pulse sends the stored first name, not re-capitalised (D17).

**Side effects.**

| Make step | Action | Pulse equivalent | Verdict |
|---|---|---|---|
| [3] | Chronic Recall Messages row (base `appkOnjPr1SMD83CP`, `tbldCbNEKeF5NrTCs`): time, last visit date, name, patient record id, phone, Replied "No", Send Mode "**Live**" (constant), Send Status "**Sent**" (constant, even if Sanoflow answered 2xx with an error), Booked "No", Time Elapsed, PIN, Notes "Sent to: <phone>", primary condition, template id | `recall_sends` row: status (moves forward), `send_mode`, `sent_to_phone_e164`, segment, `last_visit_date_at_send`, `days_since_last_visit_at_send`, `legacy_template_ref` (`lib/recall/engine.ts:148`–`172`) | Different (status follows delivery; no phone in free text) |
| [4] "Mark Recall Sent (Live only)" | `Chronic Recall Sent On = today` (`YYYY-MM-DD`) and `Chronic Recall Condition`. There is no filter: it runs on every send | Unique `(programme, contact, cycle)` (`20261010000800_recall.sql:96`) | Same intent |
| [23] → [13] | Sanoflow `contacts/list?phone={{4.number}}`. Module 4 is the Airtable update; whether it returns a field called `number` is **not determined from the redacted blueprint**. If it is blank, which contacts Sanoflow returns is unknown | None | Not determined (D22) |
| [14]–[16] | Iterate the contacts found (filter: `contact_id` exists), join their tag ids | None | Different |
| [18]+[19], [21] | Sanoflow `contacts/edit`: tags = existing + **4654** (or 4654 alone), **label 1800** (replaces the label), names unchanged | Native tag `chronic_recall_sent`, Live mode only (`lib/recall/types.ts:162`, `lib/recall/engine.ts:256`–`259`) | Different (D11, OQ-43) |

**Timing.** Make: 12:15, no sleeps. Pulse: 12:15. Same. Make has no error handler on this scenario; three failed runs in a row switch it off (`maxErrors 3` in the scenario settings).

### 2.5 Chronic Update (5916036)

**Trigger.** Make custom webhook (hook 2679889), called by a Sanoflow flow's API Action node. Payload keys `Mobile` (E.164), `Status` (`Replied` or `Booked`), `Trigger Data` (Sanoflow flow id and contact channel id). Runs immediately. **Pulse:** two domain events, `message.received` and `appointment.created` (`lib/recall/listeners.ts:12`, `:31`).

**Input.** Chronic Recall Messages, matched by phone. **Pulse:** `recall_sends` of the contact.

| Make step | Condition / action | Pulse equivalent | Verdict |
|---|---|---|---|
| [3] route A filter | `Status = "Replied"` | Any inbound message from the contact (`lib/recall/listeners.ts:12`–`30`) | Different: Pulse counts any reply, not only the Sanoflow flow's "Replied" |
| [4] | Search `{Phone} = '<Mobile>'`, max 10 | Newest send of the contact with `replied_at` null, status sent/delivered/read, sent within `recall_reply_attribution_days` (default 14) (`lib/recall/replies.ts:23`–`38`, `lib/recall/attribution.ts:44`) | Different (D12, OQ-22) |
| [6] filter | `{{4.id}}` exists; runs once **per matching row** | One row only | Different (OQ-22) |
| [6] | `Patient Replied = Yes`, `Reply Date = today` | `replied_at`, `reply_message_id`; a button reply also sets `outcome` (`lib/recall/attribution.ts:62`–`81`) | Same intent |
| [3] route B filter | `Status = "Booked"` (a button or flow step in Sanoflow, not a real appointment) | `appointment.created` for the contact (Unite sync or Pulse booking) within `recall_booking_attribution_days` (default 30) (`lib/recall/replies.ts:40`–`55`, `lib/recall/attribution.ts:112`) | Different (D13) |
| [7], [8] | Same phone search; `Appointment Booked = Yes`, `Booking Date = today` on every match | `booked_at`, `appointment_id`, and **`follow_up_status = booked`** on the newest open send (`lib/recall/attribution.ts:133`) | Different: Make never touches Follow Up Status |
| (none) | Any test or live row for that phone is updated | Only rows of the same contact; test sends go to test contacts | Different |

**Message sent.** None. **Precondition in Pulse.** With Sanoflow keeping the numbers, patients' replies arrive in Sanoflow. Pulse's `message.received` fires only for messages Pulse receives. Without a reply feed from Sanoflow into Pulse, Pulse records no reply (D12, OQ-182). Booking attribution needs the Unite appointment sync (OQ-26).

**Being built (20 Oct 2026, not yet merged).** A Sanoflow webhook (`app/api/webhooks/integrations/sanoflow/[accountId]/route.ts`, parser `lib/integrations/sanoflow/webhook.ts`) takes the same `{Mobile, Status}` body as Make's hook. `Replied` credits the newest open send (`attributeExternalReply`, `lib/recall/attribution.ts:92`); `Booked` goes through `attributeBooking`. So the Sanoflow flow's API Action node can be pointed at Pulse instead of Make. Attribution stays "newest open send", not every row for the phone. Re-check this section when that work lands.

### 2.6 Acute Follow-Up – MRD Sync (5990863)

**Trigger.** Daily, 23:55–23:56 Dubai, max 10 visits per run. **Pulse:** not built. The Unite visit feed is P2 in `docs/45_PATIENT_JOURNEY_AND_ECOSYSTEM_PLAN.md:115`. The clinical rules engine exists (`lib/clinical/*`).

**Input.** Airtable Medical Records Data (`tblllKPKIY9qvMoEU`). The scenario that refreshed that table (`medical records sync`, 6251023) has been off since 21 Sep 2026 (`docs/audit/make-scenarios.md:19`), so MRD Sync now reads a table that no longer changes.

| Make step | Condition / action | Pulse equivalent | Verdict |
|---|---|---|---|
| [1] | `Acute Sync On` blank AND Visit Date set AND within the last 30 days; max 10 | Unite visit feed with a cursor per clinic (P2) | Missing |
| [2] filter | Patient link exists (else skipped and retried every night) | `external_refs` match | Missing |
| [3] | Create an Acute Visit: department by substring (paed/pedia, gyn/obstet, derma, general/internal/family, else Other) | `mapDepartment` (`lib/clinical/department.ts:17`) | Built, not fed |
| [3] | Vitals parsed from strings; BP split on "/" | `parseVital`, `parseBp` (`lib/clinical/vitals.ts:23`, `:43`) | Built, not fed |
| [3] | Observation notes = plain concatenation, no negation scrubbing | `scrubNarrative`, `composeObservationNotes` (`lib/clinical/negation.ts:20`, `:36`) | Different by design (OQ-31) |
| [4] | `Acute Sync On = today` | `external_refs` (idempotent) | Missing |
| [5] | Iterate up to 20 medications | All prescriptions | Missing |
| [6]+[7] | Prescription: class by `contains()` on the medicine-type text (antibiotic, corticosteroid, probiotic, vitamin, blank → UNCLASSIFIED, else Other); probiotic 10 days; "Not started" | `suggestMedicationClass` (`lib/clinical/medication-class.ts:12`) as a suggestion only; class by code (OQ-13) | Different by design |

**Message sent.** None (the Acute base has no automation that sends). **Recommendation:** D20.

### 2.7 Airtable automations on the Unite base

Not Make, but part of the same move (OQ-41).

| Automation | What it does | Pulse | Verdict |
|---|---|---|---|
| `wflJ8HcmP16BqEv7z` | Patient record created → `60 days >` = True when a visit medication's `Dosage Days` contains 60 or 90 | Not applied (feeds the Chronic view, 2.4) | Missing (D2) |
| `wflwgvvZP4J8Kvg8K` | Record enters view "Chronic" → a row of about 33 patient fields in the Google Sheet "Chronic" | Dropped: the owner said on 20 Oct 2026 the sheet is not needed | Dropped (OQ-41) |

### 2.8 Run times side by side (Asia/Dubai)

| Scenario | Make | Pulse | Verdict |
|---|---|---|---|
| Token | 11:55, 17:55, 23:55 | On demand | Different (by design) |
| Reminders | 12:00 and 18:00, for tomorrow | 24 h before each start; queue every 10 s, sweep every 5 min | Different (D8) |
| Birthday | 12:00, 15 s per patient | 09:00 (seed), outbound pacing | Different (D7) |
| Chronic recall | 12:15 | 12:15 | Same |
| Chronic Update | On the Sanoflow webhook | On each inbound message or booking event | Different (D12) |
| MRD Sync | 23:55, 10 visits | Not built | Missing (D20) |
| Unite appointment pull | Inside the reminder runs | Every 15 min 07:00–21:45 and 22:30 nightly | Different |
| Parallel-run diff | (none) | 00:30 (`supabase/migrations/20261010000900_recall_phase8.sql:111`) | n/a |

---

## 3. Differences to decide

"Who" names the owner from `docs/audit/open-questions.md`. Engineering items need no business answer, only the work.

| # | Difference | What Make does | What Pulse does | Recommended choice | Who decides |
|---|---|---|---|---|---|
| D1 | Chronic recall threshold | View: last visit before 85 days ago (in practice), formula ≥ 30, description 90 | `chronic_recall_min_days` ≥ N; proposed 90, unsigned, so nobody is eligible | For the parallel week sign the value that reproduces the view (86 if Airtable's "before" excludes the day; check on day 1 of the diff), then set the agreed value | Abdul / Snezana (OQ-01) |
| D2 | `60 days >` long-prescription gate | Required by the Chronic view; set by Airtable automation `wflJ8HcmP16BqEv7z` | Not applied, so Pulse selects more patients | Decide first. To keep parity, import `60 days >` as a contact flag and add a signed setting that requires it; the data can only be derived again from prescriptions once the visit feed (P2) exists | Abdul / Snezana (OQ-104 (4)) |
| D3 | Calendar for the day count | Asia/Karachi (the view's time zone) | Database `current_date` (UTC); programme schedules in Dubai | Use Dubai; no effect at 12:15. Revisit only if the run moves near midnight | Saveez (OQ-20, OQ-55) |
| D4 | Once ever or once per cycle | Chronic: `Sent On` never cleared. Birthday: `Birthday Message = Sent` never reset | Chronic: once per last visit date. Birthday: once per year | Keep Pulse's cycles. Note that the 56 Make-era chronic sends are not imported (OQ-53), so the first live run may message those patients again; import their ids and dates if that matters | Abdul / Snezana (OQ-104 (5)); Saeed / marketing (OQ-17); Management (OQ-53) |
| D5 | Birthday bands and greeting | Bands M 20–29, 30–39, ≥ 40; F 18–35, 36–45, 46–65 (36–65 share 12291); nothing for M < 20, F < 18, F > 65, gender U; greeting = **last name**, else first name | Same bands and templates; uncovered bands recorded as `skipped_no_template` | Confirm the bands; decide whether the greeting should be the first name (`contact.first_name|default:Patient`) or keep Make's last-name rule | Saeed / marketing (OQ-17) |
| D6 | Birthday consent | No opt-out or opt-in check | `stop_marketing` excluded and `promotions_opt_in` required (programme flag and Marketing template). The Unite patient import sets no opt-in, so only contacts with an opt-in from the Sanoflow import are reached | Keep the opt-out (rule 11). Decide whether a birthday greeting needs the promotions opt-in; if it does, expect far fewer sends than Make. If it does not, use a Utility template and set `requires_marketing_opt_in = false` | Saeed / marketing (OQ-17) |
| D7 | Birthday run time | 12:00 | 09:00 (seed) | 12:00 during the parallel run, then decide | Marketing (OQ-55) |
| D8 | Reminder run times and notice | 12:00 for all of tomorrow, 18:00 for bookings made since; 12 to 36 h notice; nothing for bookings after 18:00 | Exactly 24 h before; nothing for bookings made less than 24 h ahead | Keep 24 h and switch on the third rule (3 h) for late bookings, or accept the gap; rename the template away from "48h" | Operations (OQ-19) |
| D9 | Failed reminder | Retried once at 18:00 (log only on success); Sanoflow contact created and the send repeated on "Invalid channel details"; else a Google Sheet row | `failed`, notice to reception, "Call patient" task, SMS fallback if on; no automatic re-send | Keep Pulse's task. Do not re-create Sanoflow contacts automatically (D11) | Operations (OQ-42) |
| D10 | Reminder exclusions | Hard-coded per branch; Palm Jumeirah uses "contains" for SHORELINE and block and "equals" for Break; tested on Unite's raw names | One editable list (`reminder_exclusions`), tested on the Pulse contact and specialist names | Confirm the list; add `contains` rows for SHORELINE and block if Palm Jumeirah's looser match is wanted | Operations (OQ-21) |
| D11 | Sanoflow contact writes | Birthday: tag 3590 added, names overwritten from Airtable. Chronic: tag 4654 added, label 1800 set. Reminders: contacts created on error | Native Pulse tags only (`birthday_sent_<year>`, `chronic_recall_sent`), Live mode only. The Sanoflow sender being built sends templates only | Ask marketing whether anything in Sanoflow (segments, flows, reports) reads tags 3590, 4654 or label 1800. If not, drop them. If so, add a separate, off-by-default "tag in Sanoflow" step after a send (`contacts/edit`), and never overwrite names | Marketing / Saveez (OQ-43, OQ-182) |
| D12 | Reply attribution | Every row for the phone (up to 10), only when the Sanoflow flow posts "Replied" | Newest open send of the contact within 14 days, on any inbound message Pulse receives | Keep "newest open send". Because Sanoflow keeps the numbers, Pulse sees replies only through Sanoflow: point the Sanoflow flow's API Action at Pulse's Sanoflow webhook (being built, 2.5) | Saveez / Abdul (OQ-22, OQ-182) |
| D13 | What "Booked" means | A Sanoflow button or flow status; Follow Up Status untouched | A real appointment within 30 days; sets `follow_up_status = booked` | Keep a real appointment as the proof of a booking (needs the Unite appointment sync). Decide whether Sanoflow's "Booked" status (the webhook being built, 2.5) also counts, as it does in Make | Management (OQ-33); credentials OQ-26 |
| D14 | Chronic fallback template | 13170 for any group not in the SWITCH | Nothing sent (`skipped_no_template`) | Fail closed (Pulse) | Saeed / Abdul (OQ-24) |
| D15 | Chronic consent | None | Live mode needs `clinical_messaging_consent`, which only test records have after the import, so live chronic recall reaches nobody | Drop the consent requirement for chronic recall (keep `stop_marketing`) or capture consent first | Abdul / Snezana (OQ-104 (6)) |
| D16 | Recall template variables | Name variable built in each send module | **Done 20 Oct 2026.** Seeded `{"body.1": "contact.first_name|default:Patient"}` on every chronic and birthday row (empty maps backfilled once) and editable per group on the Recall page (`supabase/migrations/20261224000200_recall_variables_map.sql`, `lib/recall/variables.ts`) | Done | Engineering |
| D17 | First-name form | Title-cased first word of the full name (reminders, chronic) | Stored first name, first word (reminders); recall depends on D16 | Add a title-case filter to the shared value map, or accept stored casing | Engineering, with marketing |
| D18 | Reminder time variable | Raw Unite start time in "tomorrow at {{2}}" | "Mon 12 Oct, 9:00 AM" | Map `body.2` to `appointment.time` on the reminder template | Operations |
| D19 | Unite token during the parallel run | Make authorises 3× a day and on every reminder run | Pulse authorises on demand with its own credentials | Test once whether one side's authorise invalidates the other's token before both run together (`docs/09_STATUS_AND_ROADMAP.md:292`) | Saveez / Unite |
| D20 | MRD Sync | Runs nightly on a table nobody refreshes since 21 Sep 2026 | Not built (P2 visit feed) | Switch Make MRD Sync off now (it adds nothing) or keep it to cut-over; parallel run against it only once P2 is built | Saveez / Abdul |
| D21 | Unite appointment status | Not checked | Inactive statuses get no reminder, but every Unite code is unmapped, so all stay Awaiting | Answer OQ-23, then fill `unite_appointment_status_map` | Sharafadin / Unite (OQ-23) |
| D22 | Chronic Sanoflow contact lookup | `contacts/list?phone={{4.number}}`; whether that field has a value is not determined | n/a | Check in Sanoflow how many contacts carry tag 4654 and label 1800 against the 56 sends, before deciding D11 | Saveez |
| D23 | Call-list day count | Send day counted (`WORKDAY_DIFF >= 3`, both ends) | Send day not counted, so one working day later | Count the send day, or keep it and set `recall_followup_workdays` to 2 | Abdul (OQ-104 (7)) |

---

## 4. Inactive scenarios

From `docs/audit/make-scenarios.md:41`–`53` (42 inactive scenarios). Nothing here runs in Make today.

| Group | Make scenarios | Pulse | Status |
|---|---|---|---|
| Unite data syncs | `medical records sync` 6251023, `Update Chronic` 4210055, `Old-Unite > Airtable` 3758764, `med-chronic-unite` 4354177, `Unite > Sano Appointment Sync` 5480742, `Clinics & Appts` 3576553, `Sano Id's` 3882448 | One incremental Unite sync (appointments, doctors, patients built; visits P2). `Update Chronic` marked every diagnosis chronic and must not be copied; `med-chronic-unite` holds the 60/90-day rule (OQ-104) | Folded |
| Unite Finance API | `TEST - Unite Finance API` 6555877 | Finance capture, off and guarded (deliver-once) | Carried over |
| Screening and dormant | Annual Checkup (330 days), Annual Dental, Pap Smear, Colonoscopy, Skin Cancer and Mole Check, Menopause, Pre-Menopause, Dormant Patient Reactivation, Lab Test Reminder | Recall programme drafts with no eligibility view yet, so they cannot be activated (`supabase/migrations/20261010000800_recall.sql:222`–`229`); P6 | Carried over (not built) |
| Birthday legacy | Birthday_Campaign, Birthday Follow Ups, Birthday Offer Update (webhook) | Birthday programme; starter flow "Birthday offer" on the "Claim offer" button (`lib/flow-engine/starter-flows.ts:35`) | Folded |
| Labs | Lab Result Ready, Lab Follow-up Required (webhooks), Lab Test Reminder | `lab_orders` not built | Not built |
| Post-appointment and no-show | Post-Appointment Follow-up, NoShow_Recovery, DRAFT No-Show Recovery Outreach, DRAFT Post-Visit Follow-Up | Starter flows `post_visit_followup` and `no_show_recovery` (`lib/flow-engine/starter-flows.ts:158`, `:177`), templates to choose | Carried over (drafts) |
| DRAFT clinic operations | Antibiotic Follow-Up Conditional, Daily Conversation Analytics, Insurance Verification Express, Patient Retention Alert System, Payment Collection Sequence, Symptom Triage and Routing | Clinical sequence engine, reports, enquiry pipelines, payment links, routing flows (no diagnosis) | Folded |
| Search New Contact | 3630414 | Not needed (one CRM) | Dropped |
| Scratch "Integration …" | 9 empty test scenarios | Not needed | Dropped |

---

## 5. Building a similar automation in Pulse

### 5.1 Which tool

| You need | Use | Why |
|---|---|---|
| A daily list of patients picked by a rule (days since a visit, a birthday, a condition), each messaged at most once per cycle, with Test/Live and a call list | **Recall programme** (`lib/recall/engine.ts`) | Eligibility is a SQL view; the send log (`recall_sends`) is unique per patient and cycle, so a re-run never sends twice |
| Something that reacts to an event (a button tap, a new booking, a status change, a reply, a webhook) or has steps with waits | **Flow** (`lib/flow-engine/`, triggers in `lib/flow-engine/types.ts:56`–`80`) | One job per step, waits in `scheduled_jobs`, dry run before publishing |
| One message to a marketing audience, once or on a schedule | **Campaign** (recurring runs claimed with `campaign_recurrence_claim`) | Audience filters, A/B, budget; clinical fields are refused for marketing audiences |
| A message tied to one appointment (reminder, confirmation) | **Booking rules** (Settings, Appointments) | Planned per appointment and re-planned when it moves |

Rule of thumb: a Make scenario that starts with "search records where …" on a schedule is a recall programme. One that starts with a webhook or a button is a flow.

### 5.2 The parts of a recall programme

**`recall_programmes`** (`supabase/migrations/20261010000800_recall.sql:29`):

| Field | Meaning | Make equivalent |
|---|---|---|
| `key`, `name`, `kind` | Identity; `kind` in `chronic, birthday, screening, dormant, post_visit, no_show`. Chronic, screening, post_visit and no_show are clinical and need the signed gate in Live (`lib/recall/types.ts:166`) | Scenario name |
| `status` | `draft`, `active`, `paused`; only `active` runs; activation needs an eligibility view (`app/(app)/recall/actions.ts:81`) | On/off switch |
| `eligibility_view` | Name of the SQL view that lists patients. It must be in `ALLOWED_VIEWS` (`lib/recall/types.ts:156`), and in `ELIGIBLE_FLAG_VIEWS` if it has an `eligible` column | The search module and its filters |
| `cron_expression` | Five-field cron in Asia/Dubai, checked every minute by `recall_run`; one run per slot (`lib/jobs/handlers/recall-run.ts:24`–`26`) | Schedule |
| `max_per_run` | 1 to 1000 | `maxRecords` |
| `send_mode_override` | `test`, `live` or null (use `recall_send_mode`). Anything else is Test (`lib/recall/engine.ts:28`). Switching to Live needs `clinical.settings.manage` and a typed confirmation (`app/(app)/recall/actions.ts:66`) | The missing SEND_MODE |
| `requires_marketing_opt_in` | Patient must have `promotions_opt_in` | (none) |
| `requires_clinical_consent` | In Live, patient must have `clinical_messaging_consent` | (none) |
| `config` | `order_by` (allow-listed column and direction), `test_sample_size` (default 5), `tag` (`{cycle}` placeholder), `button_outcomes`, `threshold_setting` | Sort, tags |
| `repeat_policy`, `min_days_since_visit` | Stored but not read by the engine: the view's `cycle_key` decides how often, and thresholds belong in `clinical_settings` | "Sent" flag |

**The view contract.** Columns `org_id`, `contact_id`, `segment_key`, `cycle_key`, and optionally `eligible`, `excluded`, `last_visit_date`, `days_since_last_visit`, `appointment_id`, `starts_at`, `doctor_name` (`lib/recall/types.ts:24`–`36`). `cycle_key` is the repeat rule: the year for "once a year", the last visit date for "once per visit", the constant `'once'` for "once ever". Put opt-out, phone and test-record checks in the view as the existing two do. Read thresholds with `clinical_setting_num()`, so a missing sign-off means nobody is eligible (rule 15).

**`recall_programme_templates`** (`20261010000800_recall.sql:51`): one row per `segment_key` (or `*` as a catch-all; never for chronic):

| Field | Meaning |
|---|---|
| `segment_key` | Band or condition group from the view |
| `wa_template_id` | Pulse template (must be APPROVED) |
| `legacy_sanoflow_template_id` | The Make template id, kept for the record and the parallel run (stored on each send as `legacy_template_ref`) |
| `variables_map` | `{"body.1": "contact.first_name|default:Patient"}`. Keys follow `templateVariables` (`body.N`, `lib/whatsapp/templates.ts:121`); values are paths with filters (`contact.*`, `appointment.starts_at`, `appointment.doctor_name`, `recall.segment`, `recall.cycle`; `lib/recall/engine.ts:274`–`296`). The Recall page offers the patient-facing ones (first, last or full name, doctor's name) with a fallback (`lib/recall/variables.ts`) |
| `active` | Off rows are ignored |

For sending through Sanoflow, the Pulse template also needs its Sanoflow template number (part of the Sanoflow sender being built, OQ-182); a template without one is not sent through Sanoflow.

### 5.3 Worked example: the birthday scenario

Each Make module of 2.3 and where it lives in Pulse.

1. **Search [1] and filters [2]–[4], [5]–[84].** View `v_birthday_today` lists today's birthdays with `segment_key` = band and `cycle_key` = year. Nothing to build.
2. **Schedule.** Recall, Birthday: cron `0 12 * * *` to match Make for the parallel week (D7). Max per run 1000.
3. **Templates [6]…[85].** For each band row link the approved Pulse template whose Sanoflow number is 12294, 12295, 12296, 12289 or 12291. The legacy id is already seeded.
4. **Variable.** Already seeded as `{"body.1": "contact.first_name|default:Patient"}`. To change it (for example Make's last-name rule, D5), open the programme on the Recall page and use the values under the group's template (D16).
5. **Marker [7].** Nothing to do: the `recall_sends` row is written before the send.
6. **Tags [8]–[17].** Native tag `birthday_sent_<year>` in Live. A Sanoflow tag needs D11.
7. **Consent.** Decide D6 and set `requires_marketing_opt_in` and the template category to match.
8. **Test mode.** Leave `recall_send_mode` = test, fill `test_recipient_numbers` (E.164) under clinical settings, keep `test_sample_size` small. Test mode delivers up to that many messages per run to the test numbers and records the rest as `eligible` (`lib/recall/engine.ts:220`–`240`).
9. **Activate** (`status = active`) and watch one run on the Recall page: listed, queued, skipped (no template, opted out), failed.
10. **Parallel run.** Each day load Make's PINs with `pnpm parallel:ingest --org <slug> --scenario birthday --date YYYY-MM-DD --file ids.txt` (hashed, never stored raw); the 00:30 job compares (`lib/parallel-run/service.ts:33`). Explain each day's difference on `/recall/parallel-run`; after 7 clean days switch Make off, then Pulse to Live.

A **new** programme (for example the annual check-up at 330 days) also needs code: a new view in a migration (with RLS through its base tables, `security_invoker`), the view name in `ALLOWED_VIEWS`, its threshold as a `clinical_settings` row with an owner, unit tests for the rule and a DB test for the view, then steps 2 to 10.

### 5.4 Checklist before any automation sends to a patient

- **Opt-out and consent.** `stop_marketing` always wins (rule 11); WhatsApp error 131050 sets it. Marketing templates need `promotions_opt_in` (checked when queued and again when sent, `lib/jobs/handlers/outbound.ts:314`). Clinical programmes need the signed `clinical_messaging_enabled`, and consent where the programme says so.
- **Template, not free text.** Automations start conversations, so they use approved templates. Free text is allowed only inside the 24-hour window, and only for replies.
- **Variables.** Every body variable mapped, with a fallback ("Patient", "your doctor"); a missing value fails the send rather than sending a blank.
- **Rate.** No sleeps. The outbound queue holds the per-number limit. Keep `max_per_run` near what Make sent.
- **Test mode first.** Recall: `recall_send_mode` = test and `test_recipient_numbers`. Reminders have their own switch: `reminder_test_mode` and `reminder_test_numbers` (Settings, Appointments), which is **off by default** (`lib/appointments/settings.ts:81`); switch it on before the parallel week or patients get two reminders. Training mode sends nothing to Meta.
- **Exactly once.** One row per patient and cycle (or appointment and slot), inserted before the send. Re-runs and retries must be no-ops.
- **No patient data in logs.** Counts and ids in job logs and notes; no names, numbers or message text (rules 9, 10).
- **Permissions.** Programme settings need `campaigns.create`, the template map `templates.manage`, Live mode `clinical.settings.manage`.
- **Parallel run.** Make stays on, Pulse in Test mode, at least 7 compared days, every difference explained (known ones listed in `EXPECTED_DIFFERENCES`, `lib/parallel-run/diff.ts:29`), then Make off, then Pulse Live. The migration page (`/settings/migration`, `lib/migration/status.ts:139`–`155`) shows each scenario's state.
- **Sanoflow.** While Sanoflow keeps the numbers, the send goes through the Sanoflow channel and the template needs its Sanoflow number. Replies and button taps reach Pulse only through Sanoflow's reply feed (D12).
