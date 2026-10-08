-- 0104_recall.sql  (DRAFT — Phase 0)
-- Recall programmes (chronic 90-day, birthday, screenings, dormant) and the per-patient send log.
-- Replaces: Unite patient flag columns, Campaigns.Birthday Messages, Campaigns.Chronic Recall Messages,
-- Make scenarios 4049277, 5882746, 5916036 and the 9 inactive screening scenarios.
-- Depends on 0101, 0102, Phase 2 (contacts), Phase 3 (messages), Phase 4 (wa_templates), Phase 6 (appointments).

do $$ begin
  if not exists (select 1 from pg_type where typname = 'recall_kind') then
    create type public.recall_kind as enum ('chronic','birthday','screening','dormant','post_visit','no_show');
  end if;
  if not exists (select 1 from pg_type where typname = 'recall_repeat_policy') then
    create type public.recall_repeat_policy as enum ('once','per_cycle');
  end if;
  if not exists (select 1 from pg_type where typname = 'recall_send_status') then
    create type public.recall_send_status as enum
      ('eligible','queued','sent','delivered','read','failed','skipped_no_template','skipped_opted_out','excluded','cancelled');
  end if;
  if not exists (select 1 from pg_type where typname = 'recall_follow_up_status') then
    create type public.recall_follow_up_status as enum ('called','no_response','booked');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- recall_programmes
-- ---------------------------------------------------------------------------
create table if not exists public.recall_programmes (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null references public.orgs(id) on delete cascade,
  key                       text not null,                       -- chronic_90d, birthday, annual_checkup, pap_smear, dental, skin_check, colonoscopy, pre_menopause, menopause, dormant
  name                      text not null,
  kind                      public.recall_kind not null,
  status                    text not null default 'draft',       -- draft | active | paused
  eligibility_view          text,                                -- name of the SQL view that lists eligible contacts (org_id, contact_id, segment_key, cycle_key, …)
  cron_expression           text,                                -- pg_cron schedule (Asia/Dubai semantics handled by the job)
  min_days_since_visit      int,                                 -- e.g. 330 for annual checkup; chronic reads clinical_settings instead
  repeat_policy             public.recall_repeat_policy not null default 'per_cycle',
  max_per_run               int not null default 100,
  send_mode_override        text,                                -- null = use clinical_settings.recall_send_mode
  requires_marketing_opt_in boolean not null default true,       -- marketing-category templates need promotions_opt_in
  requires_clinical_consent boolean not null default false,
  config                    jsonb not null default '{}'::jsonb,  -- programme-specific (age bands, steps for post_visit, …)
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (org_id, key)
);

-- segment_key → template. No default row for chronic (fail closed, OQ-24); '*' may be used by other programmes.
create table if not exists public.recall_programme_templates (
  id                           uuid primary key default gen_random_uuid(),
  org_id                       uuid not null references public.orgs(id) on delete cascade,
  programme_id                 uuid not null references public.recall_programmes(id) on delete cascade,
  segment_key                  text not null,                    -- condition group key | gender_band | '*'
  wa_template_id               uuid references public.wa_templates(id),
  legacy_sanoflow_template_id  text,                             -- 13159 … 13170, 12289 … 12296, 11885
  variables_map                jsonb not null default '{}'::jsonb, -- {{1}} → contact.first_name etc.
  active                       boolean not null default true,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  unique (programme_id, segment_key)
);

-- ---------------------------------------------------------------------------
-- recall_sends — one row per contact per programme per cycle
-- ---------------------------------------------------------------------------
create table if not exists public.recall_sends (
  id                              uuid primary key default gen_random_uuid(),
  org_id                          uuid not null references public.orgs(id) on delete cascade,
  programme_id                    uuid not null references public.recall_programmes(id) on delete cascade,
  contact_id                      uuid not null references public.contacts(id) on delete cascade,
  cycle_key                       text not null,                 -- chronic: last_visit_date; birthday: year; once-programmes: 'once'
  segment_key                     text,                          -- condition group | gender_band
  template_id                     uuid references public.recall_programme_templates(id),
  legacy_template_ref             text,                          -- Sanoflow template id used historically
  send_mode                       text not null default 'test',  -- test | live
  status                          public.recall_send_status not null default 'eligible',
  eligible_at                     timestamptz,
  sent_at                         timestamptz,
  sent_to_phone_e164              text,                          -- the number actually messaged (test numbers in test mode)
  message_id                      uuid references public.messages(id),
  last_visit_date_at_send         date,
  days_since_last_visit_at_send   int,
  replied_at                      timestamptz,
  reply_message_id                uuid references public.messages(id),
  booked_at                       timestamptz,
  appointment_id                  uuid references public.appointments(id),
  follow_up_status                public.recall_follow_up_status,
  assigned_user_id                uuid references public.profiles(id),
  outcome                         text,                          -- offer_redeemed, wants_booking, declined, …
  notes                           text,
  source                          text not null default 'engine', -- engine | airtable_import
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now(),
  unique (programme_id, contact_id, cycle_key),
  -- "Always fill in Booking Date when setting this to Booked."
  constraint booked_requires_date check (follow_up_status is distinct from 'booked' or booked_at is not null)
);
create index if not exists recall_sends_open_idx on public.recall_sends (org_id, programme_id, contact_id) where replied_at is null and status in ('sent','delivered','read');
create index if not exists recall_sends_sent_idx on public.recall_sends (org_id, sent_at desc);

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------
-- Per-contact visit statistics (replaces Unite First/Last Visit Date, Time Elapsed)
create or replace view public.v_contact_visit_stats with (security_invoker = true) as
select v.org_id, v.contact_id,
       min(v.visit_date) as first_visit_date,
       max(v.visit_date) as last_visit_date,
       (current_date - max(v.visit_date))::int as days_since_last_visit,
       count(*)::int as visit_count
from public.visits v
where v.contact_id is not null and not v.is_test_record
group by v.org_id, v.contact_id;

-- Chronic recall eligibility (R-20…R-22). Threshold from clinical_settings (fail closed: NULL → nobody eligible).
create or replace view public.v_chronic_recall_eligibility with (security_invoker = true) as
with groups as (
  select cc.org_id, cc.contact_id,
         array_agg(distinct g.key order by g.key) as all_group_keys,
         (array_agg(g.key order by g.sort, g.key) filter (where g.messageable))[1] as primary_condition_group,
         array_remove(array_agg(distinct case when g.messageable then g.key end), null) as messageable_groups
  from public.contact_chronic_conditions cc
  join public.ref_diagnoses d on d.id = cc.ref_diagnosis_id
  join public.ref_condition_groups g on g.id = d.condition_group_id
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

-- Birthday eligibility (OQ-17, OQ-18). 29 Feb → 1 Mar in non-leap years.
create or replace view public.v_birthday_today with (security_invoker = true) as
select c.org_id, c.id as contact_id, c.gender,
       extract(year from age((now() at time zone 'Asia/Dubai')::date, c.dob))::int as age_today,
       case
         when c.gender = 'male'   and extract(year from age((now() at time zone 'Asia/Dubai')::date, c.dob)) between 20 and 29 then 'm_20_29'
         when c.gender = 'male'   and extract(year from age((now() at time zone 'Asia/Dubai')::date, c.dob)) between 30 and 39 then 'm_30_39'
         when c.gender = 'male'   and extract(year from age((now() at time zone 'Asia/Dubai')::date, c.dob)) >= 40 then 'm_40_plus'
         when c.gender = 'female' and extract(year from age((now() at time zone 'Asia/Dubai')::date, c.dob)) between 18 and 35 then 'f_18_35'
         when c.gender = 'female' and extract(year from age((now() at time zone 'Asia/Dubai')::date, c.dob)) between 36 and 45 then 'f_36_45'
         when c.gender = 'female' and extract(year from age((now() at time zone 'Asia/Dubai')::date, c.dob)) between 46 and 65 then 'f_46_65'
         else null
       end as segment_key,
       extract(year from (now() at time zone 'Asia/Dubai'))::text as cycle_key
from public.contacts c
where c.dob is not null
  and c.phone_e164 is not null
  and not coalesce(c.stop_marketing, false)
  and not coalesce(c.is_test_record, false)
  and (
        to_char(c.dob, 'MM-DD') = to_char((now() at time zone 'Asia/Dubai')::date, 'MM-DD')
     or (to_char(c.dob, 'MM-DD') = '02-29'
         and to_char((now() at time zone 'Asia/Dubai')::date, 'MM-DD') = '03-01'
         and not (extract(year from (now() at time zone 'Asia/Dubai'))::int % 4 = 0
                  and (extract(year from (now() at time zone 'Asia/Dubai'))::int % 100 <> 0
                       or extract(year from (now() at time zone 'Asia/Dubai'))::int % 400 = 0)))
  );

-- Care-coordinator call list (R-24, R-25). Replaces the "Chronic Recall Call List" interface.
create or replace view public.v_recall_call_list with (security_invoker = true) as
select rs.org_id, rs.id as recall_send_id, rs.programme_id, rs.contact_id, rs.segment_key,
       rs.sent_at, rs.follow_up_status, rs.assigned_user_id,
       rs.days_since_last_visit_at_send, rs.last_visit_date_at_send,
       case when rs.replied_at is null then ((now() at time zone 'Asia/Dubai')::date - (rs.sent_at at time zone 'Asia/Dubai')::date) end as days_waiting,
       public.workdays_between(rs.org_id, (rs.sent_at at time zone 'Asia/Dubai')::date, (now() at time zone 'Asia/Dubai')::date) as workdays_waiting,
       (   rs.send_mode = 'live'
       and rs.status in ('sent','delivered','read')
       and rs.replied_at is null
       and rs.follow_up_status is distinct from 'booked'
       and public.clinical_setting_num(rs.org_id, 'recall_followup_workdays') is not null
       and public.workdays_between(rs.org_id, (rs.sent_at at time zone 'Asia/Dubai')::date, (now() at time zone 'Asia/Dubai')::date)
             >= public.clinical_setting_num(rs.org_id, 'recall_followup_workdays')
       ) as call_now,
       (rs.days_since_last_visit_at_send > public.clinical_setting_num(rs.org_id, 'chronic_recall_overdue_days')) as overdue
from public.recall_sends rs
where rs.sent_at is not null;

-- Weekly rollup (Week Starting = Monday, Asia/Dubai)
create or replace view public.v_recall_weekly with (security_invoker = true) as
select rs.org_id, rs.programme_id, rs.send_mode,
       date_trunc('week', rs.sent_at at time zone 'Asia/Dubai')::date as week_start,
       count(*) filter (where rs.status in ('sent','delivered','read')) as sent,
       count(*) filter (where rs.status = 'failed') as failed,
       count(*) filter (where rs.replied_at is not null) as replied,
       count(*) filter (where rs.booked_at is not null) as booked,
       count(distinct rs.contact_id) as unique_contacts,
       avg(rs.days_since_last_visit_at_send) as avg_days_since_last_visit,
       count(*) filter (where rs.days_since_last_visit_at_send > public.clinical_setting_num(rs.org_id, 'chronic_recall_overdue_days')) as over_threshold
from public.recall_sends rs
where rs.sent_at is not null
group by rs.org_id, rs.programme_id, rs.send_mode, date_trunc('week', rs.sent_at at time zone 'Asia/Dubai')::date;

-- ---------------------------------------------------------------------------
-- Seed: programmes + legacy template map. Run per org: select public.seed_recall_programmes('<org uuid>');
-- ---------------------------------------------------------------------------
create or replace function public.seed_recall_programmes(p_org uuid)
returns void language plpgsql set search_path = '' as $$
declare chronic uuid; bday uuid;
begin
  insert into public.recall_programmes (org_id, key, name, kind, status, eligibility_view, cron_expression, repeat_policy, max_per_run, requires_marketing_opt_in, requires_clinical_consent, config)
  values
    (p_org, 'chronic_90d',   'Chronic condition recall',           'chronic',   'draft', 'v_chronic_recall_eligibility', '15 12 * * *', 'per_cycle', 100, false, true,  '{"threshold_setting":"chronic_recall_min_days","order_by":"days_since_last_visit desc"}'),
    (p_org, 'birthday',      'Birthday message',                   'birthday',  'draft', 'v_birthday_today',              '0 9 * * *',   'per_cycle', 1000, true, false, '{"bands":["m_20_29","m_30_39","m_40_plus","f_18_35","f_36_45","f_46_65"]}'),
    (p_org, 'annual_checkup','Annual check-up reminder (330 days)','screening', 'draft', null, '0 9 * * *', 'per_cycle', 200, true, false, '{"min_days_since_visit":330}'),
    (p_org, 'dental',        'Annual dental check-up',             'screening', 'draft', null, '0 9 * * *', 'per_cycle', 200, true, false, '{}'),
    (p_org, 'pap_smear',     'Pap smear reminder',                 'screening', 'draft', null, '0 9 * * *', 'per_cycle', 200, true, false, '{}'),
    (p_org, 'colonoscopy',   'Colonoscopy screening',              'screening', 'draft', null, '0 9 * * *', 'per_cycle', 200, true, false, '{}'),
    (p_org, 'skin_check',    'Skin cancer screening & mole check', 'screening', 'draft', null, '0 9 * * *', 'per_cycle', 200, true, false, '{}'),
    (p_org, 'pre_menopause', 'Pre-menopause assessment',           'screening', 'draft', null, '0 9 * * *', 'per_cycle', 200, true, false, '{}'),
    (p_org, 'menopause',     'Menopause assessment',               'screening', 'draft', null, '0 9 * * *', 'per_cycle', 200, true, false, '{}'),
    (p_org, 'dormant',       'Dormant patient reactivation',       'dormant',   'draft', null, '0 9 * * *', 'once',      200, true, false, '{}')
  on conflict (org_id, key) do nothing;

  select id into chronic from public.recall_programmes where org_id = p_org and key = 'chronic_90d';
  select id into bday    from public.recall_programmes where org_id = p_org and key = 'birthday';

  -- Chronic: per-condition Sanoflow template ids from the live SWITCH (R-23). No default row (fail closed).
  insert into public.recall_programme_templates (org_id, programme_id, segment_key, legacy_sanoflow_template_id) values
    (p_org, chronic, 'hypertension',   '13159'),
    (p_org, chronic, 'diabetes',       '13164'),
    (p_org, chronic, 'hyperlipidemia', '13163'),
    (p_org, chronic, 'hypothyroidism', '13169'),
    (p_org, chronic, 'ckd',            '13168'),
    (p_org, chronic, 'asthma',         '13162'),
    (p_org, chronic, 'copd',           '13165'),
    (p_org, chronic, 'ra',             '13161'),
    (p_org, chronic, 'af',             '13167'),
    (p_org, chronic, 'epilepsy',       '13166')
  on conflict (programme_id, segment_key) do nothing;

  -- Birthday: gender/age bands from the Make scenario (OQ-17).
  insert into public.recall_programme_templates (org_id, programme_id, segment_key, legacy_sanoflow_template_id) values
    (p_org, bday, 'm_20_29',  '12294'),
    (p_org, bday, 'm_30_39',  '12295'),
    (p_org, bday, 'm_40_plus','12296'),
    (p_org, bday, 'f_18_35',  '12289'),
    (p_org, bday, 'f_36_45',  '12291'),
    (p_org, bday, 'f_46_65',  '12291')
  on conflict (programme_id, segment_key) do nothing;
end $$;

-- ---------------------------------------------------------------------------
-- RLS + updated_at
-- ---------------------------------------------------------------------------
select app.add_tenant_rls('recall_programmes',          'campaigns.create');
select app.add_tenant_rls('recall_programme_templates', 'templates.manage');
select app.add_tenant_rls('recall_sends',               'portal.recall_sends.write');   -- call-list edits (follow_up_status, booked_at)
revoke all on function public.seed_recall_programmes(uuid) from public, anon, authenticated;
grant execute on function public.seed_recall_programmes(uuid) to service_role;
