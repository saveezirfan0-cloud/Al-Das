-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Recruitment calculator (M4A): recruitment defaults, saved scenarios, and the Ramadan, Eid and holiday calendar
-- (seeded once per organisation with approximate dates that Finance corrects).
-- Needs every earlier file first, up to and including 86_rooms_capacity.sql.
-- Check the project name in the Supabase header first: this is for the Pulse project only.

-- ======================================================================
-- 20261203000600_finance_recruitment_scenarios.sql
-- ======================================================================
-- M4 (first scenario): recruitment viability calculator (docs/40_MANAGEMENT_PLATFORM_PLAN.md §4 M4,
-- docs/23_PHASE_M4A_NOTES.md). Replaces the owner's May "Department Benchmarking Recruitment" workbook, without its
-- defects (docs/40 §1 #1 to #4). Everything here is a SCENARIO: it never writes to actual tables and is never pay.
--
--   * fin_ref_finance_settings: the calculator's defaults (conservative factor on claimed revenue, consumables %,
--     payment gateway %) and the minimum doctor-months for a department benchmark. Never constants in code.
--   * fin_recruitment_benchmarks(): per department, monthly net revenue per doctor from the current Unite collection
--     report rows (fin_report_visits) over the calendar months fully covered by committed uploads: median, 75th
--     percentile, doctor-months and doctors, plus the clinic-wide figures. Amounts and counts only (no doctor, no PIN).
--     Branch-scoped exactly like fin_doctor_performance_inputs (p_branches = the member's finance codes, null = all;
--     a row whose branch is not yet mapped is visible only to an unrestricted member). SECURITY DEFINER, service role
--     only; the server checks finance.profit.view AND finance.costs.compensation first.
--   * fin_ref_calendar_events: dated events (Ramadan, Eid, school holidays...) for the seasonal note. Seeded with the
--     UAE Ramadan and Eid dates for 2026 and 2027, all marked approximate (see the seed below). Read by
--     finance.profit.view holders; written only by audited server actions (finance.costs.manage).
--   * fin_recruitment_scenarios: saved scenarios (a role-label title, the inputs and the result as calculated). Read
--     by holders of BOTH finance.costs.compensation (the pay inputs) and finance.profit.view (the profit figures; the
--     Cost / Payroll role must never see revenue or profit, F8). Written only by audited server actions.

-- ---------------------------------------------------------------------------
-- 1. Settings
-- ---------------------------------------------------------------------------
alter table public.fin_ref_finance_settings
  add column recruit_conservative_pct numeric(5, 2) not null default 70,
  add column recruit_consumables_pct numeric(5, 2) not null default 12,
  add column recruit_gateway_pct numeric(5, 2) not null default 1.5,
  add column recruit_min_peer_months integer not null default 6,
  add constraint fin_ref_finance_settings_recruit_check check (
    recruit_conservative_pct > 0 and recruit_conservative_pct <= 100
    and recruit_consumables_pct >= 0 and recruit_gateway_pct >= 0
    and recruit_consumables_pct + recruit_gateway_pct < 100
    and recruit_min_peer_months between 1 and 1000);

-- ---------------------------------------------------------------------------
-- 2. Calendar events
-- ---------------------------------------------------------------------------
create table public.fin_ref_calendar_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  starts_on date not null,
  ends_on date not null,
  kind text not null check (kind in ('ramadan', 'eid', 'school_holiday', 'summer', 'other')),
  label text not null check (char_length(btrim(label)) between 1 and 80),
  -- true until the date is confirmed (moon sighting, ministry calendar)
  approximate boolean not null default false,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint fin_ref_calendar_events_dates_check check (ends_on >= starts_on and ends_on - starts_on <= 366),
  unique (org_id, kind, starts_on)
);
create index fin_ref_calendar_events_org_dates on public.fin_ref_calendar_events (org_id, starts_on);

alter table public.fin_ref_calendar_events enable row level security;
create policy fin_ref_calendar_events_select on public.fin_ref_calendar_events for select to authenticated
  using (app.has_perm(org_id, 'finance.profit.view'));

-- Seed: Ramadan and Eid in the UAE, 2026 and 2027. Source: the Emirates Astronomical Society and International
-- Astronomical Center forecasts as reported by The National and Gulf News (2026 forecasts published Jun 2025 to Jan
-- 2026; 1448 AH forecasts Aug to Oct 2026). Lunar dates move by a day with the moon sighting, so every row is
-- approximate until Finance checks it against the UAE announcement (editable on /finance/recruitment). Eid rows are
-- the public-holiday span (Eid al Adha includes Arafat Day).
create or replace function public.fin_seed_calendar_events(p_org_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  -- seed once: an org that already has calendar events (seeded earlier, or edited / pruned by Finance) is left alone,
  -- so a re-run of `pnpm finance:seed` never brings back a deleted event or duplicates a corrected date
  if exists (select 1 from public.fin_ref_calendar_events e where e.org_id = p_org_id) then
    return 0;
  end if;
  insert into public.fin_ref_calendar_events (org_id, starts_on, ends_on, kind, label, approximate) values
    (p_org_id, '2026-02-18', '2026-03-19', 'ramadan', 'Ramadan 1447', true),
    (p_org_id, '2026-03-20', '2026-03-22', 'eid', 'Eid al Fitr 1447', true),
    (p_org_id, '2026-05-26', '2026-05-29', 'eid', 'Arafat Day and Eid al Adha 1447', true),
    (p_org_id, '2027-02-08', '2027-03-09', 'ramadan', 'Ramadan 1448', true),
    (p_org_id, '2027-03-10', '2027-03-12', 'eid', 'Eid al Fitr 1448', true),
    (p_org_id, '2027-05-15', '2027-05-18', 'eid', 'Arafat Day and Eid al Adha 1448', true)
  on conflict (org_id, kind, starts_on) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.fin_seed_calendar_events(uuid) from public, anon, authenticated;
grant execute on function public.fin_seed_calendar_events(uuid) to service_role;

create or replace function app.fin_seed_m4a_on_org_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.fin_seed_calendar_events(new.id);
  return new;
end;
$$;
revoke all on function app.fin_seed_m4a_on_org_insert() from public, anon, authenticated;

create trigger orgs_seed_finance_m4a after insert on public.orgs
  for each row execute function app.fin_seed_m4a_on_org_insert();

select public.fin_seed_calendar_events(id) from public.orgs;

-- ---------------------------------------------------------------------------
-- 3. Saved scenarios
-- ---------------------------------------------------------------------------
create table public.fin_recruitment_scenarios (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  -- a role label ("Dermatologist, Jumeirah"), never a candidate's name
  title text not null check (char_length(btrim(title)) between 1 and 80),
  inputs jsonb not null check (jsonb_typeof(inputs) = 'object' and pg_column_size(inputs) <= 16384),
  result jsonb not null check (jsonb_typeof(result) = 'object' and pg_column_size(result) <= 32768),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index fin_recruitment_scenarios_org_created on public.fin_recruitment_scenarios (org_id, created_at desc);

alter table public.fin_recruitment_scenarios enable row level security;
create policy fin_recruitment_scenarios_select on public.fin_recruitment_scenarios for select to authenticated
  using (app.has_perm(org_id, 'finance.costs.compensation') and app.has_perm(org_id, 'finance.profit.view'));

-- ---------------------------------------------------------------------------
-- 4. Benchmarks
-- ---------------------------------------------------------------------------
-- A doctor-month is one doctor's net revenue (sum of Unite Net Billing, cancelled rows included as in 23B) in one
-- calendar month that committed uploads cover completely; months only partly covered are left out so a part month
-- never reads as a weak doctor. Doctor-months of 0 or less (no billing) are left out. Department figures group by
-- (department, doctor, month); clinic figures by (doctor, month), so a doctor working in two departments is one
-- clinic doctor-month. Percentiles are continuous (percentile_cont).
create or replace function public.fin_recruitment_benchmarks(p_org_id uuid, p_branches text[] default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_settings jsonb;
  v_months jsonb;
  v_departments jsonb;
  v_clinic jsonb;
begin
  if p_org_id is null then
    raise exception 'org is required' using errcode = 'invalid_parameter_value';
  end if;

  select jsonb_build_object(
           'conservative_pct', coalesce(s.recruit_conservative_pct, 70),
           'consumables_pct', coalesce(s.recruit_consumables_pct, 12),
           'gateway_pct', coalesce(s.recruit_gateway_pct, 1.5),
           'min_peer_months', coalesce(s.recruit_min_peer_months, 6))
    into v_settings
  from (select 1) one
  left join public.fin_ref_finance_settings s on s.org_id = p_org_id;

  with v as (
    select nullif(btrim(r.department), '') as department, r.doctor_key,
           date_trunc('month', r.report_date)::date as month, r.net
    from public.fin_report_visits r
    left join public.fin_ref_branches b
      on b.org_id = r.org_id and b.active and b.unite_clinic_long_name = r.clinic_name
    where r.org_id = p_org_id
      and r.is_current
      and (p_branches is null or coalesce(b.code, r.branch_code) = any (p_branches))
  ),
  full_months as (
    select m.month
    from (select distinct month from v) m
    where app.fin_report_coverage(p_org_id, m.month, ((m.month + interval '1 month')::date - 1))
          = jsonb_build_array(jsonb_build_object('from', m.month, 'to', ((m.month + interval '1 month')::date - 1)))
  ),
  dm as (
    select v.department, v.doctor_key, v.month, sum(v.net) as net
    from v join full_months f on f.month = v.month
    group by v.department, v.doctor_key, v.month
  ),
  cm as (
    select doctor_key, month, sum(net) as net from dm group by doctor_key, month
  )
  select
    (select coalesce(jsonb_agg(f.month order by f.month), '[]'::jsonb) from full_months f),
    (select coalesce(jsonb_agg(jsonb_build_object(
               'department', d.department, 'doctor_months', d.n, 'doctors', d.doctors,
               'median', d.median, 'p75', d.p75) order by d.department collate "C" nulls last), '[]'::jsonb)
     from (
       select department, count(*) as n, count(distinct doctor_key) as doctors,
              round((percentile_cont(0.5) within group (order by net))::numeric, 3) as median,
              round((percentile_cont(0.75) within group (order by net))::numeric, 3) as p75
       from dm
       where net > 0
       group by department
     ) d),
    (select jsonb_build_object(
               'department', null, 'doctor_months', count(*), 'doctors', count(distinct doctor_key),
               'median', round((percentile_cont(0.5) within group (order by net))::numeric, 3),
               'p75', round((percentile_cont(0.75) within group (order by net))::numeric, 3))
     from cm where net > 0)
    into v_months, v_departments, v_clinic;

  return jsonb_build_object(
    'settings', v_settings,
    'months', v_months,
    'departments', v_departments,
    'clinic', v_clinic
  );
end;
$$;
revoke all on function public.fin_recruitment_benchmarks(uuid, text[]) from public, anon, authenticated;
grant execute on function public.fin_recruitment_benchmarks(uuid, text[]) to service_role;
