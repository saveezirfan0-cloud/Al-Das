### Acute Follow-Up — MRD Sync (id 5990863) — ACTIVE
Schedule: daily 23:55–23:56 window (15-min interval, restricted). Max 10 visits per run. Historical ops ≈ 1,145. Scenario description claims "classifies drugs by contains-match on All Medicine Types, scrubs negations from notes" — **the blueprint contains no negation scrubbing**.
Blueprint not stored in this repo (only the mapper logic matters; it is reproduced in full below).

- [1] airtable:ActionSearchRecords «Find unsynced recent visits»: base=app7QJ2pvhADHQeBP; table=tblllKPKIY9qvMoEU (Medical Records Data); formula `AND({Acute Sync On} = BLANK(), {Visit Date} != BLANK(), IS_AFTER({Visit Date}, DATEADD(TODAY(), -30, 'days')))`; maxRecords 10
- [2] airtable:ActionGetRecord «Get patient (DOB, department)» (filter: `{{1.Unite}}` exists): table=tbl9856qJP9S7OEqB, id=`first(1.Unite)`
- [3] airtable:ActionCreateRecord «Create Visit in Acute base»: base=appH2jHpsNR1nqEQ2; table=tblyOweSP3FfeY9q0 (Visits). Mapping (Acute field ← expression):
  - Visit ID ← `1.id` (Airtable record id of the MRD row)
  - Visit Date ← `1.Visit Date`; DOB ← `2.DOB`; Doctor ← `1.Doctor Name`
  - Department ← `contains(lower(2.Department))`: `paed`|`pedia` → Paediatrics; `gyn`|`obstet` → Gynaecology; `derma` → Dermatology; `general`|`internal`|`family` → GP; else Other
  - Temperature (C) ← `parseNumber(replace(1.Body Temperature, /[^0-9.]/g, ""))` if non-blank else empty
  - BP Systolic ← `parseNumber(first(split(1.BP Systolic, "/")))`; BP Diastolic ← `parseNumber(last(split(1.BP Diastolic, "/")))` (both guarded by `length(trim()) > 0`)
  - O2 Saturation (%) ← numeric parse of `1.O2 % BldC Oximetry`; Pulse ← numeric parse of `1.Pulse`
  - Primary Diagnosis Code ← `1.Primary Diagnosis`; Primary Diagnosis Text ← `join(1.Description (from Diagnosis), "; ")`
  - Procedures ← `1.Procedure Notes`; Investigations Ordered ← `join(1.Description (from Items), "; ")`; Investigation Count ← `length(1.Items)`
  - Plan of Treatment ← `1.Plan of Treatment`
  - Observation Notes ← `1.Complaints + " " + 1.History Of Present Illness + " " + 1.Doctor Notes + " " + 1.Nurse Notes` (plain concatenation, **no scrubbing**)
  - Pap Result ← constant `"Not available in Unite"`; Is Test Record ← false
  - Secondary Diagnosis Codes, Symptomatic ← not mapped
- [4] airtable:ActionUpdateRecords «Mark visit synced»: MRD row `Acute Sync On = today` (idempotency marker)
- [5] builtin:BasicFeeder «Iterate drug positions (1..n)»: `slice(split("1,…,20"), 0, length(1.Medication))` — hard cap of 20 medications
- [6] airtable:ActionGetRecord «Get drug record (classification)»: table=tblLM2BXjA680GQws (Medication), id = `get(1.Medication, position)`
- [7] airtable:ActionCreateRecord «Create Prescription»: table=tblQra08AflxuXxQq. Mapping:
  - Prescription ID ← `1.id + "-" + position`; Visit ← [3.id]; Start Date ← `1.Visit Date`; Sequence Status ← "Not started"
  - Medication Code ← `6.DDC Code`; Medication Name ← `6.Trade Name`
  - Medication Class ← `t = lower(ifempty(6.All Medicine Types, 6.MEDICINE TYPE))`: contains "antibiotic" → Antibiotic; else contains "corticosteroid" → Steroid; else contains "probiotic" → Probiotic; else contains "vitamin" → Supplement; else blank → UNCLASSIFIED; else Other
  - Requires Probiotics ← `contains(t, "antibiotic")`; Probiotic Duration (Days) ← constant **10**
  - Duration (Days) ← `parseNumber(trim(get(split(1.Dosage Days, ","), position)))`; Total Quantity ← same on `1.Total Quantity (from Medication)`; Dosage Instruction ← same on `1.Roa Description (from Medication)` (the MRD row stores these as comma-joined strings in medication order)
  - Patient link ← not mapped (Acute Visits/Prescriptions are linked to each other but not to Acute Patients)

**Behavioural notes**
- Classification is by the Unite Medication table's free-text category, not by the Acute `Medication Reference` (which is empty). A category like "Corticosteroid + Antibiotic" becomes Antibiotic.
- Combination fields split on "," break when a dosage instruction itself contains a comma.
- If a visit has >20 medications the extra ones are silently dropped; if `Unite` link is missing the visit is skipped **and never marked synced**, so it is retried every night forever.
- Native replacement: `lib/unite/mappers.ts` + `lib/clinical/` ingest (see `make-replacement-design.md` §7 and `clinical-rules.md` R-01…R-05).
