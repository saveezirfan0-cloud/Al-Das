-- Finance F9: the Insurance and receivables overview (Integration Blueprint v2, p5) and one definition of "accepted".
--
--   * v_fin_claims_status.accepted now follows the same evidence rule as v_fin_monthly_measures: a claim counts as
--     accepted only with a remitted amount or a status listed in fin_ref_finance_settings.accepted_claim_statuses
--   * fin_insurance_overview(): counts, amounts, ageing, payment timelines and the biggest open payers for claims in a
--     period. SECURITY DEFINER, service role only: the page checks finance.claims.view first, so the Insurance role (which
--     holds no finance.view) can have its own overview without access to revenue, costs or profit.
-- Identifiers and amounts only: no patient data.

create or replace view public.v_fin_claims_status with (security_invoker = false) as
select c.org_id, c.claim_year, c.claim_month, c.payer_id, i.branch_code,
       count(*)                                                                    as submitted,
       count(*) filter (where ev.evidenced)                                        as accepted,
       count(*) filter (where coalesce(c.rejected, 0) > 0)                         as rejected,
       count(*) filter (where not ev.evidenced and coalesce(c.rejected, 0) = 0)    as pending,
       count(*) filter (where coalesce(c.resubmission_count, 0) > 0)               as resubmitted,
       sum(c.net)      as net,
       sum(c.remitted) as remitted,
       sum(c.rejected) as rejected_amount
from public.ins_claim_activities c
left join public.fin_invoices i on i.id = c.matched_invoice_id
left join public.fin_ref_finance_settings s on s.org_id = c.org_id
cross join lateral (
  select (coalesce(c.remitted, 0) > 0
          or (s.accepted_claim_statuses is not null and exists (
                select 1 from unnest(s.accepted_claim_statuses) as x where lower(x) = lower(btrim(coalesce(c.claim_status, ''))))))
         as evidenced
) ev
where app.has_perm(c.org_id, 'finance.view')
group by c.org_id, c.claim_year, c.claim_month, c.payer_id, i.branch_code;

create or replace function public.fin_insurance_overview(p_org_id uuid, p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with base as (
    select c.id, c.payer_id, coalesce(c.net, 0) as net, coalesce(c.remitted, 0) as remitted, coalesce(c.rejected, 0) as rejected,
           coalesce(c.resubmission_count, 0) as resub,
           (nullif(btrim(coalesce(c.claim_status, '')), '') is null) as no_status,
           ( coalesce(c.remitted, 0) > 0
             or exists (select 1 from public.fin_ref_finance_settings s, unnest(s.accepted_claim_statuses) as x
                        where s.org_id = c.org_id and lower(x) = lower(btrim(coalesce(c.claim_status, ''))))) as evidenced,
           greatest(coalesce(c.net, 0) - coalesce(c.remitted, 0)
                    - case when lower(coalesce(c.write_off_status, '')) = 'approved' then coalesce(c.write_off, 0) else 0 end, 0) as outstanding,
           current_date - c.transaction_date as age_days,
           case when coalesce(c.remitted, 0) > 0 and c.first_remittance_date is not null
                then greatest(c.first_remittance_date - c.transaction_date, 0) end as days_to_pay
    from public.ins_claim_activities c
    where c.org_id = p_org_id and c.transaction_date between p_from and p_to
  ), allocated as (
    select b.id, sum(l.paid_amount) as paid
    from base b join public.ins_remittance_lines l on l.claim_activity_id = b.id and l.match_status = 'matched'
    group by b.id
  ), tot as (
    select count(*) as submitted,
           count(*) filter (where evidenced) as accepted,
           count(*) filter (where rejected > 0) as rejected,
           count(*) filter (where not evidenced and rejected = 0) as pending,
           count(*) filter (where not evidenced and rejected = 0 and no_status) as no_status,
           count(*) filter (where resub > 0) as resubmitted,
           coalesce(sum(net), 0) as claimed,
           coalesce(sum(net) filter (where evidenced), 0) as accepted_amount,
           coalesce(sum(rejected), 0) as rejected_amount,
           coalesce(sum(outstanding), 0) as outstanding,
           count(days_to_pay) as paid_claims,
           round(avg(days_to_pay)::numeric, 1) as avg_days_to_pay,
           round((percentile_cont(0.9) within group (order by days_to_pay))::numeric, 1) as p90_days_to_pay
    from base
  )
  select jsonb_build_object(
    'totals', (select to_jsonb(t) from tot t) || jsonb_build_object('paid_allocated', coalesce((select sum(paid) from allocated), 0)),
    'ageing', (
      select coalesce(jsonb_agg(jsonb_build_object('bucket', g.bucket, 'claims', g.n, 'outstanding', g.amt) order by g.ord), '[]'::jsonb)
      from (
        select case when age_days <= 30 then '0-30' when age_days <= 60 then '31-60' when age_days <= 90 then '61-90' else '90+' end as bucket,
               min(case when age_days <= 30 then 1 when age_days <= 60 then 2 when age_days <= 90 then 3 else 4 end) as ord,
               count(*) as n, round(sum(outstanding), 2) as amt
        from base where outstanding > 0
        group by 1
      ) g),
    'payers', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'payer_id', p.payer_id, 'payer_name', p.payer_name, 'claims', p.n, 'rejected', p.rej, 'outstanding', p.amt) order by p.amt desc), '[]'::jsonb)
      from (
        select coalesce(b.payer_id, '(no payer)') as payer_id,
               (select pr.payer_name from public.fin_ref_payers pr where pr.org_id = p_org_id and pr.payer_id = b.payer_id) as payer_name,
               count(*) as n, count(*) filter (where b.rejected > 0) as rej, round(sum(b.outstanding), 2) as amt
        from base b group by b.payer_id
        order by sum(b.outstanding) desc limit 15
      ) p)
  );
$$;
revoke all on function public.fin_insurance_overview(uuid, date, date) from public, anon, authenticated;
grant execute on function public.fin_insurance_overview(uuid, date, date) to service_role;
