# Data model mapping — Airtable → Pulse (Phase 0)

Every table and every field of the five Al Das bases, mapped to its new home. Keyed by **field ID** (names change, IDs do not; the importer in `scripts/import-airtable.ts` maps by ID). Rule notes from field descriptions are preserved verbatim or near-verbatim in the *Rule / transform* column; the full descriptions and formulas are in `airtable-raw/*.schema.json`.

**Target vocabulary**

| Target | Meaning |
|---|---|
| `table.column` | Stored column (type in brackets where it changes). Tables without a draft migration yet are the docs/02 §3 core tables (`contacts`, `appointments`, `messages`, `wa_templates`, …) created in Phases 1–6. |
| `computed:view` / `computed:sql` / `computed:ts` | Not stored at import; recomputed as a SQL view / generated column / `lib/clinical` TypeScript. |
| `ref:external_refs` | Stored as an `external_refs` row (source, entity, external_id → local id). |
| `drop` | Not imported. Reason given. System fields (`createdTime`, `lastModifiedTime`) are always dropped; Postgres `created_at`/`updated_at` take over. |
| `backlog(P2)` | Requirements source for a Phase 2 feature; not built in the MVP. |

Draft DDL for the new clinical/recall tables is in `supabase/drafts/`. Core-table columns that are **new** relative to docs/02 §3 are marked ⊕ and listed in §7.

---

## 1. Unite base (`app7QJ2pvhADHQeBP`) — patient master

### 1.1 `Unite` (patients) — `tbl9856qJP9S7OEqB` → `contacts` (+ `recall_sends`, `external_refs`)

Matching rule on import: Unite PIN → E.164 phone → name + DOB; ambiguous → `sync_review` queue (importer spec rule 6).

| Field | ID | Type | Target | Rule / transform |
|---|---|---|---|---|
| Patient Name | fldcF6Tlh1q8SYNsI | text | `contacts.first_name`, `contacts.last_name` | Split on first space (first word = first name, remainder = last name). Keep full string in `contacts.custom.unite_full_name` for exact matching. |
| Patient Pin | fldGW2uKUvJ8Go98Q | text | `contacts.external_id` + `ref:external_refs(source='unite', entity='patient')` | **Primary join key to Unite.** Unique per org when present. |
| Sanoflow Contact Id | fldm649QE0vG2RxkG | text | `ref:external_refs(source='sanoflow', entity='contact')` | Used by the Sanoflow CSV importer to merge, then dropped from the record. |
| Phone | flddF5X0a7DtDJRNf | phone | `contacts.phone_e164` | Unite format `971-5xxxxxxx` → `+9715xxxxxxx` via libphonenumber (default region AE). Invalid → NULL + reconciliation report. |
| number | fldOW9sCfJ8k5Yp3g | formula | `drop` | Digits after the dash; superseded by E.164 normalisation. |
| Email | fldikPNTGpc52GqOW | email | `contacts.email` | Lower-case, trim. |
| Nationality -t | fldWCINbQSFZUrBBd | text | `contacts.nationality` | Primary source (free text as Unite sends it). |
| Nationality -t copy | fldb5otM9QGYPGcfY | select | `drop` | Duplicate of the text field; use it only to backfill when the text is blank. |
| Gender | fldXgsBUYTP2xvUv1 | select F/M/U | `contacts.gender` | Map F→`female`, M→`male`, U→`unknown`. |
| DOB | fld1Zt1g7IGjk2mOX | date | `contacts.dob` | Date only; no timezone shift. |
| DOB (DD-MM) | fldPsGjpw4wXtEgsi | formula | `computed:view` (`v_birthday_today`) | `to_char(dob,'DD-MM') = to_char(current_date at Asia/Dubai,'DD-MM')`. Decide 29 Feb handling (OQ-18). |
| Birth Month | fldqI3DlerhG3rsOG | formula | `computed:sql` | `extract(month from dob)`. |
| Address | fldluzXiKHaK4RfaW | multiline | `contacts.custom.address` | Free text. |
| First Visit Date | fldZHFmhmfL6INxWR | date | `computed:view` | `min(visits.visit_date)` per contact. Imported value kept in `contacts.custom.unite_first_visit_date` for reconciliation only. |
| Last Visit Date | fldwTnnvCipJeVvco | date | `computed:view` (`v_contact_visit_stats.last_visit_date`) | `max(visits.visit_date)`. Drives chronic recall eligibility. Imported value kept as `contacts.custom.unite_last_visit_date` for reconciliation. |
| Dr. Name | fld0rZhF2bjTxyiNS | text | `computed:view` | Doctor of the latest visit (`visits.doctor_name`). Raw value → `contacts.custom.unite_doctor_name`. |
| Dr. Name copy | fldgBy5vqiCQacYs5 | select | `drop` | Duplicate; the choice list is a useful seed for `specialists` (staff names, see §7). |
| Clinic | fldsA7v4aGIVzv0S8 | select (3 branches) | `contacts.custom.home_location_id` → `locations.id` | Map the 3 branch names to `locations` rows (external_id = DHA licence). |
| Department | fldHk1eGk61Hqr3yB | text | `contacts.custom.unite_department` | **Patient-level** department from Unite. Never used directly by clinical rules (see clinical-rules R-07). |
| Department copy | fldFH9a3OL0fGEqNu | select | `drop` | Duplicate of the text field. Choice list seeds `departments`. |
| Follow Up Visit | fldgSGQs00acVQccE | text | `contacts.custom.follow_up_visit_legacy` | Semantics unknown (OQ-27). Kept raw. |
| Annual Checkup Reminder Date | fldWgrSZwlTSw5VWF | formula | `computed:view` | `last_visit_date + 330 days` → `recall_programmes` "annual_checkup" eligibility (`min_days_since_visit = 330`). |
| 330 Days | fldP7oMHDfxHVE7Sk | formula | `computed:view` | "today is exactly 330 days after last visit" → replaced by a window test `days_since >= 330 and no send this cycle` so a missed day is not lost. |
| Sano Id | fldKENME489G7LCbC | select Yes/No/NF | `drop` | Derivable: exists `external_refs` for sanoflow. |
| Phone Number After Dash | fld3C0YR4HD6y6ins | formula | `drop` | Same as `number`. |
| First Name | fldKCzOUiobmu5rCG | formula | `contacts.first_name` | Same split as Patient Name. |
| Last Name | fldDAfHKAj7F5I6KR | formula | `contacts.last_name` | Last word of name. |
| Age | fldlbRJ3Gd7uorljW | formula | `computed:sql` | `date_part('year', age(current_date, dob))`. Age *at visit* is a separate computation (R-06). |
| Birthday Message | fldRoTvJFjvyGiPIK | select Sent/Pending | `recall_sends` (programme `birthday`) | "Sent" → one historical `recall_sends` row (`sent_at` unknown → from Birthday Messages log where available). Live flag never reset → see OQ-17. |
| Birthday Offer | fldL02KcYhX8DUbpY | select Not Redeemed/Redeemed | `recall_sends.outcome = 'offer_redeemed'` on the birthday row | Fed by the legacy "Birthday Offer Update" webhook → becomes a flow trigger. |
| Annual Checkup Reminder | fldrEBcMdlyc2wD1Q | select Pending/Sent/NA | `recall_sends` (programme `annual_checkup`) | Sent → row; NA → `recall_sends.status='excluded'` (reason `legacy_na`); Pending → nothing. |
| Pap Smear Reminder | fldnjiYH4flVeGtJ9 | select | `recall_sends` (programme `pap_smear`) | As above. |
| Annual Dental Checkup | fldPTE2UPWTwh9E6l | select | `recall_sends` (programme `dental`) | As above. |
| Skin Cancer Screening & Mole Check | fldOmR7MIOAPc6Vac | select | `recall_sends` (programme `skin_check`) | As above. |
| Colonoscopy Screening | fldCO5R7Dm4KnI2O9 | select | `recall_sends` (programme `colonoscopy`) | As above. |
| Pre-Menopause Assessment | fldE9tH7TLFk52XKa | select | `recall_sends` (programme `pre_menopause`) | As above. |
| Menopause Assessment | fldUPXnKkW8PvMntH | select | `recall_sends` (programme `menopause`) | As above. |
| Dormant Reactivation Message | fld6pcu9FExk8aDyA | select | `recall_sends` (programme `dormant`) | As above. |
| Medical Records Data | flda3KM4KzJ9ANR7E | link → MRD | `visits.contact_id` (inverse FK) | Resolved in importer pass 2. |
| Diagnosis (from Medical Records Data) | fldGq2Fqkkhy6Poly | lookup | `computed:view` | Via `visit_diagnoses`. |
| Count (Medical Records Data) | fldwXLQuKnBOQQelP | count | `computed:view` | `count(visits)`. |
| Chronic Diagnosis | fld9gw5nJNzgywljY | link → Diagnosis | `contact_chronic_conditions(contact_id, ref_diagnosis_id)` ⊕ | Patient-level chronic diagnosis list (set by the Unite sync, not by visits). Drives recall eligibility. |
| Top 30 (from Chronic Diagnosis) | flddyNe5c5reWAMyL | lookup | `computed:view` | `ref_diagnoses.top30`. |
| Mapped condition group (from Chronic Diagnosis) | fldCLyNOOBpbLAkGp | lookup | `computed:view` | `ref_diagnoses.condition_group_id → ref_condition_groups`. |
| Typical visit CPT (established) (from Chronic Diagnosis) | fld5RICCcp4rBLBzL | lookup | `computed:view` | From `ref_diagnoses`. |
| Monitoring procedures/other (CPT) (from Chronic Diagnosis) | fldOBH1g2DMG5Paus | lookup | `computed:view` | From `ref_diagnoses`. |
| Monitoring labs (CPT) (from Chronic Diagnosis) | fldj3txZ3jVDBTbdv | lookup | `computed:view` | From `ref_diagnoses`. |
| Regular medication (examples) (from Chronic Diagnosis) | fldClpADJHgFPe80u | lookup | `computed:view` | From `ref_diagnoses`. |
| Follow-up interval (for chronic monitoring) (from Chronic Diagnosis) | fldSHT652Dabbt0Ic | lookup | `computed:view` | From `ref_condition_groups.follow_up_interval_days`. |
| SHORT DESCRIPTION (…) (from Chronic Diagnosis) | fld0W92DbyfAqK1x4 | lookup | `computed:view` | From `ref_diagnoses.short_description`. |
| Last Modified By | fldHHGs0WC77TBEwm | lastModifiedTime | `drop` | System. |
| Visit Date (from Medical Records Data) | fldZSg1gJ0DQeeSfJ | lookup | `computed:view` | Via `visits`. |
| Dosage Days (from Medical Records Data) | fldWmLauQFB1OzOaI | lookup | `computed:view` | Via `prescriptions`. |
| 60 days > | fldXbiS53VgVfJaq3 | select True/False | `drop` | Manually maintained flag superseded by `days_since_last_visit`. |
| Medication (from Medical Records Data) | fldsKUWwiNd017yAq | lookup | `computed:view` | Via `prescriptions`. |
| Name (from Medication) (from Medical Records Data) | fld1zUkP31AzkAdy1 | lookup | `computed:view` | Via `prescriptions → ref_medications`. |
| Medication | fldZgI4a9JcG7Bi1L | link → Medication | `contact_regular_medications(contact_id, ref_medication_id)` ⊕ | Patient-level medication list (chronic/regular meds). |
| Trade Name (from Medication) | fld0zpzfXji5Ug1Pn | lookup | `computed:view` | From `ref_medications`. |
| Medicine Name | fldWEUhXYYrN0Pstt | multiline | `contacts.custom.medicine_name_legacy` | Free text, unstructured. Not used by rules. |
| Chronic (from Medical Records Data) | fld1rcfyHtRqU4smN | lookup | `computed:view` | Via `visit_diagnoses → ref_diagnoses.chronic`. |
| nmdr-25 | flddCd5RFHVjD4uwb | checkbox | `contacts.custom.nmdr_25` | Meaning unknown (OQ-27). Kept raw. |
| Insurance Plan | fldsXPzDxNdHqwET8 | select Mednet/AXA | `contacts.custom.insurance_plan` | Phase 2 `insurance_policies` candidate. |
| Dosage Days (from Medical Records Data) 2 | fldKuHeI2ELyYI5P1 | lookup | `drop` | Duplicate lookup. |
| Time Elapsed (Days) | fld9DJRSuMhP0uyv2 | formula | `computed:view` (`v_contact_visit_stats.days_since_last_visit`) | `current_date - last_visit_date`. |
| Created | fldfZP0baTGepB1CH | createdTime | `drop` | System. Original Airtable created time kept in `external_refs.meta.airtable_created_at`. |
| Created 2 | fld1qzi3GmVYwAT4F | createdTime | `drop` | System. |
| Chronic Recall Sent On | fldGJULCGakWZOt5S | date | `recall_sends.sent_at` (programme `chronic_90d`) | "Set by Make … when the chronic follow-up WhatsApp template has been sent. Blank = eligible. Prevents the daily scenario from re-firing on the same patient." → eligibility view excludes contacts with an open `recall_sends` row for the current cycle. |
| Chronic Recall Condition | flduLqrsCl6CvaHec | text | `recall_sends.segment_key` | "The mapped condition group the chronic recall message was sent for. Written at send time so the log and the patient record agree." |
| Chronic Recall Groups | fldTnPcF0Y96Oe5so | formula | `computed:view` (`v_chronic_recall_eligibility.condition_groups`) | Live formula strips `Depression (major)` and `Anxiety disorders` (mental-health groups are never messaged) → `ref_condition_groups.messageable = false`. |
| Chronic Recall Primary Condition | fldB3w0oECaHSvdvO | formula | `computed:view` (`.primary_condition_group`) | First messageable group. Ordering rule to confirm (OQ-15). |
| Chronic Recall Eligible | fldfaqFDZuQQlVsEH | formula | `computed:view` (`v_chronic_recall_eligibility.eligible`) | Description says 90+ days; **live formula is `Time Elapsed >= 30`**, phone non-blank, primary condition non-blank, Sent On blank. Threshold comes from `clinical_settings.chronic_recall_min_days` (OQ-01). |
| Chronic Recall Template ID | fld2bvMSsTi0mpDo3 | formula | `recall_programme_templates` rows | SWITCH per condition group → Sanoflow template id (13159 Hypertension, 13164 Diabetes, 13163 Hyperlipidemia, 13169 Hypothyroidism, 13168 CKD, 13162 Asthma, 13165 COPD, 13161 RA, 13167 AF, 13166 Epilepsy, default 13170). Stored as `legacy_sanoflow_template_id`; the new `wa_template_id` is filled when templates are recreated in Phase 4. |
| Primary Diagnosis (from Medical Records Data) | fldQtGSC8RwtOy1pV | lookup | `computed:view` | Via `visits.primary_diagnosis_code`. |
| Chronic Status | fld0NR4XBFjQG6D4j | select Yes | `drop` | Derivable: exists chronic condition. |

### 1.2 `Medical Records Data` (visits) — `tblllKPKIY9qvMoEU` → `visits`, `visit_diagnoses`, `visit_items`, `prescriptions`

Vitals arrive as strings and are parsed at ingest (R-01, R-02). Blank → NULL, never 0. Record id → `visits.external_id` (and `external_refs source='airtable'`).

| Field | ID | Type | Target | Rule / transform |
|---|---|---|---|---|
| Patient Name | fldtMJzbQovI9IliR | text | `drop` | Denormalised; join through `contact_id`. Used only as a fallback match key. |
| Unite | fldtxNjAanspw8h40 | link → Unite | `visits.contact_id` | Pass 2 link resolution. Missing link → reconciliation report (today the Make sync skips and retries these forever). |
| Last Visit Date (from Unite) | fldsWMY4lxXq5pLlm | lookup | `drop` | Circular lookup. |
| Patient Pin (from Unite) | fldFyoQfT4QF90Ue5 | lookup | `drop` | Available via contact. |
| Visit Date | fldKuI5eXoDJIiOcu | date | `visits.visit_date` | Date in Asia/Dubai; stored as `date`. |
| Height | fldJajCqvONmaX3XL | text | `visits.height_cm (numeric)` | Strip non-numeric; blank → NULL; raw kept in `visits.vitals_raw.height`. |
| Weight Measured | fldzdjzBPCdvG9U8U | text | `visits.weight_kg (numeric)` | Same. |
| Body Temperature | fldQWA9jjupL6EF3L | text | `visits.temp_c (numeric(4,1))` | Same (R-02). |
| Pulse | fldOVaKPQc3VUwJnh | text | `visits.pulse (int)` | Same. |
| BP Systolic | fldQEoJfTLKODHoq7 | text | `visits.bp_systolic (int)` | Unite sends `"92/61"` in this field → take part before `/` (R-01). |
| BP Diastolic | fldz0AtfcKuYy52FV | text | `visits.bp_diastolic (int)` | Same string → part after `/`. If only one field is populated, parse both values from it. |
| O2 % BldC Oximetry | fldFzXAhtt2fcRTDy | text | `visits.spo2 (int)` | Numeric parse. |
| Desc | fld5eftp6BVHSyPQd | multiline | `visits.description` | Free text. |
| Diagnosis | fldsrglawqYEoNqZu | link → Diagnosis | `visit_diagnoses(visit_id, ref_diagnosis_id)` | Pass 2. |
| Description (from Diagnosis) | fld90bi0NddIgW5fO | lookup | `computed:view` + `visits.primary_diagnosis_text` | The Make sync joins these with `; ` into Acute "Primary Diagnosis Text"; the rules engine reads coded text from `visit_diagnoses`. |
| Medication | fldIBSKJNAyz1kKlo | link → Medication | `prescriptions(visit_id, position, ref_medication_id)` | One row per linked medication, `position` = link order (1-based). |
| Name (from Medication) | flddh8qycN8eMqr0z | lookup | `computed:view` | From `ref_medications.trade_name`. |
| Dosage Days | fldw8Oyu3hhgAS3gV | text (comma-joined) | `prescriptions.duration_days (int)` | Split on `,` by position. Mismatched length → NULL + reconciliation. |
| Total Quantity (from Medication) | fld2m2sHEXFI3hCvl | text (comma-joined) | `prescriptions.total_quantity (numeric)` | Same split. |
| Roa Description (from Medication) | fld0m9i56euiz70Wd | text (comma-joined) | `prescriptions.dosage_instruction` | Same split; instructions containing commas break the legacy split (see MRD Sync summary). |
| Items | fld5GjbpREf5EvHRS | link → Items | `visit_items(visit_id, ref_item_id, position)` | Pass 2. `investigation_count` = count of items. |
| Description (from Items) | fldE7j7ikeCoY79Q3 | lookup | `computed:view` | From `ref_items.description`. |
| Complaints | fldZsPHI9BBzWWgap | multiline | `visits.complaints` | Part of Observation Notes composite (R-03). |
| Nurse Notes | fldX8Chw8INeRhuTD | text | `visits.nurse_notes` | Part of composite. |
| Doctor Notes | fld5ONgPlFlyJFZYy | text | `visits.doctor_notes` | Part of composite. |
| Therapy Notes | fldx5AdhYb49W946I | multiline | `visits.therapy_notes` | Not read by rules. |
| Procedure Notes | fldVWIrd7336dmS6x | multiline | `visits.procedure_notes` | = Acute "Procedures" (GP-04, GYN-07, GYN-08, Post-Procedure). |
| Observations/Physical Examination | fldpNQHsUjrA9XG8a | multiline | `visits.physical_exam_notes` | Not in the legacy composite; decide whether to include (OQ-28). |
| History Of Present Illness | fldJQiC2fplhNXa1N | multiline | `visits.hpi` | Part of composite. |
| Review Of Systems | fldUGZGwjklowwHJI | text | `visits.review_of_systems` | Not read by rules. |
| Plan of Treatment | fldhDyDyi1V5soDiO | multiline | `visits.plan_of_treatment` | PAED-09, GP-06, GYN-09; future "review in X days" parse (R-10). |
| Created | fldezCsEahKg8AnGL | createdTime | `drop` | System. |
| Chronic (from Diagnosis) | fldGDbAITA479dzHZ | lookup | `computed:view` | From `ref_diagnoses.chronic`. |
| Top 30 | fld1qsBahGnH8MKjs | lookup | `computed:view` | From `ref_diagnoses.top30`. |
| Doctor Name | fldZiy0HG9KGApOtc | text | `visits.doctor_name` + `visits.specialist_id` (resolved by exact name) | Doctor routing lists match on this exact string (R-07). |
| Primary Diagnosis | fldSIH4uHnviEYYel | text | `visits.primary_diagnosis_code` | ICD code string as Unite sends it. |
| Primary Diagnosis Link | fldDJcDJYLqffQ5A0 | link → Diagnosis | `visit_diagnoses.is_primary = true` | Pass 2. |
| Acute Sync On | fldTVFyiKlZAhzUe6 | date | `drop` | Make idempotency marker ("Blank = not yet synced. Do not edit manually."). Native idempotency = `visit_rule_evaluations.dedupe_key` + `external_refs`. Imported into `visits.legacy_acute_synced_on` only for the parallel-run comparison, then dropped. |

### 1.3 `Diagnosis` — `tblZqf4Zcw5Kweadh` → `ref_diagnoses` (+ `ref_condition_groups`)

| Field | ID | Type | Target | Rule / transform |
|---|---|---|---|---|
| Code | fldld9DKnsoLK9ADK | text | `ref_diagnoses.code` | ICD-10. Unique per org. |
| SHORT DESCRIPTION (VALID ICD-10 FY2026) | fldlgGXBFovQBgr7N | text | `ref_diagnoses.short_description` | |
| LONG DESCRIPTION (VALID ICD-10 FY2026) | fldXgTWsfTbPrlreE | multiline | `ref_diagnoses.long_description` | |
| Medical Records Data | fldhZEmogfSr6ImNV | link | inverse of `visit_diagnoses` | Not imported from this side. |
| Follow-up interval (for chronic monitoring) | fldSqRWz914hDYRBf | select ("Every 3 months") | `ref_condition_groups.follow_up_interval_days = 90` | All Top-30 codes carry "Every 3 months". Stored on the group, not the code. |
| Regular medication (examples) | fldfhJrKlgXaxHuQO | select | `ref_condition_groups.regular_medication_examples` | Informational. |
| Monitoring labs (CPT) | fldiGELdzlLp7i46d | select | `ref_condition_groups.monitoring_labs_cpt` | Informational. |
| Monitoring procedures/other (CPT) | fldkUbUTXumjsRkFm | select | `ref_condition_groups.monitoring_procedures_cpt` | Informational. |
| Typical visit CPT (established) | fldBQJcawPXqJc6it | select | `ref_condition_groups.typical_visit_cpt` | Informational. |
| Mapped condition group | fldyz11Dj5wK2y2S8 | select (12 groups) | `ref_diagnoses.condition_group_id → ref_condition_groups` | 10 messageable groups + `Depression (major)`, `Anxiety disorders` (`messageable=false`). |
| Unite | fldrYIl9ThLNImcZZ | link | inverse of `contact_chronic_conditions` | Not imported from this side. |
| Top 30 | fldFVPiTP5g4AGaV2 | checkbox | `ref_diagnoses.top30` | 30 rows true. |
| Chronic | fldIGBzWtu2QFP0Yk | checkbox | `ref_diagnoses.chronic` | |
| Unite 2 | fldBrKtpGsjwZz6Qw | text | `drop` | Scratch column. |
| new | fldcjL0XTK3ruAiuj | checkbox | `drop` | Maintenance flag. |
| Updated | fldZ1GJURbssClWC6 | checkbox | `drop` | Maintenance flag. |
| NF | fldgC3rVdSM5ehgtQ | checkbox | `ref_diagnoses.not_found_in_unite` | "NF" presumed "not found" in Unite's code list (OQ-27). |
| Medical Records Data 2 | fld3Jg5CLuPVCP6Wd | link | inverse of `visit_diagnoses.is_primary` | Not imported from this side. |

### 1.4 `Items` — `tblTJtk6aIMbwpoA2` → `ref_items`

| Field | ID | Type | Target | Rule / transform |
|---|---|---|---|---|
| Code | fld0i0BQItTWZpTm5 | text | `ref_items.code` | CPT / Unite item code. Unique per org. |
| Description | fldB4i14uDiaFt0Qv | multiline | `ref_items.description` | |
| Item Type | fldDUW6cM6saCg5m8 | select (19 variants) | `ref_items.item_type` | Normalise case variants (`Consumables`/`CONSUMABLES`, `Drugs`/`DRUGS`, `Other services`/`OTHER SERVICES`/`Other Services`, `Vaccine`/`VACCINE`) to one upper-snake enum; drop the header artefact `ItemType`. |
| Medical Records Data | fld8rbMC3zSkDqC8J | link | inverse of `visit_items` | Not imported from this side. |

### 1.5 `Medication` — `tblLM2BXjA680GQws` → `ref_medications`

| Field | ID | Type | Target | Rule / transform |
|---|---|---|---|---|
| DDC Code | fld7kgxlA3c0kjFdW | text | `ref_medications.ddc_code` | Unite local code. Unique per org. Join key for `ref_medication_classes`. |
| Trade Name | fldvBHlyQEFGX1UFS | text | `ref_medications.trade_name` | |
| Medical Records Data | fldpryRGaMe7cCqkd | link | inverse of `prescriptions` | Not imported from this side. |
| Status | fldDwPzpHS7bHGZbj | text | `ref_medications.status` | |
| SCIENTIFIC_CODE | fld6erxHG8rlNl7Zr | text | `ref_medications.scientific_code` | |
| SCIENTIFIC_NAME | fldIea5PEr6Tk50tY | text | `ref_medications.scientific_name` | |
| INGREDIENT_STRENGTH | fldsXKIf7k6HF3jhW | text | `ref_medications.strength` | |
| DOSAGE_FORM_PACKAGE | fld7ovnGh11wewXqw | text | `ref_medications.dosage_form` | |
| ROUTE_OF_ADMIN | flduJNhd0tBaFqDoT | text | `ref_medications.route` | |
| PACKAGE_PRICE | fldQPwna6WcQkIsrb | text | `ref_medications.package_price (numeric)` | Parse; blank → NULL. |
| GRANULAR_UNIT | fldGFRp4X68CfAO6k | text | `ref_medications.granular_unit` | |
| REGISTERED_OWNER | fldlWj6a725a6l54H | select | `ref_medications.registered_owner` | Drop the header artefact value `REGISTERED_OWNER`. |
| UPDATED_DATE | fldGvn9X6b6sNY9Xi | date | `ref_medications.source_updated_on` | |
| SOURCE | fldkhVVFyNnSz5T4n | select | `ref_medications.source` | Drop the header artefact value `SOURCE`. |
| IS_EBP | fldQQsGZMJDEmcIkL | select true/false | `ref_medications.is_ebp (bool)` | Drop header artefact `IS_EBP`. |
| Unite | fldqajLnh3yZU4hf8 | link | inverse of `contact_regular_medications` | Not imported from this side. |
| Updated | fldxCZs4yk0jdXKtM | checkbox | `drop` | Maintenance flag. |
| MEDICINE TYPE | fldOr4Wf4rSrjTDwV | select (29 categories) | `ref_medications.medicine_type` | Text category. The legacy MRD sync derived drug class from this by substring (`antibiotic` → Antibiotic, `corticosteroid` → Steroid, `probiotic`, `vitamin` → Supplement). Kept as **advisory input** for the one-off `ref_medication_classes` backfill; never read by the live sequence engine (R-05). |
| All Medicine Types | fld15ltyTEfiugYam | select (combos, e.g. "Corticosteroid + Antibiotic") | `ref_medications.all_medicine_types text[]` | Split on ` + `. Same advisory role. |
| ICD Codes | fldma2rcVXZDIDsuY | text | `ref_medications.icd_codes` | Free text. |

---

## 2. Campaigns – Message Log (`appkOnjPr1SMD83CP`)

### 2.1 `Appointment Messages` — `tblhoSfiSjO4zh9cf` → `appointment_reminders` + `messages` (+ `appointments`)

One row per reminder sent by Make. History import creates an `appointments` row (source `unite`, from the Unite appointment id) when none exists, then an `appointment_reminders` row with `idx = 1` and a `messages` row (`direction='out'`, `kind='template'`, status from the log).

| Field | ID | Type | Target | Rule / transform |
|---|---|---|---|---|
| Patient Name | fldXNoDvRSfmxHT3e | text | `drop` | Join via `appointments.contact_id` (matched by Patient Pin → phone). |
| Status | fldlE1a7BlurxGn1c | select Appointment/Birthday | split: `Appointment` → `appointment_reminders`; `Birthday` → `recall_sends` (programme `birthday`, legacy rows) | Early birthday sends were logged here before the Birthday Messages table existed. |
| Appointment Status | fldEjNPjzAlgKyae9 | select AAC/ACF/APH/CNR/CVI/YTC/NSW | `appointments.status` via `unite_appointment_status_map` ⊕ | Unite status codes; meanings to confirm (OQ-23). Raw code kept in `appointments.external_status`. |
| Clinic ID | fldMpGtsHnKw3DP5z | text (DHA licence) | `appointments.location_id` via `locations.external_id` | DHA-F-6456618 Golden Mile, DHA-F-2116734 Meadows, DHA-F-0000419 Palm Jumeirah. |
| Clinic | fldqMvqY7Ezx6U8Wi | select | `drop` | Derivable from Clinic ID. |
| Appointment Start Time | fld4B0oauTX8Q2qfN | dateTime | `appointments.starts_at (timestamptz)` | Unite string → Asia/Dubai → UTC. |
| Appointment End Time | fldZzUkNgSivq82JM | dateTime | `appointments.ends_at` | Same. |
| Doctor Name | fldluFMx5NiNs8NuC | text | `appointments.specialist_id` (by exact name) + `appointments.custom.unite_doctor_name` | |
| Doctor ID | fldNHDnfMQ3bD9vA1 | text | `specialists.external_id` | Unite doctor id. |
| Phone | fldmxRuElZh9zTWSc | phone | `contacts.phone_e164` (match only) | Not stored on the reminder. |
| Nationality | fldVKZTdSimmoaCEW | text | `drop` | Already on contact. |
| Created By | fldJHqmrkU4gHdrAr | text | `appointments.custom.unite_created_by` | Unite user who booked. |
| Appointment ID | fldjRghFRS8xkpkWa | text | `appointments.external_id` + `appointment_reminders.unite_appointment_id` | Dedupe key of the 6PM scenario. |
| Patient Pin | fldkmbCGn5ovZIxHF | text | `contacts.external_id` (match) | |
| Remarks | fldkI33eF320eoe0F | multiline | `appointments.notes` | |
| Message Sent On | fld5m4VQXx6JQYAIk | date | `appointment_reminders.sent_at`, `messages.at` | Date only in the log; time unknown → noon Asia/Dubai. |
| Birthday This Week | fldMJWq5zg82ZIBUR | formula | `drop` | Misnamed (reads appointment start); dashboard helper. |
| Birthday This Month | fldqPmWC1ypnA71tf | formula | `drop` | Same. |
| Message Sent? | fldj3SRkmpVjTp9ev | formula | `computed:sql` | `sent_at is not null`. |
| Upcoming Appointment? | fldWSWXkv4hyVjwBB | formula | `computed:view` | `starts_at between now() and now()+7d`. |
| Age from DOB | flde1nmmJyhDYpFqm | formula | `drop` | Reads the appointment time, not DOB; broken. |

### 2.2 `Birthday Messages` — `tblHTlF6LXMK5p4mU` → `recall_sends` (programme `birthday`)

| Field | ID | Type | Target | Rule / transform |
|---|---|---|---|---|
| Patient Name | fldXVNfbTvnrC3mQf | text | `drop` | Join via contact. |
| Unite Patient ID | fldUYm1BW2qck0zTm | text | `recall_sends.contact_id` via `contacts.external_id` | |
| Sanoflow Patient ID | fld4AGplhBuTMcFtE | text | `recall_sends.contact_id` via `external_refs(sanoflow)` (fallback) | |
| Message Sent On | fldJA8wk04TfEVCAm | date (D/M/YYYY) | `recall_sends.sent_at` | Legacy rows were written as `DD/MM/YYYY` strings into a date field; parse day-first. `cycle_key = year`. |
| Phone | fld6zgRMRFHz8jAO9 | phone | match only | |
| DOB | fldYCemm5zEn6qB1z | text (DD-MM) | `drop` | On contact. |
| First Name | fldIJFyFtrksbVe5C | text | `drop` | On contact. |
| Last Name | fld4NF7BsDK8HlmVy | text | `drop` | On contact. |
| Age | fld6Rlp4uzQLuJf3m | number | `recall_sends.segment_key` | Age + gender at send → band key (`m_20_29`, `f_18_35`, …) so the template used can be reconstructed. |

### 2.3 `Website` — `tblpWst9QqYNuKpwZ` → `website_entry_points` (new portal object)

84 rows mapping each website CTA to the WhatsApp number, prefilled message, routing target and priority. Becomes a real table registered in `portal_objects`, and the "Source / Keyword" conditions of the inbound routing flow are generated from it.

| Field | ID | Type | Target | Rule / transform |
|---|---|---|---|---|
| Section | fld44pzWF1WiW96XW | text | `website_entry_points.section` | e.g. "01. General Booking", "04. Doctor-Specific". |
| Source | fld87i81Uv5xEbCjh | text | `website_entry_points.source_key` | e.g. "DoctorProfile — <name>", "VaccinePrices — <vaccine>". Matches the first inbound message. |
| Number | fldeVUgOhIlFt0fPu | text | `website_entry_points.channel_id` via `channels.display_phone` | All 84 rows point at the same clinic number today. |
| Message | fldMXt1bD5N6aTNbR | multiline | `website_entry_points.prefill_message` | The wa.me prefilled text; the flow keyword condition is derived from it. |
| Route | fldySS9CEPFLYnWVP | text | `website_entry_points.route_to` → `teams.id` / `specialists.id` | "Nursing team", "Dental team", "<Doctor> schedule", "<Dept> receptionist", "General receptionist triage", "Home visit coordinator". |
| Priority | fld4cpDJ3LsB3Fq7k | text | `website_entry_points.priority_key` | e.g. "1 - Doctor Name", "14 - General Triage". |
| Dynamic | fld6BmbGE4MDFZENr | text Yes/No | `website_entry_points.is_dynamic (bool)` | Whether the message text carries a variable part (doctor, vaccine, price). |

### 2.4 `Chronic Recall Messages` — `tbldCbNEKeF5NrTCs` → `recall_sends` (programme `chronic_90d`) + `messages`

| Field | ID | Type | Target | Rule / transform |
|---|---|---|---|---|
| Patient Name | fldCn3wXKEXGRxmMp | text | `drop` | Join via contact. |
| Patient Pin | fldmqIT40DYyGAe8q | text | `recall_sends.contact_id` via `contacts.external_id` | |
| Unite Record ID | fldFD99GmktfyJ7Xa | text | `recall_sends.contact_id` via `external_refs(airtable, tbl9856qJP9S7OEqB)` (fallback) | "Airtable record ID in the Unite base patient table. Used to join replies/bookings back to the patient." |
| Phone | fldFulU3YySov9d4P | phone | match only + `recall_sends.sent_to_phone_e164` | Keep the number actually messaged (Test mode routes to internal numbers). |
| Condition | fldvLFVogNna9clyG | select (10 groups) | `recall_sends.segment_key` | "Mapped condition group the recall was sent for." |
| Template ID | fldzdrQ26RpvigSUE | text | `recall_sends.legacy_template_ref` | Sanoflow template id. Per-condition templates live since Aug 2026; placeholder 55 retired. |
| Last Visit Date | fld6a8W0nUzktk9o5 | date | `recall_sends.last_visit_date_at_send` | Snapshot at send time. |
| Days Since Last Visit | fldczA3OSrSQAEFE2 | number | `recall_sends.days_since_last_visit_at_send` | Snapshot. |
| Message Sent On | fld01KXt1biCwWS55 | dateTime (Asia/Dubai) | `recall_sends.sent_at` | → UTC. |
| Send Mode | fldO6ql2L51mNEmJt | select Test/Live | `recall_sends.send_mode` | "Test = routed to internal validation numbers during the sign-off week. Live = sent to the real patient." |
| Send Status | fldWUAkSRmbstj93Q | select Sent/Failed | `recall_sends.status` (`sent` / `failed`) | Delivery statuses later come from `messages.status`. |
| Patient Replied | fldY4zg5P4pTRFD90 | select Yes/No | `computed:sql` (`replied_at is not null`) | |
| Reply Date | fld1VuzlSX4IrKblI | date | `recall_sends.replied_at` | Set natively by the inbound-reply handler (replaces the Chronic Update webhook). |
| Appointment Booked | fldJMpPFmXguYJTp0 | select Yes/No | `computed:sql` (`booked_at is not null`) | |
| Booking Date | fldhv2BcULV9m5k97 | date | `recall_sends.booked_at` (+ `appointment_id` when known) | Set natively on appointment creation for that contact after the send. |
| Notes | fldoG6VR5IIm5I2b5 | multiline | `recall_sends.notes` | Legacy value "Sent to: <phone>" → dropped (PHI in free text); staff notes kept. |
| Days Since Message Sent | fldHUoJP5cOzsUl9A | formula | `computed:view` (`v_recall_call_list.days_waiting`) | "Calendar days elapsed since the recall message was sent. Blank once a reply is recorded." |
| Follow-Up Due | fld0Wh9UIUthSVq2A | formula | `computed:view` (`v_recall_call_list.call_now`) | "A live send with no reply after **3 working days** moves to the care coordinator's active call list… Setting Follow Up Status to 'Booked' clears this flag." Workdays via `clinic_calendar` (R-24). |
| Follow Up Status | fldqgbYSfHGYq8LVV | select Called/No Response/Booked | `recall_sends.follow_up_status` | "Called = phoned, no appointment yet (stays on the call list). No Response = could not reach (stays). Booked = appointment made — clears Follow-Up Due. Always fill in Booking Date when setting this to Booked." → enforce with a check constraint `follow_up_status='booked' ⇒ booked_at not null`. |
| Recall Overdue Flag | fldvyaQ3eeAOV768d | formula | `computed:view` (`v_recall_call_list.overdue`) | `days_since_last_visit_at_send > clinical_settings.chronic_recall_overdue_days (120)`. "Feedback cites an 85-day target while the dashboard subtitle says ~90 — confirm" (OQ-01). |
| Week Starting | fldgU2byPEvccm8lW | formula | `computed:view` (`v_recall_weekly.week_start`) | `date_trunc('week', sent_at at time zone 'Asia/Dubai')` (Monday). |
| Assigned for Follow-Up | fldeAsuTofDH8LkdO | text (deleted?) | `recall_sends.assigned_user_id` | Field appears in the Make module interface only; map if present. |

---

## 3. Acute Clinical Follow-Up Automation (`appH2jHpsNR1nqEQ2`)

### 3.1 `Settings` — `tbl69r1kelxG4g93L` → `clinical_settings`

"NEVER hardcode these thresholds in formulas - read them from here so sign-off does not require a rebuild." All 30 live rows are seeded in `supabase/drafts/0101_clinical_settings.sql`.

| Field | ID | Type | Target | Rule / transform |
|---|---|---|---|---|
| Parameter | fldpn14HNQN3BFEfc | text | `clinical_settings.label` + derived `key` (snake_case, stable) | Keys listed in the seed. |
| Category | fld7M5zm094N0rlcm | select | `clinical_settings.category` (enum) | paediatrics / gp_adults / gynaecology / medication_sequence / escalation / operational. |
| Proposed Value | fldg7eo4b6905Vouh | text | `clinical_settings.proposed_value` | Text as written; typed parse in `value_type`. |
| Approved Value | fld5xepAeK9pdB6mE | text | `clinical_settings.approved_value` | Empty everywhere today. |
| Sign-Off Status | fldezo13piyceP6Ex | select | `clinical_settings.sign_off_status` (enum) | blocking / awaiting / confirm_exclusion / approved. |
| Owner | fldD5bnejIIX8YMqO | select | `clinical_settings.owner` | Free text (staff). |
| Notes | fldOGCNJX09G2Rlms | multiline | `clinical_settings.notes` | Preserved verbatim in the seed. |
| Signed By | fldU8lQx3G30drRGi | text | `clinical_settings.signed_by` | |
| Signed Date | fld51DuMTqkow2Qic | date | `clinical_settings.signed_at` | |

### 3.2 `Patients` — `tblghX1mVYWgXvWbk` → `contacts`

"Mirrors the existing Unite-fed patient list; keep Patient ID aligned with Unite PIN."

| Field | ID | Type | Target | Rule / transform |
|---|---|---|---|---|
| Patient ID | fldHaQAC8l41cjJOP | text | `contacts.external_id` (match) | Unite PIN. |
| Full Name | fldMsD1pVAFKrY6Ud | text | match only | |
| Mobile Number | fldkdbQTj4yPG8jgk | phone | match only | |
| DOB | fldsO6hLu7C8XBnMD | date | match only | |
| Gender | fldNNrAAzH9GN927w | select Male/Female | `contacts.gender` (fill if blank) | |
| Consent for WhatsApp | fldOjPlY1tktSXZTE | checkbox | `contacts.clinical_messaging_consent` ⊕ | Distinct from marketing `promotions_opt_in`. |
| Language Preference | fldQCxICzmkXLlrRb | select EN/AR | `contacts.language` | |
| Is Test Record | fld5rbCcXG48MfDrO | checkbox | `contacts.is_test_record` ⊕ | Excluded from reports and from live sends. |
| Visits / Prescriptions / Follow-Up Queue / Feedback & Outcomes / Message Log | fldMVFn5CdjFOf4Rz, fldNHLDnBq1Nc0KV6, fldcmbGGvi0xeGSxP, fldr9GHiConWXYBy7, fldpKAbMduSJZsgYk | links | inverse FKs | Not imported from this side. |

### 3.3 `Medication Reference` — `tblIxa5xUOG3GRwmt` → `ref_medication_classes`

Empty today (0 rows). "Classify by CODE not name… Unknown codes must FAIL CLOSED - no sequence fires."

| Field | ID | Type | Target | Rule / transform |
|---|---|---|---|---|
| Local Code | fld8IyFkiQC3VrDpH | text | `ref_medication_classes.unite_local_code` | PK per org; FK-ish to `ref_medications.ddc_code`. |
| Medication Name | fldBmjJIDVEFm6gbW | text | `ref_medication_classes.medication_name` | |
| Medication Class | fldHUcvmoD8Sy8Yia | select | `ref_medication_classes.class` (enum) | antibiotic / steroid / probiotic / supplement / enzyme / other / unclassified. |
| Requires Probiotics Default | fldUVPyOsylLribKr | checkbox | `ref_medication_classes.requires_probiotics_default` | |
| Classified By | fldDSObi3AgyZAX3U | text | `ref_medication_classes.classified_by` | |
| Notes | fldSuHUA4YgNPovVI | multiline | `ref_medication_classes.notes` | |

### 3.4 `Visits` — `tblyOweSP3FfeY9q0` → `visits` + `visit_rule_evaluations`

These rows are **derived copies** of MRD rows (Visit ID = MRD record id). Import them only to reconcile the 1,815 already-evaluated visits against the new engine; stored columns come from the MRD mapping in §1.2, formula columns become `visit_rule_evaluations` written by `lib/clinical`.

| Field | ID | Type | Target | Rule / transform |
|---|---|---|---|---|
| Visit ID | fldRPRNAgGU7aaSQe | text | `visits.external_id` (= MRD Airtable rec id) | Join key to §1.2. |
| Visit Date | fldXlyyw4yhhwby2g | date | `visits.visit_date` | |
| Department | fldfDoqBTP05oHIhJ | select (5) | `visits.department_mapped` ⊕ (enum) | Derived by the sync from the patient-level Unite department (R-04). |
| Doctor | fld56HJ56HDz5ICqX | text | `visits.doctor_name` | |
| DOB | fld0Uc4dbKfTTV0Ep | date | `drop` | On contact; age at visit computed from `contacts.dob` (R-06). |
| Temperature (C) | fldW2drDyJO7x4Bhn | number(1) | `visits.temp_c` | |
| BP Systolic | fld4MabuolV2ia0hn | number | `visits.bp_systolic` | |
| BP Diastolic | fld0uMrH7Uu9lCxdv | number | `visits.bp_diastolic` | |
| O2 Saturation (%) | fldfGYvo9oW5pFvMY | number | `visits.spo2` | |
| Pulse | fldzTCJ2RDTiyZV6p | number | `visits.pulse` | |
| Primary Diagnosis Code | fldx908qYxc9kT74t | text | `visits.primary_diagnosis_code` | |
| Primary Diagnosis Text | flduu0Nv3L4JCMitD | multiline | `visits.primary_diagnosis_text` | `; `-joined coded descriptions. Rules read this as **coded** text. |
| Secondary Diagnosis Codes | fldXAkFSh3q9dlkEC | multiline | `visits.secondary_diagnosis_codes` | Never populated by the sync today. |
| Procedures | fldyu2FVfEijTqWUR | multiline | `visits.procedure_notes` | |
| Investigations Ordered | fldWNmWnvGBPYwZ6P | multiline | `computed:view` from `visit_items` | |
| Investigation Count | fldni7004CwZHjnl1 | number | `visits.investigation_count` (generated from `visit_items`) | |
| Plan of Treatment | fldutfsNvr26p8pLy | multiline | `visits.plan_of_treatment` | |
| Observation Notes | fld5WrzkmTaFitlca | multiline | `visits.observation_notes_scrubbed` ⊕ (`computed:ts`, stored) | Composite of complaints + HPI + doctor notes + nurse notes, **negation-scrubbed** (R-03). Legacy value is the unscrubbed concat. |
| Pap Result | fldgZRyGr1tVmNbYk | select | `visits.pap_result` (enum) | Constant "Not available in Unite" today (OQ-12). |
| Symptomatic | fld2al0GgsV6g4Rdi | checkbox | `visits.symptomatic` | Never set by the sync; GYN-06 depends on it (OQ-29). |
| Is Test Record | fldAjZRrsEvuCtcVR | checkbox | `visits.is_test_record` | |
| Patient / Prescriptions / Follow-Up Queue / Feedback & Outcomes / Message Log | fldpEvjq9SHOLAD7h, fldxA8sNrnt5zR3mO, fldYG3pmyveLOzY1W, fldnt5hhiAxVk3LE6, fldYb3hRSOgWUDSZK | links | FKs | Patient link is never set by the sync today. |
| Age at Visit | fldTQMLFKlaMkjFm0 | formula | `visit_rule_evaluations.age_at_visit` (`computed:ts`, R-06) | "Age in years AT THE VISIT, not today." |
| Vitals Complete | fldtFRG74pQRh4x2R | formula | `visit_rule_evaluations.vitals_complete` (R-08) | "Missing vitals must never be read as normal vitals." Feeds the Data Quality Exceptions view. |
| TRIGGER Paediatrics | fld7Ic3LQAyPsDiPx | formula | `visit_rule_evaluations.rules_fired[]` (PAED-*) | R-PAED-01…09. |
| TRIGGER GP | fld3PcFh9hWXjwGmV | formula | `visit_rule_evaluations.rules_fired[]` (GP-*) | R-GP-01…06. |
| TRIGGER Gynaecology | fldRFpvIZUklwMXRh | formula | `visit_rule_evaluations.rules_fired[]` (GYN-*) | R-GYN-01…09. |
| Trigger Rules Fired | fld2MgtyrFuHEgHIz | formula | `visit_rule_evaluations.rules_fired text[]` | "The clinical lead must be able to see WHY a follow-up was raised." |
| Trigger Category | fld0Dk59ehaDtIv8b | formula | `visit_rule_evaluations.trigger_category` (R-09) | Priority cascade: Paediatric High-Concern → Bleeding (coded fields only) → Vitals → Infection-Labs → Post-Procedure → Clinical Check. |
| Follow-Up Due Date | fldC1mCKPhY2FAKnt | formula | `visit_rule_evaluations.follow_up_due_date` (R-10) | WORKDAY(+1) for Paediatric High-Concern/Vitals/Bleeding/Infection-Labs, else +2. Clinic calendar from `clinic_calendar` ⊕. |
| Dedupe Key | fldOwccCmsPNoCZs0 | formula | `visit_rule_evaluations.dedupe_key` (unique) | `<visit external_id>-<trigger_category>`. |
| Has Antibiotic | fldnkbivqcfkreotL | rollup | `computed:view` (`exists prescriptions.class='antibiotic'`) | "Fails closed: unclassified drugs return 0." |
| Has Steroid | fldx7MZfenSV5s4ak | rollup | `computed:view` | Same. |
| Department Effective | fldWrg409vbzA9Sp7 | formula | `visit_rule_evaluations.department_effective` (R-07) | Under-14 → Paediatrics; then doctor lists from `clinical_settings.doctor_routing_*` (empty today); else mapped department. |

### 3.5 `Prescriptions` — `tblQra08AflxuXxQq` → `prescriptions` + `prescription_sequences`

"Unite payload maps as: localcode → Medication Code, name → Medication Name, dosagedays → Duration (Days), totalquantity → Total Quantity, roadescription → Dosage Instruction."

| Field | ID | Type | Target | Rule / transform |
|---|---|---|---|---|
| Prescription ID | fldPLUnLoIBIUfcfT | text (`<mrd rec id>-<n>`) | `prescriptions.external_key` | Join to §1.2 rows by visit + position. |
| Medication Code | fldNp6WqXyDjupsue | text | `prescriptions.medication_code` + `prescriptions.ref_medication_id` | Unite DDC/local code. |
| Medication Name | fldTp7F5vU2efpLY8 | text | `prescriptions.medication_name` | Snapshot of trade name. |
| Medication Class | fld7K9SVDvqjaU30A | select | `prescriptions.class` (enum) | From `ref_medication_classes` by code; `unclassified` when unknown (R-05). |
| Duration (Days) | fldfujiLktvFEPNE1 | number | `prescriptions.duration_days` | |
| Dosage Instruction | fldbHnnCairp1oMA2 | text | `prescriptions.dosage_instruction` | |
| Total Quantity | fldfYDjKPKJn9vPPU | number | `prescriptions.total_quantity` | |
| Start Date | fldM5leoAtTzhVg6R | date | `prescriptions.start_date` | = visit date today. |
| Requires Probiotics | fldwNVLgPMpESN3Hz | checkbox | `prescription_sequences.requires_probiotics` | Default from `ref_medication_classes.requires_probiotics_default`, "clinically overridable per prescription". |
| Probiotic Duration (Days) | fld2u0WCiQkYkHbHf | number | `prescription_sequences.probiotic_duration_days` | Default `clinical_settings.probiotic_default_days` (10, unsigned). |
| Sequence Status | fldWHAoxbXpISk6FS | select (9) | `prescription_sequences.status` (enum) | not_started / day3_sent / awaiting_day3_reply / awaiting_clarification / awaiting_probiotic / probiotic_sent / outcome_sent / complete / halted_clinical. |
| Day 3 Score | fldwrqZebkNcCcvD3 | number | `prescription_sequences.day3_score` | Also a `clinical_feedback` row (stage day3). |
| Outcome Score | fldsB3CbqdZspzYLK | number | `prescription_sequences.outcome_score` | Also `clinical_feedback` (stage after_probiotics). |
| Outcome Symptoms | fldSHEYRBRqBcxKOo | multiline | `clinical_feedback.symptoms_reported` | |
| Is Test Record | fldYGZHkRjicwBPz6 | checkbox | `prescriptions.is_test_record` | |
| Patient / Visit / Feedback & Outcomes / Message Log | fldYe4toZohBlfMrg, fldYBAQSnbjTmxsq0, fldhdiOUnlWiDQAZe, fldk38Yd0frRKurBw | links | FKs | |
| End Date | fldAORkWOJfCAnZX6 | formula | `prescription_sequences.antibiotic_end_date` (`computed:ts`, R-13) | "Minus 1 day so that a 7-day course ending is day 7, not day 8." |
| Is Antibiotic | fldsbcdjkPjqeVbA4 | formula | `computed:sql` (`class = 'antibiotic'`) | "FAILS CLOSED. Only returns 1 on an explicit Antibiotic classification." |
| Day 3 Check Date | fldZBLoQlcX31d8Dh | formula | `prescription_sequences.day3_check_date` (R-14) | `start + clinical_settings.day3_offset_days` (2 today; "+2 vs +3 awaiting clinical confirmation"). |
| Probiotic Start Date | fldg7TTVRxBd5uAZ9 | formula | `prescription_sequences.probiotic_start_date` (R-15) | "SCHEDULED date only. The automation must NOT send PROBIOTIC_START on this date alone - it must first check that Sequence Status is not HALTED - clinical." |
| Probiotic End Date | fldAw8sZbgLjrsSFI | formula | `prescription_sequences.probiotic_end_date` (R-15) | Drives TREATMENT_OUTCOME. |
| Is Steroid | fldFN1LavSfihpF8U | formula | `computed:sql` (`class = 'steroid'`) | Fails closed. |

### 3.6 `Follow-Up Queue` — `tblgX6wIqWefpwrBg` → `clinical_followups` (portal object `clinical_followups`)

"PHASE 2 launches with internal nurse and call-centre tasks ONLY - no patient-facing messages until validation is signed off."

| Field | ID | Type | Target | Rule / transform |
|---|---|---|---|---|
| Follow-Up Ref | fldXCi8apfSF1wGLH | text | `clinical_followups.ref` | Human-readable; `external_refs` for the Airtable id. |
| Trigger Rules Fired | fldDjGGhM3ZxN2ada | multiline | `clinical_followups.rule_evaluation_id → visit_rule_evaluations.rules_fired` | Not duplicated. |
| Trigger Category | fldNOnLLHzKuEapJX | select (6) | `clinical_followups.trigger_category` (enum) | |
| Priority | fldX94COawJmYp0kb | select High/Medium | `clinical_followups.priority` (enum high/medium) | Default rule: Paediatric High-Concern & Bleeding → high (OQ-30 confirm). |
| Follow-Up Due Date | fldOVqtqfwRc7lOxx | date | `clinical_followups.due_date` | |
| Assigned To | fldckx3vmXjysOFzf | select Nurse/Call Centre/Reception | `clinical_followups.assigned_team_id → teams` | Seed three teams. |
| Call Status | fldoS3vnm2UmJI21S | select | `clinical_followups.call_status` (enum pending/completed/escalated/no_answer) | |
| Outcome | fldbMjWZfeQfBYvJZ | select Improving/Same/Worse | `clinical_followups.outcome` (enum) | |
| Doctor Alert Required | fldKoC0xMVSjhKZ1g | checkbox | `clinical_followups.doctor_alert_required` | |
| Doctor Notified | fldwfriyDgawIslbQ | checkbox | `clinical_followups.doctor_notified_at (timestamptz)` | Bool → timestamp (import: true → row created_at). |
| Follow-Up Notes | fldGJirPqdjyTo3e0 | multiline | `clinical_followups.notes` | |
| Message Sent | fldgegORWmkIaSI4c | checkbox | `computed:sql` (`exists clinical_message_log for this followup`) | |
| Is Test Record | fldJDp2lrt0n3YY1z | checkbox | `clinical_followups.is_test_record` | |
| Visit / Patient | fldZouRo0kxRzIB80, fldcR5cyDiuO4LDlO | links | `clinical_followups.visit_id`, `.contact_id` | |

### 3.7 `Feedback & Outcomes` — `tbluNXftGwkP9rJDV` → `clinical_feedback`

"The ONLY place treatment outcome data is captured. Red flag fires on score at or below threshold OR any side-effect keyword. Dual notification is mandatory."

| Field | ID | Type | Target | Rule / transform |
|---|---|---|---|---|
| Feedback Ref | fldRthKkY016ceRta | text | `clinical_feedback.ref` | |
| Feedback Stage | fldeR3gUWc5H3cRDh | select (4) | `clinical_feedback.stage` (enum day3_antibiotics/after_antibiotics/after_probiotics/post_procedure) | |
| Score (1-10) | fld0yu7tTxBdtds2e | number | `clinical_feedback.score` (check 1..10) | |
| Symptoms Reported | fldvGMaOXbeZKCZ13 | multiline | `clinical_feedback.symptoms_reported` | |
| Side Effects Flagged | fldwRxxa94xztwfpr | checkbox | `clinical_feedback.side_effects_flagged` | Set by keyword scan (`clinical_settings.side_effect_keywords`, BLOCKING). |
| Doctor Notified | fld0Hyt8i9QjKFPuB | checkbox | `clinical_feedback.doctor_notified_at` | |
| Care Coordinator Notified | flduYSDkd6Uc8VzPf | checkbox | `clinical_feedback.coordinator_notified_at` | |
| Notified At | fldq8lgUIHlHSc75b | dateTime | merged into the two timestamps above | |
| Is Test Record | fld1HTj2zNEKN9jjP | checkbox | `clinical_feedback.is_test_record` | |
| Patient / Related Prescription / Related Visit | fldFaPDTjSAkSL3Zl, fldmRIAqu1fLwd44F, fld5DKPuB27ioYfn9 | links | FKs | |
| Needs Doctor Review | fldK1rGS5kkG5IL2G | formula | `clinical_feedback.needs_doctor_review` (`computed:ts`, stored, R-18) | `score <= clinical_settings.red_flag_score_threshold OR side_effects_flagged`. "A reply of 8 but I have a rash must escalate." |

### 3.8 `Message Templates` — `tblnCsSkyw4Tu9Ak7` → `wa_templates` (+ ⊕ clinical approval columns)

| Field | ID | Type | Target | Rule / transform |
|---|---|---|---|---|
| Template ID | fldgpCwM1uG424pKz | text (RX_START, ABX_DAY3, …) | `wa_templates.internal_key` ⊕ | Stable key used by `clinical_message_log.template_key` and `recall_programme_templates`. |
| Purpose | fldtnpNhYCdu8Sdbr | text | `wa_templates.purpose` ⊕ | |
| Trigger | fldVafqyE1Co6QOqR | text | `wa_templates.trigger_note` ⊕ | Informational; the real trigger is in the sequence engine. |
| Expects Reply | fldCipfcyRejaEmu2 | select | `wa_templates.expects_reply` ⊕ (enum none/yes/score_1_10/score_and_symptoms/optional) | Drives reply parsing. |
| Approved Copy | fldyfsVBI5CP4L8GM | multiline | `wa_templates.components` (body) once recreated in Phase 4; until then `wa_templates.draft_copy` ⊕ | Call scripts (FU_*) are not WhatsApp templates: they go to `clinical_call_scripts` ⊕ instead. |
| Clinical Approval | fld1lj7DaZSAaJRME | select | `wa_templates.clinical_approval` ⊕ (enum approved/awaiting/to_be_drafted) | Send guard: clinical templates require `approved`. |
| Phase | fldruCMCoDqzTEtgH | select 1/2/3 | `wa_templates.clinical_phase` ⊕ | |
| Sanoflow Template ID | fldxEiS8klZNiMZWC | text | `ref:external_refs(source='sanoflow', entity='template')` | |
| Notes | fldHKolWfL6RVnBHQ | multiline | `wa_templates.clinical_notes` ⊕ | e.g. LAB_READY "VERIFIED-ONLY GATE IS MANDATORY". |

### 3.9 `Message Log` — `tblXNWAh1hdaueUbs` → `clinical_message_log` (+ `messages`)

"Idempotency Key blocks duplicate sends when Unite re-syncs. Raw reply text is stored verbatim regardless of whether a score could be parsed."

| Field | ID | Type | Target | Rule / transform |
|---|---|---|---|---|
| Log Ref | fld0vFJUNeSuuwaRG | text | `clinical_message_log.ref` | |
| Template ID | fldU0k0N5b3RiqfOl | text | `clinical_message_log.template_key` | |
| Trigger Category | fld10J2UlPe3KH1gn | text | `clinical_message_log.trigger_category` | |
| Idempotency Key | fldYJRG3KcI8YyQbo | text | `clinical_message_log.idempotency_key` (unique) | `<prescription or visit external id>:<template_key>`. |
| Scheduled At | fldZ1PwpI2xNXRm4I | dateTime | `clinical_message_log.scheduled_at` | Also a `scheduled_jobs` row when pending. |
| Sent At | fldBN7AFKvB77rHaV | dateTime | `clinical_message_log.sent_at` (+ `messages.id`) | |
| Delivered | fldigImLLUJ11a6ce | checkbox | `computed:sql` from `messages.status` | |
| Replied | fld8DkJbXI3agZomH | checkbox | `computed:sql` (`replied_at is not null`) | |
| Reply Text | fld5hfgCqvHX5R8Fo | multiline | `clinical_message_log.reply_text` | Verbatim, never parsed-over. |
| Reply Parsed Score | fldQgZnNj0k86Wckg | number | `clinical_message_log.reply_parsed_score` | NULL when unparseable (R-16). |
| Is Test Record | fldIICnc9N59HHUoH | checkbox | `clinical_message_log.is_test_record` | |
| Patient / Visit / Prescription | flduUsU2TEoOlSKEK, fldxhgwdwSbGJPR6d, fldrdxterwqjkh020 | links | FKs | |

### 3.10 `Test Plan` — `tbl2xmInmphVGkkFY` → `tests/fixtures/clinical/*.json` (Phase 6) and `clinical-rules.md` §5

| Field | ID | Type | Target | Rule / transform |
|---|---|---|---|---|
| Test Case | fldAzDsGpXcIrd6SS | text | fixture `name` | |
| Setup | fldIQqKAP6RSVGcZG | multiline | fixture `given` (hand-translated to a synthetic visit/prescription) | |
| Expected Result | fldWamBdcSPOXNvkA | multiline | fixture `expect` | |
| Phase | fldV4J096cg0xHF4v | select | fixture `tags` | |
| Result / Tested By / Tested Date / Notes | fldZSLd7yEAy4gFNI, fldBUqE98FBgg0lhp, flduV7jwj7VctxpwT, fldiBvXjWfHqFbLOw | mixed | `drop` (test runner records results) | All 20 are "Not tested" today. |

---

## 4. Clinical Follow-Up & Care Automation (`appVsJVw5jjj5YiMp`) — superseded prototype

### 4.1 `Follow-Up Queue` — `tblJvIh3Wf7z8Qn8k` → `clinical_followups` (history only, `source='legacy_cfu'`)

| Field | ID | Type | Target | Rule / transform |
|---|---|---|---|---|
| Patient ID | fld6OhLP42w2HIQSe | text | `clinical_followups.contact_id` via `contacts.external_id` | |
| Patient Name, Phone, DOB, Gender | fldtI12OUP7Ag4DGK, fldp5Gqkk1o4ZLf98, fld1Qy2QnqH1lg8iO, fldbjbf9UTdKr9Thc | mixed | match only | |
| Age | fldtregvNGHaJ750F | formula | `drop` | Age *today*; superseded by age at visit. |
| Doctor | fld4kay6bt0l2Jm0m | select (placeholder names) | `drop` | Prototype values ("Doctor 1", "Dr. Sharma"). |
| Department | fldm8K33wuLuBcJ7X | select | `clinical_followups.notes` (prefix) | Prototype choice list. |
| Visit Date | fldsCFssERLY68rxI | date | `clinical_followups.visit_id` (match by contact + date) else `notes` | |
| Temperature (°C), BP, Diagnosis (ICD), Procedures, Investigations Ordered, Medications Prescribed, Plan of Treatment | fldk9al97BKQHIchQ, fldggR8OPHySFrm5t, fldFqm1CLiBDCWDeM, fldXjR8LAzQKuEt6Z, fldNpNzdHpJXrqjDk, fldIUKdeBXRJGuMmN, fldyHBfD63N9Ph7Sh | text | `drop` | Already in `visits` from Unite. |
| Follow-Up Mentioned | fldudFf3Pwv9ExPDM | formula | `drop` | Early version of GP-06 (`FIND("follow")`). Documented in clinical-rules R-10 history. |
| Auto Follow-Up Trigger | fldAhGjL3xEYIIQXH | formula | `drop` | v1 of the trigger set (temp ≥39; paeds <2 & ≥38; "infection"; "procedure"; "culture"). Superseded. |
| Follow-Up Type | fld4tEf9E9vreKr5P | formula | `clinical_followups.trigger_category` | 3-value precursor of Trigger Category. |
| Follow-Up Due Date | fldhXWgslD9v3BSzK | formula | `clinical_followups.due_date` | Calendar days (+1 paeds, +2 other), not workdays. |
| Assigned To | fldnzYPCN4lf0C9Dj | select | `clinical_followups.assigned_team_id` | Named nurses → team Nurse. |
| Call Status | fldjPQXHBjuUJRLNq | select | `clinical_followups.call_status` | |
| Outcome | fldkPuFbyq2tntnUN | select (5) | `clinical_followups.outcome` | "Not Reached"/"Reached" → call_status no_answer/completed. |
| Doctor Alert Required | fldAH6K7B4jUIVRO1 | checkbox | `clinical_followups.doctor_alert_required` | |
| Follow-Up Notes | fldQ6rcJt7yGrvB2H | multiline | `clinical_followups.notes` | |
| Last Updated | fldiKRrQAn7rV4AvV | lastModifiedTime | `drop` | |
| Escalation Status | fldVSf9u8lD3O97vp | select | `clinical_followups.escalation_status` ⊕ (enum none/open/escalated/resolved) | Kept: useful state the Acute base lost. |
| Doctor Response Notes | fldfDWGbyIjyUKGy5 | multiline | `clinical_followups.doctor_response_notes` ⊕ | Kept. |

---

## 5. Patient Treatment & Follow-Up System (`appZbwlQvkuaUsF2l`) — requirements source

### 5.1 `Patients` — `tbl9856qJP9S7OEqB` (same IDs as Unite.Unite) → `contacts`
Shared field IDs (fldcF6Tlh1q8SYNsI … fldlbRJ3Gd7uorljW, fldZHFmhmfL6INxWR, fldwTnnvCipJeVvco, fld0rZhF2bjTxyiNS, fldsA7v4aGIVzv0S8, fldHk1eGk61Hqr3yB, fldKENME489G7LCbC) map exactly as in §1.1 and are **not re-imported** from this base (the Unite base wins). Base-specific fields:

| Field | ID | Type | Target | Rule / transform |
|---|---|---|---|---|
| Nationality | flddLEEOFH50BoW1Q | select | `drop` | Duplicate. |
| Language Preference | fldz2XAcE0Nj4Kph7 | select | `contacts.language` (fill if blank) | |
| Consent for Whatsapp | fldiFSSvUwYzX4DuK | checkbox | `contacts.clinical_messaging_consent` (OR with Acute) | |
| Prescriptions / Laboratory & Diagnostic Test / Whatsapp Automation Log / Feedback & Outcomes / Patient Visits | fldW7V46PfnlHNtds, fldkSD83G62610DtM, fldsqyyUFIPCJr8oz, fldyb4caLskfBvE2A, flduGpmcRd9U2lcl7 | links | inverse FKs | |

### 5.2 `Prescriptions` — `tblRNJcasTIz0vLhR` → `prescriptions` (history, `source='legacy_ptf'`)

| Field | ID | Type | Target | Rule / transform |
|---|---|---|---|---|
| Prescription ID | fldocMh0yomOPBDUf | text | `prescriptions.external_key` | |
| Patient | fldSNEMvtKxKi5UFO | link | `prescriptions.contact_id` | |
| Phone (from Patient), Dr. Name (from Patient) | fldk5ElaP63He8BFs, fldg843bo7jXOElwL | lookups | `drop` | |
| Prescription Date | fldn1CALuXkS6iPYo | date | `prescriptions.start_date` | |
| Medication Name | fldCHoABZoNlSc66w | text | `prescriptions.medication_name` | No code → `class` stays `unclassified` unless Medication Type says Antibiotic (history only, never drives a sequence). |
| Medication Type | fldwOw2vmR6QKpriS | select | `prescriptions.class` (antibiotic/supplement/enzyme/other) | |
| Dosage, Frequency | fldygMAMVayc6C66S, fld0SS6knzf0ofBrM | text | `prescriptions.dosage_instruction` (joined) | |
| Duration (Days) | fldQTu2pq7Uo5cJ4v | number(1) | `prescriptions.duration_days` | |
| Start Date | fld9Gu0v5MiCutpAn | date | `prescriptions.start_date` (overrides Prescription Date when set) | |
| End Date | fldAvMTOjzq0U8xaT | formula | `computed:ts` | Old formula added duration without the −1 day correction (documented in R-13). |
| Requires Probiotics? | fldlmtYSBoJboygdz | checkbox | `prescription_sequences.requires_probiotics` | |
| Probiotic Start Date | fldPeWMDDJudYzqfY | formula | `computed:ts` | |
| Probiotic End Date | fldF7tE4L79YBBk1V | formula (`1`) | `drop` | Stub. |
| Status | fldbia9AfcKOE0B8z | select Active/Completed | `prescription_sequences.status` (active → not_started, completed → complete) | |
| Notes for Patient | fldi63hCyya30zCz8 | multiline | `prescriptions.notes_for_patient` ⊕ | |
| Feedback & Outcomes | fldtG18wRQshIQhM2 | link | FK | |
| Antibiotic Follow-Up Sent | fldUXwB8yEN6oFRbR | checkbox | `clinical_message_log` row (template_key `ABX_END_LEGACY`) | "Set by Make.com Antibiotic Follow-Up scenario after the day-after-end-of-course template is sent." |

### 5.3 `Laboratory & Diagnostic Test` — `tbl6LX9OJu8lBwSgf` → `backlog(P2)` `lab_orders`

Not built in the MVP; schema recorded for the Phase 2 `lab_orders` table. Field → proposed column: Test ID fldJAI2i7J8p9qabU → `lab_orders.external_id`; Patients fldvBE60GLT5yXrN3 → `contact_id`; Test Type fldJlDnLQTG7NkijC → `test_type`; Test Name fld6hUdtHQnx5dUL1 → `test_name`; Sample Date fldZljmNmDeZrpx4R → `sampled_on`; Result Ready Date fldub8K5v1er5RvMP → `result_ready_on`; Result Summary fldnNqTUoKGwbXG7C → `result_summary`; Doctor Interpretation fldcMgrz6Ajqx2ehO → `doctor_interpretation`; Abnormal fldvpCrKxRdgY3Mcm → `abnormal`; Requires Follow-Up fldqcRFBeICVvm8m0 → `requires_follow_up`; Follow-Up Date fldFTD5KKoTduI4Qo → `follow_up_on`; Result Shared fldai1GjcdKlNzfrm → `result_shared_at`; CPT Code fldAxe0dFNRX8YLwe → `ref_item_id`; Doctor fldIMWZ7ibEMHkfym → `specialist_id`; Order Status fldBY3VLoVUy40JK4 → `status` (enum of the 6 values); Date Report Verified fldD35kyUcsqM1yKz → `verified_on`; Notes fldvTbEUv2oIecfeS → `notes`; Messages Sent fldWwpfds6uYnopdL → `clinical_message_log` FK; Turnaround Time fldcavLGgkNKlEeup, Verification Delay fldP7jtorWdfPHqXm → `computed:sql`; Message Trigger fldxSQBojs4tMEysX → `computed:ts` (verified-only gate: LAB_READY only when status = Report Verified; LAB_PENDING when Test Ordered > 3 days — days from `clinical_settings`); lookups fldvoB270yfg9fwSe, fldOhIxZbY1Lg28di, fldzMWLsCN7Dwfu3Z → `computed:view`.

### 5.4 `Whatsapp Automation Log` — `tbl5wvAX6GidMm7n3` → `clinical_message_log` (history)
Message ID fldq33obO7P5my0vL → `ref`; Patients fldT1JTjdzrcILR5H → `contact_id`; Trigger Type fldIrMo7Wv8Xi6hmx → `template_key` (map the 8 values to keys); Message Template fldxZqZ0NiQ41TTHz → `template_key` fallback; Scheduled Date fldTFQU5ZZ82B1EhC → `scheduled_at`; Sent? fldKcsaeVetrSSDCB → `sent_at` (bool→ts); Delivered? fldTvov9TmwxOdAuK → `delivered_at`; Patient Replied? fldPrunK5pdpDIvLG → `replied_at`; Patient Response fldneSjjHkSMEBKRw → `reply_text`; Laboratory & Diagnostic Test fldDlH9LrP80LlaSU → `lab_order_id` (P2); Patient Visits fldcgD86OfFR25c2K → `visit_id`.

### 5.5 `Feedback & Outcomes` — `tbleAP5BLA6Juf8B1` → `clinical_feedback` (history)
Feedback ID fld6n4xoPkQb9ywO3 → `ref`; Patients fldAwEMZ2NXh5X2pv → `contact_id`; Related Prescription fldeycrfzKSQsqGdz → `prescription_id`; Feedback Stage fldxevmV7Q0wJKa7X → `stage` (During Treatment → day3_antibiotics, After Antibiotics, After Probiotics); How Do You Feel? fldTdafMk8XX6cWXW (rating 1–10) → `score`; Symptoms Improved? fldJmrHi2sP0foSH3 → `symptoms_improved` ⊕ (bool); Side Effects? fldTgwb7mtTODJwWD → `symptoms_reported` + `side_effects_flagged = len>0`; Needs Doctor Review? fld729Xo5RK0jfsJB → `needs_doctor_review`; Doctor Notified? fldISlSLzLM8HTLHZ (multiline) → `doctor_notified_at` (non-empty → created_at) + `notes`.

### 5.6 `CPT Master` — `tblopYbHPAbTi4QeX` → merged into `ref_items`
CPT Code fldjaLpahs9NgSFAF → `ref_items.code` (upsert on code); Description fldX4POEMd2VY8FKc → `description` (fill if blank); Item Type fldYCtqy5kYgQrwlr → `item_type` (same normalisation as §1.4); Test Category fldqsVvaiGRe59o9w → `ref_items.test_category` ⊕; Patient Message Group fldyLyowekQPhpFnr → `ref_items.patient_message_group` ⊕; Doctor Verified fldi4vFfiPdSU7ZxC → `ref_items.doctor_verified` ⊕ ("Must be checked by a doctor before this CPT code is used in live automations"); Laboratory & Diagnostic Test fld0BG0GE6XGXGNrE → inverse FK.

### 5.7 `Doctors` — `tblhoMqQ1jgiCGHGY` → `specialists`
Doctor Name fld0ghl5SVDzYlwU0 → `specialists.name` (match existing by exact name); Specialty fldkfam3qESHnrbTr → `specialists.department_id` (map specialty → department) + `specialists.title`; Branch fld4QdPKVRNqVlRKk → `specialist_locations`; links fldK7PfRnqB4lBIiB, fldn3MkLhFUTMn10p → inverse FKs.

### 5.8 `Patient Visits` — `tbldH45nIL5EQAjpy` → `backlog(P2)` `visit_feedback` (5-star)
Visit ID fldxdC4oFODCEejLD → `visits.external_id` (match) ; Visit Date fld7GVu2ybazYOv03, Appointment Time fldJaEb6QAir0sxmS → `appointments.starts_at` (match); Department fldxsnzxzwyHu0s2v → `departments` seed (15 names); Location fldjDbQcK5oU2IbNu → `locations`; Visit Status fldAeSKvv54kqEjkA → `appointments.status` (Pending/Completed/Cancelled/No Show); Feedback Status fld62vpgB5VCR8hDE → `visit_feedback.status`; Star Rating fldRksUIiqT14u49f → `visit_feedback.rating`; Feedback Comment fldbcDnJjDVZo7d9s → `visit_feedback.comment` ("only collected if rating ≤ 3"); Feedback Timestamp fldbOBEWZuN8entnV → `visit_feedback.submitted_at`; Patient fldXTGoEy5kkTw5Uu → `contact_id`; Doctor fldoDixgwNsN6ecI8 → `specialist_id`; Low Rating Alert Sent fld8ecrYgvB47rZXY → `visit_feedback.low_rating_alert_sent_at` (rule: rating ≤ 3 → alert Operations/Medical Director); Feedback Link fldcdhMDK702Xp2WC → `drop` (replaced by a WhatsApp Flow or interactive message); Messages Sent fldZMC1grAQpTrndG → `clinical_message_log` FK.

### 5.9 DRAFT tables → `drop` (requirements only; Phase 2 backlog)
All fields of the seven DRAFT tables are **not imported**. Their designs are carried into the Phase 2 backlog in `make-replacement-design.md` §9:

| Table | ID | Fields (all → drop) | Backlog feature |
|---|---|---|---|
| DRAFT - Post-Visit Follow-Up | tblFQn2YMbmoqa6HF | fldX6WXZAl2vw7NDA, fld88UckrSYq8DZgE, fldjosnkWepenrNsu, fldlSRASvTZ56KCqi, fldZ5PO7HXmLGFehP, fldEQtgrqgSjceiYh, fldjNMsHqUaLyYfo1, fldb8MQ4Q44b8JmjI, fldwwBcHpLAJb5WtK, fldvmIZ6lebRPZZHB, fldBnHl4MzHOLjV9L, fldS9F70mLwzYnYRN, fldVwZ3ggRCswIKkI, fldrTC2bFozodX4yW, fldB3MVR2EgqFRBEn, fldSQnPDkyvOIk9Of, fld89UL2IAdxzVmXG, fldZ8dLGzOw3whE3D, fldDySGq3mlDsnuXH, fldDeKSkfINlzU7TD, fld5eWAjUfs7TOuSV | Recall programme `post_visit` with D0/D1/D3/D7 steps (a 4-step `recall_programme_steps` child table). |
| DRAFT - No-Show Recovery | tblrQgE70HzqJYw2n | fldxbQ1pnbBiOFJH0, fldSictiG7y1XdhJ9, fldpeuNcsaVe59DC7, fldFsdfcfDQ6hfeRW, fld7wBqw7Y23Rr39t, fldvF3gsPFLoUlaTo, fldCey046R4viJ3MG, fldjsjlmiqVNdL0aa, fldLOZLBBEqPTuIOk, fldnPMgo2IjPNcjE3, fld6YV1XSA0d5AeSF, fld2kTP6vUB9SoSxa, fldTYQBLliKOq37H2, fld0HhQPDkspYhJMd, fldv3C3vXZcrjU33W, fldmllBvblUKWysd8 | Flow on `appointment.status_changed → no_show` + `recall_sends` programme `no_show`. `No-Show Count` = `computed:view`. |
| DRAFT - Patient Retention Alerts | tblF3lIUbACqMeEO5 | fldVtbw0sNzfeMF8I, fldDDCn5X2V6FjxD4, fldnkfLhpiXfllAJJ, fldjKOT9R8zCbCQ3z, fldCBsL3TXIUSLuNN, fldce6DN7RZVRLSf0, fld9leH2rWON2LFn8, fldyjniYKYWUgPMky, fldScNCpu3AT3boek, fldfEiRzYStgpP5Zc, fldeUMks6HFxFhR3x, fldL5t7fIJnM2DA8n, fldwfgcCyRf7x4DOD, fldjAAtNW62Xgq3a5, fld8qfRzkoYtQ8fEG, fldCxuMxKCLB3kYRa | Inbox AI tag `retention_risk` + enquiry pipeline "Retention" (enquiries table, no new table). |
| DRAFT - Symptom Triage Log | tblDW9nZ8CO7ay0nJ | fldCxreaTEYKJsMt1, fldz6URgbZIwIyKgh, fldFgL9UMbkK1kqiw, fldTNraBko6QtqK48, fldcqE6QVu4oMUb23, fldGIUhrMAxYVghpU, fldut61Tetc2gbfgI, fldrDcgajnVJh5CVZ, fldksvyetbstTOOZ3, fld5fdkWWCHQa5Tl4, fldK4bH3kmmWAyRtn, fld1XjRmoaMxEDb8e, fldRU4JdnWqfeQHzS, fld3hR5qMCphuAY0e, fldc2cMbpJaB3hpFa, fldnmTuQdCLzfgg6k, fldKCLNNCHa6OB7Ym, fldEeOJ95aWULtXBb | Clinic-specific routing flow (keyword → department/team); **no automated diagnosis**. Metrics from `conversations`. |
| DRAFT - Payment Collection | tblLFZxm2DLOQyX2H | fldA3OT72ZNkVJCXD, flduxWuByVaHCMzrT, fldv3crixioK0pPp2, fldKgYoWR9aAJjfQF, fldAbFIjYuWc4Y2L4, fldiXCsXXn1vznKkq, fldsteFpeP4SIokCy, fld1aijtOFzkkOwMn, fldWw3JcnNyfstthu, fldXxGB28vjrvk8rM, fldEp9XjtYeyccReH, fldvBTOReyJOqrW9r, flddmZnGNKYM6ie7O, fldILUTvkbekPGcdz, fldRrjwWjlfJHpYFO, fldlzNRFuzTmNncYa, fldQNWTY6VJZZwtDb | Phase 2 payment links + `payment_requests` with D0/3/7/14/21 steps. Needs Unite Finance (sync-once, guarded). |
| DRAFT - Insurance Verification | tblsGOqQIaB3JsMIQ | fldnBnYBmB3aMtZXg, flddPZXRaVkB9UDWE, fldx8ezWYjKSnycwK, fld3vv2o8C6UEgSJr, fld4m05kP0xjaZGtG, fldbvLvShyo42LDvC, fldMLntIWb3gEDMBw, fldcYFVHpVwvqQ84J, fldkptrM5yoqdUiXn, fldmF1xo1g8RSNERT, fldllpG1gldKRnhsE, fldhsotIL35UeYbty, fldvJKjoXkediigbr, fldnrjUypiuaxwjDE, fld6KDPcnKskuj9kt, fld33tSjMu1Ns8Pa1 | Enquiry pipeline "Insurance review" with a 5-minute SLA (enquiries + `enquiry_views`; card number must be encrypted if ever stored). |
| DRAFT - Conversation Analytics | tblUV2xClsjzRJ5qU | fldsD6rEX1eqv84mn, fld1H1BndobePLJu7, fldmF8SfL6Meww4P5, fldcRUta7KDXu3vW9, fld0gfCxEGVSBSrar, fldSmgH2PRJS30MEG, fldiDK0lJUJFbnHcO, fldazdPOgow01H55n, fld4czjcdEHAI6FbW, fldVnUVSSwONx754t, fldXGkI8GRKE12K5Z, fldns7cgQfADqg2t1, fldKvInJBf45IkN4B, fldyz3A1kkQDlBNSw, fldWDJRQ7PrsAz1K1, fldEh1Cg69yyikJXO, fldqCZyCnhlIArGUK, fldtHPM3NnOJIQ6th, fld9VkXlMCBrsrJYz, fld9GW3twoJPiZvu5 | Reports layer (`mv_daily_conversations`), not a table. Each column is a KPI definition for Phase 10. |

---

## 6. Formula → SQL / TS translation table

| Airtable formula (field) | New implementation |
|---|---|
| Age (fldlbRJ3Gd7uorljW) | `extract(year from age(current_date, dob))::int` |
| Age at Visit (fldTQMLFKlaMkjFm0) | `extract(year from age(visit_date, dob))::int` — TS `ageAtVisit(dob, visitDate)`; NULL when either is missing (R-06) |
| Time Elapsed (Days) (fld9DJRSuMhP0uyv2) | `(current_date at time zone 'Asia/Dubai')::date - last_visit_date` |
| 330 Days / Annual Checkup Reminder Date | `days_since_last_visit >= 330 and not exists(recall_sends … programme annual_checkup, cycle = last_visit_date)` |
| DOB (DD-MM) / Birth Month | `to_char(dob,'DD-MM')`, `extract(month from dob)` |
| Chronic Recall Groups (fldTnPcF0Y96Oe5so) | `array_agg(distinct g.key order by g.sort) filter (where g.messageable)` over `contact_chronic_conditions → ref_diagnoses → ref_condition_groups` |
| Chronic Recall Primary Condition | first element of the above (ordering per OQ-15) |
| Chronic Recall Eligible (fldfaqFDZuQQlVsEH) | `days_since_last_visit >= setting('chronic_recall_min_days') and phone_e164 is not null and primary_group is not null and not exists open recall_sends row and not stop_marketing and not is_test_record` (view `v_chronic_recall_eligibility`) |
| Chronic Recall Template ID | `recall_programme_templates(programme='chronic_90d', segment_key=<group>)`, default row `segment_key='*'` |
| Vitals Complete (fldtFRG74pQRh4x2R) | `temp_c is not null and bp_systolic is not null and spo2 is not null and pulse is not null` |
| Department Effective (fldWrg409vbzA9Sp7) | TS `departmentEffective(ageAtVisit, doctorName, departmentMapped, routingLists)` (R-07) |
| TRIGGER Paediatrics / GP / Gynaecology | TS rule functions, one per rule id (R-PAED/GP/GYN) |
| Trigger Category (fld0Dk59ehaDtIv8b) | TS `triggerCategory(...)` (R-09) |
| Follow-Up Due Date (fldC1mCKPhY2FAKnt) | TS `followUpDueDate(visitDate, category, calendar)` using `clinic_calendar` (R-10) |
| Dedupe Key (fldOwccCmsPNoCZs0) | `visit.external_id || '-' || trigger_category` (unique index) |
| Has Antibiotic / Has Steroid | `exists (select 1 from prescriptions p where p.visit_id = v.id and p.class = 'antibiotic')` |
| End Date (fldAORkWOJfCAnZX6) | `start_date + (duration_days - 1)` when `duration_days > 0` |
| Day 3 Check Date (fldZBLoQlcX31d8Dh) | `start_date + setting('day3_offset_days')` when class = antibiotic |
| Probiotic Start / End Date | `antibiotic_end_date + 1`; `probiotic_start_date + (probiotic_duration_days - 1)`; send gated on `status <> 'halted_clinical'` |
| Is Antibiotic / Is Steroid | `class = 'antibiotic'` / `class = 'steroid'` |
| Needs Doctor Review (fldK1rGS5kkG5IL2G) | `(score is not null and score <= setting('red_flag_score_threshold')) or side_effects_flagged` |
| Days Since Message Sent (fldHUoJP5cOzsUl9A) | `case when replied_at is null then current_date - sent_at::date end` |
| Follow-Up Due (fld0Wh9UIUthSVq2A) | `send_mode='live' and status='sent' and replied_at is null and follow_up_status is distinct from 'booked' and workdays_between(sent_at::date, current_date) >= setting('recall_followup_workdays')` |
| Recall Overdue Flag (fldvyaQ3eeAOV768d) | `days_since_last_visit_at_send > setting('chronic_recall_overdue_days')` |
| Week Starting (fldgU2byPEvccm8lW) | `date_trunc('week', sent_at at time zone 'Asia/Dubai')::date` |
| Message Sent? / Upcoming Appointment? | `sent_at is not null`; `starts_at between now() and now() + interval '7 days'` |
| Message Trigger (labs, fldxSQBojs4tMEysX) | TS state machine on `lab_orders.status` (Phase 2) |

## 7. New columns / tables this mapping adds to the docs/02 §3 core (⊕)

- `contacts`: `clinical_messaging_consent bool`, `is_test_record bool`, `nationality text` (docs/02 already lists nationality), `custom` keys documented above. Unique `(org_id, external_id)` where not null.
- `contact_chronic_conditions(org_id, contact_id, ref_diagnosis_id, source, noted_at)`, `contact_regular_medications(org_id, contact_id, ref_medication_id, source)`.
- `visits.department_mapped`, `visits.observation_notes_scrubbed`, `visits.vitals_raw jsonb`, `visits.legacy_acute_synced_on`.
- `appointments.external_status text`, `unite_appointment_status_map(code, status, label)`; `appointment_reminders.unite_appointment_id`, `.dedupe_key`; `reminder_exclusions`.
- `wa_templates`: `internal_key`, `purpose`, `trigger_note`, `expects_reply`, `draft_copy`, `clinical_approval`, `clinical_phase`, `clinical_notes`; `clinical_call_scripts(key, category, script, approval)`.
- `clinical_followups.escalation_status`, `.doctor_response_notes`; `clinical_feedback.symptoms_improved`.
- `ref_items.test_category`, `.patient_message_group`, `.doctor_verified`; `ref_medications.all_medicine_types text[]`.
- `clinic_calendar(org_id, location_id, weekday_mask, holidays date[])` for WORKDAY semantics.
- `website_entry_points` (portal object).
- `prescriptions.notes_for_patient`.

## 8. Import order (for `scripts/import-airtable.ts`)

1. References: `ref_condition_groups` (seed), Diagnosis → `ref_diagnoses`, Medication → `ref_medications`, Items + CPT Master → `ref_items`, Medication Reference → `ref_medication_classes`, Settings → `clinical_settings` (approved values only; proposed values are already seeded).
2. Staff/places: Doctors → `specialists`, branch names → `locations`, departments.
3. Patients: Unite.Unite → `contacts` (+ chronic conditions, regular meds, recall flags), then Acute.Patients / PTF.Patients fill-ins.
4. Visits: MRD → `visits`, `visit_diagnoses`, `visit_items`, `prescriptions`; Acute.Visits/Prescriptions used for reconciliation (`visit_rule_evaluations` are recomputed by the engine, then compared with the Airtable TRIGGER columns).
5. Logs: Appointment Messages → `appointments`/`appointment_reminders`/`messages`; Birthday + Chronic Recall Messages → `recall_sends`; Message Log / WhatsApp Automation Log → `clinical_message_log`; Follow-Up Queue (both) → `clinical_followups`; Feedback (both) → `clinical_feedback`.
6. Website → `website_entry_points`; Message Templates → `wa_templates` drafts + `clinical_call_scripts`.

Every row goes through `external_refs(source='airtable', entity='<baseId>.<tableId>', external_id=<recId>)`; re-runs update, never duplicate.

## 9. Deviations in the importer as built (Phase 9 follow-up)

The mapping above is the target design; `scripts/import/tables/clinical.ts` implements it with these deliberate differences:

- **PTF and CFU tables are not imported** (PTF Prescriptions / Feedback / WhatsApp log / Patient Visits, CFU Follow-Up Queue): prototype bases, confirmed mostly test data. The field maps in §4.1 and §5 stay as the reference if real history turns up.
- **Imported visits are `source='airtable'`** and `visits.external_id` holds the Airtable Medical Records record id. The clinical engine evaluates `source='unite'` visits only. A future Unite visit sync must adopt by contact + date (or map ids) before it runs.
- **No `visit_diagnoses` / `visit_items` / `prescription_sequences` / `visit_rule_evaluations`**: the junction tables are still drafts, sequences are not scheduled yet, and evaluations are recomputed by the engine. `primary_diagnosis_code` is kept as text.
- **Follow-ups** use `source='airtable_acute'` and the engine's dedupe key `<visit external_id>-<category>`; only rows still pending (and not test) are imported open, the rest are closed with `closed_reason='airtable_history'`.
- **Medication class** is looked up in `ref_medication_classes` by code, never read from Airtable; unknown → `unclassified`.
- **Message log** rows are terminal history; `scheduled` is never written. **Call scripts** import `FU_*` templates only and always as `awaiting` (Airtable approval is not imported).
- **Doctor branch** → `specialist_locations` is not imported (needs hours and locations configured in Settings).
