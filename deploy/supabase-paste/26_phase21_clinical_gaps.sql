-- Paste into Supabase > SQL Editor > New query, then Run. Needs 22_finance_flash.sql applied first.
-- The migration-history line is included at the bottom of this file.

-- Phase 21, part 1: the Make / Airtable replacement gaps that need no new data from the clinic
-- (docs/20_FINANCE_CONTROL_PLAN.md slice 21 items 2, 3, 5 and 6; docs/21_PHASE_21A_NOTES.md).
--
--   * visit_diagnoses: the ICD-10 codes of each visit (Unite feed or the Airtable import), linked to ref_diagnoses
--     when the code is known. PHI: read needs portal.clinical_visits.read; written by server code only.
--   * contact_chronic_conditions gains an id, evidence columns and PHI-gated RLS (it was readable by every member).
--     It is filled by the Airtable import (the Unite base's patient-level "Chronic Diagnosis" list) and DERIVED from
--     visit_diagnoses by the pure rule lib/clinical/chronic.ts; clinical_apply_chronic_conditions() writes the result.
--   * clinical setting chronic_condition_min_visits (awaiting sign-off: nothing is derived until it is signed, OQ-102).
--   * Prescription sequences: clinical_prescriptions_needing_sequence() + clinical_create_sequence() create the
--     prescription_sequences row and its scheduled_jobs (kind clinical.sequence_step) in one transaction, once.
--     The steps run on the new `clinical` queue and go through the clinical messaging gate (still OFF).
--   * Data quality: v_visit_data_quality gains is_test_record and doctor_name; new v_unknown_diagnosis_codes.
--   * Reports (counts only): v_appointment_reminder_stats gains delivered / read / replied and buckets by the org's
--     day; report_reminder_stats_*, report_recall_week, report_clinical_followup_load, report_clinical_red_flags,
--     report_clinical_data_quality.
--   * parallel_run_scenarios: the token / mrd_sync / chronic_recall seed rows no longer cite unbuilt phases.
--
-- Nothing here sends a message, and no sign-off gate changes.

-- ---------------------------------------------------------------------------
-- 1. visit_diagnoses
-- ---------------------------------------------------------------------------
create table public.visit_diagnoses (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.orgs (id) on delete cascade,
  visit_id          uuid not null references public.visits (id) on delete cascade,
  contact_id        uuid references public.contacts (id) on delete set null,     -- kept equal to visits.contact_id (trigger)
  ref_diagnosis_id  uuid references public.ref_diagnoses (id) on delete set null, -- null = code not in the reference (yet)
  diagnosis_code    text not null,                                               -- ICD-10 as delivered, trimmed, upper case
  is_primary        boolean not null default false,
  source            text not null default 'unite' check (source in ('unite', 'airtable', 'manual')),
  visit_date        date not null,                                               -- kept equal to visits.visit_date (trigger)
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (visit_id, diagnosis_code),
  constraint visit_diagnoses_code_shape check (diagnosis_code <> '' and diagnosis_code = upper(btrim(diagnosis_code)))
);
create index visit_diagnoses_contact_idx on public.visit_diagnoses (org_id, contact_id);
create index visit_diagnoses_ref_idx on public.visit_diagnoses (org_id, ref_diagnosis_id);
create index visit_diagnoses_unknown_idx on public.visit_diagnoses (org_id, diagnosis_code) where ref_diagnosis_id is null;
create index if not exists ref_diagnoses_upper_code_idx on public.ref_diagnoses (org_id, upper(code));

create trigger visit_diagnoses_visit_org_check before insert or update of visit_id, org_id on public.visit_diagnoses
  for each row execute function app.check_parent_org('visits', 'visit_id');
create trigger visit_diagnoses_contact_org_check before insert or update of contact_id, org_id on public.visit_diagnoses
  for each row execute function app.check_parent_org('contacts', 'contact_id');
create trigger visit_diagnoses_ref_org_check before insert or update of ref_diagnosis_id, org_id on public.visit_diagnoses
  for each row execute function app.check_parent_org('ref_diagnoses', 'ref_diagnosis_id');

-- PHI: reads need the clinical-visits permission; no write policy (the ingest path and the importer use the service role).
select app.add_tenant_rls_gated('visit_diagnoses', 'portal.clinical_visits.read');

-- A visit linked to its patient later (Sync Review) or re-dated by the feed carries its diagnoses along.
create or replace function app.sync_visit_diagnoses_from_visit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.visit_diagnoses
     set contact_id = new.contact_id, visit_date = new.visit_date
   where visit_id = new.id
     and (contact_id is distinct from new.contact_id or visit_date is distinct from new.visit_date);
  return new;
end;
$$;
revoke all on function app.sync_visit_diagnoses_from_visit() from public, anon, authenticated;
create trigger visits_sync_diagnoses after update of contact_id, visit_date on public.visits
  for each row when (old.contact_id is distinct from new.contact_id or old.visit_date is distinct from new.visit_date)
  execute function app.sync_visit_diagnoses_from_visit();

-- ---------------------------------------------------------------------------
-- 2. contact_chronic_conditions: id, evidence, PHI-gated RLS
-- ---------------------------------------------------------------------------
alter table public.contact_chronic_conditions
  add column if not exists id uuid not null default gen_random_uuid(),
  add column if not exists evidence_visits integer,
  add column if not exists last_seen_on date,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();
create unique index if not exists contact_chronic_conditions_id_uidx on public.contact_chronic_conditions (id);
create index if not exists contact_chronic_conditions_org_idx on public.contact_chronic_conditions (org_id, contact_id);
alter table public.contact_chronic_conditions
  add constraint contact_chronic_conditions_source_check
    check (source in ('unite', 'airtable', 'visit_diagnoses', 'manual')),
  add constraint contact_chronic_conditions_evidence_check
    check (evidence_visits is null or evidence_visits >= 1);

create trigger contact_chronic_conditions_contact_org_check before insert or update of contact_id, org_id on public.contact_chronic_conditions
  for each row execute function app.check_parent_org('contacts', 'contact_id');
create trigger contact_chronic_conditions_ref_org_check before insert or update of ref_diagnosis_id, org_id on public.contact_chronic_conditions
  for each row execute function app.check_parent_org('ref_diagnoses', 'ref_diagnosis_id');

-- Chronic diagnoses are health data. Phase 8 let every member read them; now the same key as visits.
-- Replaces the Phase 8 policies (and installs the updated_at trigger now that the column exists).
select app.add_tenant_rls_gated('contact_chronic_conditions', 'portal.clinical_visits.read');

-- ---------------------------------------------------------------------------
-- 3. Clinical setting for the derivation rule (awaiting sign-off; fails closed until signed)
-- ---------------------------------------------------------------------------
alter function public.seed_clinical_settings(uuid) rename to seed_clinical_settings_phase6;

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
     'Phase 21. A diagnosis flagged Chronic in the Diagnosis reference becomes one of the patient''s chronic conditions (and so a reason for chronic recall) once it has been coded on this many separate visits. The Unite base kept a patient-level Chronic Diagnosis list instead, and how Unite fills it is not documented. Proposed 1 = any coded chronic diagnosis. Nothing is derived until this is signed off (OQ-102).',
     'pulse')
  on conflict (org_id, key) do nothing;
$$;

create or replace function public.seed_clinical_settings(p_org uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform public.seed_clinical_settings_phase6(p_org);
  perform public.seed_clinical_settings_phase21(p_org);
end;
$$;
revoke all on function public.seed_clinical_settings_phase6(uuid) from public, anon, authenticated;
revoke all on function public.seed_clinical_settings_phase21(uuid) from public, anon, authenticated;
revoke all on function public.seed_clinical_settings(uuid) from public, anon, authenticated;
grant execute on function public.seed_clinical_settings_phase6(uuid) to service_role;
grant execute on function public.seed_clinical_settings_phase21(uuid) to service_role;
grant execute on function public.seed_clinical_settings(uuid) to service_role;

-- Workspaces that already have clinical settings get the new row (awaiting sign-off) now.
select public.seed_clinical_settings_phase21(s.org_id)
from (select distinct org_id from public.clinical_settings) s;

-- ---------------------------------------------------------------------------
-- 4. Ingest: store a visit's diagnosis codes; link codes that reached the reference later
-- ---------------------------------------------------------------------------
-- p_codes: [{"code": "I10", "is_primary": true}, ...] (lib/clinical/ingest.ts ingestDiagnosisCodes). Replaces the
-- visit's rows from the same source; idempotent. Unknown codes are stored with ref_diagnosis_id null (fail closed:
-- they never make a condition chronic) and listed on the Data quality screen.
create or replace function public.clinical_store_visit_diagnoses(p_org uuid, p_visit uuid, p_codes jsonb, p_source text default 'unite')
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_contact uuid;
  v_date date;
  v_codes text[];
  v_primary boolean[];
  v_removed integer;
  v_stored integer;
begin
  if p_source not in ('unite', 'airtable', 'manual') then
    raise exception 'unknown diagnosis source %', p_source using errcode = '22023';
  end if;
  if jsonb_typeof(p_codes) is distinct from 'array' then
    raise exception 'p_codes must be a JSON array' using errcode = '22023';
  end if;
  select v.contact_id, v.visit_date into v_contact, v_date
  from public.visits v where v.id = p_visit and v.org_id = p_org;
  if not found then
    raise exception 'visit not found' using errcode = 'P0002';
  end if;

  select coalesce(array_agg(t.code order by t.code), '{}'), coalesce(array_agg(t.is_primary order by t.code), '{}')
    into v_codes, v_primary
  from (
    select upper(btrim(x ->> 'code')) as code, bool_or(coalesce((x ->> 'is_primary')::boolean, false)) as is_primary
    from jsonb_array_elements(p_codes) x
    where nullif(btrim(coalesce(x ->> 'code', '')), '') is not null
    group by 1
  ) t;

  delete from public.visit_diagnoses d
   where d.visit_id = p_visit and d.org_id = p_org and d.source = p_source
     and not (d.diagnosis_code = any (v_codes));
  get diagnostics v_removed = row_count;

  insert into public.visit_diagnoses as vd
    (org_id, visit_id, contact_id, ref_diagnosis_id, diagnosis_code, is_primary, source, visit_date)
  select p_org, p_visit, v_contact,
         (select r.id from public.ref_diagnoses r where r.org_id = p_org and upper(r.code) = c.code limit 1),
         c.code, c.is_primary, p_source, v_date
  from unnest(v_codes, v_primary) as c (code, is_primary)
  on conflict (visit_id, diagnosis_code) do update
     set ref_diagnosis_id = excluded.ref_diagnosis_id,
         is_primary = excluded.is_primary,
         contact_id = excluded.contact_id,
         visit_date = excluded.visit_date
   where (vd.ref_diagnosis_id, vd.is_primary, vd.contact_id, vd.visit_date)
         is distinct from (excluded.ref_diagnosis_id, excluded.is_primary, excluded.contact_id, excluded.visit_date);
  get diagnostics v_stored = row_count;

  return jsonb_build_object(
    'codes', coalesce(array_length(v_codes, 1), 0),
    'written', v_stored,
    'removed', v_removed,
    'unknown', (select count(*) from public.visit_diagnoses d
                 where d.visit_id = p_visit and d.org_id = p_org and d.ref_diagnosis_id is null));
end;
$$;

-- Codes stored before the Diagnosis reference had them (a new code from Unite) are linked here, nightly.
create or replace function public.clinical_resolve_visit_diagnoses(p_org uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_n integer;
begin
  update public.visit_diagnoses vd
     set ref_diagnosis_id = r.id
    from public.ref_diagnoses r
   where vd.org_id = p_org and vd.ref_diagnosis_id is null
     and r.org_id = p_org and upper(r.code) = vd.diagnosis_code;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Chronic conditions: facts for the pure rule, and the idempotent writer
-- ---------------------------------------------------------------------------
-- One row per patient + chronic-flagged diagnosis over the patient's non-test visits. Ids, dates and counts only.
create or replace function public.clinical_chronic_facts(p_org uuid, p_contacts uuid[] default null)
returns table (contact_id uuid, ref_diagnosis_id uuid, chronic boolean, visit_count integer,
               first_visit_date date, last_visit_date date)
language sql
stable
set search_path = ''
as $$
  select v.contact_id, vd.ref_diagnosis_id, d.chronic, count(distinct v.id)::integer,
         min(v.visit_date), max(v.visit_date)
  from public.visit_diagnoses vd
  join public.visits v on v.id = vd.visit_id and v.org_id = p_org
  join public.ref_diagnoses d on d.id = vd.ref_diagnosis_id and d.org_id = p_org
  where vd.org_id = p_org
    and v.contact_id is not null
    and not v.is_test_record
    and d.chronic
    and (p_contacts is null or v.contact_id = any (p_contacts))
  group by v.contact_id, vd.ref_diagnosis_id, d.chronic
  order by v.contact_id, vd.ref_diagnosis_id;
$$;

-- Writes what lib/clinical/chronic.ts derived. Derived rows (source 'visit_diagnoses') that the rule no longer
-- returns are removed; rows from Unite / the Airtable import / a person are never removed here (their evidence
-- columns are refreshed when the rule also finds them). p_contacts limits the run to some patients (after one
-- visit is ingested); null = the whole organisation. Rows that fail the org / chronic check are rejected.
create or replace function public.clinical_apply_chronic_conditions(p_org uuid, p_rows jsonb, p_contacts uuid[] default null)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_removed integer;
  v_inserted integer;
  v_updated integer;
  v_valid integer;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'p_rows must be a JSON array' using errcode = '22023';
  end if;

  -- One statement: the rows removed (derived, no longer returned) and the rows upserted are disjoint sets.
  with input as (
    select (r ->> 'contact_id')::uuid as contact_id, (r ->> 'ref_diagnosis_id')::uuid as ref_diagnosis_id,
           (r ->> 'noted_at')::date as noted_at, (r ->> 'last_seen_on')::date as last_seen_on,
           (r ->> 'evidence_visits')::integer as evidence_visits
    from jsonb_array_elements(p_rows) r
  ),
  valid as (
    select distinct on (i.contact_id, i.ref_diagnosis_id) i.*
    from input i
    join public.contacts c on c.id = i.contact_id and c.org_id = p_org
    join public.ref_diagnoses d on d.id = i.ref_diagnosis_id and d.org_id = p_org and d.chronic
    where i.evidence_visits >= 1
      and (p_contacts is null or i.contact_id = any (p_contacts))
    order by i.contact_id, i.ref_diagnosis_id, i.evidence_visits desc
  ),
  removed as (
    delete from public.contact_chronic_conditions cc
     where cc.org_id = p_org and cc.source = 'visit_diagnoses'
       and (p_contacts is null or cc.contact_id = any (p_contacts))
       and not exists (select 1 from valid a
                        where a.contact_id = cc.contact_id and a.ref_diagnosis_id = cc.ref_diagnosis_id)
    returning 1
  ),
  up as (
    insert into public.contact_chronic_conditions as cc
      (org_id, contact_id, ref_diagnosis_id, source, noted_at, last_seen_on, evidence_visits)
    select p_org, a.contact_id, a.ref_diagnosis_id, 'visit_diagnoses', a.noted_at, a.last_seen_on, a.evidence_visits
    from valid a
    on conflict (contact_id, ref_diagnosis_id) do update
       set noted_at = least(cc.noted_at, excluded.noted_at),
           last_seen_on = excluded.last_seen_on,
           evidence_visits = excluded.evidence_visits
     where (cc.noted_at, cc.last_seen_on, cc.evidence_visits)
           is distinct from (least(cc.noted_at, excluded.noted_at), excluded.last_seen_on, excluded.evidence_visits)
    returning (xmax = 0) as inserted
  )
  select (select count(*) from removed),
         (select count(*) from up where inserted),
         (select count(*) from up where not inserted),
         (select count(*) from valid)
    into v_removed, v_inserted, v_updated, v_valid;

  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'removed', v_removed,
                            'rejected', jsonb_array_length(p_rows) - v_valid);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Prescription sequences (R-13 .. R-17): create once, schedule the steps durably
-- ---------------------------------------------------------------------------
-- What each scheduled step did, by step key: {"ABX_DAY3": {"outcome": "skipped_gate_off", "reason": "...", "at": "..."}}.
-- Outcome words and reason codes only, never message text.
alter table public.prescription_sequences
  add column if not exists step_outcomes jsonb not null default '{}'::jsonb
    check (jsonb_typeof(step_outcomes) = 'object');

-- Antibiotic prescriptions from the live Unite feed that have no sequence yet. History imported from Airtable
-- (source 'airtable_acute') is never sequenced. requires_probiotics comes from the drug's class row (R-05).
create or replace function public.clinical_prescriptions_needing_sequence(p_org uuid, p_limit integer default 200)
returns table (prescription_id uuid, external_key text, start_date date, duration_days integer,
               requires_probiotics boolean)
language sql
stable
set search_path = ''
as $$
  select p.id, p.external_key, p.start_date, p.duration_days, coalesce(mc.requires_probiotics_default, false)
  from public.prescriptions p
  left join public.ref_medication_classes mc
    on mc.org_id = p.org_id and mc.unite_local_code = p.medication_code and mc.class = 'antibiotic'
  where p.org_id = p_org
    and p.source = 'unite'
    and p.class = 'antibiotic'
    and not exists (select 1 from public.prescription_sequences s where s.prescription_id = p.id)
  order by p.created_at desc, p.id
  limit greatest(1, least(coalesce(p_limit, 200), 1000));
$$;

-- p_sequence: the dates from lib/clinical/sequence.ts planSequence(); p_steps: [{"step": "ABX_DAY3", "run_at": "<iso>"}].
-- The sequence row and its scheduled_jobs are written in one transaction, and only when the row is new, so a
-- re-run never schedules twice (prescription_sequences.prescription_id is unique).
create or replace function public.clinical_create_sequence(p_org uuid, p_prescription uuid, p_sequence jsonb, p_steps jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
  v_n integer := 0;
begin
  if not exists (select 1 from public.prescriptions p
                  where p.id = p_prescription and p.org_id = p_org and p.class = 'antibiotic') then
    return jsonb_build_object('created', false, 'reason', 'not_an_antibiotic');
  end if;
  if p_steps is not null and jsonb_typeof(p_steps) <> 'array' then
    raise exception 'p_steps must be a JSON array' using errcode = '22023';
  end if;

  insert into public.prescription_sequences
    (org_id, prescription_id, requires_probiotics, probiotic_duration_days, day3_offset_days,
     antibiotic_end_date, day3_check_date, probiotic_start_date, probiotic_end_date, status)
  values
    (p_org, p_prescription,
     coalesce((p_sequence ->> 'requires_probiotics')::boolean, false),
     (p_sequence ->> 'probiotic_duration_days')::integer,
     (p_sequence ->> 'day3_offset_days')::integer,
     (p_sequence ->> 'antibiotic_end_date')::date,
     (p_sequence ->> 'day3_check_date')::date,
     (p_sequence ->> 'probiotic_start_date')::date,
     (p_sequence ->> 'probiotic_end_date')::date,
     'not_started')
  on conflict (prescription_id) do nothing
  returning id into v_id;

  if v_id is null then
    select s.id into v_id from public.prescription_sequences s where s.prescription_id = p_prescription;
    return jsonb_build_object('created', false, 'sequence_id', v_id, 'reason', 'exists');
  end if;

  insert into public.scheduled_jobs (org_id, kind, payload, run_at, dedupe_key, max_attempts)
  select p_org, 'clinical.sequence_step',
         jsonb_build_object('sequence_id', v_id, 'step', s ->> 'step'),
         (s ->> 'run_at')::timestamptz,
         'clinical-seq:' || v_id::text || ':' || (s ->> 'step'),
         5
  from jsonb_array_elements(coalesce(p_steps, '[]'::jsonb)) s
  where s ->> 'step' in ('ABX_DAY3', 'NO_REPLY_CHECK', 'PROBIOTIC_START', 'TREATMENT_OUTCOME')
    and s ->> 'run_at' is not null
  on conflict do nothing;
  get diagnostics v_n = row_count;

  return jsonb_build_object('created', true, 'sequence_id', v_id, 'scheduled', v_n);
end;
$$;

-- The steps' own lane (handler lib/jobs/handlers/clinical.ts).
select pgmq.create('clinical');
select cron.schedule('pulse:clinical', '30 seconds', $$select app.ping_jobs('clinical')$$);
-- Nightly chronic-condition derivation, 00:45 Asia/Dubai (UTC+4).
select cron.schedule('pulse:clinical_nightly', '45 20 * * *', $$select app.ping_jobs('clinical_nightly')$$);

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.clinical_store_visit_diagnoses(uuid, uuid, jsonb, text)',
    'public.clinical_resolve_visit_diagnoses(uuid)',
    'public.clinical_chronic_facts(uuid, uuid[])',
    'public.clinical_apply_chronic_conditions(uuid, jsonb, uuid[])',
    'public.clinical_prescriptions_needing_sequence(uuid, integer)',
    'public.clinical_create_sequence(uuid, uuid, jsonb, jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 7. Data quality views (security invoker: the base tables' RLS applies)
-- ---------------------------------------------------------------------------
create or replace view public.v_visit_data_quality with (security_invoker = true) as
select v.org_id, v.id as visit_id, v.external_id, v.visit_date, v.contact_id,
       (v.temp_c is null) as missing_temp,
       (v.bp_systolic is null or v.bp_diastolic is null) as missing_bp,
       (v.spo2 is null) as missing_spo2,
       (v.pulse is null) as missing_pulse,
       (v.contact_id is null) as unmatched_patient,
       v.is_test_record,
       v.doctor_name,
       v.source
from public.visits v
where v.temp_c is null or v.bp_systolic is null or v.bp_diastolic is null or v.spo2 is null or v.pulse is null or v.contact_id is null;

create view public.v_unknown_diagnosis_codes with (security_invoker = true) as
select vd.org_id, vd.diagnosis_code, count(*)::integer as visit_count,
       min(vd.visit_date) as first_seen, max(vd.visit_date) as last_seen
from public.visit_diagnoses vd
where vd.ref_diagnosis_id is null
group by vd.org_id, vd.diagnosis_code;

-- ---------------------------------------------------------------------------
-- 8. Reports (counts only; service role; the pages check reports.view first)
-- ---------------------------------------------------------------------------
create index if not exists messages_reply_to_idx on public.messages (org_id, reply_to_wa_message_id)
  where reply_to_wa_message_id is not null;

-- Same columns as Phase 6 plus delivered / read / replied at the end. sent_day is now the org's calendar day
-- (it was the UTC day), like every other report. "Replied" = an inbound message that quotes the reminder
-- (a button tap or a swipe reply).
create or replace view public.v_appointment_reminder_stats with (security_invoker = true) as
select a.org_id, a.location_id, a.specialist_id, a.external_status,
       (r.sent_at at time zone o.timezone)::date as sent_day,
       count(r.id) filter (where r.status = 'sent')     as reminders_sent,
       count(r.id) filter (where r.status = 'failed')   as reminders_failed,
       count(r.id) filter (where r.status = 'excluded') as reminders_excluded,
       count(distinct a.contact_id) as patients_contacted,
       count(r.id) filter (where r.status = 'sent' and m.status in ('delivered', 'read')) as reminders_delivered,
       count(r.id) filter (where r.status = 'sent' and m.status = 'read') as reminders_read,
       count(r.id) filter (where r.status = 'sent' and m.wa_message_id is not null and exists (
         select 1 from public.messages i
         where i.org_id = r.org_id and i.direction = 'in' and i.reply_to_wa_message_id = m.wa_message_id)) as reminders_replied
from public.appointment_reminders r
join public.appointments a on a.id = r.appointment_id
join public.orgs o on o.id = a.org_id
left join public.messages m on m.id = r.message_id
group by a.org_id, a.location_id, a.specialist_id, a.external_status, (r.sent_at at time zone o.timezone)::date;

-- Per doctor: appointments in the period (by the day they take place, cancelled excluded), how many had at least one
-- reminder sent, and the reminders sent in the period with their delivery, read and reply counts.
create or replace function public.report_reminder_stats_by_specialist(p_org uuid, p_from date, p_to date)
returns table (specialist_id uuid, specialist_name text, appointments integer, contacted integer,
               reminders_sent integer, reminders_delivered integer, reminders_read integer,
               reminders_replied integer, reminders_failed integer, reminders_excluded integer)
language sql stable
set search_path = public, pg_temp
as $$
  with appts as (
    select f.specialist_id, count(*)::integer as n,
           count(*) filter (where exists (select 1 from public.appointment_reminders r
                                          where r.appointment_id = f.id and r.status = 'sent'))::integer as contacted
    from public.v_appointment_facts f
    where f.org_id = p_org and f.day between p_from and p_to and f.status <> 'cancelled'
    group by f.specialist_id
  ),
  rem as (
    select s.specialist_id,
           sum(s.reminders_sent)::integer as sent, sum(s.reminders_delivered)::integer as delivered,
           sum(s.reminders_read)::integer as read_n, sum(s.reminders_replied)::integer as replied,
           sum(s.reminders_failed)::integer as failed, sum(s.reminders_excluded)::integer as excluded
    from public.v_appointment_reminder_stats s
    where s.org_id = p_org and s.sent_day between p_from and p_to
    group by s.specialist_id
  ),
  keys as (select a.specialist_id from appts a union select r.specialist_id from rem r)
  select k.specialist_id, coalesce(sp.name, 'No specialist'),
         coalesce(a.n, 0), coalesce(a.contacted, 0),
         coalesce(r.sent, 0), coalesce(r.delivered, 0), coalesce(r.read_n, 0),
         coalesce(r.replied, 0), coalesce(r.failed, 0), coalesce(r.excluded, 0)
  from keys k
  left join appts a on a.specialist_id is not distinct from k.specialist_id
  left join rem r on r.specialist_id is not distinct from k.specialist_id
  left join public.specialists sp on sp.id = k.specialist_id and sp.org_id = p_org
  order by coalesce(a.n, 0) desc, coalesce(r.sent, 0) desc, 2
  limit 200;
$$;

create or replace function public.report_reminder_stats_by_day(p_org uuid, p_from date, p_to date)
returns table (day date, reminders_sent integer, reminders_delivered integer, reminders_read integer,
               reminders_replied integer, reminders_failed integer)
language sql stable
set search_path = public, pg_temp
as $$
  with days as (select d::date as day from generate_series(p_from, p_to, interval '1 day') d),
  agg as (
    select s.sent_day, sum(s.reminders_sent)::integer as sent, sum(s.reminders_delivered)::integer as delivered,
           sum(s.reminders_read)::integer as read_n, sum(s.reminders_replied)::integer as replied,
           sum(s.reminders_failed)::integer as failed
    from public.v_appointment_reminder_stats s
    where s.org_id = p_org and s.sent_day between p_from and p_to
    group by s.sent_day
  )
  select days.day, coalesce(agg.sent, 0), coalesce(agg.delivered, 0), coalesce(agg.read_n, 0),
         coalesce(agg.replied, 0), coalesce(agg.failed, 0)
  from days left join agg on agg.sent_day = days.day
  order by days.day;
$$;

-- Recall sends in one week (Monday start, Asia/Dubai like v_recall_weekly), per programme and send mode.
create or replace function public.report_recall_week(p_org uuid, p_week_start date)
returns table (programme_key text, programme_name text, send_mode text, sent integer, failed integer,
               replied integer, booked integer, unique_contacts integer)
language sql stable
set search_path = public, pg_temp
as $$
  select p.key, p.name, w.send_mode, sum(w.sent)::integer, sum(w.failed)::integer, sum(w.replied)::integer,
         sum(w.booked)::integer, sum(w.unique_contacts)::integer
  from public.v_recall_weekly w
  join public.recall_programmes p on p.id = w.programme_id and p.org_id = p_org
  where w.org_id = p_org and w.week_start = p_week_start
  group by p.key, p.name, w.send_mode
  order by sum(w.sent) desc, p.key;
$$;

-- The Follow-Up Queue right now: open items by category, high priority, overdue (due before p_today) and
-- doctor alerts still waiting for the doctor to be told. Test records are left out.
create or replace function public.report_clinical_followup_load(p_org uuid, p_today date)
returns table (trigger_category text, open_items integer, high_priority integer, overdue integer,
               doctor_alerts_pending integer)
language sql stable
set search_path = public, pg_temp
as $$
  select coalesce(f.trigger_category::text, 'other'), count(*)::integer,
         count(*) filter (where f.priority = 'high')::integer,
         count(*) filter (where f.due_date < p_today)::integer,
         count(*) filter (where f.doctor_alert_required and f.doctor_notified_at is null)::integer
  from public.clinical_followups f
  where f.org_id = p_org and f.closed_at is null and not f.is_test_record
  group by 1
  order by 2 desc, 1;
$$;

-- Patient replies in the period (by the org's day): red flags (doctor and coordinator notified) and replies
-- that needed a person (red flag, unreadable score or unsigned thresholds).
create or replace function public.report_clinical_red_flags(p_org uuid, p_from date, p_to date)
returns table (replies integer, red_flags integer, needs_review integer)
language sql stable
set search_path = public, pg_temp
as $$
  select count(*)::integer,
         count(*) filter (where fb.doctor_notified_at is not null and fb.coordinator_notified_at is not null)::integer,
         count(*) filter (where fb.needs_doctor_review)::integer
  from public.clinical_feedback fb
  join public.orgs o on o.id = fb.org_id
  where fb.org_id = p_org and not fb.is_test_record
    and (fb.created_at at time zone o.timezone)::date between p_from and p_to;
$$;

-- Data quality: visits in the period with incomplete vitals or no matched patient (v_visit_data_quality), and the
-- medication and diagnosis codes still waiting for a classification or a reference row (all time).
create or replace function public.report_clinical_data_quality(p_org uuid, p_from date, p_to date)
returns table (visits integer, incomplete_vitals integer, unmatched_patients integer,
               unclassified_medication_codes integer, unknown_diagnosis_codes integer)
language sql stable
set search_path = public, pg_temp
as $$
  select
    (select count(*) from public.visits v
      where v.org_id = p_org and not v.is_test_record and v.visit_date between p_from and p_to)::integer,
    (select count(*) from public.v_visit_data_quality q
      where q.org_id = p_org and not q.is_test_record and q.visit_date between p_from and p_to
        and (q.missing_temp or q.missing_bp or q.missing_spo2 or q.missing_pulse))::integer,
    (select count(*) from public.v_visit_data_quality q
      where q.org_id = p_org and not q.is_test_record and q.visit_date between p_from and p_to
        and q.unmatched_patient)::integer,
    (select count(*) from public.v_unclassified_medications u
      where u.org_id = p_org and u.medication_code is not null)::integer,
    (select count(*) from public.v_unknown_diagnosis_codes k where k.org_id = p_org)::integer;
$$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.report_reminder_stats_by_specialist(uuid, date, date)',
    'public.report_reminder_stats_by_day(uuid, date, date)',
    'public.report_recall_week(uuid, date)',
    'public.report_clinical_followup_load(uuid, date)',
    'public.report_clinical_red_flags(uuid, date, date)',
    'public.report_clinical_data_quality(uuid, date, date)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 9. Parallel-run checklist: seed rows that cited phases which have since been built
-- ---------------------------------------------------------------------------
create or replace function public.seed_parallel_run_scenarios(p_org uuid)
returns void language sql set search_path = '' as $$
  insert into public.parallel_run_scenarios (org_id, scenario_key, make_scenario_id, name, native_built, blocked_reason) values
    (p_org, 'token',                 '3576415', 'Token (Unite auth refresh)',        true,
     'Nothing to compare: Pulse refreshes the Unite token on demand (lib/unite/auth.ts). Check a week of Unite call outcomes in System health before switching Make off.'),
    (p_org, 'appointment_reminders', '3613818', 'Appointment reminders (12:00 + 18:00)', true,  null),
    (p_org, 'birthday',              '4049277', 'Agewise birthday message',          true,  null),
    (p_org, 'chronic_recall',        '5882746', 'Chronic recall (90 day)',           true,
     'Needs visits and chronic conditions (Airtable import or the Unite visits sync) and the OQ-01 threshold and chronic_condition_min_visits signed off'),
    (p_org, 'chronic_update',        '5916036', 'Chronic update (reply / booked)',   true,  null),
    (p_org, 'mrd_sync',              '5990863', 'Acute follow-up MRD sync',          false,
     'The clinical engine and the visit-diagnosis ingest are built; the Unite visits / prescriptions feed is not (Unite has not documented the endpoint: Phase 21 item 1, OQ-23 / OQ-26)'),
    (p_org, 'airtable_automations',  null,      'Airtable native automations (2)',   false, 'Document then switch off (OQ-41)')
  on conflict do nothing;
$$;
revoke all on function public.seed_parallel_run_scenarios(uuid) from public, anon, authenticated;
grant execute on function public.seed_parallel_run_scenarios(uuid) to service_role;

-- Existing workspaces: only rows still carrying the original seed text (a person's edits are left alone).
update public.parallel_run_scenarios
   set native_built = true,
       blocked_reason = 'Nothing to compare: Pulse refreshes the Unite token on demand (lib/unite/auth.ts). Check a week of Unite call outcomes in System health before switching Make off.',
       updated_at = now()
 where scenario_key = 'token' and not native_built
   and blocked_reason = 'Needs lib/unite (Phase 6); Unite stays untouched until then';
update public.parallel_run_scenarios
   set blocked_reason = 'The clinical engine and the visit-diagnosis ingest are built; the Unite visits / prescriptions feed is not (Unite has not documented the endpoint: Phase 21 item 1, OQ-23 / OQ-26)',
       updated_at = now()
 where scenario_key = 'mrd_sync' and blocked_reason = 'Phase 6 clinical engine';
update public.parallel_run_scenarios
   set blocked_reason = 'Needs visits and chronic conditions (Airtable import or the Unite visits sync) and the OQ-01 threshold and chronic_condition_min_visits signed off',
       updated_at = now()
 where scenario_key = 'chronic_recall' and blocked_reason = 'Needs visits sync (Phase 6) and OQ-01 threshold sign-off';

insert into supabase_migrations.schema_migrations (version, name) values ('20261027000100', 'phase21_clinical_gaps') on conflict (version) do nothing;
