-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Clears the security advisor's security_definer_view errors on the 14 finance views. Needs every earlier file first, up to
-- and including 58_pin_function_search_path.sql. What each member can see is unchanged; six views no screen reads are
-- closed to signed-in users.
-- Check the project name in the Supabase header first: this is for the Pulse project only.

-- ======================================================================
-- 20261119000100_finance_views_invoker.sql
-- ======================================================================
-- Security advisor (security_definer_view): the 14 finance reporting views ran with their owner's rights.
-- docs/34_FINANCE_VIEWS_INVOKER_NOTES.md has the per-view reasoning. Access stays exactly as it was: nobody gains
-- a row, and the only loss is the six views no screen reads (section 1).
--
-- None of the 14 can simply be switched to security_invoker: each one deliberately shows a permission holder more
-- than the base tables' RLS lets them read (Finance / CEO / Medical Director hold finance.view but the invoice
-- tables need finance.invoices.view and the claim table finance.claims.view; Insurance reads invoice fields without
-- finance.invoices.view; Billing sees claim sums without finance.claims.view; the freshness view reads the
-- service-only raw tables). So:
--
--   1. Six views that nothing in the app reads (every finance screen uses the member's own client, and the service
--      role sees no rows in them anyway because app.has_perm needs auth.uid()) are revoked from the API roles.
--      They stay owner-rights views, usable only by the owner: v_fin_monthly_summary is still the source of
--      v_fin_monthly_measures.
--   2. Seven views the screens read become security_invoker views over a SECURITY DEFINER function in the
--      unexposed `app` schema (search_path = '', EXECUTE for authenticated and service_role only). The function
--      body is the previous view query. The one rewrite: a per-row app.has_perm(x.org_id, p) filter is written as
--      x.org_id in (the caller's orgs where app.has_perm(org, p)), which is the same test (has_perm requires an
--      active membership, which is what app.user_org_ids lists) evaluated once per org instead of once per row,
--      to make up for filters on the view no longer reaching inside the function. Rows each member sees are unchanged.
--   3. v_fin_invoice_list becomes security_invoker over the base tables (its gate, finance.invoices.view, is the
--      invoice and payment tables' own RLS rule), with only the claim sums behind a SECURITY DEFINER helper that
--      repeats the same gate. Paging and counting keep running on the plain tables.

-- ---------------------------------------------------------------------------
-- 1. Unread views: no API access.
-- ---------------------------------------------------------------------------
revoke all on public.v_ins_invoice_match, public.v_ins_invoice_line_match, public.v_fin_revenue_daily,
  public.v_fin_adjustments_daily, public.v_fin_collections_daily, public.v_fin_monthly_summary
  from anon, authenticated;
grant select on public.v_ins_invoice_match, public.v_ins_invoice_line_match, public.v_fin_revenue_daily,
  public.v_fin_adjustments_daily, public.v_fin_collections_daily, public.v_fin_monthly_summary
  to service_role;

-- ---------------------------------------------------------------------------
-- 2. Screen views: invoker view over a definer function holding the previous query.
-- ---------------------------------------------------------------------------

-- v_fin_receivables_ageing (finance.view), from 20261009000400.
create or replace function app.fin_view_receivables_ageing()
returns table (org_id uuid, payer_id text, branch_code text, bucket text, claim_activities bigint, outstanding numeric)
language sql
stable
security definer
set search_path = ''
as $$
  with outstanding as (
    select c.org_id, c.payer_id, i.branch_code,
           greatest(coalesce(c.net, 0) - coalesce(c.remitted, 0)
                    - case when lower(coalesce(c.write_off_status, '')) = 'approved' then coalesce(c.write_off, 0) else 0 end, 0) as amount,
           (current_date - c.transaction_date) as age_days
    from public.ins_claim_activities c
    left join public.fin_invoices i on i.id = c.matched_invoice_id
    where c.transaction_date is not null and c.org_id in (select o.org_id from app.user_org_ids() as o(org_id) where app.has_perm(o.org_id, 'finance.view'))
  )
  select o.org_id, o.payer_id, o.branch_code,
         case when o.age_days <= 30 then '0-30'
              when o.age_days <= 60 then '31-60'
              when o.age_days <= 90 then '61-90'
              else '90+' end as bucket,
         count(*) as claim_activities,
         sum(o.amount) as outstanding
  from outstanding o
  where o.amount > 0
  group by o.org_id, o.payer_id, o.branch_code,
           case when o.age_days <= 30 then '0-30'
                when o.age_days <= 60 then '31-60'
                when o.age_days <= 90 then '61-90'
                else '90+' end;
$$;

-- v_fin_denials (finance.view), from 20261009000400.
create or replace function app.fin_view_denials()
returns table (org_id uuid, denial_type text, last_denial_code text, doctor_dha_id text, service_category text,
               payer_id text, claim_activities bigint, rejected_amount numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select c.org_id, c.denial_type, c.last_denial_code, c.clinician_id as doctor_dha_id,
         c.cpt_category as service_category, c.payer_id,
         count(*) as claim_activities, sum(c.rejected) as rejected_amount
  from public.ins_claim_activities c
  where coalesce(c.rejected, 0) > 0 and c.org_id in (select o.org_id from app.user_org_ids() as o(org_id) where app.has_perm(o.org_id, 'finance.view'))
  group by c.org_id, c.denial_type, c.last_denial_code, c.clinician_id, c.cpt_category, c.payer_id;
$$;

-- v_fin_claims_status (finance.view), from 20261022000100.
create or replace function app.fin_view_claims_status()
returns table (org_id uuid, claim_year integer, claim_month integer, payer_id text, branch_code text,
               submitted bigint, accepted bigint, rejected bigint, pending bigint, resubmitted bigint,
               net numeric, remitted numeric, rejected_amount numeric)
language sql
stable
security definer
set search_path = ''
as $$
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
  where c.org_id in (select o.org_id from app.user_org_ids() as o(org_id) where app.has_perm(o.org_id, 'finance.view'))
  group by c.org_id, c.claim_year, c.claim_month, c.payer_id, i.branch_code;
$$;

-- v_fin_revenue_monthly (finance.view), from 20261009000990.
create or replace function app.fin_view_revenue_monthly()
returns table (org_id uuid, month date, branch_code text, department text, doctor_dha_id text, doctor_name text,
               service_category text, inv_type text, gross numeric, discount numeric, net numeric, vat numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select i.org_id,
         date_trunc('month', i.transaction_date)::date as month,
         i.branch_code, i.department, i.doctor_dha_id, i.doctor_name,
         coalesce(s.service_category, 'Unmapped') as service_category,
         i.inv_type,
         sum(l.line_gross) as gross, sum(l.line_discount) as discount, sum(l.line_net) as net, sum(l.vat) as vat
  from public.fin_invoices i
  join public.fin_invoice_lines l on l.invoice_id = i.id and l.is_current
  left join public.fin_ref_services s on s.org_id = i.org_id and s.item_code = l.item_code
  where not i.is_deleted and i.transaction_date is not null
    and i.org_id in (select o.org_id from app.user_org_ids() as o(org_id) where app.has_perm(o.org_id, 'finance.view'))
  group by i.org_id, date_trunc('month', i.transaction_date)::date, i.branch_code, i.department, i.doctor_dha_id,
           i.doctor_name, coalesce(s.service_category, 'Unmapped'), i.inv_type;
$$;

-- v_fin_monthly_measures (finance.view through v_fin_monthly_summary), from 20261021000100.
create or replace function app.fin_view_monthly_measures()
returns table (org_id uuid, month date, branch_code text, generated numeric, claimed numeric, accepted numeric,
               paid_allocated numeric, remitted numeric, rejected numeric, outstanding numeric,
               self_pay_collected numeric, status_unknown_claims bigint)
language sql
stable
security definer
set search_path = ''
as $$
  with flagged as (
    select c.org_id, date_trunc('month', c.transaction_date)::date as month, i.branch_code, c.net, c.id,
           ( coalesce(c.remitted, 0) > 0
             or exists (select 1 from public.fin_ref_finance_settings s, unnest(s.accepted_claim_statuses) as x
                        where s.org_id = c.org_id and lower(x) = lower(btrim(coalesce(c.claim_status, '')))) ) as evidenced,
           ( nullif(btrim(coalesce(c.claim_status, '')), '') is null and coalesce(c.remitted, 0) = 0 and coalesce(c.rejected, 0) = 0 ) as unknown_status
    from public.ins_claim_activities c
    left join public.fin_invoices i on i.id = c.matched_invoice_id
    where c.transaction_date is not null
  ), acc as (
    select f.org_id, f.month, f.branch_code,
           sum(f.net) filter (where f.evidenced) as accepted,
           count(*) filter (where f.unknown_status) as status_unknown_claims
    from flagged f group by f.org_id, f.month, f.branch_code
  ), paid as (
    select f.org_id, f.month, f.branch_code, sum(l.paid_amount) as paid_allocated
    from public.ins_remittance_lines l
    join flagged f on f.id = l.claim_activity_id
    where l.match_status = 'matched'
    group by f.org_id, f.month, f.branch_code
  )
  select m.org_id, m.month, m.branch_code, m.generated, m.claimed, a.accepted, p.paid_allocated, m.remitted, m.rejected,
         m.outstanding, m.self_pay_collected, a.status_unknown_claims
  from public.v_fin_monthly_summary m
  left join acc a on a.org_id = m.org_id and a.month = m.month and a.branch_code is not distinct from m.branch_code
  left join paid p on p.org_id = m.org_id and p.month = m.month and p.branch_code is not distinct from m.branch_code;
$$;

-- v_fin_data_freshness (finance.view; reads the service-only raw tables), from 20261021000100.
create or replace function app.fin_view_data_freshness()
returns table (org_id uuid, capture_enabled boolean, credentials_configured boolean,
               last_capture_at timestamptz, last_import_at timestamptz, batch_count bigint, invoice_count bigint,
               claim_count bigint, branches_mapped bigint, active_rules bigint, open_exceptions bigint,
               first_invoice_date date, last_invoice_date date, first_claim_date date, last_claim_date date,
               last_remittance_at timestamptz, escalated_exceptions bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select s.org_id,
         s.enabled                                                                   as capture_enabled,
         exists (select 1 from public.integration_accounts a
                 where a.org_id = s.org_id and a.kind = 'unite')                     as credentials_configured,
         (select max(b.processed_at) from public.fin_raw_unite_batches b
           where b.org_id = s.org_id and b.process_status = 'processed')             as last_capture_at,
         (select max(f.committed_at) from public.fin_raw_diligence_files f
           where f.org_id = s.org_id and f.status = 'committed')                     as last_import_at,
         (select count(*) from public.fin_raw_unite_batches b where b.org_id = s.org_id)      as batch_count,
         (select count(*) from public.fin_invoices i where i.org_id = s.org_id and not i.is_deleted) as invoice_count,
         (select count(*) from public.ins_claim_activities c where c.org_id = s.org_id)       as claim_count,
         (select count(*) from public.fin_ref_branches r
           where r.org_id = s.org_id and r.active and r.unite_clinic_long_name is not null)   as branches_mapped,
         (select count(*) from public.fin_ref_exception_rules x
           where x.org_id = s.org_id and x.active)                                   as active_rules,
         (select count(*) from public.ops_exceptions e
           where e.org_id = s.org_id and e.status in ('open', 'in_progress'))        as open_exceptions,
         (select min(i.transaction_date) from public.fin_invoices i where i.org_id = s.org_id and not i.is_deleted) as first_invoice_date,
         (select max(i.transaction_date) from public.fin_invoices i where i.org_id = s.org_id and not i.is_deleted) as last_invoice_date,
         (select min(c.transaction_date) from public.ins_claim_activities c where c.org_id = s.org_id)              as first_claim_date,
         (select max(c.transaction_date) from public.ins_claim_activities c where c.org_id = s.org_id)              as last_claim_date,
         (select max(b.created_at) from public.ins_remittance_batches b where b.org_id = s.org_id)                 as last_remittance_at,
         (select count(*) from public.ops_exceptions e
           where e.org_id = s.org_id and e.status in ('open', 'in_progress') and e.escalated_at is not null)       as escalated_exceptions
  from public.fin_capture_settings s
  where app.has_perm(s.org_id, 'finance.view');
$$;

-- v_fin_billing_readiness (finance.eligibility.manage; reads claims the Billing role cannot), from 20261016000200.
create or replace function app.fin_view_billing_readiness()
returns table (org_id uuid, invoice_id uuid, inv_display_number text, transaction_date date, branch_code text,
               patient_pin text, net numeric, total numeric, doctor_dha_id text, reasons text[])
language sql
stable
security definer
set search_path = ''
as $$
  with base as (
    select i.org_id, i.id as invoice_id, i.inv_display_number, i.transaction_date, i.branch_code, i.patient_pin,
           i.net, i.total, i.doctor_dha_id
    from public.fin_invoices i
    join public.fin_ref_finance_settings s on s.org_id = i.org_id
    where not i.is_deleted
      and public.fin_is_insurance_type(i.inv_type)
      and i.transaction_date is not null
      and s.ready_start_date is not null
      and i.transaction_date >= s.ready_start_date
      and i.transaction_date <= current_date - s.ready_grace_days
      and i.org_id in (select o.org_id from app.user_org_ids() as o(org_id) where app.has_perm(o.org_id, 'finance.eligibility.manage'))
      -- not yet claimed: no Diligence claim activity matched to this invoice or quoting its number
      and not exists (select 1 from public.ins_claim_activities c where c.org_id = i.org_id and c.matched_invoice_id = i.id)
      and not exists (
        select 1 from public.ins_claim_activities c
        where c.org_id = i.org_id and upper(regexp_replace(coalesce(c.invoice_no, ''), '\s+', '', 'g')) = i.inv_key
      )
  ), facts as (
    select b.*,
      exists (
        select 1 from public.fin_eligibility_checks e
        where e.org_id = b.org_id and e.patient_pin = b.patient_pin and e.status = 'verified'
          and (e.valid_from is null or e.valid_from <= b.transaction_date) and e.valid_to >= b.transaction_date
      ) as covered,
      (select e.document_id is null from public.fin_eligibility_checks e
        where e.org_id = b.org_id and e.patient_pin = b.patient_pin and e.status = 'verified'
          and (e.valid_from is null or e.valid_from <= b.transaction_date) and e.valid_to >= b.transaction_date
        order by e.checked_on desc, e.created_at desc limit 1) as card_missing,
      (select e.status from public.fin_eligibility_checks e
        where e.org_id = b.org_id and e.patient_pin = b.patient_pin
        order by e.checked_on desc nulls last, e.created_at desc limit 1) as latest_status,
      exists (
        select 1 from public.fin_invoice_lines l
        join public.fin_ref_services sv on sv.org_id = l.org_id and sv.item_code = l.item_code and sv.requires_preauth
        where l.invoice_id = b.invoice_id and l.is_current
      ) as needs_preauth,
      exists (
        select 1 from public.fin_pre_authorisations p
        where p.org_id = b.org_id and p.patient_pin = b.patient_pin and p.status in ('approved', 'partially_approved', 'used')
          and (p.valid_from is null or p.valid_from <= b.transaction_date) and p.expires_on >= b.transaction_date
      ) as has_preauth
    from base b
  ), judged as (
    select f.*,
      array_remove(array[
        case when f.patient_pin is null then 'no_patient_pin' end,
        case when f.patient_pin is not null and not f.covered then
          case coalesce(f.latest_status, 'none')
            when 'none' then 'no_eligibility'
            when 'pending' then 'eligibility_pending'
            when 'failed' then 'eligibility_failed'
            else 'eligibility_expired'
          end
        end,
        case when f.covered and coalesce(f.card_missing, false) then 'no_card_on_file' end,
        case when f.needs_preauth and not f.has_preauth then 'preauth_missing' end
      ], null) as reasons
    from facts f
  )
  select j.org_id, j.invoice_id, j.inv_display_number, j.transaction_date, j.branch_code, j.patient_pin, j.net, j.total,
         j.doctor_dha_id, j.reasons
  from judged j
  where cardinality(j.reasons) > 0;
$$;

revoke all on function app.fin_view_receivables_ageing(), app.fin_view_denials(), app.fin_view_claims_status(),
  app.fin_view_revenue_monthly(), app.fin_view_monthly_measures(), app.fin_view_data_freshness(),
  app.fin_view_billing_readiness()
  from public, anon;
grant execute on function app.fin_view_receivables_ageing(), app.fin_view_denials(), app.fin_view_claims_status(),
  app.fin_view_revenue_monthly(), app.fin_view_monthly_measures(), app.fin_view_data_freshness(),
  app.fin_view_billing_readiness()
  to authenticated, service_role;

-- Same names, columns and grants (create or replace keeps them); only the source changes.
create or replace view public.v_fin_receivables_ageing with (security_invoker = true) as
select * from app.fin_view_receivables_ageing();

create or replace view public.v_fin_denials with (security_invoker = true) as
select * from app.fin_view_denials();

create or replace view public.v_fin_claims_status with (security_invoker = true) as
select * from app.fin_view_claims_status();

create or replace view public.v_fin_revenue_monthly with (security_invoker = true) as
select * from app.fin_view_revenue_monthly();

create or replace view public.v_fin_monthly_measures with (security_invoker = true) as
select * from app.fin_view_monthly_measures();

create or replace view public.v_fin_data_freshness with (security_invoker = true) as
select * from app.fin_view_data_freshness();

-- net / total keep their numeric(14,2) column type (a function result carries no typmod).
create or replace view public.v_fin_billing_readiness with (security_invoker = true) as
select r.org_id, r.invoice_id, r.inv_display_number, r.transaction_date, r.branch_code, r.patient_pin,
       r.net::numeric(14,2) as net, r.total::numeric(14,2) as total, r.doctor_dha_id, r.reasons
from app.fin_view_billing_readiness() r;

-- ---------------------------------------------------------------------------
-- 3. v_fin_invoice_list: invoker over the tables; claim sums from a gated helper.
-- ---------------------------------------------------------------------------
-- Billing (finance.invoices.view, no finance.claims.view) sees claim progress as sums, never claim rows. The gate is
-- the invoice's own: a claim is counted only for a member who may read that invoice (claims share the invoice's org,
-- enforced by ins_claims_invoice_org_check).
create or replace function app.fin_invoice_claim_totals(p_invoice_id uuid)
returns table (claim_count bigint, claimed numeric, remitted numeric, rejected numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select count(*), sum(c.net), sum(c.remitted), sum(c.rejected)
  from public.ins_claim_activities c
  where c.matched_invoice_id = p_invoice_id
    and app.has_perm(c.org_id, 'finance.invoices.view');
$$;
revoke all on function app.fin_invoice_claim_totals(uuid) from public, anon;
grant execute on function app.fin_invoice_claim_totals(uuid) to authenticated, service_role;

-- fin_invoices and fin_payments are read under the caller's RLS, whose rule (finance.invoices.view on the row's org)
-- is also the view's own filter, so the rows are the same; payments share the invoice's org
-- (fin_payments_invoice_org_check). The sums are scalar subqueries rather than lateral joins so that a count, which
-- reads no sum, skips them, and a sorted page computes them for the rows it returns only.
create or replace view public.v_fin_invoice_list with (security_invoker = true) as
select i.org_id, i.id, i.inv_display_number, i.transaction_date, i.branch_code, i.doctor_dha_id, i.doctor_name,
       i.department, i.inv_type, i.is_deleted, i.net, i.total, i.version, i.appointment_id, i.patient_pin,
       coalesce((select t.claim_count from app.fin_invoice_claim_totals(i.id) t), 0) as claim_count,
       (select t.claimed from app.fin_invoice_claim_totals(i.id) t) as claimed,
       (select t.remitted from app.fin_invoice_claim_totals(i.id) t) as remitted,
       (select t.rejected from app.fin_invoice_claim_totals(i.id) t) as rejected,
       (select sum(p.paid) from public.fin_payments p where p.invoice_id = i.id and p.is_current) as paid
from public.fin_invoices i
where i.org_id in (select o.org_id from app.user_org_ids() as o(org_id) where app.has_perm(o.org_id, 'finance.invoices.view'));

-- Belt and braces: create or replace keeps grants, restate them.
revoke all on public.v_fin_receivables_ageing, public.v_fin_denials, public.v_fin_claims_status,
  public.v_fin_revenue_monthly, public.v_fin_monthly_measures, public.v_fin_data_freshness,
  public.v_fin_billing_readiness, public.v_fin_invoice_list from anon;
grant select on public.v_fin_receivables_ageing, public.v_fin_denials, public.v_fin_claims_status,
  public.v_fin_revenue_monthly, public.v_fin_monthly_measures, public.v_fin_data_freshness,
  public.v_fin_billing_readiness, public.v_fin_invoice_list to authenticated, service_role;

insert into supabase_migrations.schema_migrations (version, name) values ('20261119000100', 'finance_views_invoker') on conflict (version) do nothing;
