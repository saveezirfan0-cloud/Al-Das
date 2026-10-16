-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Finance controls of 16 Oct 2026: Revenue & Collections and Costs & Expenses roles, close deadline the 10th, e-mail trail steps.
-- Needs every earlier file first, up to and including 92_finance_branch_clinic_aliases.sql.
-- Check the project name in the Supabase header first: this is for the Pulse project only.

-- ======================================================================
-- 20261209000300_finance_controls.sql
-- ======================================================================
-- Finance controls confirmed by management on 16 Oct 2026 (docs/42_FINANCE_CONTROLS_2026_10.md).
--
--   * Separation and reporting access: Revenue & Collections (revenue, collections, receipt-side matching) and Costs &
--     Expenses (suppliers, labs, cost coding, VAT inputs) each submit inside their own scope. Neither role sees,
--     approves, signs, packs or circulates the clinic-wide P&L; only the Finance Manager consolidates and signs the
--     finance review, and the CEO gives the final approval that locks the month. New orgs get the roles from
--     lib/auth/permissions.ts (FINANCE_ROLES); existing orgs get them here. People are assigned in Settings, Users.
--   * Month-end: the reporting and approval trail is complete by the 10th of the following month (replaces the 7th
--     working day target). fin_ref_finance_settings.close_deadline_day holds the calendar day (1-28); null keeps the
--     working-day deadline (close_deadline_wd). Existing rows take 10.
--   * The close checklist gains the trail's steps: revenue and cost submissions to the Finance Manager, and the
--     reviewed pack sent to the CEO. The CEO sign-off itself stays the existing lock (fin_period_closes).

-- 1. Roles ------------------------------------------------------------------------------------------------------------
insert into public.roles (org_id, name, description, permissions, is_system)
select o.id, 'Revenue & Collections',
       'Revenue and collections: Unite uploads, daily takings and cash-ups, card and bank receipt matching, and the revenue reports. Submits to the Finance Manager; does not see, sign or circulate the clinic-wide P&L.',
       '["finance.view","finance.invoices.view","finance.claims.view","finance.revenue.view","finance.revenue.import","finance.flash.view","finance.cashup.manage","finance.recovery.manage","finance.changes.view","finance.bank.view","finance.bank.manage","finance.bank.ai","finance.close.view","finance.close.tasks"]'::jsonb,
       true
from public.orgs o
on conflict (org_id, name) do nothing;

insert into public.roles (org_id, name, description, permissions, is_system)
select o.id, 'Costs & Expenses',
       'Costs and expenses: supplier invoices and payment vouchers, lab and referral statements, branch cost coding and VAT inputs. Submits to the Finance Manager; does not see, sign or circulate the clinic-wide P&L.',
       '["finance.costs.view","finance.costs.manage","finance.payables.view","finance.payables.manage","finance.vouchers.prepare","finance.vouchers.pay","finance.labs.view","finance.labs.manage","finance.inbox.manage","finance.tally.export","finance.close.view","finance.close.tasks"]'::jsonb,
       true
from public.orgs o
on conflict (org_id, name) do nothing;

-- 2. Deadline by the 10th ---------------------------------------------------------------------------------------------
alter table public.fin_ref_finance_settings
  add column if not exists close_deadline_day smallint default 10
    check (close_deadline_day is null or close_deadline_day between 1 and 28);

-- 3. The trail's steps in the close checklist --------------------------------------------------------------------------
-- Redefined from 20261029000100 (its only definition) with three rows added; existing orgs' templates keep every edit
-- Finance made (on conflict do nothing) and simply gain the new steps.
create or replace function public.fin_close_seed_steps(p_org_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into public.fin_close_steps (org_id, code, title, owner_role, due_wd, depends_on, evidence_hint, sort_order)
  values
    (p_org_id, 'INS_SUBMISSIONS', 'Insurance submissions and resubmissions for the month complete', 'Insurance (Diligence)', 5, '{}',
     'Diligence submission and resubmission reports for the month', 10),
    (p_org_id, 'DILIGENCE_REC', 'Diligence reconciliation complete', 'Insurance (Diligence)', 5, '{INS_SUBMISSIONS}',
     'Latest Diligence file committed in Pulse; outstanding items listed', 20),
    (p_org_id, 'REVENUE_UNITE', 'Revenue reconciled to Unite', 'Revenue and receivables', 5, '{}',
     'Unite revenue report agreed to the month''s figures', 30),
    (p_org_id, 'BANK_CASH', 'Bank and cash reconciled', 'Revenue and receivables', 5, '{}',
     'Bank statements, card settlements and cash-ups agreed', 40),
    (p_org_id, 'SUPPLIER_INVOICES', 'Supplier invoices booked', 'Costs and payables', 5, '{}',
     'Purchase entries posted in Tally', 50),
    (p_org_id, 'HR_INPUTS', 'HR inputs submitted (joiners, leavers, changes)', 'HR', 5, '{}',
     'HR change list for the month', 60),
    (p_org_id, 'LAB_REFERRALS', 'Lab and referral invoices checked', 'Costs and payables', 7, '{}',
     'Lab reports arrive by the 7th or 8th; checked against what Unite billed', 70),
    (p_org_id, 'REVENUE_SHARES', 'Doctor revenue shares and staff incentives calculated', 'Finance Manager', 7,
     '{REVENUE_UNITE,LAB_REFERRALS,HR_INPUTS}', 'Calculation with its source data, verified', 80),
    (p_org_id, 'TALLY_CLOSE', 'Tally close substantially complete', 'Costs and payables', 7, '{SUPPLIER_INVOICES,BANK_CASH}',
     'Tally trial balance', 90),
    (p_org_id, 'DRAFT_ACCOUNTS', 'Draft management accounts', 'Finance Manager', 8,
     '{TALLY_CLOSE,REVENUE_SHARES,DILIGENCE_REC}', 'Draft P&L and balance sheet', 100),
    -- 16 Oct 2026 controls: the month-end e-mail trail (Krishna and Althaf -> Hardik -> Saeed)
    (p_org_id, 'REVENUE_SUBMIT', 'Revenue and collections schedules sent to the Finance Manager', 'Revenue and collections', 4,
     '{REVENUE_UNITE,BANK_CASH}', 'Revenue and collections schedules, reconciliations and open issues (not a P&L)', 35),
    (p_org_id, 'COSTS_SUBMIT', 'Cost and expense schedules sent to the Finance Manager', 'Costs and expenses', 4,
     '{SUPPLIER_INVOICES}', 'Cost and expense schedules, reconciliations and open issues (not a P&L)', 55),
    (p_org_id, 'PACK_TO_CEO', 'Reviewed consolidated P&L and management pack sent to the CEO', 'Finance Manager', 6,
     '{REVENUE_SUBMIT,COSTS_SUBMIT,DRAFT_ACCOUNTS}', 'Finance review signed; corrections and open items recorded', 110)
  on conflict (org_id, code) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.fin_close_seed_steps(uuid) from public, anon, authenticated;
grant execute on function public.fin_close_seed_steps(uuid) to service_role;

select public.fin_close_seed_steps(id) from public.orgs;
