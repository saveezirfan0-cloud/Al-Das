-- Phase 21B: chronic recall aligned with how Airtable really works (docs/21_PHASE_21B_NOTES.md).
--
-- Evidence (read live 13 Oct 2026, Airtable base app7QJ2pvhADHQeBP, Make scenario "Update Chronic" 4210055):
--   * The patient-level "Chronic Diagnosis" link (fld9gw5nJNzgywljY) was filled by Make "Update Chronic" with EVERY
--     diagnosis of every new visit, with no filter on the Diagnosis "Chronic" flag (fldIGBzWtu2QFP0Yk): 1,365
--     non-chronic codes against 37 chronic ones. Only "Chronic Recall Groups" (fldTnPcF0Y96Oe5so) made it chronic, by
--     reading "Mapped condition group", which exists only on Chronic-flagged codes.
--   * "Time Elapsed (Days)" (fld9DJRSuMhP0uyv2) counts from the patient-level Unite "Last Visit Date"
--     (fldwTnnvCipJeVvco); 150 of the 445 patients eligible today have no visit in the visits table.
--
-- So:
--   1. contact_chronic_conditions holds chronic-flagged diagnoses only. A trigger refuses any other (fail closed: a
--      blank flag is not chronic). Non-chronic rows that came from the Airtable import are deleted with their
--      external_refs (the importer now skips them); rows from any other source are left in place and are simply
--      not counted by the recall view, which reads only chronic-flagged diagnoses.
--   2. contacts.unite_last_visit_date: Unite's patient-level last visit date as a typed column (backfilled from the
--      importer's custom field, invalid dates ignored). v_contact_visit_stats uses the later of it and the latest
--      Pulse visit, and includes patients with no visit in Pulse.
--   3. v_recall_call_list: a booked patient is never on the call list.
--   4. The chronic_condition_min_visits description no longer says Unite fills the list. Not signed, value unchanged.
--
-- Not changed here (clinical decisions, OQ-104 (4)-(7)): the consent requirement of chronic_90d, once ever vs once per
-- last-visit cycle, the "60 days >" medication gate, the call-list working-day count, the min-visits value.
-- Nothing here sends a message, and no sign-off gate changes.

-- ---------------------------------------------------------------------------
-- 1. Chronic conditions are chronic-flagged diagnoses only
-- ---------------------------------------------------------------------------
create or replace function app.contact_chronic_conditions_require_chronic()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- A null diagnosis is refused by NOT NULL (after RLS, which must decide first for another org's insert).
  if new.ref_diagnosis_id is not null
     and not exists (select 1 from public.ref_diagnoses d where d.id = new.ref_diagnosis_id and d.chronic is true) then
    raise exception 'diagnosis is not flagged chronic' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function app.contact_chronic_conditions_require_chronic() from public, anon, authenticated;
-- Named so it fires after the org checks (triggers run in name order).
create trigger contact_chronic_conditions_require_chronic
  before insert or update of ref_diagnosis_id on public.contact_chronic_conditions
  for each row execute function app.contact_chronic_conditions_require_chronic();

-- Non-chronic links the Airtable import copied from the patient list: remove them and their import refs, so a
-- re-import (which now skips them) reconciles.
with gone as (
  delete from public.contact_chronic_conditions cc
   using public.ref_diagnoses d
   where d.id = cc.ref_diagnosis_id
     and cc.source = 'airtable'
     and d.chronic is not true
  returning cc.org_id, cc.id
)
delete from public.external_refs er
 using gone g
 where er.org_id = g.org_id and er.local_table = 'contact_chronic_conditions' and er.local_id = g.id;

-- ---------------------------------------------------------------------------
-- 2. Unite's patient-level last visit date
-- ---------------------------------------------------------------------------
alter table public.contacts add column if not exists unite_last_visit_date date;
comment on column public.contacts.unite_last_visit_date is
  'Unite''s patient-level Last Visit Date (any visit, any department), from the Airtable import. Chronic recall counts days from the later of this and the latest Pulse visit.';

-- YYYY-MM-DD → date, or null for anything else (never raises).
create or replace function app.safe_ymd_date(p text)
returns date
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p is null or p !~ '^\d{4}-\d{2}-\d{2}$' then
    return null;
  end if;
  return p::date;
exception when others then
  return null;
end;
$$;
revoke all on function app.safe_ymd_date(text) from public, anon, authenticated;

update public.contacts
   set unite_last_visit_date = app.safe_ymd_date(custom ->> 'last_visit_date')
 where unite_last_visit_date is null
   and app.safe_ymd_date(custom ->> 'last_visit_date') is not null;

-- Erasure scrubs the contact row: the date goes with it. A merge carries the later date to the surviving record.
-- (Triggers rather than changes to erase_contact / merge_contacts, so a later rewrite of those cannot forget it.)
create or replace function app.contacts_unite_last_visit_erase()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.erased_at is not null then
    new.unite_last_visit_date := null;
  end if;
  return new;
end;
$$;
revoke all on function app.contacts_unite_last_visit_erase() from public, anon, authenticated;
create trigger contacts_unite_last_visit_erase before update of erased_at on public.contacts
  for each row when (new.erased_at is not null) execute function app.contacts_unite_last_visit_erase();

create or replace function app.contacts_unite_last_visit_merge()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.merged_into_id is not null and new.merged_into_id is distinct from old.merged_into_id
     and new.unite_last_visit_date is not null then
    update public.contacts
       set unite_last_visit_date = greatest(unite_last_visit_date, new.unite_last_visit_date)
     where org_id = new.org_id and id = new.merged_into_id
       and unite_last_visit_date is distinct from greatest(unite_last_visit_date, new.unite_last_visit_date);
  end if;
  return new;
end;
$$;
revoke all on function app.contacts_unite_last_visit_merge() from public, anon, authenticated;
create trigger contacts_unite_last_visit_merge after update of merged_into_id on public.contacts
  for each row execute function app.contacts_unite_last_visit_merge();

-- ---------------------------------------------------------------------------
-- 3. Views
-- ---------------------------------------------------------------------------
-- Per-contact visit statistics. last_visit_date = the later of the latest Pulse visit and Unite's patient-level date;
-- a patient with only the Unite date has visit_count 0. Same columns as before, two appended.
create or replace view public.v_contact_visit_stats with (security_invoker = true) as
with pulse as (
  select v.org_id, v.contact_id,
         min(v.visit_date) as first_visit_date,
         max(v.visit_date) as last_visit_date,
         count(*)::int as visit_count
  from public.visits v
  where v.contact_id is not null and not v.is_test_record
  group by v.org_id, v.contact_id
),
unite as (
  select c.org_id, c.id as contact_id, c.unite_last_visit_date
  from public.contacts c
  where c.unite_last_visit_date is not null
)
select coalesce(p.org_id, u.org_id) as org_id,
       coalesce(p.contact_id, u.contact_id) as contact_id,
       p.first_visit_date,
       greatest(p.last_visit_date, u.unite_last_visit_date) as last_visit_date,
       (current_date - greatest(p.last_visit_date, u.unite_last_visit_date))::int as days_since_last_visit,
       coalesce(p.visit_count, 0) as visit_count,
       p.last_visit_date as pulse_last_visit_date,
       u.unite_last_visit_date
from pulse p
full join unite u on u.contact_id = p.contact_id and u.org_id = p.org_id;

-- Chronic recall eligibility (R-20…R-22). Only chronic-flagged diagnoses count, whichever source wrote the row.
-- Threshold from clinical_settings (fail closed: NULL → nobody eligible). Same columns as before.
create or replace view public.v_chronic_recall_eligibility with (security_invoker = true) as
with groups as (
  select cc.org_id, cc.contact_id,
         array_agg(distinct g.key order by g.key) as all_group_keys,
         (array_agg(g.key order by g.sort, g.key) filter (where g.messageable))[1] as primary_condition_group,
         array_remove(array_agg(distinct case when g.messageable then g.key end), null) as messageable_groups
  from public.contact_chronic_conditions cc
  join public.ref_diagnoses d on d.id = cc.ref_diagnosis_id
  join public.ref_condition_groups g on g.id = d.condition_group_id
  where d.chronic is true
  group by cc.org_id, cc.contact_id
),
prog as (select id, org_id from public.recall_programmes where key = 'chronic_90d')
select c.org_id, c.id as contact_id,
       s.last_visit_date, s.days_since_last_visit,
       g.primary_condition_group, g.messageable_groups,
       public.clinical_setting_num(c.org_id, 'chronic_recall_min_days') as min_days,
       (s.last_visit_date::text) as cycle_key,
       (   c.phone_e164 is not null
       and not coalesce(c.stop_marketing, false)
       and not coalesce(c.is_test_record, false)
       and g.primary_condition_group is not null
       and public.clinical_setting_num(c.org_id, 'chronic_recall_min_days') is not null
       and s.days_since_last_visit >= public.clinical_setting_num(c.org_id, 'chronic_recall_min_days')
       and not exists (select 1 from public.recall_sends rs join prog p on p.id = rs.programme_id
                       where rs.contact_id = c.id and rs.cycle_key = s.last_visit_date::text
                         and rs.status not in ('cancelled','failed'))
       ) as eligible
from public.contacts c
join public.v_contact_visit_stats s on s.contact_id = c.id and s.org_id = c.org_id
join groups g on g.contact_id = c.id and g.org_id = c.org_id;

-- Care-coordinator call list (R-24, R-25). A booked patient is never on it (booked_at set by the reply webhook or a
-- person), whatever the follow-up status says. Same columns as before.
create or replace view public.v_recall_call_list with (security_invoker = true) as
select rs.org_id, rs.id as recall_send_id, rs.programme_id, rs.contact_id, rs.segment_key,
       rs.sent_at, rs.follow_up_status, rs.assigned_user_id,
       rs.days_since_last_visit_at_send, rs.last_visit_date_at_send,
       case when rs.replied_at is null then ((now() at time zone 'Asia/Dubai')::date - (rs.sent_at at time zone 'Asia/Dubai')::date) end as days_waiting,
       public.workdays_between(rs.org_id, (rs.sent_at at time zone 'Asia/Dubai')::date, (now() at time zone 'Asia/Dubai')::date) as workdays_waiting,
       (   rs.send_mode = 'live'
       and rs.status in ('sent','delivered','read')
       and rs.replied_at is null
       and rs.booked_at is null
       and rs.follow_up_status is distinct from 'booked'
       and public.clinical_setting_num(rs.org_id, 'recall_followup_workdays') is not null
       and public.workdays_between(rs.org_id, (rs.sent_at at time zone 'Asia/Dubai')::date, (now() at time zone 'Asia/Dubai')::date)
             >= public.clinical_setting_num(rs.org_id, 'recall_followup_workdays')
       ) as call_now,
       (rs.days_since_last_visit_at_send > public.clinical_setting_num(rs.org_id, 'chronic_recall_overdue_days')) as overdue
from public.recall_sends rs
where rs.sent_at is not null;

-- ---------------------------------------------------------------------------
-- 4. chronic_condition_min_visits: corrected description (not signed, value unchanged)
-- ---------------------------------------------------------------------------
create or replace function public.seed_clinical_settings_phase21(p_org uuid)
returns void
language sql
set search_path = ''
as $$
  insert into public.clinical_settings
    (org_id, key, label, category, value_type, proposed_value, live_value, sign_off_status, owner, notes, source)
  values
    (p_org, 'chronic_condition_min_visits', 'Chronic condition: visits with the diagnosis before it counts', 'recall', 'number',
     '1', null, 'awaiting', 'Abdul / Snezana',
     'Phase 21. A diagnosis flagged Chronic in the Diagnosis reference becomes one of the patient''s chronic conditions (and so a reason for chronic recall) once it has been coded on this many separate visits. In Airtable the patient-level Chronic Diagnosis list was filled from visits by the Make scenario "Update Chronic" (every diagnosis of every new visit, no Chronic filter); only Chronic-flagged codes counted for recall, and one coded visit was enough. Pulse imports only the Chronic-flagged links. Proposed 1 = any coded chronic diagnosis (as Airtable). Nothing is derived until this is signed off (OQ-104).',
     'pulse')
  on conflict (org_id, key) do nothing;
$$;
revoke all on function public.seed_clinical_settings_phase21(uuid) from public, anon, authenticated;
grant execute on function public.seed_clinical_settings_phase21(uuid) to service_role;

-- Existing workspaces: only rows still carrying the original text (a person's edits are left alone).
update public.clinical_settings
   set notes = 'Phase 21. A diagnosis flagged Chronic in the Diagnosis reference becomes one of the patient''s chronic conditions (and so a reason for chronic recall) once it has been coded on this many separate visits. In Airtable the patient-level Chronic Diagnosis list was filled from visits by the Make scenario "Update Chronic" (every diagnosis of every new visit, no Chronic filter); only Chronic-flagged codes counted for recall, and one coded visit was enough. Pulse imports only the Chronic-flagged links. Proposed 1 = any coded chronic diagnosis (as Airtable). Nothing is derived until this is signed off (OQ-104).'
 where key = 'chronic_condition_min_visits'
   and notes = 'Phase 21. A diagnosis flagged Chronic in the Diagnosis reference becomes one of the patient''s chronic conditions (and so a reason for chronic recall) once it has been coded on this many separate visits. The Unite base kept a patient-level Chronic Diagnosis list instead, and how Unite fills it is not documented. Proposed 1 = any coded chronic diagnosis. Nothing is derived until this is signed off (OQ-104).';
