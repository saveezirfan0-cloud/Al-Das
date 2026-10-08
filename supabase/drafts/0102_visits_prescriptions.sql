-- 0102_visits_prescriptions.sql  (DRAFT — Phase 0)
-- Visits (Unite medical records), diagnoses/items per visit, prescriptions, medication sequences and
-- the stored output of the clinical rules engine.
-- Depends on 0100, 0101, Phase 1 (orgs, memberships), Phase 2 (contacts), Phase 6 (locations, specialists).
-- Source mapping: data-model-mapping.md §1.2, §3.4, §3.5.

do $$ begin
  if not exists (select 1 from pg_type where typname = 'department_mapped') then
    create type public.department_mapped as enum ('paediatrics','gp','gynaecology','dermatology','other');
  end if;
  if not exists (select 1 from pg_type where typname = 'pap_result') then
    create type public.pap_result as enum ('positive','negative','pending','not_available');
  end if;
  if not exists (select 1 from pg_type where typname = 'trigger_category') then
    create type public.trigger_category as enum
      ('paediatric_high_concern','bleeding','vitals','infection_labs','post_procedure','clinical_check');
  end if;
  if not exists (select 1 from pg_type where typname = 'sequence_status') then
    create type public.sequence_status as enum
      ('not_started','day3_sent','awaiting_day3_reply','awaiting_clarification','awaiting_probiotic',
       'probiotic_sent','outcome_sent','complete','halted_clinical');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- clinic_calendar — working week + holidays for WORKDAY() semantics (OQ-07)
-- ---------------------------------------------------------------------------
create table if not exists public.clinic_calendar (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.orgs(id) on delete cascade,
  location_id       uuid references public.locations(id) on delete cascade,   -- null = org default
  working_weekdays  int[] not null default '{1,2,3,4,5,6}',                     -- ISO: 1=Mon … 7=Sun
  holidays          date[] not null default '{}',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index if not exists clinic_calendar_org_default on public.clinic_calendar (org_id) where location_id is null;
create unique index if not exists clinic_calendar_org_location on public.clinic_calendar (org_id, location_id) where location_id is not null;

create or replace function public.is_working_day(p_org uuid, p_day date, p_location uuid default null)
returns boolean language sql stable as $$
  with cal as (
    select * from public.clinic_calendar
    where org_id = p_org and (location_id = p_location or location_id is null)
    order by location_id nulls last limit 1)
  select coalesce(
    (select extract(isodow from p_day)::int = any(working_weekdays) and not (p_day = any(holidays)) from cal),
    extract(isodow from p_day)::int between 1 and 5);   -- no calendar row → Mon–Fri (documented fallback)
$$;

create or replace function public.add_workdays(p_org uuid, p_from date, p_n int, p_location uuid default null)
returns date language plpgsql stable as $$
declare d date := p_from; left_n int := p_n;
begin
  while left_n > 0 loop
    d := d + 1;
    if public.is_working_day(p_org, d, p_location) then left_n := left_n - 1; end if;
  end loop;
  return d;
end $$;

create or replace function public.workdays_between(p_org uuid, p_from date, p_to date, p_location uuid default null)
returns int language sql stable as $$
  select count(*)::int from generate_series(p_from + 1, p_to, interval '1 day') g
  where public.is_working_day(p_org, g::date, p_location);
$$;

-- ---------------------------------------------------------------------------
-- visits — Unite.Medical Records Data (tblllKPKIY9qvMoEU) + Acute.Visits stored columns
-- ---------------------------------------------------------------------------
create table if not exists public.visits (
  id                          uuid primary key default gen_random_uuid(),
  org_id                      uuid not null references public.orgs(id) on delete cascade,
  contact_id                  uuid references public.contacts(id) on delete set null,   -- fldtxNjAanspw8h40 (may be unresolved → sync_review)
  external_id                 text not null,                       -- Unite MRD id (Airtable rec id for imported history)
  source                      text not null default 'unite',       -- unite | airtable_import
  visit_date                  date not null,                       -- fldKuI5eXoDJIiOcu
  location_id                 uuid references public.locations(id),
  specialist_id               uuid references public.specialists(id),
  doctor_name                 text,                                -- fldZiy0HG9KGApOtc (exact string, R-07 routing)
  department_raw              text,                                -- patient-level department as Unite sends it
  department_mapped           public.department_mapped,            -- R-04
  -- vitals (parsed, R-01/R-02). NULL = not recorded, never 0.
  height_cm                   numeric(5,1),
  weight_kg                   numeric(5,1),
  temp_c                      numeric(4,1),
  pulse                       int,
  bp_systolic                 int,
  bp_diastolic                int,
  spo2                        int,
  vitals_raw                  jsonb not null default '{}'::jsonb,  -- original strings
  -- narrative
  description                 text,                                -- fld5eftp6BVHSyPQd
  complaints                  text,                                -- fldZsPHI9BBzWWgap
  hpi                         text,                                -- fldJQiC2fplhNXa1N
  doctor_notes                text,                                -- fld5ONgPlFlyJFZYy
  nurse_notes                 text,                                -- fldX8Chw8INeRhuTD
  therapy_notes               text,                                -- fldx5AdhYb49W946I
  procedure_notes             text,                                -- fldVWIrd7336dmS6x  (= Acute "Procedures")
  physical_exam_notes         text,                                -- fldpNQHsUjrA9XG8a
  review_of_systems           text,                                -- fldUGZGwjklowwHJI
  plan_of_treatment           text,                                -- fldhDyDyi1V5soDiO
  observation_notes_raw       text,                                -- composite (R-03)
  observation_notes_scrubbed  text,                                -- composite, negation-scrubbed (R-03)
  scrub_version               int,
  -- coded
  primary_diagnosis_code      text,                                -- fldSIH4uHnviEYYel
  primary_diagnosis_text      text,                                -- '; '-joined coded descriptions (Acute flduu0Nv3L4JCMitD)
  secondary_diagnosis_codes   text,                                -- Acute fldXAkFSh3q9dlkEC
  pap_result                  public.pap_result,                   -- Acute fldgZRyGr1tVmNbYk
  symptomatic                 boolean,                             -- Acute fld2al0GgsV6g4Rdi (OQ-29)
  is_test_record              boolean not null default false,
  legacy_acute_synced_on      date,                                -- Acute Sync On, parallel-run only
  raw                         jsonb,                               -- full Unite payload (no PHI beyond the row itself)
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  unique (org_id, external_id),
  constraint bp_plausible check (
    (bp_systolic is null or bp_systolic between 30 and 300) and
    (bp_diastolic is null or bp_diastolic between 10 and 200)),
  constraint temp_plausible check (temp_c is null or temp_c between 30 and 45),
  constraint spo2_plausible check (spo2 is null or spo2 between 50 and 100),
  constraint pulse_plausible check (pulse is null or pulse between 20 and 250)
);
create index if not exists visits_contact_date_idx on public.visits (org_id, contact_id, visit_date desc);
create index if not exists visits_date_idx on public.visits (org_id, visit_date desc);

create table if not exists public.visit_diagnoses (
  org_id            uuid not null references public.orgs(id) on delete cascade,
  visit_id          uuid not null references public.visits(id) on delete cascade,
  ref_diagnosis_id  uuid not null references public.ref_diagnoses(id),
  is_primary        boolean not null default false,              -- fldDJcDJYLqffQ5A0
  primary key (visit_id, ref_diagnosis_id)
);
create index if not exists visit_diagnoses_dx_idx on public.visit_diagnoses (org_id, ref_diagnosis_id);

create table if not exists public.visit_items (
  org_id       uuid not null references public.orgs(id) on delete cascade,
  visit_id     uuid not null references public.visits(id) on delete cascade,
  ref_item_id  uuid not null references public.ref_items(id),
  position     int  not null,
  primary key (visit_id, ref_item_id)
);

-- Patient-level lists from the Unite patient record (fld9gw5nJNzgywljY, fldZgI4a9JcG7Bi1L)
create table if not exists public.contact_chronic_conditions (
  org_id            uuid not null references public.orgs(id) on delete cascade,
  contact_id        uuid not null references public.contacts(id) on delete cascade,
  ref_diagnosis_id  uuid not null references public.ref_diagnoses(id),
  source            text not null default 'unite',
  noted_at          date,
  primary key (contact_id, ref_diagnosis_id)
);
create table if not exists public.contact_regular_medications (
  org_id             uuid not null references public.orgs(id) on delete cascade,
  contact_id         uuid not null references public.contacts(id) on delete cascade,
  ref_medication_id  uuid not null references public.ref_medications(id),
  source             text not null default 'unite',
  primary key (contact_id, ref_medication_id)
);

-- ---------------------------------------------------------------------------
-- prescriptions — one row per medication on a visit (Acute.Prescriptions tblQra08AflxuXxQq)
-- ---------------------------------------------------------------------------
create table if not exists public.prescriptions (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.orgs(id) on delete cascade,
  visit_id             uuid references public.visits(id) on delete cascade,
  contact_id           uuid references public.contacts(id) on delete set null,
  position             int,                                       -- order within the visit (1-based)
  external_key         text not null,                             -- '<visit external_id>-<position>' (fldPLUnLoIBIUfcfT)
  ref_medication_id    uuid references public.ref_medications(id),
  medication_code      text,                                      -- fldNp6WqXyDjupsue (Unite local code)
  medication_name      text,                                      -- fldTp7F5vU2efpLY8
  class                public.medication_class not null default 'unclassified',  -- fld7K9SVDvqjaU30A (from ref_medication_classes, R-05)
  duration_days        int,                                       -- fldfujiLktvFEPNE1
  dosage_instruction   text,                                      -- fldbHnnCairp1oMA2
  total_quantity       numeric(10,2),                             -- fldfYDjKPKJn9vPPU
  start_date           date,                                      -- fldM5leoAtTzhVg6R
  notes_for_patient    text,                                      -- PTF fldi63hCyya30zCz8
  is_test_record       boolean not null default false,
  source               text not null default 'unite',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, external_key)
);
create index if not exists prescriptions_visit_idx on public.prescriptions (visit_id);
create index if not exists prescriptions_unclassified_idx on public.prescriptions (org_id) where class = 'unclassified';

-- ---------------------------------------------------------------------------
-- prescription_sequences — the antibiotic → probiotic → outcome sequence (R-13…R-17)
-- Dates are computed by lib/clinical and stored so the scheduler can read them.
-- ---------------------------------------------------------------------------
create table if not exists public.prescription_sequences (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null references public.orgs(id) on delete cascade,
  prescription_id           uuid not null unique references public.prescriptions(id) on delete cascade,
  requires_probiotics       boolean not null default false,       -- fldwNVLgPMpESN3Hz
  probiotic_duration_days   int,                                  -- fld2u0WCiQkYkHbHf (default clinical_settings.probiotic_default_days)
  day3_offset_days          int,                                  -- snapshot of clinical_settings.day3_offset_days at creation
  antibiotic_end_date       date,                                 -- R-13: start + duration - 1
  day3_check_date           date,                                 -- R-14
  probiotic_start_date      date,                                 -- R-15: end + 1 (scheduled only; send is gated on status)
  probiotic_end_date        date,                                 -- R-15
  status                    public.sequence_status not null default 'not_started',   -- fldWHAoxbXpISk6FS
  day3_score                int,                                  -- fldwrqZebkNcCcvD3
  outcome_score             int,                                  -- fldsB3CbqdZspzYLK
  outcome_symptoms          text,                                 -- fldSHEYRBRqBcxKOo
  halted_at                 timestamptz,
  halted_reason             text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint scores_in_range check (
    (day3_score is null or day3_score between 1 and 10) and
    (outcome_score is null or outcome_score between 1 and 10)),
  constraint halted_has_timestamp check (status <> 'halted_clinical' or halted_at is not null)
);
create index if not exists prescription_sequences_due_idx on public.prescription_sequences (org_id, status, day3_check_date, probiotic_start_date, probiotic_end_date);

-- ---------------------------------------------------------------------------
-- visit_rule_evaluations — what lib/clinical computed for a visit (R-06…R-11)
-- ---------------------------------------------------------------------------
create table if not exists public.visit_rule_evaluations (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references public.orgs(id) on delete cascade,
  visit_id               uuid not null references public.visits(id) on delete cascade,
  engine_version         text not null,                            -- lib/clinical version
  settings_snapshot      jsonb not null default '{}'::jsonb,       -- the setting values used
  inputs_hash            text,                                     -- hash of the visit columns read → skip re-evaluation when unchanged
  age_at_visit           int,                                      -- R-06
  department_effective   public.department_mapped,                 -- R-07
  vitals_complete        boolean,                                  -- R-08
  rules_fired            text[] not null default '{}',             -- 'PAED-02-INFANT', 'GP-01-VITALS', …
  trigger_category       public.trigger_category,                  -- R-09 (null when nothing fired)
  follow_up_due_date     date,                                     -- R-10
  dedupe_key             text,                                     -- R-11: <visit external_id>-<category>
  is_current             boolean not null default true,
  evaluated_at           timestamptz not null default now(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint category_iff_rules check ((trigger_category is null) = (cardinality(rules_fired) = 0)),
  constraint dedupe_key_iff_category check ((dedupe_key is null) = (trigger_category is null))
);
create unique index if not exists visit_rule_evaluations_dedupe on public.visit_rule_evaluations (org_id, dedupe_key) where is_current and dedupe_key is not null;
create unique index if not exists visit_rule_evaluations_current on public.visit_rule_evaluations (visit_id) where is_current;

-- Data-quality exceptions (Acute "Data Quality Exceptions" view)
create or replace view public.v_visit_data_quality with (security_invoker = true) as
select v.org_id, v.id as visit_id, v.external_id, v.visit_date, v.contact_id,
       (v.temp_c is null)      as missing_temp,
       (v.bp_systolic is null or v.bp_diastolic is null) as missing_bp,
       (v.spo2 is null)        as missing_spo2,
       (v.pulse is null)       as missing_pulse,
       (v.contact_id is null)  as unmatched_patient,
       (v.vitals_raw <> '{}'::jsonb and (v.temp_c is null or v.bp_systolic is null or v.spo2 is null or v.pulse is null)) as parse_failure_suspected
from public.visits v
where v.temp_c is null or v.bp_systolic is null or v.bp_diastolic is null or v.spo2 is null or v.pulse is null or v.contact_id is null;

-- Unclassified medications review (TP-19)
create or replace view public.v_unclassified_medications with (security_invoker = true) as
select p.org_id, p.medication_code, max(p.medication_name) as medication_name,
       count(*) as prescription_count, min(p.start_date) as first_seen, max(p.start_date) as last_seen,
       (select array_agg(distinct t) from public.ref_medications m, unnest(coalesce(m.all_medicine_types, '{}')) t
          where m.org_id = p.org_id and m.ddc_code = p.medication_code) as legacy_category_hint
from public.prescriptions p
where p.class = 'unclassified'
group by p.org_id, p.medication_code;

-- ---------------------------------------------------------------------------
-- RLS + updated_at
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['clinic_calendar','visits','visit_diagnoses','visit_items','contact_chronic_conditions',
                           'contact_regular_medications','prescriptions','prescription_sequences','visit_rule_evaluations'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_member', t);
    execute format('create policy %I on public.%I for all using (public.is_org_member(org_id)) with check (public.is_org_member(org_id))', t || '_member', t);
  end loop;
  foreach t in array array['clinic_calendar','visits','prescriptions','prescription_sequences','visit_rule_evaluations'] loop
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format('create trigger set_updated_at before update on public.%I for each row execute function public.set_updated_at()', t);
  end loop;
end $$;
