-- Slice 20K: doctor billing mix and seasonal trends (docs/20_FINANCE_CONTROL_PLAN.md, slice 20K).
--
--   * fin_billing_mix(): per doctor (on the configured doctor basis, as fin_doctor_measures and the flash report) and
--     for the whole clinic: net of current invoice lines by service category (fin_ref_services; 'Unmapped' when the
--     item has no category), net and invoices by payer type (insurance / self-pay / other from inv_type), distinct
--     patients, invoices and lines. Deleted invoices excluded.
--   * fin_revenue_trend(): invoice net, invoices and distinct patients per week or month, with the same period a year
--     earlier (52 weeks earlier for weeks, so the weekdays line up; the same calendar month for months) and whether
--     the invoices on record reach back that far.
--
-- Counts and amounts only: no patient identifier leaves either function. Both are SECURITY DEFINER with
-- search_path = '', service role only; the page and the CSV route check finance.revenue.view first.
-- No new table, no new permission.

-- ---------------------------------------------------------------------------
-- 1. Billing mix per doctor
-- ---------------------------------------------------------------------------
create or replace function public.fin_billing_mix(p_org_id uuid, p_from date, p_to date, p_branch text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_basis text;
  v_result jsonb;
begin
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'the period must have a start on or before its end' using errcode = 'invalid_parameter_value';
  end if;
  select s.doctor_basis into v_basis from public.fin_ref_finance_settings s where s.org_id = p_org_id;

  with ln as (
    select i.id as invoice_id,
           case v_basis
             when 'ordering' then coalesce(i.ordering_doctor_dha_id, i.doctor_dha_id)
             when 'performing' then coalesce(i.performing_doctor_dha_id, i.doctor_dha_id)
             else i.doctor_dha_id end as doctor_id,
           i.doctor_dha_id as invoice_doctor_id,
           i.doctor_name,
           nullif(btrim(i.department), '') as department,
           coalesce(i.patient_ref, i.patient_pin, i.id::text) as pid,
           case when public.fin_is_insurance_type(i.inv_type) then 'insurance'
                when upper(coalesce(i.inv_type, '')) like 'SELF%' then 'self_pay'
                else 'other' end as payer,
           coalesce(nullif(btrim(s.service_category), ''), 'Unmapped') as category,
           coalesce(l.line_net, 0) as net
    from public.fin_invoices i
    join public.fin_invoice_lines l on l.invoice_id = i.id and l.is_current
    left join public.fin_ref_services s on s.org_id = i.org_id and s.item_code = l.item_code
    where i.org_id = p_org_id and not i.is_deleted
      and i.transaction_date between p_from and p_to
      and (p_branch is null or i.branch_code = p_branch)
  ), tot as (
    -- one row per doctor (null doctor included) and, from the empty grouping set, one clinic row
    select grouping(doctor_id) = 1 as is_clinic, doctor_id,
           -- the invoice's doctor name only describes the counted doctor when they are the same person
           max(doctor_name) filter (where invoice_doctor_id = doctor_id) as doctor_name,
           max(department) as department,
           round(sum(net), 2) as net,
           count(distinct invoice_id) as invoices,
           count(*) as lines,
           count(distinct pid) as patients,
           round(coalesce(sum(net) filter (where payer = 'insurance'), 0), 2) as insurance_net,
           round(coalesce(sum(net) filter (where payer = 'self_pay'), 0), 2) as self_pay_net,
           round(coalesce(sum(net) filter (where payer = 'other'), 0), 2) as other_net,
           count(distinct invoice_id) filter (where payer = 'insurance') as insurance_invoices,
           count(distinct invoice_id) filter (where payer = 'self_pay') as self_pay_invoices,
           count(distinct invoice_id) filter (where payer = 'other') as other_invoices
    from ln
    group by grouping sets ((doctor_id), ())
    having count(*) > 0  -- the empty grouping set returns a row even when nothing was billed
  ), cat as (
    select grouping(doctor_id) = 1 as is_clinic, doctor_id, category, round(sum(net), 2) as net
    from ln
    group by grouping sets ((doctor_id, category), (category))
  ), obj as (
    select t.is_clinic, t.net, t.doctor_id,
           jsonb_build_object(
             'doctor_id', t.doctor_id,
             'doctor_name', case when not t.is_clinic then coalesce(d.name, t.doctor_name) end,
             'department', case when not t.is_clinic then coalesce(d.department, t.department) end,
             'net', t.net, 'invoices', t.invoices, 'lines', t.lines, 'patients', t.patients,
             'payer', jsonb_build_object(
               'insurance', jsonb_build_object('net', t.insurance_net, 'invoices', t.insurance_invoices),
               'self_pay', jsonb_build_object('net', t.self_pay_net, 'invoices', t.self_pay_invoices),
               'other', jsonb_build_object('net', t.other_net, 'invoices', t.other_invoices)),
             'categories', coalesce((
               select jsonb_object_agg(c.category, c.net)
               from cat c
               where c.is_clinic = t.is_clinic and c.doctor_id is not distinct from t.doctor_id), '{}'::jsonb)
           ) as o
    from tot t
    left join public.fin_ref_doctors d on not t.is_clinic and d.org_id = p_org_id and d.dha_id = t.doctor_id
  )
  select jsonb_build_object(
    'doctor_basis', v_basis,
    'clinic', (select o.o from obj o where o.is_clinic),
    'rows', coalesce((select jsonb_agg(o.o order by o.net desc, o.doctor_id nulls last) from obj o where not o.is_clinic),
                     '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.fin_billing_mix(uuid, date, date, text) from public, anon, authenticated;
grant execute on function public.fin_billing_mix(uuid, date, date, text) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Revenue per week or month, with the same period a year earlier
-- ---------------------------------------------------------------------------
-- Net is the invoice net (as on the flash report and the Doctors page). Patients are distinct within each period.
-- Last year: an invoice dated d counts for the period that holds d + shift, when d + shift is inside the range
-- (shift = 364 days for weeks, 1 year for months; 29 Feb lands on 28 Feb). Periods at either end of the range are
-- clipped to it, and last year is clipped the same way. ly_covered is false when the first invoice on record is later
-- than the start of last year's window: the last-year figures are then incomplete and the page does not compare.
create or replace function public.fin_revenue_trend(
  p_org_id uuid, p_from date, p_to date, p_grain text default 'month', p_branch text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_shift interval;
  v_step interval;
  v_history date;
  v_result jsonb;
begin
  if p_grain is null or p_grain not in ('week', 'month') then
    raise exception 'unknown grain %', p_grain using errcode = 'invalid_parameter_value';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 1100 then
    raise exception 'the period must run forwards and cover at most three years' using errcode = 'invalid_parameter_value';
  end if;
  v_shift := case p_grain when 'week' then interval '364 days' else interval '1 year' end;
  v_step := case p_grain when 'week' then interval '7 days' else interval '1 month' end;
  select min(i.transaction_date) into v_history
  from public.fin_invoices i where i.org_id = p_org_id and not i.is_deleted;

  with periods as (
    select gs::date as period,
           greatest(gs::date, p_from) as d_from,
           least((gs + v_step)::date - 1, p_to) as d_to
    from generate_series(date_trunc(p_grain, p_from::timestamp), p_to::timestamp, v_step) gs
  ), cur as (
    select date_trunc(p_grain, i.transaction_date::timestamp)::date as period,
           round(sum(coalesce(i.net, 0)), 2) as net, count(*) as invoices,
           count(distinct coalesce(i.patient_ref, i.patient_pin, i.id::text)) as patients
    from public.fin_invoices i
    where i.org_id = p_org_id and not i.is_deleted
      and i.transaction_date between p_from and p_to
      and (p_branch is null or i.branch_code = p_branch)
    group by 1
  ), ly as (
    select date_trunc(p_grain, (i.transaction_date + v_shift))::date as period,
           round(sum(coalesce(i.net, 0)), 2) as net, count(*) as invoices,
           count(distinct coalesce(i.patient_ref, i.patient_pin, i.id::text)) as patients
    from public.fin_invoices i
    where i.org_id = p_org_id and not i.is_deleted
      -- loose bounds for the index, then the exact rule
      and i.transaction_date between (p_from - v_shift)::date - 1 and (p_to - v_shift)::date + 1
      and (i.transaction_date + v_shift)::date between p_from and p_to
      and (p_branch is null or i.branch_code = p_branch)
    group by 1
  )
  select jsonb_build_object(
    'grain', p_grain,
    'history_from', v_history,
    'rows', coalesce(jsonb_agg(jsonb_build_object(
      'period', p.period, 'from', p.d_from, 'to', p.d_to,
      'net', coalesce(c.net, 0), 'invoices', coalesce(c.invoices, 0), 'patients', coalesce(c.patients, 0),
      'ly_net', coalesce(l.net, 0), 'ly_invoices', coalesce(l.invoices, 0), 'ly_patients', coalesce(l.patients, 0),
      'ly_covered', v_history is not null and v_history <= (p.d_from - v_shift)::date)
      order by p.period), '[]'::jsonb)
  ) into v_result
  from periods p
  left join cur c on c.period = p.period
  left join ly l on l.period = p.period;
  return v_result;
end;
$$;
revoke all on function public.fin_revenue_trend(uuid, date, date, text, text) from public, anon, authenticated;
grant execute on function public.fin_revenue_trend(uuid, date, date, text, text) to service_role;
