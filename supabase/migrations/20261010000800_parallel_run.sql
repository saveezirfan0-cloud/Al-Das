-- Phase 8: parallel run of the native replacements against the Make scenarios (docs/audit/make-replacement-design.md §10).
--
-- For about a week each replacement runs in Test mode next to its Make scenario, and every day the two
-- sets of outputs are compared by IDENTIFIER ONLY (Unite appointment id or patient PIN: no names, no phone
-- numbers). Make's side is loaded from its Airtable log tables (pasted or uploaded as ids); the native side
-- comes from the replacement itself ("shadow" runs of a recall programme, or the reminder rows).
--   parallel_run_scenarios    the cut-over checklist per Make scenario
--   parallel_run_make_keys    ids Make handled on a day
--   parallel_run_native_keys  ids the native replacement would have handled (recall shadow runs)
--   parallel_run_diffs        the daily comparison

create table public.parallel_run_scenarios (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,48}$'),
  label text not null,
  make_scenario_ids text,
  native_summary text,
  compare_kind text not null default 'ids' check (compare_kind in ('ids', 'health', 'none')),
  native_ready boolean not null default false,
  parallel_started_on date,
  make_off_on date,
  signed_off_by text,
  signed_off_on date,
  notes text check (notes is null or char_length(notes) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, key),
  check (signed_off_by is null or signed_off_on is not null)
);

create table public.parallel_run_make_keys (
  org_id uuid not null references public.orgs (id) on delete cascade,
  scenario text not null,
  run_date date not null,
  key text not null check (char_length(key) between 1 and 80),
  primary key (org_id, scenario, run_date, key)
);

create table public.parallel_run_native_keys (
  org_id uuid not null references public.orgs (id) on delete cascade,
  scenario text not null,
  run_date date not null,
  key text not null check (char_length(key) between 1 and 80),
  primary key (org_id, scenario, run_date, key)
);

create table public.parallel_run_diffs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  scenario text not null,
  run_date date not null,
  make_count integer not null,
  native_count integer not null,
  only_in_make text[] not null default '{}',
  only_in_native text[] not null default '{}',
  note text check (note is null or char_length(note) <= 500),   -- why the difference is expected (e.g. already sent once, uncovered band)
  computed_at timestamptz not null default now(),
  unique (org_id, scenario, run_date)
);

-- The native side of the comparison for one day.
create or replace function public.parallel_run_native_keys_for(p_org uuid, p_scenario text, p_date date, p_tz text)
returns text[]
language plpgsql
stable
set search_path = ''
as $$
declare out text[];
begin
  if p_scenario = 'appointment_reminders' then
    -- Reminders due that day that were sent, or that Test mode held back for non-test patients.
    select coalesce(array_agg(distinct a.external_id), '{}') into out
      from public.appointment_reminders r
      join public.appointments a on a.id = r.appointment_id
     where r.org_id = p_org
       and (r.status = 'sent' or (r.status = 'excluded' and r.exclusion_reason = 'test_mode'))
       and (r.due_at at time zone p_tz)::date = p_date
       and a.external_id is not null;
  elsif p_scenario = 'chronic_update' then
    -- Patients whose recall was answered or booked that day (replaces the "Chronic Update" webhook).
    select coalesce(array_agg(distinct c.external_id), '{}') into out
      from public.recall_sends s
      join public.recall_programmes p on p.id = s.programme_id and p.key = 'chronic_90d'
      join public.contacts c on c.id = s.contact_id
     where s.org_id = p_org and c.external_id is not null
       and ((s.replied_at at time zone p_tz)::date = p_date or (s.booked_at at time zone p_tz)::date = p_date);
  else
    select coalesce(array_agg(distinct k.key), '{}') into out
      from public.parallel_run_native_keys k
     where k.org_id = p_org and k.scenario = p_scenario and k.run_date = p_date;
  end if;
  return out;
end;
$$;

create or replace function public.parallel_run_compare(p_org uuid, p_scenario text, p_date date, p_tz text default 'Asia/Dubai')
returns public.parallel_run_diffs
language plpgsql
set search_path = ''
as $$
declare
  n text[] := public.parallel_run_native_keys_for(p_org, p_scenario, p_date, p_tz);
  m text[];
  row public.parallel_run_diffs;
begin
  select coalesce(array_agg(distinct k.key), '{}') into m
    from public.parallel_run_make_keys k where k.org_id = p_org and k.scenario = p_scenario and k.run_date = p_date;
  insert into public.parallel_run_diffs as d (org_id, scenario, run_date, make_count, native_count, only_in_make, only_in_native)
  values (p_org, p_scenario, p_date, cardinality(m), cardinality(n),
          array(select unnest(m) except select unnest(n) order by 1),
          array(select unnest(n) except select unnest(m) order by 1))
  on conflict (org_id, scenario, run_date) do update
    set make_count = excluded.make_count, native_count = excluded.native_count,
        only_in_make = excluded.only_in_make, only_in_native = excluded.only_in_native, computed_at = now()
  returning * into row;
  return row;
end;
$$;

-- Native call health for the Token scenario: share of Unite calls (excluding the finance endpoint) that succeeded.
create or replace function public.parallel_run_unite_health(p_org uuid, p_days integer default 7)
returns table (total integer, ok integer)
language sql
stable
set search_path = ''
as $$
  select count(*)::int, count(*) filter (where coalesce(http_status, 0) between 200 and 299 and coalesce(lower(unite_status), 'success') !~ 'expired|invalid|error|fail')::int
    from public.unite_api_calls
   where org_id = p_org and at >= now() - make_interval(days => greatest(1, least(p_days, 60)));
$$;

create or replace function public.seed_parallel_run_scenarios(p_org uuid)
returns void
language sql
set search_path = ''
as $$
  insert into public.parallel_run_scenarios (org_id, key, label, make_scenario_ids, native_summary, compare_kind, native_ready, notes) values
    (p_org, 'token', 'Token (Unite sign-in)', '3576415', 'Tokens are refreshed on demand (lib/unite/auth.ts); no schedule, no stored plain-text keys.', 'health', true, 'Nothing to compare: judged by the Unite call success rate. Rotate the Unite keys at cut-over.'),
    (p_org, 'appointment_reminders', 'Appointment reminders (12:00 and 18:00)', '3613818, 3913219', 'Unite appointment sync plus reminder rows and the appointments queue (Phase 6). Test mode while both run.', 'ids', true, null),
    (p_org, 'birthday', 'Birthday message by age band', '4049277', 'Recall programme "Birthday message" (Flows → Recall programmes).', 'ids', true, null),
    (p_org, 'chronic_recall', 'Chronic recall', '5882746', 'Recall programme "Chronic condition recall"; needs the clinical gate and signed-off thresholds.', 'ids', true, null),
    (p_org, 'chronic_update', 'Chronic update (replied / booked)', '5916036', 'Replies and bookings attributed to the patient''s latest recall (no webhook).', 'ids', true, null),
    (p_org, 'mrd_sync', 'Acute follow-up: medical-record sync', '5990863', 'Not built: needs the Unite medical-records endpoint (undocumented, OQ list).', 'none', false, 'Blocked on the vendor. Make stays on for this scenario until the endpoint and fields are confirmed.')
  on conflict (org_id, key) do nothing;
$$;

revoke all on function public.parallel_run_native_keys_for(uuid, text, date, text), public.parallel_run_compare(uuid, text, date, text),
  public.parallel_run_unite_health(uuid, integer), public.seed_parallel_run_scenarios(uuid) from public, anon, authenticated;
grant execute on function public.parallel_run_native_keys_for(uuid, text, date, text), public.parallel_run_compare(uuid, text, date, text),
  public.parallel_run_unite_health(uuid, integer), public.seed_parallel_run_scenarios(uuid) to service_role;

select app.add_tenant_rls_gated('parallel_run_scenarios', 'flows.manage', 'flows.manage');
select app.add_tenant_rls_gated('parallel_run_make_keys', 'flows.manage');
select app.add_tenant_rls_gated('parallel_run_native_keys', 'flows.manage');
select app.add_tenant_rls_gated('parallel_run_diffs', 'flows.manage');
