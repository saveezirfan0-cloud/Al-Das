-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Doctor performance (Phase 23B): the revenue-per-patient target and band settings and the aggregate
-- function behind Finance, Doctor performance (service role only; counts and sums, no patient ids).
-- Needs every earlier file first, up to and including 67_finance_unite_report_functions.sql.
-- Check the project name in the Supabase header first: this is for the Pulse project only.

-- ======================================================================
-- 20261126000300_finance_doctor_performance.sql
-- ======================================================================
-- Phase 23B: doctor performance and month comparison (docs/39_UNITE_REPORTS_PLAN.md §4, docs/23_PHASE_23B_NOTES.md).
-- Replaces the clinic's hand-built "Revenue comparison" workbook.
--
--   * fin_ref_finance_settings: the revenue-per-patient target and the two lower band edges (bands are half-open, no
--     gaps: >= target Achieved, >= near Near Target, >= moderate Moderate, else Below Target).
--   * fin_doctor_performance_inputs(): per (department, doctor) for a calendar month and the month before it, sums and
--     counts from the current Unite collection report rows (fin_report_visits). Department and total patients are
--     distinct patients at that level (never a sum of doctors). Counts and amounts only: no PIN, no patient ref.
--     Branch scoping: p_branches is the member's allowed finance branch codes (null = no restriction; rows with no
--     branch stay visible, as app.location_visible_to() does); p_branch is the page's own filter (exactly that code).
--     SECURITY DEFINER, service role only; the server checks finance.revenue.view first.

-- ---------------------------------------------------------------------------
-- 1. Settings
-- ---------------------------------------------------------------------------
alter table public.fin_ref_finance_settings
  add column perf_arpp_target numeric(12, 2) not null default 750,
  add column perf_band_near numeric(12, 2) not null default 700,
  add column perf_band_moderate numeric(12, 2) not null default 650,
  add constraint fin_ref_finance_settings_perf_bands_check
    check (0 < perf_band_moderate and perf_band_moderate < perf_band_near and perf_band_near < perf_arpp_target);

-- ---------------------------------------------------------------------------
-- 2. Covered dates: the union of committed upload ranges, clipped to [p_from, p_to]
-- ---------------------------------------------------------------------------
create or replace function app.fin_report_coverage(p_org_id uuid, p_from date, p_to date)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with r as (
    select greatest(u.from_date, p_from) as f, least(u.to_date, p_to) as t
    from public.fin_report_uploads u
    where u.org_id = p_org_id and u.status = 'committed' and u.from_date <= p_to and u.to_date >= p_from
  ), marked as (
    select f, t,
           case when f <= max(t) over (order by f, t rows between unbounded preceding and 1 preceding) + 1
                then 0 else 1 end as starts
    from r
  ), grouped as (
    select f, t, sum(starts) over (order by f, t) as grp from marked
  )
  select coalesce(jsonb_agg(jsonb_build_object('from', g.f, 'to', g.t) order by g.f), '[]'::jsonb)
  from (select min(f) as f, max(t) as t from grouped group by grp) g;
$$;
revoke all on function app.fin_report_coverage(uuid, date, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Report input
-- ---------------------------------------------------------------------------
-- Patient id = coalesce(patient_ref, patient_pin), else the row itself (a row with neither is one patient, as the
-- flash report does). Cancelled rows count: Unite's own totals include them, and revenue must equal Unite's.
create or replace function public.fin_doctor_performance_inputs(
  p_org_id uuid,
  p_month date,
  p_branch text default null,
  p_branches text[] default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_month date;
  v_prev date;
  v_next date;
  v_branch text := nullif(btrim(p_branch), '');
  v_settings jsonb;
  v_scopes jsonb;
begin
  if p_org_id is null or p_month is null then
    raise exception 'org and month are required' using errcode = 'invalid_parameter_value';
  end if;
  v_month := date_trunc('month', p_month)::date;
  v_prev := (v_month - interval '1 month')::date;
  v_next := (v_month + interval '1 month')::date;

  select jsonb_build_object(
           'target', coalesce(s.perf_arpp_target, 750),
           'near', coalesce(s.perf_band_near, 700),
           'moderate', coalesce(s.perf_band_moderate, 650))
    into v_settings
  from (select 1) one
  left join public.fin_ref_finance_settings s on s.org_id = p_org_id;

  with v as (
    select case when r.report_date >= v_month then 'current' else 'previous' end as period,
           nullif(btrim(r.department), '') as department,
           r.doctor_key,
           r.doctor_name,
           coalesce(r.patient_ref, r.patient_pin, r.id::text) as pid,
           r.net,
           r.visit_status,
           r.is_cancelled
    from public.fin_report_visits r
    where r.org_id = p_org_id
      and r.is_current
      and r.report_date >= v_prev and r.report_date < v_next
      and (p_branches is null or r.branch_code is null or r.branch_code = any (p_branches))
      and (v_branch is null or r.branch_code = v_branch)
  ),
  -- Display name: the most frequent spelling for the doctor key over both months, ties alphabetical.
  names as (
    select distinct on (doctor_key) doctor_key, doctor_name
    from (select doctor_key, doctor_name, count(*) as n from v group by doctor_key, doctor_name) x
    order by doctor_key, n desc, doctor_name collate "C"
  ),
  -- g: 0 = doctor within department, 1 = department, 3 = total (grouping(department, doctor_key)).
  agg as (
    select period, department, doctor_key, grouping(department, doctor_key) as g,
           sum(net) as revenue,
           count(*) as visits,
           count(distinct pid) as patients,
           count(*) filter (where visit_status = 'new') as new_visits,
           count(*) filter (where is_cancelled) as cancelled_visits,
           count(distinct doctor_key) as doctors
    from v
    group by grouping sets ((period, department, doctor_key), (period, department), (period))
  ),
  per_patient as (
    select period, department, doctor_key, grouping(department, doctor_key) as g, pid, sum(net) as net
    from v
    group by grouping sets ((period, department, doctor_key, pid), (period, department, pid), (period, pid))
  ),
  unbilled as (
    select period, department, doctor_key, g, count(*) filter (where net <= 0) as n
    from per_patient
    group by period, department, doctor_key, g
  ),
  res as (
    select a.*, coalesce(u.n, 0) as unbilled_patients
    from agg a
    left join unbilled u
      on u.period = a.period and u.g = a.g
     and u.department is not distinct from a.department and u.doctor_key is not distinct from a.doctor_key
  )
  select jsonb_object_agg(p.period, jsonb_build_object(
           'doctors', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'department', x.department, 'doctor_key', x.doctor_key, 'doctor_name', n.doctor_name,
                      'revenue', x.revenue, 'visits', x.visits, 'patients', x.patients,
                      'unbilled_patients', x.unbilled_patients, 'new_visits', x.new_visits)
                    order by x.department collate "C" nulls last, x.doctor_key collate "C")
             from res x join names n on n.doctor_key = x.doctor_key
             where x.period = p.period and x.g = 0), '[]'::jsonb),
           'departments', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'department', x.department, 'doctors', x.doctors,
                      'revenue', x.revenue, 'visits', x.visits, 'patients', x.patients,
                      'unbilled_patients', x.unbilled_patients, 'new_visits', x.new_visits)
                    order by x.department collate "C" nulls last)
             from res x
             where x.period = p.period and x.g = 1), '[]'::jsonb),
           'total', coalesce((
             select jsonb_build_object(
                      'doctors', x.doctors, 'revenue', x.revenue, 'visits', x.visits, 'patients', x.patients,
                      'unbilled_patients', x.unbilled_patients, 'new_visits', x.new_visits,
                      'cancelled_visits', x.cancelled_visits)
             from res x
             where x.period = p.period and x.g = 3),
             jsonb_build_object('doctors', 0, 'revenue', 0, 'visits', 0, 'patients', 0, 'unbilled_patients', 0,
                                'new_visits', 0, 'cancelled_visits', 0))))
    into v_scopes
  from (values ('current'), ('previous')) as p (period);

  return jsonb_build_object(
    'month', v_month,
    'previous_month', v_prev,
    'branch', v_branch,
    'coverage', app.fin_report_coverage(p_org_id, v_month, (v_next - 1)),
    'previous_coverage', app.fin_report_coverage(p_org_id, v_prev, (v_month - 1)),
    'settings', v_settings,
    'current', v_scopes -> 'current',
    'previous', v_scopes -> 'previous'
  );
end;
$$;
revoke all on function public.fin_doctor_performance_inputs(uuid, date, text, text[]) from public, anon, authenticated;
grant execute on function public.fin_doctor_performance_inputs(uuid, date, text, text[]) to service_role;

-- ---------------------------------------------------------------------------
-- 4. The latest month with current report rows (the page's default month)
-- ---------------------------------------------------------------------------
create or replace function public.fin_report_latest_month(p_org_id uuid, p_branches text[] default null)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select date_trunc('month', max(r.report_date))::date
  from public.fin_report_visits r
  where r.org_id = p_org_id and r.is_current
    and (p_branches is null or r.branch_code is null or r.branch_code = any (p_branches));
$$;
revoke all on function public.fin_report_latest_month(uuid, text[]) from public, anon, authenticated;
grant execute on function public.fin_report_latest_month(uuid, text[]) to service_role;
