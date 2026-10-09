-- Finance F1 / 4: reporting views. These are the single agreed definition of
-- every number the portal shows.
--
-- The views run with the owner's rights (security_invoker = false) and filter
-- on the caller's permission, so Finance / CEO can read aggregates without
-- being able to read individual invoices, and Insurance can read the invoice
-- fields needed for matching without payments. Every view is filtered by
-- app.has_perm(org_id, ...), so a member never sees another org's rows.
-- Only current, non-deleted invoices and current lines / payments count.

-- Invoice fields Insurance needs for matching claims (no payments, no referral data).
create view public.v_ins_invoice_match with (security_invoker = false) as
select i.org_id, i.id as invoice_id, i.inv_display_number, i.inv_key, i.transaction_date,
       i.branch_code, i.inv_type, i.doctor_dha_id, i.net, i.total, i.is_deleted
from public.fin_invoices i
where app.has_perm(i.org_id, 'finance.claims.view');

create view public.v_ins_invoice_line_match with (security_invoker = false) as
select l.org_id, l.id as line_id, l.invoice_id, l.line_key, l.position, l.item_code, l.cpt_code,
       l.qty, l.line_net
from public.fin_invoice_lines l
where l.is_current and app.has_perm(l.org_id, 'finance.claims.view');

-- Revenue at line grain, so service category is exact. Invoice-level
-- write-offs and credit notes are in v_fin_adjustments_daily (different grain).
create view public.v_fin_revenue_daily with (security_invoker = false) as
select i.org_id,
       i.transaction_date as date,
       i.branch_code,
       i.department,
       i.doctor_dha_id,
       i.doctor_name,
       coalesce(s.service_category, 'Unmapped') as service_category,
       i.inv_type,
       sum(l.line_gross)    as gross,
       sum(l.line_discount) as discount,
       sum(l.line_net)      as net,
       sum(l.vat)           as vat
from public.fin_invoices i
join public.fin_invoice_lines l on l.invoice_id = i.id and l.is_current
left join public.fin_ref_services s on s.org_id = i.org_id and s.item_code = l.item_code
where not i.is_deleted and app.has_perm(i.org_id, 'finance.view')
group by i.org_id, i.transaction_date, i.branch_code, i.department, i.doctor_dha_id, i.doctor_name,
         coalesce(s.service_category, 'Unmapped'), i.inv_type;

create view public.v_fin_adjustments_daily with (security_invoker = false) as
select i.org_id, i.transaction_date as date, i.branch_code, i.inv_type,
       sum(i.write_off) as write_off, sum(i.credit_note) as credit_note
from public.fin_invoices i
where not i.is_deleted and app.has_perm(i.org_id, 'finance.view')
group by i.org_id, i.transaction_date, i.branch_code, i.inv_type;

create view public.v_fin_collections_daily with (security_invoker = false) as
select p.org_id, p.paid_date as date, i.branch_code, p.payment_mode,
       sum(p.paid) as paid, sum(p.refund) as refunds
from public.fin_payments p
join public.fin_invoices i on i.id = p.invoice_id
where p.is_current and not i.is_deleted and app.has_perm(p.org_id, 'finance.view')
group by p.org_id, p.paid_date, i.branch_code, p.payment_mode;

-- Claims by month / payer / branch. Branch comes from the matched invoice
-- (null while a claim is unmatched).
create view public.v_fin_claims_status with (security_invoker = false) as
select c.org_id, c.claim_year, c.claim_month, c.payer_id, i.branch_code,
       count(*)                                                         as submitted,
       count(*) filter (where coalesce(c.remitted, 0) > 0)              as accepted,
       count(*) filter (where coalesce(c.rejected, 0) > 0)              as rejected,
       count(*) filter (where coalesce(c.remitted, 0) = 0 and coalesce(c.rejected, 0) = 0) as pending,
       count(*) filter (where coalesce(c.resubmission_count, 0) > 0)    as resubmitted,
       sum(c.net)      as net,
       sum(c.remitted) as remitted,
       sum(c.rejected) as rejected_amount
from public.ins_claim_activities c
left join public.fin_invoices i on i.id = c.matched_invoice_id
where app.has_perm(c.org_id, 'finance.view')
group by c.org_id, c.claim_year, c.claim_month, c.payer_id, i.branch_code;

-- Outstanding = net - remitted - approved write-offs, bucketed by age of the
-- claim's transaction date. 'approved' is the assumed write_off_status value
-- (confirm against the first unfiltered Diligence export).
create view public.v_fin_receivables_ageing with (security_invoker = false) as
with outstanding as (
  select c.org_id, c.payer_id, i.branch_code,
         greatest(coalesce(c.net, 0) - coalesce(c.remitted, 0)
                  - case when lower(coalesce(c.write_off_status, '')) = 'approved' then coalesce(c.write_off, 0) else 0 end, 0) as amount,
         (current_date - c.transaction_date) as age_days
  from public.ins_claim_activities c
  left join public.fin_invoices i on i.id = c.matched_invoice_id
  where c.transaction_date is not null and app.has_perm(c.org_id, 'finance.view')
)
select org_id, payer_id, branch_code,
       case when age_days <= 30 then '0-30'
            when age_days <= 60 then '31-60'
            when age_days <= 90 then '61-90'
            else '90+' end as bucket,
       count(*) as claim_activities,
       sum(amount) as outstanding
from outstanding
where amount > 0
group by org_id, payer_id, branch_code,
         case when age_days <= 30 then '0-30'
              when age_days <= 60 then '31-60'
              when age_days <= 90 then '61-90'
              else '90+' end;

create view public.v_fin_denials with (security_invoker = false) as
select c.org_id, c.denial_type, c.last_denial_code, c.clinician_id as doctor_dha_id,
       c.cpt_category as service_category, c.payer_id,
       count(*) as claim_activities, sum(c.rejected) as rejected_amount
from public.ins_claim_activities c
where coalesce(c.rejected, 0) > 0 and app.has_perm(c.org_id, 'finance.view')
group by c.org_id, c.denial_type, c.last_denial_code, c.clinician_id, c.cpt_category, c.payer_id;

-- generated . claimed . remitted . rejected . outstanding . self-pay collected, by month and branch.
create view public.v_fin_monthly_summary with (security_invoker = false) as
with generated as (
  select i.org_id, date_trunc('month', i.transaction_date)::date as month, i.branch_code, sum(i.net) as generated
  from public.fin_invoices i
  where not i.is_deleted and i.transaction_date is not null
  group by 1, 2, 3
), claimed as (
  select c.org_id, date_trunc('month', c.transaction_date)::date as month, i.branch_code,
         sum(c.net) as claimed, sum(c.remitted) as remitted, sum(c.rejected) as rejected,
         sum(greatest(coalesce(c.net, 0) - coalesce(c.remitted, 0)
             - case when lower(coalesce(c.write_off_status, '')) = 'approved' then coalesce(c.write_off, 0) else 0 end, 0)) as outstanding
  from public.ins_claim_activities c
  left join public.fin_invoices i on i.id = c.matched_invoice_id
  where c.transaction_date is not null
  group by 1, 2, 3
), selfpay as (
  select p.org_id, date_trunc('month', p.paid_date)::date as month, i.branch_code, sum(p.paid) as self_pay_collected
  from public.fin_payments p
  join public.fin_invoices i on i.id = p.invoice_id
  where p.is_current and not i.is_deleted and p.paid_date is not null and upper(coalesce(i.inv_type, '')) like 'SELF%'
  group by 1, 2, 3
), keys as (
  select org_id, month, branch_code from generated
  union select org_id, month, branch_code from claimed
  union select org_id, month, branch_code from selfpay
)
select k.org_id, k.month, k.branch_code,
       g.generated, c.claimed, c.remitted, c.rejected, c.outstanding, s.self_pay_collected
from keys k
left join generated g on g.org_id = k.org_id and g.month = k.month and g.branch_code is not distinct from k.branch_code
left join claimed   c on c.org_id = k.org_id and c.month = k.month and c.branch_code is not distinct from k.branch_code
left join selfpay   s on s.org_id = k.org_id and s.month = k.month and s.branch_code is not distinct from k.branch_code
where app.has_perm(k.org_id, 'finance.view');

-- Views are never exposed to anon.
revoke all on public.v_ins_invoice_match, public.v_ins_invoice_line_match, public.v_fin_revenue_daily,
  public.v_fin_adjustments_daily, public.v_fin_collections_daily, public.v_fin_claims_status,
  public.v_fin_receivables_ageing, public.v_fin_denials, public.v_fin_monthly_summary from anon;
grant select on public.v_ins_invoice_match, public.v_ins_invoice_line_match, public.v_fin_revenue_daily,
  public.v_fin_adjustments_daily, public.v_fin_collections_daily, public.v_fin_claims_status,
  public.v_fin_receivables_ageing, public.v_fin_denials, public.v_fin_monthly_summary to authenticated, service_role;
