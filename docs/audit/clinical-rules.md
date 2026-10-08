# Clinical rules specification (Phase 0)

Source of truth for `lib/clinical/` (built in Phase 6). Every rule below is transcribed from the **live** Airtable formulas and field descriptions in the Acute Clinical Follow-Up Automation base (`appH2jHpsNR1nqEQ2`), the Unite base and the Campaigns base, as captured in `airtable-raw/*.schema.json` on 8 Oct 2026. Where the description and the formula disagree, both are shown and the difference is an open question (`OQ-nn` → `open-questions.md`).

**Implementation contract (from CLAUDE.md rule 15)**
- Pure TypeScript functions in `lib/clinical/`, one module per rule group, no I/O.
- Every threshold is read from `clinical_settings` (passed in as a `ClinicalSettings` object). Nothing numeric is hard-coded; the values written here are the *proposed* values seeded in `supabase/drafts/0101_clinical_settings.sql`.
- **Fail closed.** Unknown, blank or unparseable input never satisfies a condition. A rule that needs a setting whose `approved_value` is null does not fire unless the org has `allow_unsigned_defaults = true`, and even then nothing patient-facing is sent while `clinical_messaging_enabled = false` (R-26).
- Every rule has at least one test case in §5; the Test Plan rows (TP-01…TP-20) are the acceptance set.

Notation: `setting(key)` = approved value, else proposed value when unsigned defaults are allowed, else *absent* (rule does not fire). `txt(x)` = lower-cased string, blank → `""`. `num(x)` = number or `null`.

---

## 1. Ingest rules (run once per visit when it arrives from Unite)

### R-01 Blood-pressure string parsing
*Source:* Acute.Visits table description; MRD Sync mapper; TP-08.
- Unite delivers BP as one string such as `92/61`, usually in the `BP Systolic` field (fldQEoJfTLKODHoq7) and sometimes mirrored in `BP Diastolic` (fldz0AtfcKuYy52FV).
- Parse: take the first non-blank of the two fields; split on `/`; strip anything that is not `0-9.`; systolic = first part, diastolic = last part. Reject (both NULL, raw kept in `vitals_raw`) when either part is empty, non-numeric, or outside 30–300 / 10–200.
- Output: `visits.bp_systolic int`, `visits.bp_diastolic int`.
- "If this is not parsed at ingest, every adult and gynaecology vitals rule fails SILENTLY - no error, just no triggers."

### R-02 Numeric vitals and the blank ≠ 0 guard
*Source:* TRIGGER descriptions ("All numeric tests guard against BLANK because a blank numeric evaluates as 0 in Airtable"); TP-16.
- Temperature, pulse, SpO₂, height, weight: strip non `0-9.` characters, parse as decimal; blank or unparseable → `null`. Plausibility windows (temp 30–45 °C, pulse 20–250, SpO₂ 50–100) → outside = `null` + data-quality flag.
- Every comparison in R-PAED/GP/GYN is written as `x !== null && x <op> threshold`. A `null` never compares true.
- Empty multiline text is the empty string: text predicates use `txt(x).trim().length > 0`, mirroring Airtable `LEN(TRIM()) > 0`.

### R-03 Negation scrubbing of narrative notes
*Source:* TRIGGER GP description ("GP-02-REDFLAG … fired a false positive … against notes containing denials - Observation Notes is now negation-scrubbed at ingest by the Make sync"); Trigger Category description ("denies blood in stool"). **The live MRD Sync blueprint performs no scrubbing** (OQ-31).
- Composite `observation_notes_raw = complaints + " " + hpi + " " + doctor_notes + " " + nurse_notes` (the live composite; whether to add Observations/Physical Examination, Therapy Notes, Review Of Systems is OQ-28).
- `observation_notes_scrubbed` removes clauses governed by a negation cue up to the next sentence/clause boundary (`.`, `;`, `,`, newline, " but ", " however "). Cue list (setting `negation_cues`, proposed): `no`, `not`, `denies`, `denied`, `deny`, `negative for`, `without`, `nil`, `absent`, `-ve`, `no evidence of`, `rules out`, `ruled out`, `free of`.
- Rules that read narrative (PAED-03, PAED-05, PAED-06, GP-02, GYN-02, GYN-03, GYN-04 part, GYN-05, GYN-06 part) read **only** the scrubbed text. Rules on coded fields (primary diagnosis text, secondary codes, procedures, investigations, plan) read the field as-is.
- Keep both columns; scrubbing is versioned (`scrub_version`) so re-evaluation is reproducible.

### R-04 Department mapping from Unite text
*Source:* MRD Sync mapper.
- Unite supplies department at **patient** level. Map `txt(department)` by substring, first match wins: `paed`/`pedia` → `paediatrics`; `gyn`/`obstet` → `gynaecology`; `derma` → `dermatology`; `general`/`internal`/`family` → `gp`; else `other`.
- Stored as `visits.department_mapped`. Never read directly by triggers (see R-07).

### R-05 Drug classification (fail closed)
*Source:* Medication Reference table description; Prescriptions `Is Antibiotic`/`Is Steroid`; TP-19; MRD Sync mapper (legacy behaviour).
- Authoritative: `ref_medication_classes` keyed on the **Unite local code** (`prescriptions.medication_code`). Class ∈ {antibiotic, steroid, probiotic, supplement, enzyme, other, unclassified}. Code not present → `unclassified`.
- `isAntibiotic = class === 'antibiotic'`, `isSteroid = class === 'steroid'`. `unclassified`, `other`, blank → false. "A misclassification here would send a probiotic message to someone never on antibiotics."
- `requiresProbiotics` defaults from `ref_medication_classes.requires_probiotics_default`, overridable per prescription.
- Legacy behaviour (document only, do not reproduce live): class by substring of `ref_medications.all_medicine_types || medicine_type`: `antibiotic` → Antibiotic, else `corticosteroid` → Steroid, else `probiotic` → Probiotic, else `vitamin` → Supplement, else blank → UNCLASSIFIED, else Other. Combination "Corticosteroid + Antibiotic" became Antibiotic. This heuristic may be offered as a **suggestion** in the portal screen that fills `ref_medication_classes`, with `classified_by = 'heuristic'` and no effect until a clinician confirms (OQ-13).
- Unclassified codes appear in the "Unclassified Medications" review view.

---

## 2. Derived values

### R-06 Age at visit
*Source:* `Age at Visit` formula: `IF(AND(Visit Date, DOB), DATETIME_DIFF(Visit Date, DOB, "years"), BLANK())`; TP-09.
- `ageAtVisit = fullYearsBetween(dob, visit_date)`; `null` when either is missing. Never use age today. Infant rule and the under-14 override depend on it.

### R-07 Department Effective (safety override + doctor routing)
*Source:* `Department Effective` formula + description.
1. If `ageAtVisit !== null && ageAtVisit < setting('paeds_age_cutoff_years')` (proposed 14) → `paediatrics`, regardless of anything else. ("A 3-year-old was classified GP on the first live run and never reached the paediatric rules.")
2. Else, if `doctor_name` (trimmed, case-insensitive, exact match) is in `setting('doctor_routing_gynaecology')` → `gynaecology`; in `setting('doctor_routing_paediatrics')` → `paediatrics`; in `setting('doctor_routing_gp')` → `gp`. **All three lists are empty today**, so this step never fires (OQ-08). Note the live formula's `FIND(name, "")` with an empty list correctly yields 0.
3. Else `department_mapped` (R-04).
- Every trigger and the category cascade read this value only.

### R-08 Vitals Complete (data quality)
*Source:* `Vitals Complete` formula.
- `complete = temp_c !== null && bp_systolic !== null && spo2 !== null && pulse !== null`. Incomplete visits are listed in the Data Quality Exceptions view. "Missing vitals must never be read as normal vitals." (Diastolic is not part of the live check; include it in the new flag — minor extension.)

---

## 3. Trigger rules

Each returns a rule id when it fires. `dx` = `txt(primary_diagnosis_text)`, `dx2` = `txt(secondary_diagnosis_codes)`, `obs` = `txt(observation_notes_scrubbed)`, `proc` = `txt(procedure_notes)`, `inv` = `txt(investigations_ordered)`, `plan` = `txt(plan_of_treatment)`, `nInv` = `investigation_count`. `re(pattern)` = case-insensitive regex test. Thresholds in brackets are setting keys with proposed values.

### R-PAED — Paediatrics (gate: departmentEffective === 'paediatrics')
*Source:* `TRIGGER Paediatrics` formula. "SEIZURE IS DELIBERATELY EXCLUDED" (OQ-09).

| Rule | Predicate | Settings |
|---|---|---|
| PAED-01 | `temp_c !== null && temp_c >= T_paeds` | `paeds_fever_temp_c` (39.0) |
| PAED-02-INFANT | `temp_c !== null && temp_c >= T_infant && ageAtVisit !== null && ageAtVisit < A_infant` | `infant_fever_temp_c` (38.0), `infant_age_cutoff_years` (2). "Do not simplify to a single temperature." |
| PAED-03 | `(dx.includes('fever') \|\| obs.includes('fever')) && (obs.includes('unwell') \|\| obs.includes('lethargic'))` | — |
| PAED-04 | `spo2 !== null && spo2 <= S_low` | `spo2_low_pct` (94) |
| PAED-05 | `re(dx + ' ' + obs, 'shortness of breath\|wheeze\|bronchiolitis\|pneumonia\|croup\|respiratory distress')` | keyword list `paed05_respiratory_terms` |
| PAED-06 | `re(dx + ' ' + obs, 'vomit\|diarrh') && re(obs, 'poor intake\|dehydrat\|dry mouth\|reduced urine\|lethargic')` | `paed06_gi_terms`, `paed06_dehydration_terms` |
| PAED-07 | `re(dx, 'uti\|pyelonephritis\|tonsillitis\|otitis media\|pneumonia\|cellulitis')` | `paed07_infection_terms`. Note `uti` also matches inside words (e.g. "routine"); tighten to word boundaries (flag in OQ-31). |
| PAED-08 | `nInv !== null && nInv > 0` | — |
| PAED-09 | `re(plan, 'er advised\|ed advised\|return if worse\|follow up advised\|follow-up advised')` | `paed09_plan_terms` |
| (excluded) | febrile seizure / seizure / convulsion → **no rule, no automated action** | "Confirm exclusion stands" |

### R-GP — Adults (gate: departmentEffective === 'gp')
*Source:* `TRIGGER GP` formula.

| Rule | Predicate | Settings |
|---|---|---|
| GP-01-VITALS | `(temp_c >= 39.0) \|\| (bp_systolic < 90) \|\| (bp_diastolic < 60) \|\| (spo2 <= 94) \|\| (pulse >= 110)` — each term null-guarded | `adult_fever_temp_c` (39.0), `adult_bp_systolic_low` (90), `adult_bp_diastolic_low` (60), `spo2_low_pct` (94), `adult_pulse_high` (110) |
| GP-02-REDFLAG | `re(dx + ' ' + obs, 'chest pain\|shortness of breath\|syncope\|fainting\|palpitations\|severe abdominal pain\|persistent vomiting\|blood in stool\|severe headache\|neurological deficit\|confusion')` | `gp02_redflag_terms`. "The one to watch during internal validation." Reads scrubbed text only. |
| GP-03 | `re(dx, 'infect\|pneumonia\|uti\|cellulitis\|abscess\|infected wound') && nInv !== null && nInv > 0` | `gp03_infection_terms` |
| GP-04-PROC | `proc.trim().length > 0` | — ("empty multilineText is an empty string, not blank") |
| GP-05-MEDS | `hasAntibiotic \|\| hasSteroid` (R-05, over the visit's prescriptions) | Timing of the compliance check: `gp05_check_day_from` (3) … `_to` (5) (OQ-35) |
| GP-06 | `re(plan, 'follow up advised\|follow-up advised\|review in\|return tomorrow')` | `gp06_plan_terms` |

### R-GYN — Gynaecology (gate: departmentEffective === 'gynaecology')
*Source:* `TRIGGER Gynaecology` formula. Two deliberate exclusions: imaging/structural findings never trigger alone (OQ-10); Pap only when positive (OQ-11).

| Rule | Predicate | Settings |
|---|---|---|
| GYN-01-BLEED | `re(dx + ' ' + dx2, 'abnormal uterine bleeding\|aub\|postcoital\|intermenstrual\|menorrhagia')` — **coded fields only** | `gyn01_bleed_terms`. `aub` needs word boundaries. |
| GYN-02-BLEED | `re(obs, 'contact bleeding\|active bleeding')` | `gyn02_bleed_terms` |
| GYN-03 | `obs.includes('spotting') && re(obs, 'pain\|fatigue')` | — |
| GYN-04-INFECT | `re(obs, 'green discharge\|yellow discharge\|foul') \|\| re(inv, 'hvs\|vaginal swab\|culture') \|\| re(dx, 'vaginitis\|cervicitis\|pid\|pelvic inflammatory')` | `gyn04_*_terms`. `pid` needs word boundaries. |
| GYN-05-PAIN | `re(dx + ' ' + obs, 'pelvic pain\|perineal pain\|dysmenorrh') \|\| (re(dx + ' ' + obs, 'adenomyosis\|fibroid\|endometriosis') && re(dx + ' ' + obs, 'pain\|bleed\|heavy\|discomfort'))` | "adenomyosis, fibroid and endometriosis are STRUCTURAL diagnoses and do not trigger alone" |
| GYN-06-VITALS | `(bp_systolic !== null && bp_systolic < 95 && symptomatic) \|\| (pulse !== null && pulse >= 100 && re(dx + ' ' + obs, 'pain\|bleed')) \|\| (obs.includes('fatigue') && obs.includes('bleed'))` | `gyn_bp_systolic_low` (95), `gyn_pulse_high` (100). `symptomatic` is never populated by the sync today (OQ-29). |
| GYN-07-PROC | `proc.trim().length > 0 && re(proc, 'biopsy\|cervical examination')` | `gyn07_proc_terms` |
| GYN-08-PAP | `proc.includes('pap') && pap_result === 'positive'` | Pap result is "Not available in Unite" for every row today (OQ-12) → this rule cannot fire until a structured source exists. **Never fall back to triggering on all smears.** |
| GYN-09 | `re(plan, 'follow up advised\|review after results\|monitor symptoms')` | `gyn09_plan_terms` |
| (excluded) | TVUS findings, endometrial thickness, ovarian morphology → no rule | "Confirm exclusion stands" |

### R-09 Trigger Category cascade
*Source:* `Trigger Category` formula + description. Evaluated only when at least one rule fired; order is clinical priority ("Confirm the remaining order with the clinical lead", OQ-39).
1. `departmentEffective === 'paediatrics'` → **Paediatric High-Concern**
2. `re(dx + ' ' + dx2, 'bleed|menorrhagia|spotting|haemorrhage|hemorrhage')` → **Bleeding** — coded fields only, never narrative ("denies blood in stool" incident)
3. `temp_c >= 39.0 || spo2 <= 94 || bp_systolic < 95 || pulse >= 100` (null-guarded; note the category uses the *gynae* BP/pulse thresholds, not the adult ones) → **Vitals**
4. `nInv > 0 && re(dx, 'infect|pneumonia|uti|cellulitis|abscess|vaginitis|cervicitis|pid')` → **Infection-Labs**
5. `proc.trim().length > 0` → **Post-Procedure**
6. else → **Clinical Check**

### R-10 Follow-Up Due Date
*Source:* `Follow-Up Due Date` formula + description; Settings "Post-procedure follow-up interval = 48 hours"; TP-05.
- `category ∈ {Paediatric High-Concern, Vitals, Bleeding, Infection-Labs}` → `workday(visit_date, +1)`; else → `workday(visit_date, +2)`.
- `workday()` must use the clinic's real operating week and holiday list (`clinic_calendar`), not Mon–Fri ("almost certainly wrong for a UAE clinic", **BLOCKING** OQ-07).
- Still to add (OQ-40): parse "review in X days" / "review in X weeks" from `plan_of_treatment` and prefer X over the category default when present and ≤ 30 days.
- History: the superseded CFU base used calendar `+1` (paeds) / `+2` (other) days with no workday roll.

### R-11 Dedupe key
*Source:* `Dedupe Key` formula; TP-07.
- `dedupe_key = visit.external_id + '-' + trigger_category`. Unique index on `visit_rule_evaluations` and on `clinical_followups`. Re-sync of the same visit → no second queue item, no second send. A re-sync that changes the category creates a new key; the old item is closed with reason `superseded`.

---

## 4. Medication sequence, feedback, recall and gates

### R-12 Is Antibiotic / Is Steroid
See R-05. `class === 'antibiotic'` / `=== 'steroid'`; anything else false.

### R-13 Antibiotic end date
*Source:* `End Date` formula. `end = start_date + (duration_days − 1)` when `duration_days > 0`; else null. "A 7-day course ending is day 7, not day 8." (The old PTF formula added the full duration; it is wrong by one day.)

### R-14 Day-3 check
*Source:* `Day 3 Check Date` formula; Settings "Day-3 check timing = Start + 2 days (awaiting sign-off)"; TP-04, TP-12.
- `day3_check_date = start_date + setting('day3_offset_days')` (proposed 2 = third day inclusive; alternative 3 = 72 h after first dose, OQ-02). Only when `isAntibiotic`.
- Template `ABX_DAY3` expects a 1–10 score. Reply handling:
  - parsed score ≤ `setting('day3_halt_threshold')` → `ABX_UNWELL`, `status = halted_clinical`, doctor alerted, `clinical_followups` row at **High** priority (TP-04). `day3_halt_threshold` is **BLOCKING / unset** (OQ-05) → until set, every day-3 reply routes to a human.
  - score above threshold → `status = awaiting_probiotic` (TP-12).
  - unparseable → R-16.

### R-15 Probiotic hand-over and outcome
*Source:* `Probiotic Start/End Date` formulas; Settings rows; template `PROBIOTIC_START` note "MUST NOT send on date alone"; TP-04, TP-12.
- `probiotic_start_date = antibiotic_end_date + 1` when `isAntibiotic && requiresProbiotics`.
- `probiotic_end_date = probiotic_start_date + (probiotic_duration_days − 1)`, default `setting('probiotic_default_days')` (10, "original specification said 7–10", OQ-03).
- Send guard for `PROBIOTIC_START`: `status !== 'halted_clinical' && status !== 'awaiting_clarification'`. Halted → nothing is sent, the follow-up queue owns the patient.
- `TREATMENT_OUTCOME` is sent on `probiotic_end_date` and is "the only point where treatment outcome data is captured"; reply → `clinical_feedback(stage='after_probiotics')`.

### R-16 Unparseable reply
*Source:* Message Log description; TP-10.
- A reply to a score-expecting template is parsed with: first standalone integer 1–10 (word numbers "one"…"ten" optional). If none → `reply_parsed_score = null`, raw text stored verbatim, `status = awaiting_clarification`, task to a human. "NO score guessed."
- A reply containing both a number and a side-effect keyword is **both** scored and flagged (R-18).

### R-17 No reply by antibiotic end date
*Source:* TP-11. If `status ∈ {day3_sent, awaiting_day3_reply}` and `today > antibiotic_end_date`: the sequence proceeds (probiotic may still be scheduled) **and** a nurse call task is raised. "Silence must not be read as consent or as improvement."

### R-18 Feedback red flag
*Source:* `Needs Doctor Review` formula; Settings; TP-15.
- `redFlag = (score !== null && score <= setting('red_flag_score_threshold')) || sideEffectsFlagged`.
- `sideEffectsFlagged = any keyword of setting('side_effect_keywords') in txt(reply)`; the list is **BLOCKING / unset** (candidate set for review only: rash, swelling, vomiting, diarrhoea, dizziness, breathing difficulty, allergic reaction — OQ-06). Threshold 5 is "a Bilal-era value awaiting sign-off" (OQ-04).
- "A reply of 8 but I have a rash must escalate." Score and keyword are independent tests.

### R-19 Dual notification
*Source:* Feedback table description; Settings "Escalation notification recipients = treating doctor AND care coordinator".
- On red flag: notify the treating doctor (specialist of the visit) **and** the care coordinator team; stamp `doctor_notified_at`, `coordinator_notified_at`; create/raise a `clinical_followups` row (High). Neither notification may be skipped because the other succeeded.

### R-20 Chronic condition groups
*Source:* `Chronic Recall Groups` formula. Groups come from `contact_chronic_conditions → ref_diagnoses.condition_group`. Mental-health groups (`Depression (major)`, `Anxiety disorders`) are removed (`ref_condition_groups.messageable = false`, OQ-25). Deduplicate, keep stable order.

### R-21 Primary condition
*Source:* `Chronic Recall Primary Condition`. First messageable group of R-20. Ordering today = order Airtable returns the lookup (effectively diagnosis link order); define it explicitly as `ref_condition_groups.sort` (OQ-15).

### R-22 Chronic recall eligibility
*Source:* `Chronic Recall Eligible` formula (live) vs description.
- Live: `days_since_last_visit >= 30 && chronic_recall_sent_on is blank && phone non-blank && primary condition non-blank`.
- Description: "90+ days since last visit (Follow-up interval on all Top 30 codes is 'Every 3 months')". Feedback item also cites 85. → `setting('chronic_recall_min_days')` with live value 30 recorded, proposed 90, decision OQ-01.
- Native additions: `not stop_marketing`, `not is_test_record`, clinical consent where required, no open `recall_sends` row for the current cycle (`cycle_key = last_visit_date`), and the programme's `send_mode`.

### R-23 Chronic recall template per condition
*Source:* `Chronic Recall Template ID` SWITCH. Hypertension 13159, Diabetes 13164, Hyperlipidemia 13163, Hypothyroidism 13169, CKD 13168, Asthma 13162, COPD 13165, RA 13161, AF 13167, Epilepsy 13166, **default 13170** (OQ-24). Stored in `recall_programme_templates` and remapped to native `wa_templates` in Phase 4.

### R-24 Recall follow-up due (call list)
*Source:* `Follow-Up Due` formula. `send_mode = live && status = sent && replied_at is null && follow_up_status ≠ booked && workdays(sent_date → today) >= setting('recall_followup_workdays')` (3). Uses `clinic_calendar` (OQ-07). "Per the 7 Aug call these get a manual call, not a second message."

### R-25 Recall overdue flag
*Source:* `Recall Overdue Flag`. `days_since_last_visit_at_send > setting('chronic_recall_overdue_days')` (120) → OVERDUE. Dashboard target: booking rate 30%.

### R-26 Phase gate
*Source:* Follow-Up Queue description; Settings "Phase 2 internal validation period"; template notes.
- `clinical_messaging_enabled` (org-level, default **false**) must be true before any clinical template reaches a real patient. While false, the engine still evaluates rules, fills the queue (internal tasks) and logs *would-send* rows in `clinical_message_log` with `status = suppressed_gate`.
- Independently, `recall_send_mode = test` routes every recall/clinical send to the internal validation numbers (`clinical_settings.test_recipient_numbers`).

### R-27 Test-record isolation
*Source:* TP-14. Rows with `is_test_record = true` (contact, visit, prescription) never produce a live send and are excluded from reports. Test sends go only to the internal numbers list.

---

## 5. Test cases

### 5.1 Acceptance set — the Airtable Test Plan (all "Not tested" today)

| ID | Test case | Setup (synthetic) | Expected | Rules |
|---|---|---|---|---|
| TP-01 | Seizure exclusion | Paediatrics visit; diagnosis text contains "febrile seizure"; no other trigger | NO AUTOMATED ACTION of any kind | R-PAED (exclusion) |
| TP-02 | Gynaecology imaging exclusion | Gynaecology visit; TVUS with suspected adenomyosis in observations; no bleeding, pain, infection or procedure | DOES NOT TRIGGER | GYN-05, exclusion |
| TP-03 | Infant fever boundary – general threshold | Paediatrics; age at visit 2y1m; temp 39.0 | TRIGGERS via PAED-01 | PAED-01 |
| TP-04 | Day-3 branch – patient unwell | Antibiotic prescription; day-3 reply ≤ HALT threshold | ABX_UNWELL sent; PROBIOTIC_START suppressed; status HALTED – clinical; doctor alerted; queue row High | R-14, R-15, R-19 |
| TP-05 | Weekend / working-week roll | Visit on a Friday with a next-working-day rule | Due date rolls to the clinic's next actual operating day | R-10 (BLOCKED on OQ-07) |
| TP-06 | Infant fever boundary – outside | Paediatrics; 2y1m; temp 38.0; nothing else | DOES NOT TRIGGER | PAED-02 |
| TP-07 | Duplicate sync | Same Visit ID re-synced after a follow-up exists | NO duplicate queue record; NO duplicate send | R-11, idempotency key |
| TP-08 | BP string parsing | Unite sends `92/61` | systolic 92, diastolic 61, both numeric | R-01 |
| TP-09 | Age at visit, not age today | Visit 6 months ago; child 2y1m today, 1y7m at visit; temp 38.0 | TRIGGERS (PAED-02) | R-06 |
| TP-10 | Unparseable reply | Reply to ABX_DAY3: "not great honestly" | Routed to a human; raw text stored; no score guessed; status Awaiting clarification | R-16 |
| TP-11 | Multi-trigger visit | Paediatrics; fever 39.5 and a procedure | ONE queue record; category Paediatric High-Concern; no double send | R-09, R-11 |
| TP-12 | No reply to day-3 check | Antibiotic; no reply by End Date | Sequence proceeds; nurse call task raised | R-17 |
| TP-13 | Day-3 branch – improving | Antibiotic; day-3 score above HALT threshold | PROBIOTIC_START scheduled for End Date + 1 | R-14, R-15 |
| TP-14 | Infant fever boundary – inside | Paediatrics; 1y11m; temp 38.0 | TRIGGERS via PAED-02-INFANT | PAED-02 |
| TP-15 | Test record isolation | All synthetic records flagged; automations run | No message reaches a real number; all sends to internal numbers | R-26, R-27 |
| TP-16 | Side effect overrides high score | Reply "8 but I have a rash" | RED FLAG fires; doctor and coordinator notified | R-18, R-19 |
| TP-17 | Pap smear – positive | Gynaecology; Pap performed; Pap Result Positive | TRIGGERS via GYN-08-PAP | GYN-08 |
| TP-18 | Blank vitals guard | GP visit; BP fields empty; nothing else | DOES NOT TRIGGER ("a blank numeric must never be read as zero") | R-02, GP-01 |
| TP-19 | Unclassified medication fails closed | Prescription code absent from Medication Reference | NO sequence fires; appears in Unclassified Medications view | R-05 |
| TP-20 | Pap smear – negative | Gynaecology; Pap performed; Negative; symptoms present | DOES NOT TRIGGER via GYN-08 | GYN-08 |

### 5.2 Derived boundary cases (added by Phase 0)

| ID | Setup | Expected | Rules |
|---|---|---|---|
| BC-01 | GP, temp 38.9 | no GP-01 | GP-01 boundary |
| BC-02 | GP, temp 39.0 | GP-01 | |
| BC-03 | GP, SpO₂ 95 / 94 | no / GP-01 | `<=` semantics |
| BC-04 | GP, systolic 90 / 89 | no / GP-01 | `<` semantics |
| BC-05 | GP, pulse 109 / 110 | no / GP-01 | |
| BC-06 | Unite department "General", age at visit 13y11m | departmentEffective paediatrics | R-07 step 1 |
| BC-07 | Unite department "General", age exactly 14y0d | gp | R-07 (`< 14`) |
| BC-08 | DOB missing, department "Pediatrics" | paediatrics via mapping; PAED-02 cannot fire (age null) | R-06, R-04 |
| BC-09 | Only `BP Diastolic` field holds "120/80" | systolic 120, diastolic 80 | R-01 |
| BC-10 | BP string "120/" or "abc" | both null; vitals incomplete | R-01 |
| BC-11 | GP, obs "denies chest pain, no shortness of breath" | scrubbed text empty of both terms → no GP-02 | R-03 |
| BC-12 | GP, obs "chest pain on exertion, denies syncope" | GP-02 fires (chest pain survives scrubbing) | R-03 |
| BC-13 | GP, dx "gastroenteritis", obs "denies blood in stool" | category not Bleeding (coded fields only) | R-09 step 2 |
| BC-14 | Gyn, dx "menorrhagia" | GYN-01 and category Bleeding | GYN-01, R-09 |
| BC-15 | Gyn, obs "fibroid noted on scan" only | no GYN-05 | structural alone |
| BC-16 | Gyn, obs "fibroid, heavy bleeding" | GYN-05 | |
| BC-17 | Gyn, systolic 94, symptomatic false | no GYN-06 (needs symptomatic) | OQ-29 |
| BC-18 | Gyn, proc "Pap smear", pap_result "Not available in Unite" | no GYN-08 | fail closed |
| BC-19 | Paeds, dx "routine check" | no PAED-07 (word-boundary fix for `uti`) | regex hygiene |
| BC-20 | Prescription code with class "Corticosteroid + Antibiotic" in legacy category only, absent from ref_medication_classes | unclassified → nothing fires | R-05 |
| BC-21 | Antibiotic start 1 Mar, duration 7 | end 7 Mar; day-3 check 3 Mar (offset 2) or 4 Mar (offset 3); probiotic 8 Mar–17 Mar (10 d) | R-13…R-15 |
| BC-22 | Antibiotic, duration null or 0 | no end date, no sequence dates; queue note "duration missing" | R-13 |
| BC-23 | Day-3 reply "5" with threshold unset (BLOCKING) | awaiting_clarification + human task, nothing sent | R-14 fail closed |
| BC-24 | Reply "7, slight rash" with keywords unset | score 7 stored, side-effect flag cannot be evaluated → human review | R-18 fail closed |
| BC-25 | Chronic patient, last visit 45 days ago, min_days 30 (live) / 90 (proposed) | eligible / not eligible | R-22, OQ-01 |
| BC-26 | Chronic patient with only "Anxiety disorders" | not eligible (no messageable group) | R-20 |
| BC-27 | Chronic patient, phone null | not eligible | R-22 |
| BC-28 | Chronic patient, `stop_marketing = true` | not eligible (new native condition) | R-22 |
| BC-29 | Recall sent Thu, no reply; today Mon (clinic week Mon–Sat) | workdays ≥ 3 → call now | R-24 |
| BC-30 | Recall sent, follow_up_status booked, booked_at null | rejected by constraint | mapping §2.4 |
| BC-31 | Visit re-synced with a changed category | new dedupe key; old queue item closed `superseded` | R-11 |
| BC-32 | `clinical_messaging_enabled = false`, rule fires | queue row created; message row `suppressed_gate`; nothing sent | R-26 |
| BC-33 | Paeds, dx "viral fever", obs "child unwell, off food" | PAED-03 | PAED-03 |
| BC-34 | Paeds, SpO₂ 94 | PAED-04 and category Paediatric High-Concern | PAED-04 |
| BC-35 | Paeds, obs "wheeze on auscultation" | PAED-05 | PAED-05 |
| BC-36 | Paeds, dx "gastroenteritis", obs "vomiting x3, poor intake" / obs "vomiting x3" only | PAED-06 / no PAED-06 | PAED-06 |
| BC-37 | Paeds, one investigation ordered, no other finding | PAED-08; category Paediatric High-Concern; due next working day | PAED-08, R-10 |
| BC-38 | Paeds, plan "return if worse" | PAED-09 | PAED-09 |
| BC-39 | GP, dx "cellulitis", 1 investigation / 0 investigations | GP-03 / no GP-03 | GP-03 |
| BC-40 | GP, proc "wound dressing" | GP-04-PROC; category Post-Procedure; due +2 working days | GP-04, R-09, R-10 |
| BC-41 | GP, one prescription class antibiotic / class unclassified | GP-05-MEDS / no GP-05 | GP-05, R-12 |
| BC-42 | GP, plan "review in 5 days" | GP-06 (and, once OQ-40 lands, due = visit + 5 days) | GP-06, R-10 |
| BC-43 | Gyn, obs "active bleeding noted" | GYN-02-BLEED; category Bleeding only if coded fields also mention bleeding (else Clinical Check) | GYN-02, R-09 |
| BC-44 | Gyn, obs "spotting with pelvic pain" | GYN-03 and GYN-05 | GYN-03 |
| BC-45 | Gyn, inv "HVS culture" / dx "cervicitis" / obs "foul discharge" | GYN-04-INFECT in each case | GYN-04 |
| BC-46 | Gyn, proc "cervical biopsy" | GYN-07-PROC; category Post-Procedure | GYN-07 |
| BC-47 | Gyn, plan "review after results" | GYN-09 | GYN-09 |
| BC-48 | Visit with temp, BP, pulse recorded, SpO₂ missing | `vitals_complete = false`; row in data-quality view; vitals rules still evaluate the present values | R-08 |
| BC-49 | Contact with Hypertension and Diabetes groups, `sort` HTN 10 < DM 20 | primary group hypertension → template 13159 | R-21, R-23 |
| BC-50 | Contact whose only messageable group has no template row | `skipped_no_template`, nothing sent | R-23 |
| BC-51 | Recall sent at 121 / 120 days since last visit | overdue true / false | R-25 |

### 5.3 Fixture format (Phase 6)

```json
{
  "id": "TP-14",
  "given": { "visit": { "department_mapped": "paediatrics", "visit_date": "2026-03-10", "temp_c": 38.0 },
             "contact": { "dob": "2024-04-15" },
             "settings": { "infant_fever_temp_c": 38.0, "infant_age_cutoff_years": 2, "paeds_fever_temp_c": 39.0 } },
  "expect": { "rules_fired": ["PAED-02-INFANT"], "trigger_category": "Paediatric High-Concern" }
}
```
Synthetic data only. No names, no phones.

---

## 6. Open clinical questions raised by these rules

Full register with owners in `open-questions.md`. The ones that block Phase 6 code: OQ-01 (30/85/90 days), OQ-02 (day-3 offset), OQ-03 (probiotic 10 d), OQ-04 (red-flag ≤ 5), OQ-05 (day-3 HALT threshold, unset), OQ-06 (side-effect keywords, unset), OQ-07 (clinic working week), OQ-08 (doctor routing lists), OQ-09/10/11 (exclusions to confirm), OQ-12 (Pap availability), OQ-13 (drug class source), OQ-14 (queue staffing), OQ-29 (Symptomatic flag), OQ-31 (negation scrubbing scope), OQ-36 (all vitals thresholds unsigned), OQ-39 (category order), OQ-40 ("review in X days").
