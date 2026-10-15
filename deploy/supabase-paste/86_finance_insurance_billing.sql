-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Insurance billed vs claimed (Phase 23D-2): the tolerance and grace-day settings and the function that pairs
-- Unite report insurance invoices with Diligence claims by invoice number (service role only; no patient ids).
-- Needs every earlier file first, up to and including 85_finance_collections.sql.
-- Check the project name in the Supabase header first: this is for the Pulse project only.

-- ======================================================================
-- 20261208000200_finance_insurance_billing_recon.sql
-- ======================================================================
-- Phase 23D-2: insurance billed vs claimed (docs/23_PHASE_23D2_NOTES.md).
--
-- While the Unite finance capture is OFF, the Unite collection report (fin_report_visits, current rows) is the only
-- record of what was BILLED to insurers (insurance_invoice_no, insurance_claim per row). Diligence
-- (ins_claim_activities) is what was SUBMITTED. This reconciles the two for one month by normalised invoice number.
--
--   * fin_ref_finance_settings: ins_recon_tolerance (AED, a matched invoice is flagged when |billed − submitted| is
--     MORE than this) and ins_recon_grace_days (a billed invoice with no submission is at risk once it is MORE than
--     this many days past its report date).
--   * app.fin_invoice_key(): the invoice-number rule, the same as fin_invoices.inv_key and the Diligence index
--     (upper case, whitespace removed). Its TypeScript twin is normalizeInvoiceNumber() (lib/finance/keys.ts).
--   * fin_insurance_billing_recon_inputs(): per invoice number billed this month (sums, counts, dates, the doctor and
--     branch), what Diligence holds for it, and the Diligence invoice numbers of the month that are not in this month's
--     report. Classification (matched / billed not submitted / submitted not in the report / ambiguous), tolerance and
--     grace days are applied in lib/finance/insurance-billing.ts. Counts, sums, invoice numbers, payer ids and doctor
--     names only: no PIN, no patient ref, no names of patients, no card numbers.
--     Branch: worked out when read, as Phase 23B does (the Unite clinic through the CURRENT fin_ref_branches mapping,
--     the stored code as fallback). p_branches = the member's allowed finance codes (null = unrestricted); a row whose
--     branch is unknown is visible only to an unrestricted member. p_branch = the page's own filter. Diligence
--     activities carry no branch, so the "submitted, not in the report" list is returned only with no restriction and
--     no filter. An invoice number is ambiguous when this month's rows give it more than one (branch, doctor), counted
--     over EVERY branch; a restricted member sees only the pairs in their own branches.
--     SECURITY DEFINER, service role only; the server checks finance.claims.view first.

-- ---------------------------------------------------------------------------
-- 1. Settings
-- ---------------------------------------------------------------------------
alter table public.fin_ref_finance_settings
  add column ins_recon_tolerance numeric(12, 2) not null default 1.00,
  add column ins_recon_grace_days integer not null default 7,
  add constraint fin_ref_finance_settings_ins_recon_check
    check (ins_recon_tolerance >= 0 and ins_recon_tolerance <= 100000
           and ins_recon_grace_days >= 0 and ins_recon_grace_days <= 365);

-- ---------------------------------------------------------------------------
-- 2. The invoice-number rule (inlinable: plain SQL, immutable, no SET clause)
-- ---------------------------------------------------------------------------
create or replace function app.fin_invoice_key(p_invoice_no text)
returns text
language sql
immutable
parallel safe
as $$
  select pg_catalog.upper(pg_catalog.regexp_replace(coalesce(p_invoice_no, ''), '\s+', '', 'g'));
$$;
revoke all on function app.fin_invoice_key(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Report input
-- ---------------------------------------------------------------------------
-- Billed: insurance_claim of this month's current, NOT cancelled report rows (report_date = invoice date, else visit
-- date). Cancelled rows are left out of the pairing and counted on their own. Submitted: Diligence net (initial net
-- when net is blank) of every activity with the invoice number, whatever its date: ins_claim_activities holds one
-- current row per activity (each upload upserts it; history is in ins_claim_activity_events).
create or replace function public.fin_insurance_billing_recon_inputs(
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
  v_unrestricted boolean := p_branches is null and nullif(btrim(p_branch), '') is null;
  v_out jsonb;
begin
  if p_org_id is null or p_month is null then
    raise exception 'org and month are required' using errcode = 'invalid_parameter_value';
  end if;
  v_month := date_trunc('month', p_month)::date;
  v_next := (v_month + interval '1 month')::date;

  with r as (
    -- this month's current report rows of EVERY branch (ambiguity is judged over all of them); visible = in scope
    select app.fin_invoice_key(v.insurance_invoice_no) as key,
           nullif(btrim(v.insurance_invoice_no), '') as invoice_no,
           x.branch,
           v.doctor_key,
           v.doctor_name,
           v.report_date,
           v.insurance_claim as claim,
           v.is_cancelled,
           coalesce((p_branches is null or x.branch = any (p_branches))
                    and (v_branch is null or x.branch = v_branch), false) as visible
    from public.fin_report_visits v
    left join public.fin_ref_branches b
      on b.org_id = v.org_id and b.active and b.unite_clinic_long_name = v.clinic_name
    cross join lateral (select coalesce(b.code, v.branch_code) as branch) x
    where v.org_id = p_org_id
      and v.is_current
      and v.report_date >= v_month and v.report_date < v_next
  ),
  -- one entry per invoice number with at least one visible, not cancelled row this month
  inv as (
    select r.key,
           min(r.invoice_no collate "C") filter (where r.visible) as invoice_no,
           count(distinct coalesce(r.branch, '') || '|' || r.doctor_key) as pairs,
           sum(r.claim) filter (where r.visible) as billed,
           count(*) filter (where r.visible) as rows,
           min(r.report_date) filter (where r.visible) as first_date,
           max(r.report_date) filter (where r.visible) as last_date
    from r
    where r.key <> '' and not r.is_cancelled
    group by r.key
    having bool_or(r.visible)
  ),
  vis_pairs as (
    select p.key,
           jsonb_agg(jsonb_build_object('branch', p.branch, 'doctor', p.doctor_name)
                     order by p.branch collate "C" nulls last, p.doctor_name collate "C") as list
    from (
      select distinct on (r.key, r.branch, r.doctor_key) r.key, r.branch, r.doctor_key, r.doctor_name
      from r
      where r.key <> '' and not r.is_cancelled and r.visible
      order by r.key, r.branch, r.doctor_key, r.doctor_name collate "C"
    ) p
    group by p.key
  ),
  sub as (
    select app.fin_invoice_key(c.invoice_no) as key,
           sum(coalesce(c.net, c.initial_net, 0)) as submitted,
           count(*) as activities,
           jsonb_agg(distinct c.payer_id) filter (where nullif(btrim(c.payer_id), '') is not null) as payers
    from public.ins_claim_activities c
    where c.org_id = p_org_id
      and app.fin_invoice_key(c.invoice_no) in (select i.key from inv i)
    group by 1
  ),
  -- Diligence activities dated this month (service date, else transaction date); only without a branch restriction
  -- or filter, since activities carry no branch
  acts as (
    select app.fin_invoice_key(c.invoice_no) as key,
           btrim(c.invoice_no) as invoice_no,
           coalesce(c.net, c.initial_net, 0) as submitted,
           coalesce(c.activity_start_date, c.transaction_date) as activity_date,
           nullif(btrim(c.payer_id), '') as payer_id
    from public.ins_claim_activities c
    where v_unrestricted
      and c.org_id = p_org_id
      and coalesce(c.activity_start_date, c.transaction_date) >= v_month
      and coalesce(c.activity_start_date, c.transaction_date) < v_next
  ),
  -- ... whose invoice number is on no current, not cancelled report row of this month
  un as (
    select a.key,
           min(a.invoice_no collate "C") as invoice_no,
           sum(a.submitted) as submitted,
           count(*) as activities,
           min(a.activity_date) as first_date,
           jsonb_agg(distinct a.payer_id) filter (where a.payer_id is not null) as payers
    from acts a
    where a.key <> ''
      and not exists (select 1 from r where r.key = a.key and not r.is_cancelled)
    group by a.key
  ),
  -- where else the report has them: the latest month with a not cancelled row, and whether a cancelled row has it
  elsewhere as (
    select app.fin_invoice_key(v.insurance_invoice_no) as key,
           max(date_trunc('month', v.report_date)::date) filter (where not v.is_cancelled) as report_month,
           bool_or(v.is_cancelled) as cancelled
    from public.fin_report_visits v
    where v.org_id = p_org_id and v.is_current
      and app.fin_invoice_key(v.insurance_invoice_no) in (select u.key from un u)
    group by 1
  )
  select jsonb_build_object(
    'month', v_month,
    'branch', v_branch,
    'unreported_shown', v_unrestricted,
    'coverage', app.fin_report_coverage(p_org_id, v_month, (v_next - 1)),
    'settings', (
      select jsonb_build_object(
               'tolerance', coalesce(s.ins_recon_tolerance, 1.00),
               'grace_days', coalesce(s.ins_recon_grace_days, 7))
      from (select 1) one
      left join public.fin_ref_finance_settings s on s.org_id = p_org_id),
    'summary', (
      select jsonb_build_object(
               'billed', coalesce(sum(r.claim) filter (where not r.is_cancelled), 0),
               'billed_rows', count(*) filter (where not r.is_cancelled and r.claim <> 0),
               'no_invoice_no_rows', count(*) filter (where not r.is_cancelled and r.key = '' and r.claim <> 0),
               'no_invoice_no_amount', coalesce(sum(r.claim) filter (where not r.is_cancelled and r.key = ''), 0),
               'cancelled_rows', count(*) filter (where r.is_cancelled and r.claim <> 0),
               'cancelled_amount', coalesce(sum(r.claim) filter (where r.is_cancelled), 0))
      from r
      where r.visible)
      || (
      select jsonb_build_object(
               'submitted_no_invoice_no_activities', count(*),
               'submitted_no_invoice_no_amount', coalesce(sum(a.submitted), 0))
      from acts a
      where a.key = ''),
    'invoices', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'key', i.key,
               'invoice_no', i.invoice_no,
               'billed', i.billed,
               'rows', i.rows,
               'first_date', i.first_date,
               'last_date', i.last_date,
               'pairs', i.pairs,
               'visible_pairs', coalesce(vp.list, '[]'::jsonb),
               'submitted', s.submitted,
               'activities', coalesce(s.activities, 0),
               'payers', coalesce(s.payers, '[]'::jsonb))
             order by i.key collate "C"), '[]'::jsonb)
      from inv i
      left join vis_pairs vp on vp.key = i.key
      left join sub s on s.key = i.key),
    'unreported', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'key', u.key,
               'invoice_no', u.invoice_no,
               'submitted', u.submitted,
               'activities', u.activities,
               'first_date', u.first_date,
               'payers', coalesce(u.payers, '[]'::jsonb),
               'report_month', e.report_month,
               'cancelled_in_report', coalesce(e.cancelled, false))
             order by u.key collate "C"), '[]'::jsonb)
      from un u
      left join elsewhere e on e.key = u.key))
    into v_out;

  return v_out;
end;
$$;
revoke all on function public.fin_insurance_billing_recon_inputs(uuid, date, text, text[]) from public, anon, authenticated;
grant execute on function public.fin_insurance_billing_recon_inputs(uuid, date, text, text[]) to service_role;
