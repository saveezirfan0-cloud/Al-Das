-- Phase 8: recall programmes (chronic 90-day, birthday, screenings, dormant, reminders).
-- Promoted and reworked from supabase/drafts/0104_recall.sql.
--
-- A programme = who is eligible (a built-in rule) + which template per segment + cadence + Test/Live.
--   recall_programmes / recall_programme_templates   configuration (members read, flows.manage writes)
--   recall_sends     one row per patient per programme per cycle, created when a message is queued
--   recall_runs      one row per programme run: counts only (dry runs and skips never use up a cycle)
-- recall_sends is PHI (who was recalled for which condition): reads need the clinical follow-up key.

-- ---------------------------------------------------------------------------
-- programmes and their template map
-- ---------------------------------------------------------------------------
create table public.recall_programmes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,48}$'),
  name text not null check (char_length(name) between 1 and 120),
  kind text not null check (kind in ('chronic', 'birthday', 'screening', 'dormant', 'post_visit', 'no_show', 'reminder')),
  -- which built-in rule picks patients; 'managed' = run by another engine (appointment reminders)
  eligibility text not null check (eligibility in ('chronic', 'birthday', 'visit_gap', 'managed')),
  status text not null default 'draft' check (status in ('draft', 'active', 'paused')),
  cron_expression text,                                   -- evaluated in the workspace time zone
  repeat_policy text not null default 'per_cycle' check (repeat_policy in ('once', 'per_cycle')),
  max_per_run integer not null default 100 check (max_per_run between 1 and 2000),
  send_mode_override text check (send_mode_override is null or send_mode_override in ('test', 'live')),
  requires_marketing_opt_in boolean not null default true,
  requires_clinical_consent boolean not null default false,
  channel_id uuid references public.channels (id) on delete set null,   -- send-from number; null = the template's own number
  managed_by text check (managed_by is null or managed_by in ('appointments')),
  config jsonb not null default '{}'::jsonb,              -- rule parameters (visit_gap: min_days, gender, ages; birthday: bands)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, key),
  check (jsonb_typeof(config) = 'object')
);

create table public.recall_programme_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  programme_id uuid not null references public.recall_programmes (id) on delete cascade,
  segment_key text not null check (char_length(segment_key) between 1 and 80),   -- condition group | birthday band | '*'
  wa_template_id uuid references public.wa_templates (id) on delete set null,
  legacy_sanoflow_template_id text,                       -- the id Make sent today (provenance only)
  variables_map jsonb not null default '{}'::jsonb,       -- "body.1" -> "{contact.first_name|default:\"there\"}"
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (programme_id, segment_key),
  check (jsonb_typeof(variables_map) = 'object')
);

-- ---------------------------------------------------------------------------
-- sends (PHI) and runs
-- ---------------------------------------------------------------------------
create table public.recall_sends (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  programme_id uuid not null references public.recall_programmes (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  cycle_key text not null,                                -- chronic: last visit date; birthday: year; once: 'once'
  segment_key text,
  template_row_id uuid references public.recall_programme_templates (id) on delete set null,
  send_mode text not null default 'test' check (send_mode in ('test', 'live')),
  status text not null default 'queued' check (status in ('queued', 'sent', 'delivered', 'read', 'failed', 'cancelled')),
  queued_at timestamptz not null default now(),
  sent_at timestamptz,
  message_id uuid references public.messages (id) on delete set null,
  last_visit_date_at_send date,
  days_since_last_visit_at_send integer,
  replied_at timestamptz,
  reply_message_id uuid references public.messages (id) on delete set null,
  booked_at timestamptz,
  appointment_id uuid references public.appointments (id) on delete set null,
  follow_up_status text check (follow_up_status is null or follow_up_status in ('called', 'no_response', 'booked')),
  assigned_user_id uuid references public.profiles (id) on delete set null,
  outcome text check (outcome is null or char_length(outcome) <= 80),     -- offer_redeemed, wants_booking, declined, ...
  source text not null default 'engine' check (source in ('engine', 'airtable_import')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (programme_id, contact_id, cycle_key),
  -- "Always fill in Booking Date when setting this to Booked."
  constraint recall_booked_needs_date check (follow_up_status is distinct from 'booked' or booked_at is not null)
);
create index recall_sends_org_sent_idx on public.recall_sends (org_id, sent_at desc);
create index recall_sends_open_idx on public.recall_sends (org_id, contact_id) where replied_at is null and status in ('queued', 'sent', 'delivered', 'read');
create index recall_sends_message_idx on public.recall_sends (message_id) where message_id is not null;

create table public.recall_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  programme_id uuid not null references public.recall_programmes (id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  trigger text not null default 'schedule' check (trigger in ('schedule', 'manual', 'check')),
  send_mode text not null check (send_mode in ('test', 'live')),
  dry_run boolean not null default false,                  -- 'check' runs and runs while the gate is closed
  gate_open boolean not null default false,
  scanned integer not null default 0,
  queued integer not null default 0,
  skipped jsonb not null default '{}'::jsonb,              -- reason -> count (no patient identifiers)
  by_segment jsonb not null default '{}'::jsonb,           -- segment -> would-send / queued count
  error text,
  check (jsonb_typeof(skipped) = 'object' and jsonb_typeof(by_segment) = 'object')
);
create index recall_runs_programme_idx on public.recall_runs (programme_id, started_at desc);

-- ---------------------------------------------------------------------------
-- candidate queries (service role): the cheap, deterministic part of eligibility in SQL.
-- Everything judgemental (template mapped? gate open?) happens in lib/clinical/recall.ts.
-- ---------------------------------------------------------------------------

-- Chronic: patients whose chronic diagnoses (primary or secondary code on any visit) map to a
-- condition group, last seen at least p_min_days ago. NULL threshold = nobody (fail closed).
create or replace function public.recall_chronic_candidates(
  p_org uuid, p_programme uuid, p_min_days integer, p_today date, p_test_only boolean, p_need_consent boolean,
  p_limit integer, p_offset integer
)
returns table (contact_id uuid, last_visit_date date, days_since integer, groups jsonb)
language sql
stable
set search_path = ''
as $$
  with codes as (
    select v.contact_id, upper(btrim(v.primary_diagnosis_code)) as code
      from public.visits v where v.org_id = p_org and v.contact_id is not null and v.primary_diagnosis_code is not null
    union
    select v.contact_id, upper(btrim(c)) as code
      from public.visits v, lateral regexp_split_to_table(coalesce(v.secondary_diagnosis_codes, ''), '[,;|[:space:]]+') as c
     where v.org_id = p_org and v.contact_id is not null and btrim(c) <> ''
  ),
  grp as (
    select cd.contact_id,
           jsonb_agg(distinct jsonb_build_object('key', g.key, 'sort', g.sort, 'messageable', g.messageable)) as groups
      from codes cd
      join public.ref_diagnoses d on d.org_id = p_org and d.code = cd.code and d.chronic
      join public.ref_condition_groups g on g.id = d.condition_group_id
     group by cd.contact_id
  ),
  lv as (
    select v.contact_id, max(v.visit_date) as last_visit
      from public.visits v where v.org_id = p_org and v.contact_id is not null group by v.contact_id
  )
  select c.id, lv.last_visit, (p_today - lv.last_visit)::int, grp.groups
    from public.contacts c
    join lv on lv.contact_id = c.id
    join grp on grp.contact_id = c.id
   where p_min_days is not null
     and c.org_id = p_org
     and c.deleted_at is null
     and (c.phone_e164 is not null or c.wa_bsuid is not null)
     and not c.stop_marketing
     and (p_test_only = c.is_test_record)
     and (not p_need_consent or c.clinical_messaging_consent)
     and (p_today - lv.last_visit) >= p_min_days
     and exists (select 1 from jsonb_array_elements(grp.groups) e where (e ->> 'messageable')::boolean)
     and not exists (select 1 from public.recall_sends rs
                      where rs.programme_id = p_programme and rs.contact_id = c.id
                        and rs.cycle_key = lv.last_visit::text and rs.status <> 'cancelled')
   order by (p_today - lv.last_visit) desc, c.id
   limit greatest(1, least(p_limit, 500)) offset greatest(0, p_offset);
$$;

-- Birthdays: p_md lists today's 'MM-DD' values (plus 02-29 on 1 March in non-leap years).
create or replace function public.recall_birthday_candidates(
  p_org uuid, p_programme uuid, p_md text[], p_cycle text, p_test_only boolean, p_need_optin boolean,
  p_limit integer, p_offset integer
)
returns table (contact_id uuid, dob date, gender text)
language sql
stable
set search_path = ''
as $$
  select c.id, c.dob, c.gender
    from public.contacts c
   where c.org_id = p_org
     and c.deleted_at is null
     and c.dob is not null
     and to_char(c.dob, 'MM-DD') = any (p_md)
     and (c.phone_e164 is not null or c.wa_bsuid is not null)
     and not c.stop_marketing
     and (not p_need_optin or c.promotions_opt_in)
     and (p_test_only = c.is_test_record)
     and not exists (select 1 from public.recall_sends rs
                      where rs.programme_id = p_programme and rs.contact_id = c.id
                        and rs.cycle_key = p_cycle and rs.status <> 'cancelled')
   order by c.id
   limit greatest(1, least(p_limit, 500)) offset greatest(0, p_offset);
$$;

-- Generic "time since the last visit" programmes (annual check-up, screenings, dormant).
-- A NULL p_min_days returns nobody. Ages are in whole years on p_today.
create or replace function public.recall_visit_gap_candidates(
  p_org uuid, p_programme uuid, p_min_days integer, p_max_days integer, p_gender text, p_min_age integer, p_max_age integer,
  p_today date, p_once boolean, p_test_only boolean, p_need_optin boolean, p_need_consent boolean,
  p_limit integer, p_offset integer
)
returns table (contact_id uuid, last_visit_date date, days_since integer)
language sql
stable
set search_path = ''
as $$
  with lv as (
    select v.contact_id, max(v.visit_date) as last_visit
      from public.visits v where v.org_id = p_org and v.contact_id is not null group by v.contact_id
  )
  select c.id, lv.last_visit, (p_today - lv.last_visit)::int
    from public.contacts c
    join lv on lv.contact_id = c.id
   where p_min_days is not null
     and c.org_id = p_org
     and c.deleted_at is null
     and (c.phone_e164 is not null or c.wa_bsuid is not null)
     and not c.stop_marketing
     and (not p_need_optin or c.promotions_opt_in)
     and (not p_need_consent or c.clinical_messaging_consent)
     and (p_test_only = c.is_test_record)
     and (p_today - lv.last_visit) >= p_min_days
     and (p_max_days is null or (p_today - lv.last_visit) <= p_max_days)
     and (p_gender is null or c.gender = p_gender)
     and (p_min_age is null or (c.dob is not null and extract(year from age(p_today, c.dob)) >= p_min_age))
     and (p_max_age is null or (c.dob is not null and extract(year from age(p_today, c.dob)) <= p_max_age))
     and not exists (select 1 from public.recall_sends rs
                      where rs.programme_id = p_programme and rs.contact_id = c.id and rs.status <> 'cancelled'
                        and (p_once or rs.cycle_key = lv.last_visit::text))
   order by (p_today - lv.last_visit) desc, c.id
   limit greatest(1, least(p_limit, 500)) offset greatest(0, p_offset);
$$;

revoke all on function public.recall_chronic_candidates(uuid, uuid, integer, date, boolean, boolean, integer, integer) from public, anon, authenticated;
revoke all on function public.recall_birthday_candidates(uuid, uuid, text[], text, boolean, boolean, integer, integer) from public, anon, authenticated;
revoke all on function public.recall_visit_gap_candidates(uuid, uuid, integer, integer, text, integer, integer, date, boolean, boolean, boolean, boolean, integer, integer) from public, anon, authenticated;
grant execute on function public.recall_chronic_candidates(uuid, uuid, integer, date, boolean, boolean, integer, integer) to service_role;
grant execute on function public.recall_birthday_candidates(uuid, uuid, text[], text, boolean, boolean, integer, integer) to service_role;
grant execute on function public.recall_visit_gap_candidates(uuid, uuid, integer, integer, text, integer, integer, date, boolean, boolean, boolean, boolean, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- seed (per org; run from the portal / seed script). Programmes start as drafts and NO template is
-- mapped: nothing is sent until a person maps a clinically approved template and activates it.
-- ---------------------------------------------------------------------------
create or replace function public.seed_recall_programmes(p_org uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare chronic uuid; bday uuid;
begin
  insert into public.recall_programmes (org_id, key, name, kind, eligibility, status, cron_expression, repeat_policy, max_per_run, requires_marketing_opt_in, requires_clinical_consent, managed_by, config)
  values
    (p_org, 'chronic_90d', 'Chronic condition recall', 'chronic', 'chronic', 'draft', '15 12 * * *', 'per_cycle', 100, false, true, null,
       '{"threshold_setting": "chronic_recall_min_days"}'),
    (p_org, 'birthday', 'Birthday message', 'birthday', 'birthday', 'draft', '0 9 * * *', 'per_cycle', 1000, true, false, null,
       '{"bands": [
          {"key": "m_20_29", "gender": "male", "min_age": 20, "max_age": 29},
          {"key": "m_30_39", "gender": "male", "min_age": 30, "max_age": 39},
          {"key": "m_40_plus", "gender": "male", "min_age": 40},
          {"key": "f_18_35", "gender": "female", "min_age": 18, "max_age": 35},
          {"key": "f_36_45", "gender": "female", "min_age": 36, "max_age": 45},
          {"key": "f_46_65", "gender": "female", "min_age": 46, "max_age": 65}]}'),
    (p_org, 'appointment_reminder', 'Appointment reminders', 'reminder', 'managed', 'active', null, 'per_cycle', 1, false, false, 'appointments', '{}'),
    (p_org, 'annual_checkup', 'Annual check-up reminder', 'screening', 'visit_gap', 'draft', '0 9 * * *', 'per_cycle', 200, true, false, null, '{"min_days": null}'),
    (p_org, 'dental', 'Annual dental check-up', 'screening', 'visit_gap', 'draft', '0 9 * * *', 'per_cycle', 200, true, false, null, '{"min_days": null}'),
    (p_org, 'pap_smear', 'Pap smear reminder', 'screening', 'visit_gap', 'draft', '0 9 * * *', 'per_cycle', 200, true, false, null, '{"min_days": null, "gender": "female"}'),
    (p_org, 'colonoscopy', 'Colonoscopy screening', 'screening', 'visit_gap', 'draft', '0 9 * * *', 'per_cycle', 200, true, false, null, '{"min_days": null}'),
    (p_org, 'skin_check', 'Skin cancer screening and mole check', 'screening', 'visit_gap', 'draft', '0 9 * * *', 'per_cycle', 200, true, false, null, '{"min_days": null}'),
    (p_org, 'pre_menopause', 'Pre-menopause assessment', 'screening', 'visit_gap', 'draft', '0 9 * * *', 'per_cycle', 200, true, false, null, '{"min_days": null, "gender": "female"}'),
    (p_org, 'menopause', 'Menopause assessment', 'screening', 'visit_gap', 'draft', '0 9 * * *', 'per_cycle', 200, true, false, null, '{"min_days": null, "gender": "female"}'),
    (p_org, 'dormant', 'Dormant patient reactivation', 'dormant', 'visit_gap', 'draft', '0 9 * * *', 'once', 200, true, false, null, '{"min_days": null}')
  on conflict (org_id, key) do nothing;

  select id into chronic from public.recall_programmes where org_id = p_org and key = 'chronic_90d';
  select id into bday from public.recall_programmes where org_id = p_org and key = 'birthday';

  -- Make's per-condition template ids (provenance). No default row: an unmapped group sends nothing (OQ-24).
  insert into public.recall_programme_templates (org_id, programme_id, segment_key, legacy_sanoflow_template_id) values
    (p_org, chronic, 'hypertension', '13159'), (p_org, chronic, 'diabetes', '13164'),
    (p_org, chronic, 'hyperlipidemia', '13163'), (p_org, chronic, 'hypothyroidism', '13169'),
    (p_org, chronic, 'ckd', '13168'), (p_org, chronic, 'asthma', '13162'), (p_org, chronic, 'copd', '13165'),
    (p_org, chronic, 'ra', '13161'), (p_org, chronic, 'af', '13167'), (p_org, chronic, 'epilepsy', '13166'),
    (p_org, bday, 'm_20_29', '12294'), (p_org, bday, 'm_30_39', '12295'), (p_org, bday, 'm_40_plus', '12296'),
    (p_org, bday, 'f_18_35', '12289'), (p_org, bday, 'f_36_45', '12291'), (p_org, bday, 'f_46_65', '12291')
  on conflict (programme_id, segment_key) do nothing;
end;
$$;
revoke all on function public.seed_recall_programmes(uuid) from public, anon, authenticated;
grant execute on function public.seed_recall_programmes(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
select app.add_tenant_rls('recall_programmes', 'flows.manage');
select app.add_tenant_rls('recall_programme_templates', 'flows.manage');
select app.add_tenant_rls_gated('recall_sends', 'portal.clinical_followups.read', 'portal.clinical_followups.write');
select app.add_tenant_rls_gated('recall_runs', 'portal.clinical_followups.read');

-- One tick a minute: programmes whose schedule matches start, and message statuses are synced.
select cron.schedule('pulse:recall_programmes', '* * * * *', $$select app.ping_jobs('recall_programmes')$$);
