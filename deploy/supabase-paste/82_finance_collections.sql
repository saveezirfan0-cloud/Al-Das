-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Collections and data quality (Phase 23D): the late-invoice setting and the aggregate function behind
-- Finance, Collections (service role only; sums and counts by day, branch, doctor and invoice type, no patient ids).
-- Needs every earlier file first, up to and including 81_organisation.sql.
-- Check the project name in the Supabase header first: this is for the Pulse project only.

-- ======================================================================
-- 20261203000100_finance_collections.sql
-- ======================================================================
-- Phase 23D-1: collections and data quality from the Unite collection report (docs/39_UNITE_REPORTS_PLAN.md §1.2 and
-- §4 23D, docs/23_PHASE_23D_NOTES.md).
--
--   * fin_ref_finance_settings.dq_late_invoice_days: an invoice raised more than this many days after the visit is
--     flagged (review signal, never proof).
--   * fin_collections_inputs(): for one calendar month of current Unite collection report rows (fin_report_visits),
--     the payment-mode, share and consumption sums by day, branch, doctor and invoice type, the month total, and the
--     data-quality counts (rows and net). Counts and sums only: no PIN, no patient ref, no names other than the
--     doctor's; unmapped Unite clinic names are returned (a clinic is not personal data) so Finance can map them.
--     Branch scoping exactly as fin_doctor_performance_inputs() (Phase 23B): the branch is worked out when read from
--     the row's Unite clinic and the CURRENT fin_ref_branches mapping (the code stored at commit is the fallback);
--     p_branches = the member's allowed finance codes (null = unrestricted); a row whose branch is unknown is visible
--     only to an unrestricted member; p_branch = the page's own filter (exactly that code).
--     SECURITY DEFINER, service role only; the server checks finance.revenue.view first.

-- ---------------------------------------------------------------------------
-- 1. Settings
-- ---------------------------------------------------------------------------
alter table public.fin_ref_finance_settings
  add column dq_late_invoice_days integer not null default 3
    constraint fin_ref_finance_settings_dq_late_invoice_days_check check (dq_late_invoice_days between 0 and 60);

-- ---------------------------------------------------------------------------
-- 2. Report input
-- ---------------------------------------------------------------------------
-- Visit date = the Dubai date of visit_at (the report is in Dubai wall-clock time, as in 23A). Invoice type is
-- compared trimmed, upper case, whitespace collapsed; blank = null. Cancelled rows count in every sum (Unite's own
-- totals include them) and are also counted as a signal.
create or replace function public.fin_collections_inputs(
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
  v_next date;
  v_branch text := nullif(btrim(p_branch), '');
  v_late integer;
  v_out jsonb;
begin
  if p_org_id is null or p_month is null then
    raise exception 'org and month are required' using errcode = 'invalid_parameter_value';
  end if;
  v_month := date_trunc('month', p_month)::date;
  v_next := (v_month + interval '1 month')::date;

  select coalesce(s.dq_late_invoice_days, 3)
    into v_late
  from (select 1) one
  left join public.fin_ref_finance_settings s on s.org_id = p_org_id;

  with v as (
    select r.report_date,
           coalesce(b.code, r.branch_code) as branch_code,
           nullif(btrim(r.clinic_name), '') as clinic_name,
           r.doctor_key,
           r.doctor_name,
           nullif(upper(regexp_replace(btrim(coalesce(r.invoice_type, '')), '\s+', ' ', 'g')), '') as invoice_type,
           r.invoice_date,
           (r.visit_at at time zone 'Asia/Dubai')::date as visit_date,
           nullif(btrim(r.selfpay_invoice_no), '') is null
             and nullif(btrim(r.insurance_invoice_no), '') is null as no_invoice_no,
           r.visit_status,
           r.categories,
           r.is_cancelled,
           r.cash, r.card, r.bank_transfer, r.payment_gateway, r.other_payment, r.patient_share, r.insurance_claim,
           r.net, r.advance_consumed, r.credit_note_consumed, r.outstanding_credit, r.write_off, r.refund
    from public.fin_report_visits r
    left join public.fin_ref_branches b
      on b.org_id = r.org_id and b.active and b.unite_clinic_long_name = r.clinic_name
    where r.org_id = p_org_id
      and r.is_current
      and r.report_date >= v_month and r.report_date < v_next
      and (p_branches is null or coalesce(b.code, r.branch_code) = any (p_branches))
      and (v_branch is null or coalesce(b.code, r.branch_code) = v_branch)
  ),
  -- g (grouping of report_date, branch_code, doctor_key, invoice_type): 7 day, 11 branch, 13 doctor, 14 type, 15 total.
  agg as (
    select grouping(report_date, branch_code, doctor_key, invoice_type) as g,
           report_date, branch_code, doctor_key, invoice_type,
           jsonb_build_object(
             'rows', count(*),
             'cash', coalesce(sum(cash), 0),
             'card', coalesce(sum(card), 0),
             'bank_transfer', coalesce(sum(bank_transfer), 0),
             'payment_gateway', coalesce(sum(payment_gateway), 0),
             'other_payment', coalesce(sum(other_payment), 0),
             'patient_share', coalesce(sum(patient_share), 0),
             'insurance_claim', coalesce(sum(insurance_claim), 0),
             'net', coalesce(sum(net), 0),
             'advance_consumed', coalesce(sum(advance_consumed), 0),
             'credit_note_consumed', coalesce(sum(credit_note_consumed), 0),
             'outstanding_credit', coalesce(sum(outstanding_credit), 0),
             'write_off', coalesce(sum(write_off), 0),
             'refund', coalesce(sum(refund), 0)) as sums
    from v
    group by grouping sets ((report_date), (branch_code), (doctor_key), (invoice_type), ())
  ),
  -- Display name: the most frequent spelling for the doctor key in the month, ties alphabetical (as in 23B).
  names as (
    select distinct on (doctor_key) doctor_key, doctor_name
    from (select doctor_key, doctor_name, count(*) as n from v group by doctor_key, doctor_name) x
    order by doctor_key, n desc, doctor_name collate "C"
  ),
  flags as (
    select v.*,
           v.no_invoice_no and v.net = 0 as f_no_invoice,
           v.invoice_date is not null and v.visit_date is not null
             and v.invoice_date - v.visit_date > v_late as f_late_invoice,
           v.invoice_date is not null and v.visit_date is not null
             and v.visit_date < date_trunc('month', v.invoice_date)::date as f_earlier_month,
           v.branch_code is null as f_unknown_branch,
           v.categories ? 'NO' as f_category_no,
           v.visit_status is null as f_blank_visit_status,
           v.invoice_type is null and v.net > 0 as f_blank_invoice_type,
           v.is_cancelled as f_cancelled
    from v
  ),
  quality as (
    select jsonb_build_object(
             'no_invoice', jsonb_build_object('rows', count(*) filter (where f_no_invoice),
                                              'net', coalesce(sum(net) filter (where f_no_invoice), 0)),
             'late_invoice', jsonb_build_object('rows', count(*) filter (where f_late_invoice),
                                                'net', coalesce(sum(net) filter (where f_late_invoice), 0)),
             'earlier_month', jsonb_build_object('rows', count(*) filter (where f_earlier_month),
                                                 'net', coalesce(sum(net) filter (where f_earlier_month), 0)),
             'unknown_branch', jsonb_build_object('rows', count(*) filter (where f_unknown_branch),
                                                  'net', coalesce(sum(net) filter (where f_unknown_branch), 0)),
             'category_no', jsonb_build_object('rows', count(*) filter (where f_category_no),
                                               'net', coalesce(sum(net) filter (where f_category_no), 0)),
             'blank_visit_status', jsonb_build_object('rows', count(*) filter (where f_blank_visit_status),
                                                      'net', coalesce(sum(net) filter (where f_blank_visit_status), 0)),
             'blank_invoice_type', jsonb_build_object('rows', count(*) filter (where f_blank_invoice_type),
                                                      'net', coalesce(sum(net) filter (where f_blank_invoice_type), 0)),
             'cancelled', jsonb_build_object('rows', count(*) filter (where f_cancelled),
                                             'net', coalesce(sum(net) filter (where f_cancelled), 0))) as j
    from flags
  ),
  clinics as (
    select coalesce(jsonb_agg(jsonb_build_object('clinic', c.clinic_name, 'rows', c.n, 'net', c.net)
                              order by c.clinic_name collate "C" nulls last), '[]'::jsonb) as j
    from (select clinic_name, count(*) as n, sum(net) as net from v where branch_code is null group by clinic_name) c
  )
  select jsonb_build_object(
           'days', coalesce((select jsonb_agg(jsonb_build_object('date', a.report_date) || a.sums
                                              order by a.report_date)
                             from agg a where a.g = 7), '[]'::jsonb),
           'branches', coalesce((select jsonb_agg(jsonb_build_object('branch_code', a.branch_code) || a.sums
                                                  order by a.branch_code collate "C" nulls last)
                                 from agg a where a.g = 11), '[]'::jsonb),
           'doctors', coalesce((select jsonb_agg(jsonb_build_object('doctor_key', a.doctor_key,
                                                                    'doctor_name', n.doctor_name) || a.sums
                                                 order by a.doctor_key collate "C")
                                from agg a join names n on n.doctor_key = a.doctor_key where a.g = 13), '[]'::jsonb),
           'invoice_types', coalesce((select jsonb_agg(jsonb_build_object('invoice_type', a.invoice_type) || a.sums
                                                       order by a.invoice_type collate "C" nulls last)
                                      from agg a where a.g = 14), '[]'::jsonb),
           'total', (select a.sums from agg a where a.g = 15),
           'quality', (select q.j from quality q) || jsonb_build_object('unknown_clinics', (select c.j from clinics c)))
    into v_out;

  return jsonb_build_object(
    'month', v_month,
    'branch', v_branch,
    'coverage', app.fin_report_coverage(p_org_id, v_month, (v_next - 1)),
    'settings', jsonb_build_object('late_invoice_days', v_late)
  ) || v_out;
end;
$$;
revoke all on function public.fin_collections_inputs(uuid, date, text, text[]) from public, anon, authenticated;
grant execute on function public.fin_collections_inputs(uuid, date, text, text[]) to service_role;
