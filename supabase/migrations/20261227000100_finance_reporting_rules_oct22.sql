-- Finance's answers of 22 Oct 2026 (the 19 Oct requests document, Q6, Q7 and Q39; docs/52_FINANCE_ANSWERS_OCT22_NOTES.md):
--
--   * Q7  The daily target is the month's target divided by the BRANCH's operating days in that month (Shoreline 30,
--         Meadows 30, Golden Mile 26, Longevity 26). fin_ref_revenue_targets.operating_days holds them per reporting line
--         and month (null = every calendar day, as before); the month target is the daily target × operating days and
--         lib/finance/flash.ts scales a period from it. fin_flash_set_targets stores the new field.
--   * Q6  The revenue-per-patient target counts PAID patients only: a visit with a zero invoice (a follow-up) is left
--         out. fin_flash_inputs adds paid_patients per row (patients whose net in the row is above 0); the patient count
--         itself is unchanged.
--   * Q39 Lab requests and bills match up to 5 days apart: fin_ref_finance_settings.lab_date_window_days defaults to 5,
--         and an organisation still on the old default (2) moves to 5. A value Finance chose is left alone.
--
-- fin_flash_inputs and fin_flash_set_targets were defined only in 20261023000300; both are redefined from there.

-- 1. Operating days per reporting line and month --------------------------------------------------------------------
alter table public.fin_ref_revenue_targets
  add column operating_days smallint check (operating_days is null or operating_days between 1 and 31);

comment on column public.fin_ref_revenue_targets.operating_days is
  'Days the line (branch) operates in the month; the month target is the daily target x these days (null = every calendar day).';

-- 2. Replace one month's targets atomically (now with operating days) -----------------------------------------------
-- p_rows: [{ "line_code": "PALM" | null, "daily_revenue": n|null, "daily_patients": n|null, "arpp": n|null,
--            "operating_days": n|null }]
create or replace function public.fin_flash_set_targets(p_org_id uuid, p_month date, p_rows jsonb, p_user uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_days integer;
begin
  if p_month is null or p_month <> date_trunc('month', p_month)::date then
    raise exception 'month must be the first day of a month' using errcode = 'invalid_parameter_value';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 100 then
    raise exception 'targets must be a list of at most 100 rows' using errcode = 'invalid_parameter_value';
  end if;
  v_days := extract(day from (p_month + interval '1 month' - interval '1 day'))::integer;
  if exists (
    select 1 from jsonb_array_elements(p_rows) r
    where nullif(r->>'operating_days', '') is not null and (r->>'operating_days')::integer not between 1 and v_days
  ) then
    raise exception 'operating days must be between 1 and the days in the month' using errcode = 'invalid_parameter_value',
      hint = 'operating_days';
  end if;
  delete from public.fin_ref_revenue_targets where org_id = p_org_id and month = p_month;
  insert into public.fin_ref_revenue_targets
    (org_id, month, line_code, daily_revenue, daily_patients, arpp, operating_days, created_by)
  select p_org_id, p_month, nullif(btrim(r->>'line_code'), ''),
         (r->>'daily_revenue')::numeric, (r->>'daily_patients')::numeric, (r->>'arpp')::numeric,
         nullif(r->>'operating_days', '')::smallint, p_user
  from jsonb_array_elements(p_rows) r
  where coalesce(r->>'daily_revenue', r->>'daily_patients', r->>'arpp') is not null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.fin_flash_set_targets(uuid, date, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.fin_flash_set_targets(uuid, date, jsonb, uuid) to service_role;

-- 3. Report input with paid patients ----------------------------------------------------------------------------------
-- Patient visits = distinct patients within the row (day, branch, department, doctor), as before (OQ-93). Paid patients
-- = those of them whose net in the row adds up to more than 0 (Q6). Deleted invoices excluded.
create or replace function public.fin_flash_inputs(p_org_id uuid, p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with basis as (select doctor_basis from public.fin_ref_finance_settings where org_id = p_org_id),
  inv as (
    select i.id, i.transaction_date, i.branch_code,
           coalesce(nullif(btrim(i.department), ''), d0.department) as department,
           case (select doctor_basis from basis)
             when 'ordering' then coalesce(i.ordering_doctor_dha_id, i.doctor_dha_id)
             when 'performing' then coalesce(i.performing_doctor_dha_id, i.doctor_dha_id)
             else i.doctor_dha_id end as doctor_id,
           i.doctor_name,
           coalesce(i.patient_ref, i.patient_pin, i.id::text) as pid,
           coalesce(i.net, 0) as net
    from public.fin_invoices i
    left join public.fin_ref_doctors d0 on d0.org_id = i.org_id and d0.dha_id = i.doctor_dha_id
    where i.org_id = p_org_id and not i.is_deleted
      and i.transaction_date between p_from and p_to
  ), per_patient as (
    select v.transaction_date, v.branch_code, v.department, v.doctor_id, v.pid, sum(v.net) as net
    from inv v
    group by v.transaction_date, v.branch_code, v.department, v.doctor_id, v.pid
  ), paid as (
    select p.transaction_date, p.branch_code, p.department, p.doctor_id, count(*) as paid_patients
    from per_patient p
    where p.net > 0
    group by p.transaction_date, p.branch_code, p.department, p.doctor_id
  ), grouped as (
    select v.transaction_date, v.branch_code, v.department, v.doctor_id,
           coalesce((select d.name from public.fin_ref_doctors d where d.org_id = p_org_id and d.dha_id = v.doctor_id),
                    max(v.doctor_name)) as doctor_name,
           round(sum(v.net), 2) as net,
           count(distinct v.pid) as patients,
           count(*) as invoices
    from inv v
    group by v.transaction_date, v.branch_code, v.department, v.doctor_id
  )
  select jsonb_build_object(
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'date', g.transaction_date, 'branch', g.branch_code, 'department', g.department,
        'doctor_id', g.doctor_id, 'doctor_name', g.doctor_name,
        'net', g.net, 'patients', g.patients, 'paid_patients', coalesce(p.paid_patients, 0), 'invoices', g.invoices)
        order by g.transaction_date, g.branch_code, g.department, g.doctor_id)
      from grouped g
      left join paid p
        on p.transaction_date = g.transaction_date
       and p.branch_code is not distinct from g.branch_code
       and p.department is not distinct from g.department
       and p.doctor_id is not distinct from g.doctor_id), '[]'::jsonb),
    'last_received_at', (select max(i.last_received_at) from public.fin_invoices i where i.org_id = p_org_id)
  );
$$;
revoke all on function public.fin_flash_inputs(uuid, date, date) from public, anon, authenticated;
grant execute on function public.fin_flash_inputs(uuid, date, date) to service_role;

-- 4. Lab matching window: 5 days ----------------------------------------------------------------------------------------
alter table public.fin_ref_finance_settings alter column lab_date_window_days set default 5;
update public.fin_ref_finance_settings set lab_date_window_days = 5 where lab_date_window_days = 2;
