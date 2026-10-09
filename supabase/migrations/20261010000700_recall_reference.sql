-- Phase 8: what the recall views read that Phases 6 and 9 do not have: a patient's chronic conditions and the
-- clinic working calendar used for "working days without reply". ref_condition_groups, ref_diagnoses and
-- seed_condition_groups come from Phase 9 (20261010000400_portal_ref_tables.sql); clinical_settings, visits and
-- appointments from Phase 6.

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

select app.add_tenant_rls('contact_chronic_conditions');
select app.add_tenant_rls('clinic_calendar', 'portal.clinic_calendar.write');
