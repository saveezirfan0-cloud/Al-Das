-- Phase 18 (5/7): analytics for payer scorecards, the collections forecast, revenue views, self-pay recovery,
-- the accounting export and the cash-up.
--
-- Every function here is SECURITY DEFINER, takes the organisation explicitly and is executable by the SERVICE ROLE ONLY:
-- the server runs can('finance.<feature>') first, then calls the function with member.orgId (CLAUDE.md rule 2). They
-- return jsonb (one value, so PostgREST's row cap never truncates a report). Identifiers and amounts only: the finance
-- tables hold no patient names, and none of these functions reads the raw payload tables.
--
-- Definitions are single-sourced here (CLAUDE.md "single definition of every number"):
--   outstanding (insurance)  = greatest(net - remitted - approved write-off, 0)         (same as v_fin_receivables_ageing)
--   denied claim             = initial_rejected > 0 or rejected > 0
--   days to pay              = first_remittance_date - transaction_date, claims with a remitted amount, never negative
--   self-pay balance         = total - paid + refund - write_off - credit_note, floored at 0
--   self-pay invoice         = upper(inv_type) like 'SELF%'                              (same as v_fin_monthly_summary)

-- ---------------------------------------------------------------------------
-- Payer scorecards: grouped by payer | doctor | department | branch for claims dated in [p_from, p_to]
-- ---------------------------------------------------------------------------
create or replace function public.fin_payer_scorecard(
  p_org_id uuid, p_from date, p_to date, p_group text, p_payer text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if p_group not in ('payer', 'doctor', 'department', 'branch') then
    raise exception 'unknown scorecard grouping %', p_group using errcode = 'invalid_parameter_value';
  end if;
  with base as (
    select c.id,
           case p_group
             when 'payer' then coalesce(c.payer_id, '(no payer)')
             when 'doctor' then coalesce(c.clinician_id, '(no doctor)')
             when 'department' then coalesce(d.department, i.department, '(no department)')
             else coalesce(i.branch_code, '(no branch)')
           end as group_key,
           case p_group when 'doctor' then d.name when 'payer' then pr.payer_name else null end as group_label,
           (coalesce(c.initial_rejected, 0) > 0 or coalesce(c.rejected, 0) > 0) as denied,
           coalesce(c.net, 0) as net, coalesce(c.remitted, 0) as remitted, coalesce(c.rejected, 0) as rejected,
           case when coalesce(c.remitted, 0) > 0 and c.first_remittance_date is not null and c.transaction_date is not null
                then greatest(c.first_remittance_date - c.transaction_date, 0) end as days_to_pay
    from public.ins_claim_activities c
    left join public.fin_invoices i on i.id = c.matched_invoice_id
    left join public.fin_ref_doctors d on d.org_id = c.org_id and d.dha_id = c.clinician_id
    left join public.fin_ref_payers pr on pr.org_id = c.org_id and pr.payer_id = c.payer_id
    where c.org_id = p_org_id and c.transaction_date between p_from and p_to
      and (p_payer is null or c.payer_id = p_payer)
  )
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.claims desc, t.group_key), '[]'::jsonb) into v_result
  from (
    select group_key, max(group_label) as group_label,
           count(*) as claims,
           count(*) filter (where denied) as denied_claims,
           round(sum(net), 2) as net, round(sum(remitted), 2) as remitted, round(sum(rejected), 2) as rejected,
           count(days_to_pay) as paid_claims,
           round(avg(days_to_pay)::numeric, 1) as avg_days_to_pay,
           round((percentile_cont(0.9) within group (order by days_to_pay))::numeric, 1) as p90_days_to_pay
    from base group by group_key
  ) t;
  return v_result;
end;
$$;
revoke all on function public.fin_payer_scorecard(uuid, date, date, text, text) from public, anon, authenticated;
grant execute on function public.fin_payer_scorecard(uuid, date, date, text, text) to service_role;

-- Top denial reasons in the period (code, taxonomy description, claim count, amount)
create or replace function public.fin_denial_reasons(
  p_org_id uuid, p_from date, p_to date, p_payer text default null, p_limit integer default 10
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.claims desc, t.reason_code), '[]'::jsonb)
  from (
    select coalesce(c.last_denial_code, '(no code)') as reason_code,
           max(tax.description) as description,
           max(tax.category) as category,
           count(*) as claims,
           round(sum(coalesce(c.rejected, 0)), 2) as amount
    from public.ins_claim_activities c
    left join lateral (
      select t.description, t.category from public.fin_ref_denial_codes t
      where t.org_id = c.org_id and t.active and c.last_denial_code is not null
        and ((not t.is_family and upper(t.code) = upper(c.last_denial_code))
          or (t.is_family and upper(t.code) = upper(substring(c.last_denial_code from '^[A-Za-z]+'))))
      order by t.is_family limit 1
    ) tax on true
    where c.org_id = p_org_id and c.transaction_date between p_from and p_to
      and (coalesce(c.rejected, 0) > 0 or coalesce(c.initial_rejected, 0) > 0)
      and (p_payer is null or c.payer_id = p_payer)
    group by coalesce(c.last_denial_code, '(no code)')
    order by count(*) desc, 1
    limit greatest(p_limit, 1)
  ) t;
$$;
revoke all on function public.fin_denial_reasons(uuid, date, date, text, integer) from public, anon, authenticated;
grant execute on function public.fin_denial_reasons(uuid, date, date, text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- Collections forecast inputs
--   fin_forecast_outstanding: what is still owed, by payer and week of the claim date
--   fin_forecast_history:     how each payer has paid so far (days-to-pay percentiles and collection rate)
-- ---------------------------------------------------------------------------
create or replace function public.fin_forecast_outstanding(p_org_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.payer_id, t.week_start), '[]'::jsonb)
  from (
    select coalesce(c.payer_id, '(no payer)') as payer_id,
           date_trunc('week', c.transaction_date)::date as week_start,
           count(*) as claims,
           round(sum(greatest(coalesce(c.net, 0) - coalesce(c.remitted, 0)
                 - case when lower(coalesce(c.write_off_status, '')) = 'approved' then coalesce(c.write_off, 0) else 0 end, 0)), 2) as outstanding
    from public.ins_claim_activities c
    where c.org_id = p_org_id and c.transaction_date is not null
      and greatest(coalesce(c.net, 0) - coalesce(c.remitted, 0)
            - case when lower(coalesce(c.write_off_status, '')) = 'approved' then coalesce(c.write_off, 0) else 0 end, 0) > 0
    group by 1, 2
  ) t;
$$;
revoke all on function public.fin_forecast_outstanding(uuid) from public, anon, authenticated;
grant execute on function public.fin_forecast_outstanding(uuid) to service_role;

create or replace function public.fin_forecast_history(p_org_id uuid, p_mature_days integer default 120)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.payer_id), '[]'::jsonb)
  from (
    select coalesce(c.payer_id, '(no payer)') as payer_id,
           count(*) filter (where days.d is not null) as paid_claims,
           round((percentile_cont(0.25) within group (order by days.d))::numeric, 1) as p25,
           round((percentile_cont(0.50) within group (order by days.d))::numeric, 1) as p50,
           round((percentile_cont(0.75) within group (order by days.d))::numeric, 1) as p75,
           round((percentile_cont(0.90) within group (order by days.d))::numeric, 1) as p90,
           -- collection rate over claims old enough that they should have been paid by now
           count(*) filter (where c.transaction_date <= current_date - p_mature_days) as mature_claims,
           round(coalesce(
             sum(least(coalesce(c.remitted, 0), coalesce(c.net, 0))) filter (where c.transaction_date <= current_date - p_mature_days)
             / nullif(sum(coalesce(c.net, 0)) filter (where c.transaction_date <= current_date - p_mature_days), 0), 0), 4) as collection_rate
    from public.ins_claim_activities c
    cross join lateral (
      select case when coalesce(c.remitted, 0) > 0 and c.first_remittance_date is not null and c.transaction_date is not null
                  then greatest(c.first_remittance_date - c.transaction_date, 0) end as d
    ) days
    where c.org_id = p_org_id and c.transaction_date is not null
    group by 1
  ) t;
$$;
revoke all on function public.fin_forecast_history(uuid, integer) from public, anon, authenticated;
grant execute on function public.fin_forecast_history(uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- Revenue breakdown: net revenue by doctor | department | branch | service | category | month for invoices dated in range
-- ---------------------------------------------------------------------------
create or replace function public.fin_revenue_breakdown(
  p_org_id uuid, p_from date, p_to date, p_dimension text, p_branch text default null, p_limit integer default 300
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if p_dimension not in ('doctor', 'department', 'branch', 'service', 'category', 'month') then
    raise exception 'unknown revenue dimension %', p_dimension using errcode = 'invalid_parameter_value';
  end if;
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.net desc nulls last, t.key), '[]'::jsonb) into v_result
  from (
    select x.key, max(x.label) as label,
           round(sum(x.net), 2) as net, round(sum(x.gross), 2) as gross, round(sum(x.discount), 2) as discount,
           round(sum(x.vat), 2) as vat, count(*) as lines, count(distinct x.invoice_id) as invoices
    from (
      select i.id as invoice_id,
             case p_dimension
               when 'doctor' then coalesce(i.doctor_dha_id, '(no doctor)')
               when 'department' then coalesce(i.department, d.department, '(no department)')
               when 'branch' then coalesce(i.branch_code, '(no branch)')
               when 'service' then coalesce(l.item_code, '(no item)')
               when 'category' then coalesce(s.service_category, 'Unmapped')
               else to_char(date_trunc('month', i.transaction_date), 'YYYY-MM')
             end as key,
             case p_dimension
               when 'doctor' then coalesce(d.name, i.doctor_name)
               when 'service' then s.description
               when 'branch' then b.name
               else null
             end as label,
             coalesce(l.line_net, 0) as net, coalesce(l.line_gross, 0) as gross,
             coalesce(l.line_discount, 0) as discount, coalesce(l.vat, 0) as vat
      from public.fin_invoices i
      join public.fin_invoice_lines l on l.invoice_id = i.id and l.is_current
      left join public.fin_ref_services s on s.org_id = i.org_id and s.item_code = l.item_code
      left join public.fin_ref_doctors d on d.org_id = i.org_id and d.dha_id = i.doctor_dha_id
      left join public.fin_ref_branches b on b.org_id = i.org_id and b.code = i.branch_code
      where i.org_id = p_org_id and not i.is_deleted and i.transaction_date between p_from and p_to
        and (p_branch is null or i.branch_code = p_branch)
    ) x
    group by x.key
    order by sum(x.net) desc nulls last, x.key
    limit greatest(p_limit, 1)
  ) t;
  return v_result;
end;
$$;
revoke all on function public.fin_revenue_breakdown(uuid, date, date, text, text, integer) from public, anon, authenticated;
grant execute on function public.fin_revenue_breakdown(uuid, date, date, text, text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- Self-pay balances (candidates for a WhatsApp reminder). PIN only: the server resolves the patient.
-- ---------------------------------------------------------------------------
create or replace function public.fin_selfpay_balances(
  p_org_id uuid, p_min_balance numeric default 0, p_min_days integer default 0, p_limit integer default 500
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.transaction_date, t.inv_display_number), '[]'::jsonb)
  from (
    select i.id as invoice_id, i.inv_display_number, i.patient_pin, i.transaction_date, i.branch_code,
           round(coalesce(i.total, 0), 2) as total,
           round(coalesce(p.paid, 0) - coalesce(p.refund, 0), 2) as settled,
           round(greatest(coalesce(i.total, 0) - coalesce(p.paid, 0) + coalesce(p.refund, 0)
                 - coalesce(i.write_off, 0) - coalesce(i.credit_note, 0), 0), 2) as balance,
           (current_date - i.transaction_date) as days_old
    from public.fin_invoices i
    left join lateral (
      select sum(pay.paid) as paid, sum(pay.refund) as refund
      from public.fin_payments pay where pay.invoice_id = i.id and pay.is_current
    ) p on true
    where i.org_id = p_org_id and not i.is_deleted and upper(coalesce(i.inv_type, '')) like 'SELF%'
      and i.transaction_date is not null and i.patient_pin is not null
      and (current_date - i.transaction_date) >= p_min_days
      and greatest(coalesce(i.total, 0) - coalesce(p.paid, 0) + coalesce(p.refund, 0)
            - coalesce(i.write_off, 0) - coalesce(i.credit_note, 0), 0) >= greatest(p_min_balance, 0.01)
    order by i.transaction_date, i.inv_display_number
    limit greatest(p_limit, 1)
  ) t;
$$;
revoke all on function public.fin_selfpay_balances(uuid, numeric, integer, integer) from public, anon, authenticated;
grant execute on function public.fin_selfpay_balances(uuid, numeric, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- Accounting export source: daily aggregates by branch and invoice type. Pure inputs for lib/finance/accounting-export.ts
-- (which turns them into balanced journal lines with the account map).
--   type: insurance | self_pay | other
-- ---------------------------------------------------------------------------
create or replace function public.fin_journal_source(p_org_id uuid, p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with inv as (
    select i.id, i.transaction_date as date, coalesce(i.branch_code, '(none)') as branch,
           case when public.fin_is_insurance_type(i.inv_type) then 'insurance'
                when upper(coalesce(i.inv_type, '')) like 'SELF%' then 'self_pay'
                else 'other' end as type,
           coalesce(i.total, 0) as total, coalesce(i.write_off, 0) as write_off, coalesce(i.credit_note, 0) as credit_note
    from public.fin_invoices i
    where i.org_id = p_org_id and not i.is_deleted and i.transaction_date between p_from and p_to
  ), sales as (
    select inv.date, inv.branch, inv.type, coalesce(s.service_category, 'Unmapped') as category,
           round(sum(coalesce(l.line_net, 0)), 2) as net, round(sum(coalesce(l.vat, 0)), 2) as vat
    from inv
    join public.fin_invoice_lines l on l.invoice_id = inv.id and l.is_current
    left join public.fin_ref_services s on s.org_id = p_org_id and s.item_code = l.item_code
    group by 1, 2, 3, 4
  ), totals as (
    select date, branch, type, round(sum(total), 2) as total, round(sum(write_off), 2) as write_off, round(sum(credit_note), 2) as credit_note
    from inv group by 1, 2, 3
  ), receipts as (
    select p.paid_date as date, coalesce(i.branch_code, '(none)') as branch,
           case when public.fin_is_insurance_type(i.inv_type) then 'insurance'
                when upper(coalesce(i.inv_type, '')) like 'SELF%' then 'self_pay'
                else 'other' end as type,
           coalesce(nullif(btrim(p.payment_mode), ''), '(unknown)') as mode,
           round(sum(coalesce(p.paid, 0)), 2) as paid
    from public.fin_payments p
    join public.fin_invoices i on i.id = p.invoice_id
    where p.org_id = p_org_id and p.is_current and not i.is_deleted and p.paid_date between p_from and p_to
    group by 1, 2, 3, 4
  ), refunds as (
    select coalesce(p.refund_date, p.paid_date) as date, coalesce(i.branch_code, '(none)') as branch,
           case when public.fin_is_insurance_type(i.inv_type) then 'insurance'
                when upper(coalesce(i.inv_type, '')) like 'SELF%' then 'self_pay'
                else 'other' end as type,
           coalesce(nullif(btrim(p.payment_mode), ''), '(unknown)') as mode,
           round(sum(coalesce(p.refund, 0)), 2) as refund
    from public.fin_payments p
    join public.fin_invoices i on i.id = p.invoice_id
    where p.org_id = p_org_id and p.is_current and not i.is_deleted and coalesce(p.refund, 0) <> 0
      and coalesce(p.refund_date, p.paid_date) between p_from and p_to
    group by 1, 2, 3, 4
  )
  select jsonb_build_object(
    'sales',    coalesce((select jsonb_agg(row_to_json(s)::jsonb order by s.date, s.branch, s.type, s.category) from sales s), '[]'::jsonb),
    'totals',   coalesce((select jsonb_agg(row_to_json(t)::jsonb order by t.date, t.branch, t.type) from totals t), '[]'::jsonb),
    'receipts', coalesce((select jsonb_agg(row_to_json(r)::jsonb order by r.date, r.branch, r.type, r.mode) from receipts r), '[]'::jsonb),
    'refunds',  coalesce((select jsonb_agg(row_to_json(f)::jsonb order by f.date, f.branch, f.type, f.mode) from refunds f), '[]'::jsonb)
  );
$$;
revoke all on function public.fin_journal_source(uuid, date, date) from public, anon, authenticated;
grant execute on function public.fin_journal_source(uuid, date, date) to service_role;

-- ---------------------------------------------------------------------------
-- Cash-up: what the system says was paid at a branch on a day, by payment mode (paid minus refunds that day)
-- ---------------------------------------------------------------------------
create or replace function public.fin_cashup_expected(p_org_id uuid, p_branch text, p_date date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with paid as (
    select coalesce(nullif(btrim(p.payment_mode), ''), '(unknown)') as mode, sum(coalesce(p.paid, 0)) as amount, count(*) as payments
    from public.fin_payments p
    join public.fin_invoices i on i.id = p.invoice_id
    where p.org_id = p_org_id and p.is_current and not i.is_deleted and p.paid_date = p_date
      and coalesce(i.branch_code, '(none)') = p_branch
    group by 1
  ), refunded as (
    select coalesce(nullif(btrim(p.payment_mode), ''), '(unknown)') as mode, sum(coalesce(p.refund, 0)) as amount
    from public.fin_payments p
    join public.fin_invoices i on i.id = p.invoice_id
    where p.org_id = p_org_id and p.is_current and not i.is_deleted and coalesce(p.refund_date, p.paid_date) = p_date
      and coalesce(p.refund, 0) <> 0 and coalesce(i.branch_code, '(none)') = p_branch
    group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'mode', m.mode,
           'expected', round(coalesce(pd.amount, 0) - coalesce(rf.amount, 0), 2),
           'payments', coalesce(pd.payments, 0)) order by m.mode), '[]'::jsonb)
  from (select mode from paid union select mode from refunded) m
  left join paid pd on pd.mode = m.mode
  left join refunded rf on rf.mode = m.mode;
$$;
revoke all on function public.fin_cashup_expected(uuid, text, date) from public, anon, authenticated;
grant execute on function public.fin_cashup_expected(uuid, text, date) to service_role;
