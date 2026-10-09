-- Phase 8: recall engine additions on top of the promoted drafts.
--   * recall_programmes.last_run_at           cron de-dupe for the recall_run task
--   * flows.last_triggered_at                 cron de-dupe for recurring flows
--   * v_appointment_reminder_due              eligibility for the 48h appointment reminder programme
--   * seed_recall_reminder_programme()        programme + legacy template map (Sanoflow 11885)
--   * parallel_run_*                          native-vs-Make comparison (IDs only: hashed PIN / appointment id)
-- Cron entries for the recall_run / flow_recurring / parallel_run tasks are at the bottom.

alter table public.recall_programmes add column if not exists last_run_at timestamptz;
alter table public.flows add column if not exists last_triggered_at timestamptz;

-- Appointments that need a reminder: starting in the future within config.lead_hours (default 48),
-- not cancelled / no-show / completed, contact has a phone and has not opted out.
-- cycle_key = appointment id, so the (programme, contact, cycle_key) unique key de-dupes re-runs
-- (replaces the Airtable log lookup of the 6 PM Make scenario).
create or replace view public.v_appointment_reminder_due with (security_invoker = true) as
select a.org_id,
       a.contact_id,
       '*'::text as segment_key,
       a.id::text as cycle_key,
       a.id as appointment_id,
       a.starts_at,
       sp.name as doctor_name,
       c.first_name,
       c.full_name as patient_name,
       public.is_reminder_excluded(a.org_id, c.full_name, sp.name) as excluded,
       (   c.phone_e164 is not null
       and not coalesce(c.stop_marketing, false)
       and not coalesce(c.is_test_record, false)
       and a.starts_at > now()
       and a.starts_at <= now() + make_interval(hours => coalesce((p.config ->> 'lead_hours')::int, 48))
       and a.status in ('awaiting', 'confirmed')
       and not exists (select 1 from public.recall_sends rs
                       where rs.programme_id = p.id and rs.contact_id = a.contact_id
                         and rs.cycle_key = a.id::text and rs.status not in ('cancelled', 'failed'))
       ) as eligible
from public.appointments a
join public.contacts c on c.id = a.contact_id and c.org_id = a.org_id
join public.recall_programmes p on p.org_id = a.org_id and p.key = 'appointment_reminder_48h'
left join public.specialists sp on sp.id = a.specialist_id;

create or replace function public.seed_recall_reminder_programme(p_org uuid)
returns void language plpgsql set search_path = '' as $$
declare prog uuid;
begin
  -- Make ran at 12:00 and 18:00 Asia/Dubai; the unique cycle key makes the second run a no-op (OQ-55).
  insert into public.recall_programmes (org_id, key, name, kind, status, eligibility_view, cron_expression,
                                        repeat_policy, max_per_run, requires_marketing_opt_in, requires_clinical_consent, config)
  values (p_org, 'appointment_reminder_48h', 'Appointment reminder', 'appointment_reminder', 'draft',
          'v_appointment_reminder_due', '0 12,18 * * *', 'per_cycle', 500, false, false,
          '{"lead_hours":48,"note":"Make queried tomorrow only (~24h); lead time is OQ-19"}')
  on conflict (org_id, key) do nothing;
  select id into prog from public.recall_programmes where org_id = p_org and key = 'appointment_reminder_48h';
  insert into public.recall_programme_templates (org_id, programme_id, segment_key, legacy_sanoflow_template_id, variables_map)
  values (p_org, prog, '*', '11885',
          '{"body.1":"contact.first_name|default:Patient","body.2":"appointment.starts_at|date:\"DD MMM HH:mm\"","body.3":"appointment.doctor_name"}')
  on conflict (programme_id, segment_key) do nothing;
end $$;
revoke all on function public.seed_recall_reminder_programme(uuid) from public, anon, authenticated;
grant execute on function public.seed_recall_reminder_programme(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Parallel run (one week of native Test-mode output vs Make output before each scenario is retired)
-- Stores IDs only: ref_hash = sha256(Unite PIN / Unite appointment id). No names, phones or message bodies.
-- ---------------------------------------------------------------------------
create table public.parallel_run_scenarios (
  org_id uuid not null references public.orgs (id) on delete cascade,
  scenario_key text not null,                          -- token | appointment_reminders | birthday | chronic_recall | chronic_update | mrd_sync | airtable_automations
  make_scenario_id text,
  name text not null,
  native_built boolean not null default false,
  parallel_started_on date,
  diffs_explained boolean not null default false,
  make_off boolean not null default false,
  blocked_reason text,                                 -- e.g. 'Needs Unite sync (Phase 6)'
  notes text,
  updated_at timestamptz not null default now(),
  primary key (org_id, scenario_key)
);

create table public.parallel_run_make_outputs (
  org_id uuid not null references public.orgs (id) on delete cascade,
  scenario_key text not null,
  run_date date not null,
  ref_hash text not null,
  primary key (org_id, scenario_key, run_date, ref_hash)
);

create table public.parallel_run_diffs (
  org_id uuid not null references public.orgs (id) on delete cascade,
  scenario_key text not null,
  run_date date not null,
  make_count int not null,
  native_count int not null,
  only_in_make text[] not null default '{}',
  only_in_native text[] not null default '{}',
  reason text,                                         -- every difference needs an explanation before Make is switched off
  explained boolean not null default false,
  computed_at timestamptz not null default now(),
  primary key (org_id, scenario_key, run_date)
);

create or replace function public.seed_parallel_run_scenarios(p_org uuid)
returns void language sql set search_path = '' as $$
  insert into public.parallel_run_scenarios (org_id, scenario_key, make_scenario_id, name, native_built, blocked_reason) values
    (p_org, 'token',                 '3576415', 'Token (Unite auth refresh)',        false, 'Needs lib/unite (Phase 6); Unite stays untouched until then'),
    (p_org, 'appointment_reminders', '3613818', 'Appointment reminders (12:00 + 18:00)', true,  'Needs Unite appointment sync (Phase 6) to produce real rows'),
    (p_org, 'birthday',              '4049277', 'Agewise birthday message',          true,  null),
    (p_org, 'chronic_recall',        '5882746', 'Chronic recall (90 day)',           true,  'Needs visits sync (Phase 6) and OQ-01 threshold sign-off'),
    (p_org, 'chronic_update',        '5916036', 'Chronic update (reply / booked)',   true,  null),
    (p_org, 'mrd_sync',              '5990863', 'Acute follow-up MRD sync',          false, 'Phase 6 clinical engine'),
    (p_org, 'airtable_automations',  null,      'Airtable native automations (2)',   false, 'Document then switch off (OQ-41)')
  on conflict do nothing;
$$;
revoke all on function public.seed_parallel_run_scenarios(uuid) from public, anon, authenticated;
grant execute on function public.seed_parallel_run_scenarios(uuid) to service_role;

alter table public.parallel_run_scenarios enable row level security;
alter table public.parallel_run_make_outputs enable row level security;
alter table public.parallel_run_diffs enable row level security;
create policy parallel_run_scenarios_select on public.parallel_run_scenarios for select to authenticated
  using (app.has_perm(org_id, 'reports.view'));
create policy parallel_run_scenarios_update on public.parallel_run_scenarios for update to authenticated
  using (app.has_perm(org_id, 'settings.manage')) with check (app.has_perm(org_id, 'settings.manage'));
create policy parallel_run_diffs_select on public.parallel_run_diffs for select to authenticated
  using (app.has_perm(org_id, 'reports.view'));
create policy parallel_run_diffs_update on public.parallel_run_diffs for update to authenticated
  using (app.has_perm(org_id, 'settings.manage')) with check (app.has_perm(org_id, 'settings.manage'));
-- make_outputs: engine/importer only (service role), no policies.

-- One call for everything a workspace needs before the recall engine / parallel-run report work.
-- Idempotent (every seed is ON CONFLICT DO NOTHING). Called lazily by the Recall page and by scripts.
create or replace function public.seed_phase8_defaults(p_org uuid)
returns void language plpgsql set search_path = '' as $$
begin
  perform public.seed_condition_groups(p_org);
  perform public.seed_clinical_settings(p_org);
  perform public.seed_recall_programmes(p_org);
  perform public.seed_recall_reminder_programme(p_org);
  perform public.seed_reminder_exclusions(p_org);
  perform public.seed_unite_appointment_status_map(p_org);
  perform public.seed_parallel_run_scenarios(p_org);
end $$;
revoke all on function public.seed_phase8_defaults(uuid) from public, anon, authenticated;
grant execute on function public.seed_phase8_defaults(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Cron: tasks pinged every minute; each task evaluates its own cron expressions (Asia/Dubai).
-- Names are unique, so these do not collide with the 20261008000500 unschedule loop.
-- ---------------------------------------------------------------------------
select cron.schedule('pulse:recall_run',        '* * * * *', $$select app.ping_jobs('recall_run')$$);
select cron.schedule('pulse:flow_recurring',    '* * * * *', $$select app.ping_jobs('flow_recurring')$$);
select cron.schedule('pulse:parallel_run',      '30 20 * * *', $$select app.ping_jobs('parallel_run')$$);   -- 00:30 Asia/Dubai (UTC+4)
