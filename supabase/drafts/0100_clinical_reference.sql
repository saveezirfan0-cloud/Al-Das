-- 0100_clinical_reference.sql  (DRAFT — Phase 0, aligned with Phase 1 conventions)
-- Reference tables for the clinical engine and recall programmes.
-- Depends on Phase 1: app.set_updated_at(), app.is_org_member(uuid), app.has_perm(uuid, text), orgs.
-- Source mapping: docs/audit/data-model-mapping.md §1.3–1.5, §3.3, §5.6.

-- ---------------------------------------------------------------------------
-- app.has_perm_wild — like app.has_perm (Phase 1) but honours the prefix wildcards that
-- lib/auth/can.ts already understands: '*', 'portal.*' (any portal object, read or write) and
-- 'portal.*.read' (read on any object). Phase 1's SQL has_perm matches exact keys only (OQ-47).
-- ---------------------------------------------------------------------------
create or replace function app.has_perm_wild(p_org_id uuid, p_perm text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    join public.roles r on r.id = m.role_id
    cross join lateral jsonb_array_elements_text(r.permissions) as perm(key)
    where m.org_id = p_org_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and (
        perm.key = '*'
        or perm.key = p_perm
        -- 'portal.*'  matches 'portal.<anything>' (one or more segments)
        or (perm.key like '%.*' and p_perm like replace(perm.key, '.*', '.%'))
        -- 'portal.*.read' matches 'portal.<one segment>.read'
        or (perm.key like '%.*.%' and p_perm ~ ('^' || replace(replace(perm.key, '.', '\.'), '*', '[^.]+') || '$'))
      )
  );
$$;
grant execute on function app.has_perm_wild(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Shared helper: tenant RLS in the Phase 1 style (per-operation policies, `to authenticated`).
--   select  → any active org member
--   writes  → app.has_perm_wild(org_id, p_write_perm) when a permission key is given;
--             otherwise no write policy (server-side / service role only, like the jobs tables)
-- Also installs the updated_at trigger when the table has that column.
-- ---------------------------------------------------------------------------
create or replace function app.add_tenant_rls(p_table text, p_write_perm text default null)
returns void
language plpgsql
set search_path = ''
as $$
begin
  execute format('alter table public.%I enable row level security', p_table);
  execute format('drop policy if exists %I on public.%I', p_table || '_select', p_table);
  execute format('create policy %I on public.%I for select to authenticated using (app.is_org_member(org_id))',
                 p_table || '_select', p_table);
  execute format('drop policy if exists %I on public.%I', p_table || '_insert', p_table);
  execute format('drop policy if exists %I on public.%I', p_table || '_update', p_table);
  execute format('drop policy if exists %I on public.%I', p_table || '_delete', p_table);
  if p_write_perm is not null then
    execute format('create policy %I on public.%I for insert to authenticated with check (app.has_perm_wild(org_id, %L))',
                   p_table || '_insert', p_table, p_write_perm);
    execute format('create policy %I on public.%I for update to authenticated using (app.has_perm_wild(org_id, %L)) with check (app.has_perm_wild(org_id, %L))',
                   p_table || '_update', p_table, p_write_perm, p_write_perm);
    execute format('create policy %I on public.%I for delete to authenticated using (app.has_perm_wild(org_id, %L))',
                   p_table || '_delete', p_table, p_write_perm);
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = p_table and column_name = 'updated_at') then
    execute format('drop trigger if exists %I on public.%I', p_table || '_set_updated_at', p_table);
    execute format('create trigger %I before update on public.%I for each row execute function app.set_updated_at()',
                   p_table || '_set_updated_at', p_table);
  end if;
end;
$$;

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

-- ---------------------------------------------------------------------------
-- ref_medication_classes — Acute.Medication Reference (tblIxa5xUOG3GRwmt)
-- "Classify by CODE not name. Unknown codes must FAIL CLOSED - no sequence fires."
-- ---------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_type where typname = 'medication_class') then
    create type public.medication_class as enum
      ('antibiotic','steroid','probiotic','supplement','enzyme','other','unclassified');
  end if;
end $$;

create table if not exists public.ref_medication_classes (
  id                           uuid primary key default gen_random_uuid(),
  org_id                       uuid not null references public.orgs(id) on delete cascade,
  unite_local_code             text not null,                  -- fld8IyFkiQC3VrDpH
  medication_name              text,                           -- fldBmjJIDVEFm6gbW
  class                        public.medication_class not null default 'unclassified', -- fldHUcvmoD8Sy8Yia
  requires_probiotics_default  boolean not null default false, -- fldUVPyOsylLribKr
  classified_by                text,                           -- fldDSObi3AgyZAX3U ('heuristic' = suggestion only)
  classified_at                timestamptz,
  notes                        text,                           -- fldSuHUA4YgNPovVI
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  unique (org_id, unite_local_code),
  -- a heuristic suggestion can never be an effective classification
  constraint heuristic_is_unclassified
    check (classified_by is distinct from 'heuristic' or class = 'unclassified')
);

-- ---------------------------------------------------------------------------
-- RLS. Reference data is written by the importer / Unite sync (service role) only;
-- medication classes are maintained by clinicians in the portal.
-- ---------------------------------------------------------------------------
select app.add_tenant_rls('ref_condition_groups');
select app.add_tenant_rls('ref_diagnoses');
select app.add_tenant_rls('ref_medications');
select app.add_tenant_rls('ref_items');
select app.add_tenant_rls('ref_medication_classes', 'portal.medication_classes.write');

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
