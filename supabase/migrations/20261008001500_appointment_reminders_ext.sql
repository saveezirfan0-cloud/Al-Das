-- Phase 8: promoted from supabase/drafts/0105_appointment_reminders_ext.sql (applied here because flows/recall need it before Phase 6).
-- Phase 6 extends these tables with ALTER; do not recreate.

-- 0105_appointment_reminders_ext.sql  (DRAFT — Phase 0)
-- Extensions to the docs/02 §3 appointments / appointment_reminders tables needed to replace the two
-- Make reminder scenarios (3613818, 3913219) and import Campaigns.Appointment Messages.
-- Depends on Phase 6 appointments(id, org_id, …), appointment_reminders(id, appointment_id, idx, due_at, sent_at).

-- Unite appointment status codes seen in the log (AAC, ACF, APH, CNR, CVI, YTC, NSW). Meanings: OQ-23.
create table if not exists public.unite_appointment_status_map (
  org_id      uuid not null references public.orgs(id) on delete cascade,
  code        text not null,
  status      text,                               -- appointments.status value (awaiting | confirmed | cancelled | no_show | completed | …) — null until confirmed
  label       text,
  counts_as_no_show boolean not null default false,
  primary key (org_id, code)
);

create or replace function public.seed_unite_appointment_status_map(p_org uuid)
returns void language sql set search_path = '' as $$
  insert into public.unite_appointment_status_map (org_id, code, status, label, counts_as_no_show) values
    (p_org, 'AAC', null, 'Unite code AAC (meaning to confirm)', false),
    (p_org, 'ACF', null, 'Unite code ACF (confirmed?)',         false),
    (p_org, 'APH', null, 'Unite code APH (meaning to confirm)', false),
    (p_org, 'CNR', null, 'Unite code CNR (cancelled?)',         false),
    (p_org, 'CVI', null, 'Unite code CVI (meaning to confirm)', false),
    (p_org, 'YTC', null, 'Unite code YTC (yet to confirm?)',    false),
    (p_org, 'NSW', null, 'Unite code NSW (no-show?)',           false)
  on conflict do nothing;
$$;

alter table public.appointments
  add column if not exists external_status text,                 -- raw Unite status code
  add column if not exists unite_clinic_id text;                 -- DHA licence of the branch as sent by Unite

alter table public.appointment_reminders
  add column if not exists org_id uuid references public.orgs(id) on delete cascade,
  add column if not exists unite_appointment_id text,
  add column if not exists message_id uuid references public.messages(id),
  add column if not exists status text not null default 'scheduled',   -- scheduled | sent | failed | excluded | cancelled
  add column if not exists exclusion_reason text,
  add column if not exists dedupe_key text;

-- "(appointment_id, idx)" is the natural dedupe for the 6PM scenario's Appointment ID check
create unique index if not exists appointment_reminders_dedupe on public.appointment_reminders (appointment_id, idx);

-- Exclusion lists that were hard-coded in the Make filters (OQ-21)
create table if not exists public.reminder_exclusions (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs(id) on delete cascade,
  kind        text not null check (kind in ('placeholder_name','doctor','department','location')),
  match_type  text not null default 'equals' check (match_type in ('equals','contains')),
  value       text not null,
  reason      text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (org_id, kind, match_type, value)
);

create or replace function public.seed_reminder_exclusions(p_org uuid)
returns void language sql set search_path = '' as $$
  insert into public.reminder_exclusions (org_id, kind, match_type, value, reason) values
    (p_org, 'placeholder_name', 'equals',   'SHORELINE',   'Unite placeholder booking (from Make filter)'),
    (p_org, 'placeholder_name', 'equals',   'block',       'Unite placeholder booking (from Make filter)'),
    (p_org, 'placeholder_name', 'contains', 'break',       'Unite placeholder booking (from Make filter)'),
    (p_org, 'placeholder_name', 'equals',   'golden mile', 'Unite placeholder booking (from Make filter)'),
    (p_org, 'placeholder_name', 'equals',   'meadows',     'Unite placeholder booking (from Make filter)'),
    (p_org, 'doctor', 'equals',   'Dr. Tod Cahil',       'Excluded in Make filter; reason unknown (OQ-21)'),
    (p_org, 'doctor', 'equals',   'Mariam Abdel Malek',  'Excluded in Make filter; reason unknown (OQ-21)'),
    (p_org, 'doctor', 'equals',   'Luka Ciglic',         'Excluded in Make filter; reason unknown (OQ-21)'),
    (p_org, 'doctor', 'equals',   'Mariam Hermina',      'Excluded in Make filter; reason unknown (OQ-21)'),
    (p_org, 'doctor', 'contains', 'Patricia Oliveira',   'Excluded in Make filter; reason unknown (OQ-21)')
  on conflict do nothing;
$$;

create or replace function public.is_reminder_excluded(p_org uuid, p_patient_name text, p_doctor_name text)
returns boolean language sql stable as $$
  select exists (
    select 1 from public.reminder_exclusions x
    where x.org_id = p_org and x.active
      and (
        (x.kind = 'placeholder_name' and x.match_type = 'equals'   and lower(coalesce(p_patient_name,'')) = lower(x.value)) or
        (x.kind = 'placeholder_name' and x.match_type = 'contains' and lower(coalesce(p_patient_name,'')) like '%' || lower(x.value) || '%') or
        (x.kind = 'doctor'           and x.match_type = 'equals'   and coalesce(p_doctor_name,'') = x.value) or
        (x.kind = 'doctor'           and x.match_type = 'contains' and coalesce(p_doctor_name,'') like '%' || x.value || '%')
      ));
$$;

-- Dashboard parity with the Airtable "Doctor & Department Performance" interface
create or replace view public.v_appointment_reminder_stats with (security_invoker = true) as
select a.org_id, a.location_id, a.specialist_id, a.external_status,
       date_trunc('day', r.sent_at)::date as sent_day,
       count(r.id) filter (where r.status = 'sent')     as reminders_sent,
       count(r.id) filter (where r.status = 'failed')   as reminders_failed,
       count(r.id) filter (where r.status = 'excluded') as reminders_excluded,
       count(distinct a.contact_id) as patients_contacted
from public.appointment_reminders r
join public.appointments a on a.id = r.appointment_id
group by a.org_id, a.location_id, a.specialist_id, a.external_status, date_trunc('day', r.sent_at)::date;

select app.add_tenant_rls('unite_appointment_status_map', 'appointments.manage');
select app.add_tenant_rls('reminder_exclusions',          'appointments.manage');
revoke all on function public.seed_unite_appointment_status_map(uuid), public.seed_reminder_exclusions(uuid) from public, anon, authenticated;
grant execute on function public.seed_unite_appointment_status_map(uuid), public.seed_reminder_exclusions(uuid) to service_role;
