-- Phase 9: clinical reference tables (promoted from supabase/drafts/0100_clinical_reference.sql).
-- ref_condition_groups, ref_diagnoses, ref_medications, ref_items and seed_condition_groups().
-- The helpers (app.has_perm_wild, app.add_tenant_rls), ref_medication_classes and clinical_settings
-- already exist from Phase 6 (20261009000900_rls_helpers, 20261009000950_clinical_core), so they are
-- not repeated here. Reference data is written by the importer / Unite sync (service role) and, in
-- the portal, through lib/portal/service after a can() check; staff members only read it via RLS.

-- ---------------------------------------------------------------------------
-- ref_condition_groups — "Mapped condition group" (Unite.Diagnosis fldyz11Dj5wK2y2S8)
-- messageable=false for the mental-health groups that Chronic Recall Groups strips.
-- ---------------------------------------------------------------------------
create table if not exists public.ref_condition_groups (
  id                           uuid primary key default gen_random_uuid(),
  org_id                       uuid not null references public.orgs(id) on delete cascade,
  key                          text not null,                 -- stable snake_case key used as recall segment_key
  name                         text not null,                 -- Airtable choice name, verbatim
  messageable                  boolean not null default true,
  sort                         int  not null default 100,     -- primary-condition priority (OQ-15)
  follow_up_interval_days      int,                           -- "Every 3 months" → 90
  regular_medication_examples  text,
  monitoring_labs_cpt          text,
  monitoring_procedures_cpt    text,
  typical_visit_cpt            text,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  unique (org_id, key),
  unique (org_id, name)
);

-- ---------------------------------------------------------------------------
-- ref_diagnoses — Unite.Diagnosis (tblZqf4Zcw5Kweadh), ICD-10 FY2026
-- ---------------------------------------------------------------------------
create table if not exists public.ref_diagnoses (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.orgs(id) on delete cascade,
  code                 text not null,                          -- fldld9DKnsoLK9ADK
  short_description    text,                                   -- fldlgGXBFovQBgr7N
  long_description     text,                                   -- fldXgTWsfTbPrlreE
  chronic              boolean not null default false,         -- fldIGBzWtu2QFP0Yk
  top30                boolean not null default false,         -- fldFVPiTP5g4AGaV2
  condition_group_id   uuid references public.ref_condition_groups(id),
  not_found_in_unite   boolean not null default false,         -- fldgC3rVdSM5ehgtQ "NF" (OQ-27)
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, code)
);
create index if not exists ref_diagnoses_group_idx on public.ref_diagnoses (org_id, condition_group_id) where chronic;

-- ---------------------------------------------------------------------------
-- ref_medications — Unite.Medication (tblLM2BXjA680GQws), DDC/local codes
-- ---------------------------------------------------------------------------
create table if not exists public.ref_medications (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.orgs(id) on delete cascade,
  ddc_code             text not null,                          -- fld7kgxlA3c0kjFdW (Unite local code)
  trade_name           text,                                   -- fldvBHlyQEFGX1UFS
  status               text,                                   -- fldDwPzpHS7bHGZbj
  scientific_code      text,                                   -- fld6erxHG8rlNl7Zr
  scientific_name      text,                                   -- fldIea5PEr6Tk50tY
  strength             text,                                   -- fldsXKIf7k6HF3jhW
  dosage_form          text,                                   -- fld7ovnGh11wewXqw
  route                text,                                   -- flduJNhd0tBaFqDoT
  package_price        numeric(12,2),                          -- fldQPwna6WcQkIsrb
  granular_unit        text,                                   -- fldGFRp4X68CfAO6k
  registered_owner     text,                                   -- fldlWj6a725a6l54H
  source_updated_on    date,                                   -- fldGvn9X6b6sNY9Xi
  source               text,                                   -- fldkhVVFyNnSz5T4n
  is_ebp               boolean,                                -- fldQQsGZMJDEmcIkL
  medicine_type        text,                                   -- fldOr4Wf4rSrjTDwV  (advisory only, R-05)
  all_medicine_types   text[],                                 -- fld15ltyTEfiugYam  split on ' + '
  icd_codes            text,                                   -- fldma2rcVXZDIDsuY
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, ddc_code)
);

-- ---------------------------------------------------------------------------
-- ref_items — Unite.Items (tblTJtk6aIMbwpoA2) merged with PTF.CPT Master (tblopYbHPAbTi4QeX)
-- ---------------------------------------------------------------------------
create table if not exists public.ref_items (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references public.orgs(id) on delete cascade,
  code                    text not null,                       -- fld0i0BQItTWZpTm5 / fldjaLpahs9NgSFAF
  description             text,                                -- fldB4i14uDiaFt0Qv / fldX4POEMd2VY8FKc
  item_type               text,                                -- fldDUW6cM6saCg5m8 normalised (TEST, RADIOLOGY, PROCEDURES, DRUGS, VACCINE, CONSUMABLES, SERVICE, …)
  test_category           text,                                -- fldqsVvaiGRe59o9w (CPT Master)
  patient_message_group   text,                                -- fldyLyowekQPhpFnr (CPT Master)
  doctor_verified         boolean not null default false,      -- fldi4vFfiPdSU7ZxC "must be checked by a doctor before use in live automations"
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (org_id, code)
);

-- RLS: members read; no direct write policy (service role only, like the other sync-owned tables).
select app.add_tenant_rls('ref_condition_groups');
select app.add_tenant_rls('ref_diagnoses');
select app.add_tenant_rls('ref_medications');
select app.add_tenant_rls('ref_items');

-- ---------------------------------------------------------------------------
-- Seed helper: condition groups (names verbatim from the Airtable select).
-- Run per org from the importer: select public.seed_condition_groups('<org uuid>');
-- ---------------------------------------------------------------------------
create or replace function public.seed_condition_groups(p_org uuid)
returns void language sql set search_path = '' as $$
  insert into public.ref_condition_groups (org_id, key, name, messageable, sort, follow_up_interval_days)
  values
    (p_org, 'hypertension',   'Hypertension / Hypertensive disease',  true,  10, 90),
    (p_org, 'diabetes',       'Diabetes mellitus (Type 1/2/other)',    true,  20, 90),
    (p_org, 'hyperlipidemia', 'Hyperlipidemia',                        true,  30, 90),
    (p_org, 'hypothyroidism', 'Hypothyroidism',                        true,  40, 90),
    (p_org, 'ckd',            'Chronic kidney disease',                true,  50, 90),
    (p_org, 'asthma',         'Asthma',                                true,  60, 90),
    (p_org, 'copd',           'COPD',                                  true,  70, 90),
    (p_org, 'ra',             'Rheumatoid arthritis',                  true,  80, 90),
    (p_org, 'af',             'Atrial fibrillation / flutter',         true,  90, 90),
    (p_org, 'epilepsy',       'Epilepsy',                              true, 100, 90),
    (p_org, 'depression',     'Depression (major)',                    false, 900, 90),  -- never messaged (R-20, OQ-25)
    (p_org, 'anxiety',        'Anxiety disorders',                     false, 910, 90)   -- never messaged
  on conflict (org_id, key) do nothing;
$$;
revoke all on function public.seed_condition_groups(uuid) from public, anon, authenticated;
grant execute on function public.seed_condition_groups(uuid) to service_role;
