-- Phase 8: the clinical reference data the recall views read, which Phase 6's clinical_core did not include:
-- condition groups (which chronic conditions are messageable, in which priority), the ICD-10 diagnosis list,
-- a patient's chronic conditions, and the clinic working calendar used for "working days without reply".
-- Phase 6 tables (visits, clinical_settings, appointments, ...) are NOT touched here.

create table if not exists public.ref_condition_groups (
  id                           uuid primary key default gen_random_uuid(),
  org_id                       uuid not null references public.orgs(id) on delete cascade,
  key                          text not null,                 -- stable snake_case key used as recall segment_key
  name                         text not null,                 -- Airtable choice name, verbatim
  messageable                  boolean not null default true, -- false for the mental-health groups Chronic Recall Groups strips
  sort                         int  not null default 100,     -- primary-condition priority (OQ-15)
  follow_up_interval_days      int,                           -- "Every 3 months" -> 90
  regular_medication_examples  text,
  monitoring_labs_cpt          text,
  monitoring_procedures_cpt    text,
  typical_visit_cpt            text,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  unique (org_id, key),
  unique (org_id, name)
);

create table if not exists public.ref_diagnoses (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.orgs(id) on delete cascade,
  code                 text not null,
  short_description    text,
  long_description     text,
  chronic              boolean not null default false,
  top30                boolean not null default false,
  condition_group_id   uuid references public.ref_condition_groups(id),
  not_found_in_unite   boolean not null default false,         -- "NF" (OQ-27)
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, code)
);
create index if not exists ref_diagnoses_group_idx on public.ref_diagnoses (org_id, condition_group_id) where chronic;

create table if not exists public.contact_chronic_conditions (
  org_id            uuid not null references public.orgs(id) on delete cascade,
  contact_id        uuid not null references public.contacts(id) on delete cascade,
  ref_diagnosis_id  uuid not null references public.ref_diagnoses(id),
  source            text not null default 'unite',
  noted_at          date,
  primary key (contact_id, ref_diagnosis_id)
);

create table if not exists public.clinic_calendar (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.orgs(id) on delete cascade,
  location_id       uuid references public.locations(id) on delete cascade,   -- null = org default
  working_weekdays  int[] not null default '{1,2,3,4,5,6}',                     -- ISO: 1=Mon ... 7=Sun
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
    extract(isodow from p_day)::int between 1 and 5);   -- no calendar row: Mon-Fri (documented fallback)
$$;

create or replace function public.workdays_between(p_org uuid, p_from date, p_to date, p_location uuid default null)
returns int language sql stable as $$
  select count(*)::int from generate_series(p_from + 1, p_to, interval '1 day') g
  where public.is_working_day(p_org, g::date, p_location);
$$;

select app.add_tenant_rls('ref_condition_groups');
select app.add_tenant_rls('ref_diagnoses');
select app.add_tenant_rls('contact_chronic_conditions');
select app.add_tenant_rls('clinic_calendar', 'portal.clinic_calendar.write');

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
