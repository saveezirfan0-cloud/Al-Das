-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Management alerts (M1): alert settings, the service-only alert state table with its atomic claim, and the inputs
-- function the daily finance job reads (amounts and codes only).
-- Needs every earlier file first, up to and including 86_finance_insurance_billing.sql.
-- Check the project name in the Supabase header first: this is for the Pulse project only.

-- ======================================================================
-- 20261208000300_finance_management_alerts.sql
-- ======================================================================
-- M1 management alerts (docs/40_MANAGEMENT_PLATFORM_PLAN.md §4 M1, docs/23_PHASE_23E_NOTES.md).
--
--   * fin_ref_finance_settings: the four alert thresholds (never constants in code).
--   * fin_mgmt_alert_state: one row per (rule, scope, period) that has been announced. Open while cleared_at is null;
--     a rule that clears sets cleared_at, and the same key can be raised again later. Service role only (no policies).
--   * fin_mgmt_alert_claim(): the atomic claim. True only for the one caller that inserted the key, or reopened a
--     cleared one, so a retried or overlapping run never notifies twice.
--   * fin_mgmt_alert_inputs(): what the rules read for one month from the Unite collection report (Phase 23A): the
--     latest committed covered day, the month's covered dates, and net revenue per day, branch and department. Amounts
--     and codes only: no PIN, no patient ref, no doctor. The branch is worked out when read (the current
--     fin_ref_branches mapping, the code stored at commit as fallback), as in fin_doctor_performance_inputs().
--     SECURITY DEFINER, service role only; called by the daily finance_workflows job.

-- ---------------------------------------------------------------------------
-- 1. Settings
-- ---------------------------------------------------------------------------
alter table public.fin_ref_finance_settings
  add column alert_report_late_days integer not null default 3
    check (alert_report_late_days between 1 and 60),
  add column alert_revenue_target_pct numeric(5, 2) not null default 90
    check (alert_revenue_target_pct > 0 and alert_revenue_target_pct <= 100),
  add column alert_revenue_target_days integer not null default 3
    check (alert_revenue_target_days between 1 and 31),
  add column alert_band_min_patients integer not null default 10
    check (alert_band_min_patients between 1 and 100000);

-- ---------------------------------------------------------------------------
-- 2. What has been announced
-- ---------------------------------------------------------------------------
create table public.fin_mgmt_alert_state (
  org_id uuid not null references public.orgs (id) on delete cascade,
  rule text not null check (rule in ('report_late', 'revenue_behind', 'band_below')),
  scope text not null check (scope ~ '^[a-z]{1,8}(:[A-Z0-9_]{1,12})?$'),   -- 'all', 'total' or 'line:<code>'
  period text not null check (period ~ '^(-|[0-9]{4}-(0[1-9]|1[0-2]))$'),  -- '-' or 'yyyy-mm'
  raised_at timestamptz not null default now(),
  cleared_at timestamptz,
  primary key (org_id, rule, scope, period)
);
alter table public.fin_mgmt_alert_state enable row level security;   -- service role only

create or replace function public.fin_mgmt_alert_claim(p_org_id uuid, p_rule text, p_scope text, p_period text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  insert into public.fin_mgmt_alert_state as s (org_id, rule, scope, period)
  values (p_org_id, p_rule, p_scope, p_period)
  on conflict (org_id, rule, scope, period) do update
    set raised_at = now(), cleared_at = null
    where s.cleared_at is not null;
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;
revoke all on function public.fin_mgmt_alert_claim(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.fin_mgmt_alert_claim(uuid, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Inputs for one month
-- ---------------------------------------------------------------------------
create or replace function public.fin_mgmt_alert_inputs(p_org_id uuid, p_month date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_month date;
  v_next date;
begin
  if p_org_id is null or p_month is null then
    raise exception 'org and month are required' using errcode = 'invalid_parameter_value';
  end if;
  v_month := date_trunc('month', p_month)::date;
  v_next := (v_month + interval '1 month')::date;

  return jsonb_build_object(
    'month', v_month,
    'last_covered', (
      select max(u.to_date) from public.fin_report_uploads u
      where u.org_id = p_org_id and u.status = 'committed'),
    'coverage', app.fin_report_coverage(p_org_id, v_month, (v_next - 1)),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object('date', d.report_date, 'branch', d.branch, 'department', d.department,
                                          'net', d.net)
                       order by d.report_date, d.branch collate "C" nulls last, d.department collate "C" nulls last)
      from (
        select r.report_date,
               coalesce(b.code, r.branch_code) as branch,
               nullif(btrim(r.department), '') as department,
               sum(r.net) as net
        from public.fin_report_visits r
        left join public.fin_ref_branches b
          on b.org_id = r.org_id and b.active and b.unite_clinic_long_name = r.clinic_name
        where r.org_id = p_org_id
          and r.is_current
          and r.report_date >= v_month and r.report_date < v_next
        group by 1, 2, 3
      ) d), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.fin_mgmt_alert_inputs(uuid, date) from public, anon, authenticated;
grant execute on function public.fin_mgmt_alert_inputs(uuid, date) to service_role;
