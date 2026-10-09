-- Phase 8: recall engine additions on top of Phase 6 and 20261009001200_recall.sql.
--   * recall_programmes.last_run_at           cron de-dupe for the recall_run task
--   * flows.last_triggered_at                 cron de-dupe for recurring flows
--   * recall_clinical_messaging_enabled()     the patient-facing clinical gate, exposed to the engine
--   * seed_phase8_defaults()                  seeds a workspace for the recall pages
--   * parallel_run_*                          native-vs-Make comparison (IDs only: hashed PIN / appointment id)
-- Appointment reminders are Phase 6's (lib/appointments/reminders.ts); recall does not send them.
-- Cron entries for the recall_run / flow_recurring / parallel_run tasks are at the bottom.

alter table public.recall_programmes add column if not exists last_run_at timestamptz;
alter table public.flows add column if not exists last_triggered_at timestamptz;

-- The gate for patient-facing clinical messages. app.clinical_messaging_enabled is true only for a SIGNED-OFF
-- 'true'; allow_unsigned_defaults and proposed values never open it. Exposed (service role only) because
-- PostgREST serves only the public schema.
create or replace function public.recall_clinical_messaging_enabled(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select app.clinical_messaging_enabled(p_org)
$$;
revoke all on function public.recall_clinical_messaging_enabled(uuid) from public, anon, authenticated;
grant execute on function public.recall_clinical_messaging_enabled(uuid) to service_role;

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
    (p_org, 'appointment_reminders', '3613818', 'Appointment reminders (12:00 + 18:00)', true,  null),
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

-- One call for everything the recall pages need. Idempotent (every seed is ON CONFLICT DO NOTHING).
-- Called lazily by the Recall and Parallel run pages. Phase 6 seeds its own reminder exclusions and status map.
create or replace function public.seed_phase8_defaults(p_org uuid)
returns void language plpgsql set search_path = '' as $$
begin
  perform public.seed_condition_groups(p_org);
  perform public.seed_clinical_settings(p_org);
  perform public.seed_recall_programmes(p_org);
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
