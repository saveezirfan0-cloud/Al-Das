# Airtable audit — Al Das bases (schema only)

Pulled live through the Airtable connection on 8 Oct 2026. **Schema only: no patient records were exported.** Re-pull exact JSON with `scripts/export-airtable-schema.ts` before building migrations. Field IDs are in that export.

**Bases in scope**

| Base | ID | Status | Role in new platform |
|---|---|---|---|
| **Unite** | `app7QJ2pvhADHQeBP` | Live. Fed from Unite by Make | Core: patients, visits (medical records), diagnosis/medication/items reference |
| **Campaigns – Message Log** | `appkOnjPr1SMD83CP` | Live. Written by Make | Core: message log / campaign recipients; portal: chronic recall call list |
| **Acute Clinical Follow-Up Automation** | `appH2jHpsNR1nqEQ2` | Live build (Sep 2026), internal validation | Portal module: clinical follow-up engine (rules, queue, prescriptions, outcomes) |
| Clinical Follow-Up & Care Automation | `appVsJVw5jjj5YiMp` | Older single-table prototype | Superseded by the Acute base. Import history only |
| Patient Treatment & Follow-Up System | `appZbwlQvkuaUsF2l` | Older design + DRAFT tables | Mine for requirements (labs, feedback, no-show, payments, insurance). Mostly not live |
| Unite (Copy), Unite (April 23, 2026), 2025 | — | Backups/copies | Ignore (confirm with client) |

---

## 1. Unite base (`app7QJ2pvhADHQeBP`) — the de-facto patient master

### `Unite` (patients) — `tbl9856qJP9S7OEqB`
| Field | Type | Maps to |
|---|---|---|
| Patient Name, First/Last Name (formulas) | text | `contacts.first_name/last_name` |
| **Patient Pin** | text | `contacts.external_id` (Unite PIN) — **primary join key to Unite** |
| **Sanoflow Contact Id**, Sano Id | text/select | `external_refs(source='sanoflow')` |
| Phone (+ "number", "Phone Number After Dash" formulas) | phone | `contacts.phone_e164` (normalise; Unite sends `971-5xxxxxxx`) |
| Email, Gender, DOB, Nationality (3 variants), Address, Insurance Plan | mixed | contact fields (dedupe the Nationality copies) |
| First Visit Date, Last Visit Date, Dr. Name, Clinic, Department | date/text | derived from visits (computed, not stored) |
| Age, Birth Month, DOB (DD-MM), Time Elapsed, 330 Days, Annual Checkup Reminder Date | formulas | SQL generated columns / views |
| Birthday Message, Birthday Offer, Annual Checkup Reminder, Pap Smear, Dental, Skin Cancer, Colonoscopy, (Pre-)Menopause, Dormant Reactivation | singleSelect flags | **campaign/recall send-state** → `campaign_recipients` / `recall_sends` (one row per patient per programme) |
| Medical Records Data, Chronic Diagnosis, Medication (links) + many lookups | links | FKs to visits / diagnoses / medications |
| **Chronic Recall Sent On / Condition / Groups / Primary Condition / Eligible / Template ID**, Chronic Status | date/formula | chronic recall programme (see rules below) |

**Rules embedded in field descriptions (carry over verbatim as code + tests):**
- *Chronic Recall Eligible* = 90+ days since last visit (all Top-30 chronic codes are "every 3 months"), a messageable chronic condition, has phone, not already sent. This is the single eligibility flag.
- *Chronic Recall Groups* splits the comma-separated select lookup and strips mental-health groups (they are never messaged).
- *Chronic Recall Sent On* blank = eligible. Set at send time to stop re-firing.

### `Medical Records Data` (visits) — `tblllKPKIY9qvMoEU`
Visit Date, vitals as **strings** (Height, Weight, Temp, Pulse, BP Systolic/Diastolic, O2), notes (Complaints, Nurse, Doctor, Therapy, Procedure, Observations, HPI, ROS, Plan of Treatment), Diagnosis / Medication / Items links, Dosage Days, Total Quantity, ROA, Doctor Name, Primary Diagnosis (+ link), **Acute Sync On** (written by Make; idempotency marker).
→ `visits` + `visit_diagnoses` + `visit_items` + `prescriptions`. Parse vitals to numerics at ingest.

### Reference tables
- `Diagnosis` (`tblZqf4Zcw5Kweadh`): ICD-10 code, short/long description, **Chronic**, **Top 30**, Mapped condition group, follow-up interval, monitoring labs/procedures CPT, typical visit CPT, regular medication → `ref_diagnoses`.
- `Medication` (`tblLM2BXjA680GQws`): DDC Code, Trade Name, scientific code/name, strength, form, route, price, owner, source, **MEDICINE TYPE / All Medicine Types** (classification), ICD codes → `ref_medications`.
- `Items` (`tblTJtk6aIMbwpoA2`): Code, Description, Item Type (labs/procedures) → `ref_items`.

---

## 2. Campaigns – Message Log (`appkOnjPr1SMD83CP`)

| Table | ID | Purpose | New home |
|---|---|---|---|
| Appointment Messages | `tblhoSfiSjO4zh9cf` | One row per 48h reminder sent (patient, clinic ID, doctor, appt start/end, Unite appointment ID, status, sent on) | `appointment_reminders` + `messages` |
| Birthday Messages | `tblHTlF6LXMK5p4mU` | Birthday sends (Unite ID, Sanoflow ID, phone, age) | `campaign_recipients` for the birthday programme |
| Chronic Recall Messages | `tbldCbNEKeF5NrTCs` | Send / reply / booking log for 90-day chronic recall, plus **call-list workflow** | `recall_sends` + portal "Chronic Recall Call List" |
| Website | `tblpWst9QqYNuKpwZ` | Website section → source/number/message/route/priority map (chat routing) | `flow` trigger config / channel routing table |

**Chronic Recall Messages rules (from descriptions):**
- Template per condition group (Hypertension, Asthma, Hyperlipidemia, Diabetes… each its own approved template).
- Send Mode Test/Live (Test routes to internal validation numbers).
- **Follow-Up Due:** a live send with no reply after **3 working days** goes to the care coordinator's call list. Setting Follow Up Status = Booked clears it (and Booking Date must be filled).
- **Recall Overdue Flag:** > 120 days since last visit. *Open question in the notes: 85 vs 90-day target — confirm.*
- Week Starting = Monday of the send week (weekly charts).

---

## 3. Acute Clinical Follow-Up Automation (`appH2jHpsNR1nqEQ2`) — clinical rules engine

| Table | Purpose | Key logic to port |
|---|---|---|
| **Settings** | Clinically-governed parameters with Proposed / Approved value, sign-off status, owner, signed by/date | → `clinical_settings`. **Never hardcode thresholds; read from here** |
| **Patients** | Master patient (keyed to Unite PIN), WhatsApp consent, language, test flag | merge into `contacts` |
| **Medication Reference** | Drug class keyed on **Unite local code** (not name) | `ref_medication_classes`. **Unknown codes FAIL CLOSED** (no sequence fires) |
| **Visits** | Unite daily feed landing table: vitals parsed to numbers, diagnosis codes/text, procedures, investigations, plan, observation notes | `visits` (+ computed rule columns) |
| **Prescriptions** | Medication sequence engine: class, duration, dosage, start/end, probiotics, day-3 check, outcome scores, sequence status | `prescription_sequences` |
| **Follow-Up Queue** | Work queue: rules fired, category, priority, due date, assignee, call status, outcome, doctor alert | portal object + tasks |
| **Feedback & Outcomes** | Scores, symptoms, side effects, doctor/coordinator notified | `clinical_feedback` |
| **Message Templates** | Template register with clinical approval, Sanoflow template ID | `wa_templates` + approval fields |
| **Message Log** | Every clinical send, **Idempotency Key**, raw reply text, parsed score | `messages` + `clinical_message_log` |
| **Test Plan** | Boundary test cases (synthetic records only) | → **unit test fixtures** for the rules engine |

**Clinical rules that must become tested code (from field descriptions):**
1. **BP arrives as a single string ("92/61")** and must be parsed into systolic/diastolic at ingest, or every vitals rule silently fails.
2. **Department Effective:** Unite reports department at *patient* level. Force **under-14 at visit → Paediatrics**. Then apply doctor-name routing lists (currently empty). All triggers read this, never the raw department.
3. **Age at Visit**, not today's age (the infant fever rule is temp ≥ 38.0 AND age < 2).
4. **Rule sets:**
   - PAED-01..09: seizure deliberately excluded.
   - GP-01..06: GP-05 medication risk via Has Antibiotic / Has Steroid; GP-02 red-flag reads negation-scrubbed notes.
   - GYN-01..09: imaging/structural findings don't trigger alone; Pap only when Pap Result = Positive.
5. **Negation scrubbing** of free-text notes at ingest. Bleeding category reads **coded** diagnosis fields only, never narrative.
6. **Blank numerics ≠ 0.** Guard every numeric test; empty multiline = empty string (`LEN(TRIM())>0`).
7. **Follow-Up Due Date:**
   - Graduated by category, using WORKDAY (clinic week + holidays still to confirm).
   - TODO: parse "review in X days" from Plan of Treatment.
8. **Dedupe Key / Idempotency Key:** no duplicate queue items or sends when Unite re-syncs.
9. **Antibiotic sequence:**
   - Is Antibiotic / Is Steroid fail closed.
   - Day-3 check offset is awaiting clinical confirmation (start+2 vs start+3).
   - Probiotic start = end + 1, but **never send if Sequence Status = HALTED – clinical**.
   - Probiotic duration default 10 days is awaiting sign-off.
10. **Feedback red flag:** score ≤ threshold (5, awaiting sign-off) **OR any side-effect keyword** (even with a high score) → dual notification to treating doctor and care coordinator.
11. **Phase gate:** the follow-up queue starts with internal nurse/call-centre tasks only; **no patient-facing messages until validation sign-off**.

---

## 4. Older bases (requirements source)

- **Clinical Follow-Up & Care Automation** (`appVsJVw5jjj5YiMp`): one `Follow-Up Queue` table (patient, vitals as text, diagnosis, procedures, meds, plan, auto trigger formulas, assignment, call status, escalation, doctor response). Superseded by the Acute base. Import history only.
- **Patient Treatment & Follow-Up System** (`appZbwlQvkuaUsF2l`):
  - **Tables:** Patients, Prescriptions (antibiotic → probiotic dates), **Laboratory & Diagnostic Test** (order lifecycle, abnormal, result shared, turnaround/verification delay, message trigger), WhatsApp Automation Log, Feedback & Outcomes, **CPT Master** (lab/radiology codes, test category, patient message group, *Doctor Verified* governance flag), **Doctors** (specialty, branch), **Patient Visits** (5-star feedback, low-rating alert, prefilled feedback link).
  - **DRAFT tables:** Post-Visit Follow-Up (D0/D1/D3/D7), No-Show Recovery, Patient Retention Alerts, Symptom Triage Log, Payment Collection (D0/3/7/14/21), Insurance Verification (5-min SLA), Conversation Analytics (daily KPIs).
  - → These DRAFT designs are a good **Phase 2 backlog** for the portal. Labs + CPT Master + visit feedback are candidates for MVP if the client still wants them.

---

## 5. Proposed new-schema mapping (summary)

| New table / module | Sources |
|---|---|
| `contacts` (patients) | Unite.Unite, Acute.Patients, PTF.Patients |
| `visits`, `visit_diagnoses`, `visit_items`, `prescriptions` | Unite.Medical Records Data, Acute.Visits / Prescriptions |
| `ref_diagnoses`, `ref_medications`, `ref_items`, `ref_cpt`, `ref_medication_classes` | Unite.Diagnosis / Medication / Items, PTF.CPT Master, Acute.Medication Reference |
| `clinical_settings` | Acute.Settings |
| `clinical_followups` (portal: Follow-Up Queue) | Acute.Follow-Up Queue (+ old CFU queue history) |
| `prescription_sequences`, `clinical_feedback` | Acute.Prescriptions / Feedback & Outcomes |
| `recall_programmes`, `recall_sends` (chronic, birthday, screenings, dormant) | Unite flags + Campaigns.Chronic Recall / Birthday Messages |
| `appointment_reminders`, `messages` | Campaigns.Appointment Messages, Acute.Message Log |
| `wa_templates` (+ clinical approval) | Acute.Message Templates |
| `lab_orders` (Phase 2) | PTF.Laboratory & Diagnostic Test |
| Interfaces → portal screens | Chronic Recall call list, Follow-Up Queue, Data Quality Exceptions view, weekly recall charts |

---

## 6. Corrections found in Phase 0 (8 Oct 2026, live schema pull)

Verified against the live field configurations (`airtable-raw/*.schema.json`). The sections above stay as the original audit; where they disagree with the live base, the live base wins.

1. **Chronic recall threshold is 30 days, not 90.** The `Chronic Recall Eligible` formula tests `Time Elapsed (Days) >= 30`; only its *description* says "90+ days". Together with the 85-day feedback note this is a three-way open question (OQ-01).
2. **Negation scrubbing is not implemented.** The `TRIGGER GP` / `Trigger Category` descriptions say Observation Notes is "negation-scrubbed at ingest by the Make sync"; the MRD Sync blueprint simply concatenates Complaints + HPI + Doctor Notes + Nurse Notes (OQ-31).
3. **Medication Reference is empty (0 rows).** Drug class is derived in Make by substring on the Unite Medication table's `MEDICINE TYPE` / `All Medicine Types`, not by local code (OQ-13).
4. **Doctor routing lists in `Department Effective` are empty**, so only the under-14 override is active (OQ-08).
5. `Follow-Up Due Date` = WORKDAY(+1) for Paediatric High-Concern / Vitals / Bleeding / Infection-Labs, WORKDAY(+2) otherwise, Mon–Fri assumption, no holidays (OQ-07).
6. The chronic template SWITCH has a **default 13170** for unmapped groups (OQ-24); mental-health groups are removed by regex before that.
7. All 20 Test Plan rows are "Not tested"; 4 Settings rows are BLOCKING and 20 "Awaiting sign-off".
8. The Unite base has **two native Airtable automations** (record created → update record; record enters view "Chronic" → Google Sheets row) that the Make audit did not cover (OQ-41). The Campaigns and Acute bases have none.
9. Record counts: patients 10,652 · MRD visits 11,656 · Diagnosis 4,107 (30 Top-30) · Medication 13,534 · Items 1,981 · Appointment Messages 8,102 · Chronic Recall Messages 56 · Acute Visits 1,815 · Website 84.
10. Interfaces exist only on the Campaigns base (Patient Messaging Overview, Today's Actions, Doctor & Department Performance, Birthday Campaign Tracking, Chronic Recall Performance v2). They are inventoried in `airtable-raw/appkOnjPr1SMD83CP.schema.json`.

Field-level mapping: `data-model-mapping.md`. Rules: `clinical-rules.md`. Questions: `open-questions.md`.
