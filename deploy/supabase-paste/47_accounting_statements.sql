-- Paste into Supabase > SQL Editor > New query, then Run. Needs 43_chronic_alignment.sql applied first (and therefore
-- 41_accounting_core.sql). The migration-history line is included at the bottom of this file.

-- Phase 22G: financial statements, budgets, the VAT return and ratios (docs/22_ACCOUNTING_PLAN.md, slice 22G; notes in
-- docs/22_PHASE_22G_NOTES.md).
--
--   * Reports READ the ledger only (posted and reversed journals, like the trial balance); nothing here posts. They work the
--     same on the Tally mirror before cut-over and on the Pulse ledger after it.
--   * acc_profit_and_loss, acc_balance_sheet, acc_cash_flow (indirect method), acc_vat_return (FTA VAT 201 working paper),
--     acc_statement_exceptions, acc_ct_bridge (corporate tax working paper), acc_budget_vs_actual: aggregated here,
--     returned as jsonb; shaping is pure TypeScript in lib/accounting/statements/*. Every result says whether its figures
--     are provisional (a month in range not yet closed or locked).
--   * acc_budgets + acc_budget_lines: prepared by accounting.budgets.manage, approved by a DIFFERENT person holding
--     accounting.journals.approve, bound to the sha256 of the content they reviewed (acc_budget_hash). An approved budget's
--     lines never change; reopening returns it to draft and makes the person who reopened it its preparer.
--   * acc_accounts gains cash_flow_class (null = from its group), requires_branch / requires_cost_centre (exception
--     report only, posting is unchanged) and ct_treatment (corporate tax bridge). acc_entities gains the VAT period
--     settings and the default emirate. fin_ref_finance_settings gains the accounting thresholds.
--
-- SECURITY DEFINER, search_path = '', service role only. The server runs can() first.

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------
alter table public.acc_accounts
  -- the cash flow statement (indirect method); null = inherited from the nearest group that has one, else the Tally
  -- group's default (app.acc_cf_default). Cash and bank control accounts are always cash.
  add column cash_flow_class text check (cash_flow_class is null or cash_flow_class in (
    'operating_noncash', 'working_capital', 'investing', 'financing', 'cash')),
  -- report-only: lines on this ledger without a branch / cost centre appear on the exception report
  add column requires_branch boolean not null default false,
  add column requires_cost_centre boolean not null default false,
  -- corporate tax bridge (working paper): how the ledger's expense is treated
  add column ct_treatment text check (ct_treatment is null or ct_treatment in (
    'entertainment', 'fines_penalties', 'donations', 'non_deductible', 'connected_person')),
  add constraint acc_accounts_ct_ledger_only check (not is_group or ct_treatment is null),
  add constraint acc_accounts_dims_ledger_only check (not is_group or (not requires_branch and not requires_cost_centre));

alter table public.acc_entities
  -- VAT 201 periods: monthly or quarterly (the VAT certificate says which), starting in the anchor month
  add column vat_period_months integer not null default 3 check (vat_period_months in (1, 3)),
  add column vat_period_anchor_month integer not null default 1 check (vat_period_anchor_month between 1 and 12),
  -- the emirate used on the VAT return for a line that names no branch (the return flags those lines)
  add column default_emirate text not null default 'Dubai' check (default_emirate in (
    'Abu Dhabi', 'Dubai', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah'));

alter table public.fin_ref_finance_settings
  -- budget against actual: an account is highlighted when it is this many percent worse than budget
  add column acc_budget_variance_pct numeric(7, 2) not null default 10 check (acc_budget_variance_pct between 0 and 1000),
  -- exception report: manual journals at or above this total (AED)
  add column acc_large_journal_amount numeric(14, 2) not null default 50000 check (acc_large_journal_amount > 0),
  -- corporate tax bridge (working paper; Federal Decree-Law 47 of 2022 and the Small Business Relief decision)
  add column acc_ct_rate numeric(5, 2) not null default 9 check (acc_ct_rate between 0 and 100),
  add column acc_ct_threshold numeric(14, 2) not null default 375000 check (acc_ct_threshold >= 0),
  add column acc_ct_entertainment_pct numeric(5, 2) not null default 50 check (acc_ct_entertainment_pct between 0 and 100),
  add column acc_ct_sbr_limit numeric(16, 2) not null default 3000000 check (acc_ct_sbr_limit >= 0),
  add column acc_ct_connected_limit numeric(14, 2) not null default 500000 check (acc_ct_connected_limit >= 0);

-- Accumulated depreciation is a non-cash adjustment (its movement is the depreciation added back)
update public.acc_accounts set cash_flow_class = 'operating_noncash'
 where code = '1590' and not is_group and cash_flow_class is null and lower(name) = 'accumulated depreciation';

create or replace function app.acc_seed_cash_flow_defaults()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.acc_accounts set cash_flow_class = 'operating_noncash'
   where org_id = new.id and code = '1590' and not is_group and cash_flow_class is null
     and lower(name) = 'accumulated depreciation';
  return null;
end;
$$;
revoke all on function app.acc_seed_cash_flow_defaults() from public, anon, authenticated;
-- named to sort after orgs_seed_finance_phase22 (triggers fire in name order), which seeds the chart
create trigger orgs_seed_finance_phase22g after insert on public.orgs
  for each row execute function app.acc_seed_cash_flow_defaults();

-- ---------------------------------------------------------------------------
-- 2. Budgets
-- ---------------------------------------------------------------------------
create table public.acc_budgets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  entity_id uuid not null references public.acc_entities (id),
  fy_start date not null check (extract(day from fy_start) = 1),      -- the first day of the fiscal year budgeted
  name text not null check (char_length(btrim(name)) between 1 and 80),
  status text not null default 'draft' check (status in ('draft', 'approved')),
  prepared_by uuid references public.profiles (id) on delete set null,
  prepared_at timestamptz,
  approved_by uuid references public.profiles (id) on delete set null,
  approved_at timestamptz,
  approved_sha256 text check (approved_sha256 is null or approved_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'approved') = (approved_at is not null)),
  check ((status = 'approved') = (approved_sha256 is not null)),
  -- maker / checker (null-safe: a removed user's id becomes null)
  check (approved_by is null or prepared_by is null or approved_by <> prepared_by)
);
create unique index acc_budgets_name_uidx on public.acc_budgets (org_id, entity_id, fy_start, lower(btrim(name)));
create index acc_budgets_org_idx on public.acc_budgets (org_id, fy_start desc);
create trigger acc_budgets_set_updated_at before update on public.acc_budgets
  for each row execute function app.set_updated_at();
create trigger acc_budgets_entity_org_check before insert or update on public.acc_budgets
  for each row execute function app.check_parent_org('acc_entities', 'entity_id');

create table public.acc_budget_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  budget_id uuid not null references public.acc_budgets (id) on delete cascade,
  account_id uuid not null references public.acc_accounts (id),
  month date not null check (extract(day from month) = 1),
  branch_code text check (branch_code is null or char_length(branch_code) between 1 and 20),
  department text check (department is null or char_length(department) between 1 and 60),
  amount numeric(14, 2) not null check (amount >= 0),
  created_at timestamptz not null default now(),
  unique nulls not distinct (budget_id, account_id, month, branch_code, department)
);
create index acc_budget_lines_budget_idx on public.acc_budget_lines (budget_id, account_id, month);
create index acc_budget_lines_org_idx on public.acc_budget_lines (org_id);
create trigger acc_budget_lines_budget_org_check before insert or update on public.acc_budget_lines
  for each row execute function app.check_parent_org('acc_budgets', 'budget_id');

-- An approved budget's lines never change (every role): reopen it first. A row with no org (the cross-org probe) passes.
create or replace function app.acc_budget_line_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_budget uuid := case when tg_op = 'DELETE' then old.budget_id else new.budget_id end;
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.orgs o where o.id = old.org_id) then
    return old;   -- the org cascade
  end if;
  select b.status into v_status from public.acc_budgets b where b.id = v_budget;
  if v_status = 'approved' then
    raise exception 'An approved budget cannot change; reopen it first.' using errcode = 'check_violation', hint = 'budget_approved';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
revoke all on function app.acc_budget_line_guard() from public, anon, authenticated;
create trigger acc_budget_lines_guard before insert or update or delete on public.acc_budget_lines
  for each row execute function app.acc_budget_line_guard();

-- Who may read budgets: the reports, budgets and approve keys.
create or replace function app.acc_can_read_budgets(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    join public.roles r on r.id = m.role_id
    where m.org_id = p_org_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and (r.permissions ? '*' or r.permissions ?| array[
        'accounting.reports.view', 'accounting.budgets.manage', 'accounting.journals.approve'])
  );
$$;
revoke all on function app.acc_can_read_budgets(uuid) from public, anon;
grant execute on function app.acc_can_read_budgets(uuid) to authenticated, service_role;

alter table public.acc_budgets enable row level security;
alter table public.acc_budget_lines enable row level security;
create policy acc_budgets_select on public.acc_budgets for select to authenticated using (app.acc_can_read_budgets(org_id));
create policy acc_budget_lines_select on public.acc_budget_lines for select to authenticated
  using (app.acc_can_read_budgets(org_id));

-- ---------------------------------------------------------------------------
-- 3. Helpers
-- ---------------------------------------------------------------------------
-- Range and entity checks shared by the reports.
create or replace function app.acc_report_args(p_org_id uuid, p_entity_id uuid, p_from date, p_to date)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 3660 then
    raise exception 'Choose a valid date range.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  if p_entity_id is not null and not exists (select 1 from public.acc_entities e where e.id = p_entity_id and e.org_id = p_org_id) then
    raise exception 'Entity not found.' using errcode = 'check_violation', hint = 'entity_unknown';
  end if;
end;
$$;
revoke all on function app.acc_report_args(uuid, uuid, date, date) from public, anon, authenticated;

-- Final figures: every month touching the range is closed or locked for every active entity in scope. Otherwise the
-- report is labelled Provisional.
create or replace function app.acc_range_final(p_org_id uuid, p_entity_id uuid, p_from date, p_to date)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.acc_entities e where e.org_id = p_org_id and e.active
                   and (p_entity_id is null or e.id = p_entity_id))
     and not exists (
    select 1
    from public.acc_entities e
    cross join generate_series(date_trunc('month', p_from)::date, date_trunc('month', p_to)::date, interval '1 month') g (m)
    where e.org_id = p_org_id and e.active and (p_entity_id is null or e.id = p_entity_id)
      and not exists (
        select 1 from public.acc_periods p
        where p.entity_id = e.id and not p.is_adjustment and p.start_date = g.m::date and p.status in ('closed', 'locked')));
$$;
revoke all on function app.acc_range_final(uuid, uuid, date, date) from public, anon, authenticated;

-- The accounting thresholds (fin_ref_finance_settings, defaults when the org has no row yet).
create or replace function app.acc_report_settings(p_org_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'budget_variance_pct', coalesce(s.acc_budget_variance_pct, 10),
    'large_journal_amount', coalesce(s.acc_large_journal_amount, 50000),
    'ct_rate', coalesce(s.acc_ct_rate, 9),
    'ct_threshold', coalesce(s.acc_ct_threshold, 375000),
    'ct_entertainment_pct', coalesce(s.acc_ct_entertainment_pct, 50),
    'ct_sbr_limit', coalesce(s.acc_ct_sbr_limit, 3000000),
    'ct_connected_limit', coalesce(s.acc_ct_connected_limit, 500000))
  from (select 1) one
  left join public.fin_ref_finance_settings s on s.org_id = p_org_id;
$$;
revoke all on function app.acc_report_settings(uuid) from public, anon, authenticated;

-- The default cash flow class of a Tally system group (lib/accounting/statements/cash-flow.ts holds the same table).
create or replace function app.acc_cf_default(p_code text, p_nature text, p_is_system boolean)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when not p_is_system then null
    when p_code in ('G-BANK', 'G-CASH', 'G-BOD') then 'cash'
    when p_code in ('G-FA', 'G-INV') then 'investing'
    when p_code in ('G-CAP', 'G-RES', 'G-LOAN', 'G-SECL', 'G-UNSL') then 'financing'
    when p_code in ('G-PROV', 'G-MISC') then 'operating_noncash'
    when p_nature = 'equity' then 'financing'
    when p_nature in ('asset', 'liability') then 'working_capital'
  end;
$$;

-- Each balance-sheet account's effective cash flow class: cash and bank control accounts are cash; otherwise the
-- nearest of (its own class, a system group's default) walking up the tree; a top-level group with neither follows its
-- nature. Income and expense accounts have none (they are in the net profit).
create or replace function app.acc_cash_flow_classes(p_org_id uuid)
returns table (account_id uuid, cls text)
language sql
stable
security definer
set search_path = ''
as $$
  with recursive t as (
    select a.id, a.nature, a.control,
           coalesce(a.cash_flow_class, app.acc_cf_default(a.code, a.nature, a.is_system),
                    case when a.nature = 'equity' then 'financing' else 'working_capital' end) as cls,
           0 as depth
    from public.acc_accounts a
    where a.org_id = p_org_id and a.parent_id is null
    union all
    select c.id, c.nature, c.control,
           coalesce(c.cash_flow_class, app.acc_cf_default(c.code, c.nature, c.is_system), t.cls),
           t.depth + 1
    from public.acc_accounts c join t on c.parent_id = t.id
    where t.depth < 64
  )
  select t.id,
         case when t.nature in ('income', 'expense') then null
              when t.control in ('cash', 'bank') then 'cash'
              else t.cls end
  from t;
$$;
revoke all on function app.acc_cash_flow_classes(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Profit and loss
-- ---------------------------------------------------------------------------
-- Amounts per ledger and column in natural sign (income credit minus debit, expense debit minus credit), and per column
-- the Tally layout's totals: direct income (Sales Accounts and Direct Incomes), direct expense (Purchase Accounts and
-- Direct Expenses), gross profit, indirect income and expense, net profit. Columns: 'total', or one per month (YYYY-MM),
-- branch, department or doctor ('' = not set) from the journal lines' dimensions.
create or replace function public.acc_profit_and_loss(p_org_id uuid, p_entity_id uuid, p_from date, p_to date,
                                                      p_dimension text, p_include_adjustment boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dim text := coalesce(nullif(p_dimension, ''), 'none');
  v jsonb;
begin
  perform app.acc_report_args(p_org_id, p_entity_id, p_from, p_to);
  if v_dim not in ('none', 'month', 'branch', 'department', 'doctor') then
    raise exception 'Choose how to split the columns.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  with ln as (
    select l.account_id, a.nature, a.affects_gross_profit as gp,
           case v_dim when 'none' then 'total'
                      when 'month' then to_char(j.journal_date, 'YYYY-MM')
                      when 'branch' then coalesce(l.branch_code, '')
                      when 'department' then coalesce(l.department, '')
                      else coalesce(l.doctor_id, '') end as col,
           case when a.nature = 'income' then l.credit - l.debit else l.debit - l.credit end as amt
    from public.acc_journal_lines l
    join public.acc_journals j on j.id = l.journal_id
    join public.acc_accounts a on a.id = l.account_id
    where j.org_id = p_org_id and j.status in ('posted', 'reversed') and j.journal_date between p_from and p_to
      and (p_entity_id is null or j.entity_id = p_entity_id)
      and (coalesce(p_include_adjustment, true) or not j.is_adjustment)
      and a.nature in ('income', 'expense')
  ), per as (
    select account_id, col, sum(amt) as amt from ln group by account_id, col
  ), tot as (
    select col,
           sum(case when nature = 'income' and gp then amt else 0 end) as direct_income,
           sum(case when nature = 'expense' and gp then amt else 0 end) as direct_expense,
           sum(case when nature = 'income' and not gp then amt else 0 end) as indirect_income,
           sum(case when nature = 'expense' and not gp then amt else 0 end) as indirect_expense
    from ln group by col
  ), cols as (
    select distinct col from ln
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'entity_id', p_entity_id, 'dimension', v_dim,
    'include_adjustment', coalesce(p_include_adjustment, true),
    'provisional', not app.acc_range_final(p_org_id, p_entity_id, p_from, p_to),
    'columns', coalesce((select jsonb_agg(c.col order by c.col) from cols c), '[]'::jsonb),
    'labels', coalesce((
      select jsonb_object_agg(c.col, case
               when c.col = '' then 'Not set'
               when v_dim = 'branch' then coalesce((select b.name from public.fin_ref_branches b
                                                     where b.org_id = p_org_id and b.code = c.col), c.col)
               when v_dim = 'doctor' then coalesce((select d.name from public.fin_ref_doctors d
                                                     where d.org_id = p_org_id and d.dha_id = c.col), c.col)
               when v_dim = 'none' then 'Amount'
               else c.col end)
      from cols c), '{}'::jsonb),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object('account_id', p.account_id, 'col', p.col, 'amount', p.amt)
                       order by p.account_id, p.col)
      from per p where p.amt <> 0), '[]'::jsonb),
    'totals', coalesce((
      select jsonb_agg(jsonb_build_object(
               'col', t.col, 'direct_income', t.direct_income, 'direct_expense', t.direct_expense,
               'gross_profit', t.direct_income - t.direct_expense,
               'indirect_income', t.indirect_income, 'indirect_expense', t.indirect_expense,
               'net_profit', t.direct_income - t.direct_expense + t.indirect_income - t.indirect_expense)
             order by t.col)
      from tot t), '[]'::jsonb))
  into v;
  return v;
end;
$$;
revoke all on function public.acc_profit_and_loss(uuid, uuid, date, date, text, boolean) from public, anon, authenticated;
grant execute on function public.acc_profit_and_loss(uuid, uuid, date, date, text, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Balance sheet
-- ---------------------------------------------------------------------------
-- Balance-sheet ledgers as at a date, natural sign (asset debit minus credit; liability and equity credit minus debit),
-- the current fiscal year's profit (income and expense from each entity's year start to the date) and earlier years'
-- profit not yet closed into retained earnings (until the year-end close, 22I). difference = assets - (liabilities +
-- equity + both profit lines): zero whenever every journal balances; the page shows it prominently when it is not.
create or replace function public.acc_balance_sheet(p_org_id uuid, p_entity_id uuid, p_as_at date, p_include_adjustment boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_fy date;
  v jsonb;
begin
  perform app.acc_report_args(p_org_id, p_entity_id, p_as_at, p_as_at);
  select app.acc_fy_start(e.fiscal_year_start_month, p_as_at) into v_fy
  from public.acc_entities e
  where e.org_id = p_org_id and (e.id = p_entity_id or (p_entity_id is null and e.is_default));
  v_fy := coalesce(v_fy, app.acc_fy_start(7, p_as_at));
  with ln as (
    select l.account_id, a.nature, j.journal_date, l.debit - l.credit as dc,
           app.acc_fy_start(e.fiscal_year_start_month, p_as_at) as fy_start
    from public.acc_journal_lines l
    join public.acc_journals j on j.id = l.journal_id
    join public.acc_accounts a on a.id = l.account_id
    join public.acc_entities e on e.id = j.entity_id
    where j.org_id = p_org_id and j.status in ('posted', 'reversed') and j.journal_date <= p_as_at
      and (p_entity_id is null or j.entity_id = p_entity_id)
      and (coalesce(p_include_adjustment, true) or not j.is_adjustment)
  ), bs as (
    select account_id, nature, sum(case when nature = 'asset' then dc else -dc end) as bal
    from ln where nature in ('asset', 'liability', 'equity') group by account_id, nature
  ), pl as (
    select coalesce(sum(case when journal_date >= fy_start then -dc else 0 end), 0) as cur,
           coalesce(sum(case when journal_date < fy_start then -dc else 0 end), 0) as earlier
    from ln where nature in ('income', 'expense')
  ), tot as (
    select coalesce(sum(case when nature = 'asset' then bal else 0 end), 0) as assets,
           coalesce(sum(case when nature = 'liability' then bal else 0 end), 0) as liabilities,
           coalesce(sum(case when nature = 'equity' then bal else 0 end), 0) as equity
    from bs
  )
  select jsonb_build_object(
    'as_at', p_as_at, 'entity_id', p_entity_id, 'fy_start', v_fy,
    'include_adjustment', coalesce(p_include_adjustment, true),
    'provisional', not app.acc_range_final(p_org_id, p_entity_id, v_fy, p_as_at),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object('account_id', b.account_id, 'nature', b.nature, 'balance', b.bal)
                       order by b.account_id)
      from bs b where b.bal <> 0), '[]'::jsonb),
    'current_year_pl', (select cur from pl),
    'earlier_years_pl', (select earlier from pl),
    'totals', (select jsonb_build_object(
                 'assets', t.assets, 'liabilities', t.liabilities, 'equity', t.equity,
                 'difference', t.assets - t.liabilities - t.equity - (select cur from pl) - (select earlier from pl))
               from tot t))
  into v;
  return v;
end;
$$;
revoke all on function public.acc_balance_sheet(uuid, uuid, date, boolean) from public, anon, authenticated;
grant execute on function public.acc_balance_sheet(uuid, uuid, date, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Cash flow (indirect method)
-- ---------------------------------------------------------------------------
-- Net profit for the range, then every non-cash balance-sheet ledger's cash effect (credit minus debit over the range)
-- by class: non-cash items added back, working capital, investing, financing. Their sum is the change in cash; it is
-- reconciled to the cash and bank ledgers' own movement (opening and closing balances). Because every journal balances,
-- the difference is zero; the page still shows it.
create or replace function public.acc_cash_flow(p_org_id uuid, p_entity_id uuid, p_from date, p_to date, p_include_adjustment boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  perform app.acc_report_args(p_org_id, p_entity_id, p_from, p_to);
  with cls as (
    select * from app.acc_cash_flow_classes(p_org_id)
  ), ln as (
    select l.account_id, a.nature, c.cls, j.journal_date, l.debit, l.credit
    from public.acc_journal_lines l
    join public.acc_journals j on j.id = l.journal_id
    join public.acc_accounts a on a.id = l.account_id
    left join cls c on c.account_id = l.account_id
    where j.org_id = p_org_id and j.status in ('posted', 'reversed') and j.journal_date <= p_to
      and (p_entity_id is null or j.entity_id = p_entity_id)
      and (coalesce(p_include_adjustment, true) or not j.is_adjustment)
  ), mv as (
    select account_id, coalesce(cls, 'working_capital') as cls,
           sum(case when journal_date >= p_from then credit - debit else 0 end) as effect,
           sum(case when journal_date < p_from then debit - credit else 0 end) as opening,
           sum(debit - credit) as closing
    from ln where nature in ('asset', 'liability', 'equity') group by account_id, coalesce(cls, 'working_capital')
  ), np as (
    select coalesce(sum(credit - debit), 0) as np from ln where nature in ('income', 'expense') and journal_date >= p_from
  ), tot as (
    select coalesce(sum(case when cls = 'operating_noncash' then effect else 0 end), 0) as noncash,
           coalesce(sum(case when cls = 'working_capital' then effect else 0 end), 0) as wc,
           coalesce(sum(case when cls = 'investing' then effect else 0 end), 0) as inv,
           coalesce(sum(case when cls = 'financing' then effect else 0 end), 0) as fin,
           coalesce(sum(case when cls = 'cash' then opening else 0 end), 0) as cash_open,
           coalesce(sum(case when cls = 'cash' then closing else 0 end), 0) as cash_close
    from mv
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'entity_id', p_entity_id,
    'include_adjustment', coalesce(p_include_adjustment, true),
    'provisional', not app.acc_range_final(p_org_id, p_entity_id, p_from, p_to),
    'net_profit', (select np from np),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object('account_id', m.account_id, 'class', m.cls, 'amount', m.effect)
                       order by m.cls, m.account_id)
      from mv m where m.cls <> 'cash' and m.effect <> 0), '[]'::jsonb),
    'cash_accounts', coalesce((
      select jsonb_agg(jsonb_build_object('account_id', m.account_id, 'opening', m.opening, 'closing', m.closing)
                       order by m.account_id)
      from mv m where m.cls = 'cash' and (m.opening <> 0 or m.closing <> 0)), '[]'::jsonb),
    'totals', (select jsonb_build_object(
                 'net_profit', (select np from np),
                 'operating_noncash', t.noncash, 'working_capital', t.wc,
                 'operating', (select np from np) + t.noncash + t.wc,
                 'investing', t.inv, 'financing', t.fin,
                 'net_change', (select np from np) + t.noncash + t.wc + t.inv + t.fin,
                 'opening_cash', t.cash_open, 'closing_cash', t.cash_close,
                 'cash_movement', t.cash_close - t.cash_open,
                 'difference', (select np from np) + t.noncash + t.wc + t.inv + t.fin - (t.cash_close - t.cash_open))
               from tot t),
    'classes', coalesce((select jsonb_object_agg(c.account_id::text, c.cls) from cls c where c.cls is not null), '{}'::jsonb))
  into v;
  return v;
end;
$$;
revoke all on function public.acc_cash_flow(uuid, uuid, date, date, boolean) from public, anon, authenticated;
grant execute on function public.acc_cash_flow(uuid, uuid, date, date, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 7. VAT return (FTA VAT 201): a working paper, never filed from Pulse
-- ---------------------------------------------------------------------------
-- One entity (null = the default). Every line in the range with a tax code is placed in a box:
--   supplies (income ledgers; amount = credit - debit): standard -> 1a..1g by the emirate of the line's branch (no
--     branch -> the entity's default emirate, flagged), zero -> 4, exempt -> 5, out of scope -> listed, not in the return;
--   purchases (expense and asset ledgers; amount = debit - credit): standard -> 9, reverse charge -> 3 and 10,
--     blocked -> listed, excluded from box 9; zero / exempt / out of scope -> listed only;
--   VAT ledgers (control vat_output: credit - debit; vat_input: debit - credit) give the VAT column of the same boxes.
-- Anything else (a tax code on a liability, a reverse-charge code on income...) goes to 'review'. Lines without a tax
-- code on income, expense or VAT ledgers are listed as exceptions. expected_vat = amount x rate, to compare with the VAT
-- actually booked. Boxes 2, 6 and 7 are normally zero for the clinic and are shown as zero.
create or replace function public.acc_vat_return(p_org_id uuid, p_entity_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  e public.acc_entities;
  v jsonb;
begin
  perform app.acc_report_args(p_org_id, p_entity_id, p_from, p_to);
  select * into e from public.acc_entities x
   where x.org_id = p_org_id and (x.id = p_entity_id or (p_entity_id is null and x.is_default));
  if not found then
    raise exception 'Entity not found.' using errcode = 'check_violation', hint = 'entity_unknown';
  end if;
  with ln as (
    select l.id as line_id, j.id as journal_id, j.number, j.journal_date, a.code as account_code, a.name as account_name,
           a.nature, a.control, l.debit, l.credit, l.branch_code, t.code as tax_code, t.kind, t.rate,
           coalesce(eb.emirate, e.default_emirate) as emirate, (eb.emirate is null) as emirate_defaulted,
           case when a.control in ('vat_output', 'vat_input') then 'vat'
                when a.nature = 'income' then 'supply'
                when a.nature in ('expense', 'asset') then 'purchase'
                else 'other' end as side
    from public.acc_journal_lines l
    join public.acc_journals j on j.id = l.journal_id
    join public.acc_accounts a on a.id = l.account_id
    left join public.acc_tax_codes t on t.id = l.tax_code_id
    left join public.acc_entity_branches eb on eb.org_id = l.org_id and eb.branch_code = l.branch_code
    where j.org_id = p_org_id and j.entity_id = e.id and j.status in ('posted', 'reversed')
      and j.journal_date between p_from and p_to
  ), em as (
    select ln.*, case ln.emirate when 'Abu Dhabi' then '1a' when 'Dubai' then '1b' when 'Sharjah' then '1c'
                                 when 'Ajman' then '1d' when 'Umm Al Quwain' then '1e' when 'Ras Al Khaimah' then '1f'
                                 else '1g' end as box1
    from ln
  ), boxed as (
    select em.*, case kind when 'standard' then box1 when 'zero' then '4' when 'exempt' then '5'
                           when 'out_of_scope' then 'out_of_scope' else 'review' end as box,
           credit - debit as amount, 0::numeric as vat
    from em where side = 'supply' and kind is not null
    union all
    select em.*, case kind when 'standard' then '9' when 'reverse_charge' then '10' when 'blocked' then 'blocked'
                           else 'not_in_return' end,
           debit - credit, 0::numeric
    from em where side = 'purchase' and kind is not null
    union all
    select em.*, '3', debit - credit, 0::numeric
    from em where side = 'purchase' and kind = 'reverse_charge'
    union all
    select em.*, case when control = 'vat_output' and kind = 'standard' then box1
                      when control = 'vat_output' and kind = 'reverse_charge' then '3'
                      when control = 'vat_input' and kind = 'standard' then '9'
                      when control = 'vat_input' and kind = 'reverse_charge' then '10'
                      else 'review' end,
           0::numeric, case when control = 'vat_output' then credit - debit else debit - credit end
    from em where side = 'vat' and kind is not null
    union all
    select em.*, 'review', debit - credit, 0::numeric
    from em where side = 'other' and kind is not null
  ), box_list (box, ord) as (
    values ('1a', 1), ('1b', 2), ('1c', 3), ('1d', 4), ('1e', 5), ('1f', 6), ('1g', 7), ('2', 8), ('3', 9), ('4', 10),
           ('5', 11), ('6', 12), ('7', 13), ('9', 14), ('10', 15), ('blocked', 16), ('out_of_scope', 17),
           ('not_in_return', 18), ('review', 19)
  ), sums as (
    select bl.box, bl.ord,
           coalesce(sum(b.amount), 0) as amount, coalesce(sum(b.vat), 0) as vat,
           coalesce(round(sum(case when b.box in ('1a', '1b', '1c', '1d', '1e', '1f', '1g', '3', '9', '10')
                                   then b.amount * coalesce(b.rate, 0) / 100 else 0 end), 2), 0) as expected_vat,
           count(b.line_id) as lines,
           count(b.line_id) filter (where b.emirate_defaulted and b.box in ('1a', '1b', '1c', '1d', '1e', '1f', '1g')) as defaulted
    from box_list bl left join boxed b on b.box = bl.box
    group by bl.box, bl.ord
  ), totals as (
    select
      (select sum(amount) from sums where box in ('1a', '1b', '1c', '1d', '1e', '1f', '1g', '2', '3', '4', '5', '6', '7')) as out_amount,
      (select sum(vat) from sums where box in ('1a', '1b', '1c', '1d', '1e', '1f', '1g', '2', '3', '6', '7')) as out_vat,
      (select sum(amount) from sums where box in ('9', '10')) as in_amount,
      (select sum(vat) from sums where box in ('9', '10')) as in_vat
  ), missing as (
    select * from em
    where kind is null and (side = 'vat' or nature in ('income', 'expense'))
    order by journal_date, number, line_id
    limit 1001
  ), support as (
    select * from boxed order by box, journal_date, number, line_id limit 5001
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'entity_id', e.id, 'entity_name', e.name, 'trn', e.trn,
    'default_emirate', e.default_emirate,
    'provisional', not app.acc_range_final(p_org_id, e.id, p_from, p_to),
    'boxes', (select jsonb_agg(jsonb_build_object('box', s.box, 'amount', s.amount, 'vat', s.vat,
                                                 'expected_vat', s.expected_vat, 'adjustment', 0,
                                                 'lines', s.lines, 'defaulted_emirate', s.defaulted) order by s.ord)
              from sums s),
    'totals', (select jsonb_build_object(
                 'box8_amount', coalesce(t.out_amount, 0), 'box8_vat', coalesce(t.out_vat, 0),
                 'box11_amount', coalesce(t.in_amount, 0), 'box11_vat', coalesce(t.in_vat, 0),
                 'box12', coalesce(t.out_vat, 0), 'box13', coalesce(t.in_vat, 0),
                 'box14', coalesce(t.out_vat, 0) - coalesce(t.in_vat, 0))
               from totals t),
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'box', s.box, 'line_id', s.line_id, 'journal_id', s.journal_id, 'number', s.number, 'date', s.journal_date,
               'account_code', s.account_code, 'account_name', s.account_name, 'branch_code', s.branch_code,
               'tax_code', s.tax_code, 'emirate', s.emirate, 'emirate_defaulted', s.emirate_defaulted,
               'amount', s.amount, 'vat', s.vat))
      from (select * from support limit 5000) s), '[]'::jsonb),
    'lines_truncated', (select count(*) from support) > 5000,
    'missing_tax_code', coalesce((
      select jsonb_agg(jsonb_build_object(
               'line_id', m.line_id, 'journal_id', m.journal_id, 'number', m.number, 'date', m.journal_date,
               'account_code', m.account_code, 'account_name', m.account_name, 'branch_code', m.branch_code,
               'debit', m.debit, 'credit', m.credit))
      from (select * from missing limit 1000) m), '[]'::jsonb),
    'missing_truncated', (select count(*) from missing) > 1000)
  into v;
  return v;
end;
$$;
revoke all on function public.acc_vat_return(uuid, uuid, date, date) from public, anon, authenticated;
grant execute on function public.acc_vat_return(uuid, uuid, date, date) to service_role;

-- ---------------------------------------------------------------------------
-- 8. Exception reports (Tally-style), each capped at 500 rows
-- ---------------------------------------------------------------------------
create or replace function public.acc_statement_exceptions(p_org_id uuid, p_entity_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_settings jsonb := app.acc_report_settings(p_org_id);
  v_large numeric := (v_settings ->> 'large_journal_amount')::numeric;
  v jsonb;
begin
  perform app.acc_report_args(p_org_id, p_entity_id, p_from, p_to);
  with jr as (
    select j.* from public.acc_journals j
    where j.org_id = p_org_id and j.status in ('posted', 'reversed') and (p_entity_id is null or j.entity_id = p_entity_id)
  ), ln as (
    select l.*, j.journal_date, j.number, j.is_adjustment, e.fiscal_year_start_month
    from public.acc_journal_lines l join jr j on j.id = l.journal_id join public.acc_entities e on e.id = j.entity_id
  ), late as (
    -- posted in the adjustment period, or after its month was closed
    select j.id, j.number, j.journal_date, j.voucher_type, j.total, j.source_kind, j.is_adjustment, p.status as period_status,
           j.posted_at, p.closed_at
    from jr j join public.acc_periods p on p.id = j.period_id
    where j.journal_date between p_from and p_to
      and (j.is_adjustment or (p.closed_at is not null and j.posted_at > p.closed_at))
    order by j.journal_date, j.number limit 500
  ), cashacc as (
    select a.id, a.code, a.name from public.acc_accounts a
    where a.org_id = p_org_id and not a.is_group and a.control in ('cash', 'bank')
  ), cash_open as (
    select l.account_id, sum(l.debit - l.credit) as bal from ln l join cashacc c on c.id = l.account_id
    where l.journal_date < p_from group by l.account_id
  ), cash_day as (
    select l.account_id, l.journal_date as d, sum(l.debit - l.credit) as mv from ln l join cashacc c on c.id = l.account_id
    where l.journal_date between p_from and p_to group by l.account_id, l.journal_date
  ), cash_run as (
    select d.account_id, d.d, coalesce(o.bal, 0) + sum(d.mv) over (partition by d.account_id order by d.d) as bal
    from cash_day d left join cash_open o on o.account_id = d.account_id
    union all
    -- negative from the start of the range, with no movement on its first day
    select o.account_id, p_from, o.bal from cash_open o
    where o.bal < 0 and not exists (select 1 from cash_day d where d.account_id = o.account_id and d.d = p_from)
  ), neg_cash as (
    select r.account_id, c.code, c.name, r.d, r.bal from cash_run r join cashacc c on c.id = r.account_id
    where r.bal < 0 order by c.code, r.d limit 500
  ), bal as (
    -- balances at p_to: balance-sheet ledgers from the beginning, income and expense from the fiscal year start
    select l.account_id, sum(l.debit - l.credit) as dc from ln l join public.acc_accounts a on a.id = l.account_id
    where l.journal_date <= p_to
      and (a.nature in ('asset', 'liability', 'equity') or l.journal_date >= app.acc_fy_start(l.fiscal_year_start_month, p_to))
    group by l.account_id
  ), opposite as (
    select a.id, a.code, a.name, a.nature, b.dc from bal b join public.acc_accounts a on a.id = b.account_id
    where (a.nature in ('asset', 'expense') and b.dc < 0) or (a.nature in ('liability', 'equity', 'income') and b.dc > 0)
    order by a.code limit 500
  ), susp as (
    select a.id, a.code, a.name, b.dc from bal b join public.acc_accounts a on a.id = b.account_id
    where b.dc <> 0 and exists (
      with recursive up as (
        select a.parent_id as id, 0 as depth
        union all
        select x.parent_id, up.depth + 1 from public.acc_accounts x join up on x.id = up.id where up.depth < 64)
      select 1 from up join public.acc_accounts g on g.id = up.id where g.org_id = p_org_id and g.code = 'G-SUSP' and g.is_system)
    order by a.code limit 500
  ), large as (
    select j.id, j.number, j.journal_date, j.voucher_type, j.total, j.narration, j.prepared_by, j.approved_by
    from jr j where j.source_kind is null and j.total >= v_large and j.journal_date between p_from and p_to
    order by j.total desc, j.journal_date limit 500
  ), nodim as (
    select l.id as line_id, l.journal_id, l.number, l.journal_date, a.code, a.name,
           (a.requires_branch and l.branch_code is null) as no_branch,
           (a.requires_cost_centre and l.cost_centre_id is null) as no_cost_centre,
           l.debit, l.credit
    from ln l join public.acc_accounts a on a.id = l.account_id
    where l.journal_date between p_from and p_to
      and ((a.requires_branch and l.branch_code is null) or (a.requires_cost_centre and l.cost_centre_id is null))
    order by l.journal_date, l.number limit 500
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'entity_id', p_entity_id, 'large_journal_amount', v_large,
    'provisional', not app.acc_range_final(p_org_id, p_entity_id, p_from, p_to),
    'late_postings', coalesce((select jsonb_agg(jsonb_build_object(
        'journal_id', x.id, 'number', x.number, 'date', x.journal_date, 'voucher_type', x.voucher_type, 'total', x.total,
        'source_kind', x.source_kind, 'is_adjustment', x.is_adjustment, 'period_status', x.period_status,
        'posted_at', x.posted_at, 'closed_at', x.closed_at)) from late x), '[]'::jsonb),
    'negative_cash', coalesce((select jsonb_agg(jsonb_build_object(
        'account_id', x.account_id, 'code', x.code, 'name', x.name, 'date', x.d, 'balance', x.bal)) from neg_cash x), '[]'::jsonb),
    'opposite_balances', coalesce((select jsonb_agg(jsonb_build_object(
        'account_id', x.id, 'code', x.code, 'name', x.name, 'nature', x.nature, 'balance', x.dc)) from opposite x), '[]'::jsonb),
    'suspense', coalesce((select jsonb_agg(jsonb_build_object(
        'account_id', x.id, 'code', x.code, 'name', x.name, 'balance', x.dc)) from susp x), '[]'::jsonb),
    'large_manual', coalesce((select jsonb_agg(jsonb_build_object(
        'journal_id', x.id, 'number', x.number, 'date', x.journal_date, 'voucher_type', x.voucher_type, 'total', x.total,
        'narration', x.narration)) from large x), '[]'::jsonb),
    'missing_dimension', coalesce((select jsonb_agg(jsonb_build_object(
        'line_id', x.line_id, 'journal_id', x.journal_id, 'number', x.number, 'date', x.journal_date, 'code', x.code,
        'name', x.name, 'no_branch', x.no_branch, 'no_cost_centre', x.no_cost_centre,
        'amount', x.debit + x.credit)) from nodim x), '[]'::jsonb))
  into v;
  return v;
end;
$$;
revoke all on function public.acc_statement_exceptions(uuid, uuid, date, date) from public, anon, authenticated;
grant execute on function public.acc_statement_exceptions(uuid, uuid, date, date) to service_role;

-- ---------------------------------------------------------------------------
-- 9. Corporate tax bridge (working paper, not a tax return)
-- ---------------------------------------------------------------------------
-- Accounting profit for the range (adjustment period included), revenue (all income), and the expense on ledgers tagged
-- with a ct_treatment, per treatment and per ledger. The bridge itself (disallowances, the 0% band, the rate, Small
-- Business Relief and the connected-person disclosure note) is pure: lib/accounting/statements/corporate-tax.ts.
create or replace function public.acc_ct_bridge(p_org_id uuid, p_entity_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  perform app.acc_report_args(p_org_id, p_entity_id, p_from, p_to);
  with ln as (
    select a.id as account_id, a.code, a.name, a.nature, a.ct_treatment, l.debit, l.credit
    from public.acc_journal_lines l
    join public.acc_journals j on j.id = l.journal_id
    join public.acc_accounts a on a.id = l.account_id
    where j.org_id = p_org_id and j.status in ('posted', 'reversed') and j.journal_date between p_from and p_to
      and (p_entity_id is null or j.entity_id = p_entity_id) and a.nature in ('income', 'expense')
  ), tagged as (
    select account_id, code, name, ct_treatment, sum(debit - credit) as amount
    from ln where ct_treatment is not null and nature = 'expense'
    group by account_id, code, name, ct_treatment
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'entity_id', p_entity_id,
    'provisional', not app.acc_range_final(p_org_id, p_entity_id, p_from, p_to),
    'settings', app.acc_report_settings(p_org_id),
    'accounting_profit', (select coalesce(sum(credit - debit), 0) from ln),
    'revenue', (select coalesce(sum(credit - debit), 0) from ln where nature = 'income'),
    'by_treatment', coalesce((select jsonb_object_agg(t.ct_treatment, t.amount)
                              from (select ct_treatment, sum(amount) as amount from tagged group by ct_treatment) t), '{}'::jsonb),
    'accounts', coalesce((select jsonb_agg(jsonb_build_object(
                  'account_id', t.account_id, 'code', t.code, 'name', t.name, 'treatment', t.ct_treatment, 'amount', t.amount)
                  order by t.ct_treatment, t.code) from tagged t), '[]'::jsonb))
  into v;
  return v;
end;
$$;
revoke all on function public.acc_ct_bridge(uuid, uuid, date, date) from public, anon, authenticated;
grant execute on function public.acc_ct_bridge(uuid, uuid, date, date) to service_role;

-- ---------------------------------------------------------------------------
-- 10. Budgets: save, hash, act, budget against actual
-- ---------------------------------------------------------------------------
-- The content an approver reviews: header and lines in a fixed order, one per text line.
create or replace function public.acc_budget_hash(p_budget_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select encode(sha256(convert_to(
    'budget|' || b.id::text || '|' || b.entity_id::text || '|' || b.fy_start::text || '|' || btrim(b.name) || E'\n' ||
    coalesce((select string_agg(a.code || '|' || to_char(l.month, 'YYYY-MM') || '|' || coalesce(l.branch_code, '') || '|'
                                || coalesce(l.department, '') || '|' || to_char(l.amount, 'FM999999999990.00'), E'\n'
                                order by a.code, l.month, coalesce(l.branch_code, ''), coalesce(l.department, ''))
              from public.acc_budget_lines l join public.acc_accounts a on a.id = l.account_id
              where l.budget_id = b.id), ''), 'UTF8')), 'hex')
  from public.acc_budgets b where b.id = p_budget_id;
$$;
revoke all on function public.acc_budget_hash(uuid) from public, anon, authenticated;
grant execute on function public.acc_budget_hash(uuid) to service_role;

-- Create or replace a DRAFT budget and all its lines. p_header: { entity_id?, fy_start (yyyy-mm-dd, the year's first
-- day), name }. p_lines: [{ account_code | account_id, month (yyyy-mm or yyyy-mm-01), branch_code?, department?, amount }]
-- on active income or expense ledgers, months inside the fiscal year, amounts >= 0 with at most 2 decimals, no
-- duplicates (at most 20,000 lines). The saver becomes the preparer.
create or replace function public.acc_budget_save(p_org_id uuid, p_user_id uuid, p_budget_id uuid, p_header jsonb, p_lines jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.acc_budgets;
  v_entity uuid;
  v_fy date;
  v_name text := btrim(coalesce(p_header ->> 'name', ''));
  v_start_month integer;
  x jsonb;
  v_acc public.acc_accounts;
  v_month date;
  v_amount numeric;
  v_branch text;
  v_dept text;
  v_n integer := 0;
begin
  if not app.user_has_perm(p_org_id, p_user_id, 'accounting.budgets.manage') then
    raise exception 'You cannot prepare budgets.' using errcode = 'check_violation', hint = 'not_permitted';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) > 20000 then
    raise exception 'The budget lines are not valid.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  begin
    v_entity := nullif(p_header ->> 'entity_id', '')::uuid;
    v_fy := nullif(p_header ->> 'fy_start', '')::date;
  exception when others then
    raise exception 'Enter a valid fiscal year.' using errcode = 'check_violation', hint = 'invalid';
  end;
  if v_entity is null then
    select e.id into v_entity from public.acc_entities e where e.org_id = p_org_id and e.is_default;
  end if;
  select e.fiscal_year_start_month into v_start_month from public.acc_entities e
   where e.id = v_entity and e.org_id = p_org_id and e.active;
  if not found then
    raise exception 'Entity not found.' using errcode = 'check_violation', hint = 'entity_unknown';
  end if;
  if v_fy is null or extract(day from v_fy) <> 1 or extract(month from v_fy) <> v_start_month then
    raise exception 'Choose the fiscal year.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  if v_name = '' or char_length(v_name) > 80 then
    raise exception 'Name the budget (up to 80 characters).' using errcode = 'check_violation', hint = 'invalid';
  end if;

  if p_budget_id is null then
    insert into public.acc_budgets (org_id, entity_id, fy_start, name, prepared_by, prepared_at)
    values (p_org_id, v_entity, v_fy, v_name, p_user_id, now())
    returning * into b;
  else
    select * into b from public.acc_budgets where id = p_budget_id and org_id = p_org_id for update;
    if not found then
      raise exception 'Budget not found.' using errcode = 'no_data_found', hint = 'not_found';
    end if;
    if b.status <> 'draft' then
      raise exception 'An approved budget cannot change; reopen it first.' using errcode = 'check_violation', hint = 'budget_approved';
    end if;
    update public.acc_budgets set entity_id = v_entity, fy_start = v_fy, name = v_name, prepared_by = p_user_id,
                                  prepared_at = now()
     where id = b.id;
    delete from public.acc_budget_lines l where l.budget_id = b.id;
  end if;

  for x in select * from jsonb_array_elements(p_lines) loop
    v_n := v_n + 1;
    if nullif(x ->> 'account_id', '') is not null then
      begin
        select * into v_acc from public.acc_accounts a where a.id = (x ->> 'account_id')::uuid and a.org_id = p_org_id;
      exception when others then
        v_acc := null;
      end;
    else
      select * into v_acc from public.acc_accounts a where a.org_id = p_org_id and a.code = upper(btrim(coalesce(x ->> 'account_code', '')));
    end if;
    if v_acc.id is null or v_acc.is_group or not v_acc.is_active or v_acc.nature not in ('income', 'expense') then
      raise exception 'Line %: budget income and expense ledgers only.', v_n using errcode = 'check_violation', hint = 'budget_account';
    end if;
    begin
      v_month := (left(btrim(x ->> 'month'), 7) || '-01')::date;
      v_amount := (x ->> 'amount')::numeric;
    exception when others then
      raise exception 'Line %: enter a month (yyyy-mm) and an amount.', v_n using errcode = 'check_violation', hint = 'invalid';
    end;
    if v_month is null or v_month < v_fy or v_month > (v_fy + interval '11 months')::date then
      raise exception 'Line %: the month is outside the fiscal year.', v_n using errcode = 'check_violation', hint = 'budget_month';
    end if;
    if v_amount is null or v_amount < 0 or v_amount <> round(v_amount, 2) or v_amount >= 1e12 then
      raise exception 'Line %: amounts are zero or more, with at most two decimals.', v_n using errcode = 'check_violation', hint = 'invalid';
    end if;
    v_branch := nullif(btrim(coalesce(x ->> 'branch_code', '')), '');
    v_dept := nullif(btrim(coalesce(x ->> 'department', '')), '');
    if v_branch is not null and not exists (select 1 from public.fin_ref_branches br where br.org_id = p_org_id and br.code = v_branch) then
      raise exception 'Line %: unknown branch.', v_n using errcode = 'check_violation', hint = 'branch_unknown';
    end if;
    if v_dept is not null and char_length(v_dept) > 60 then
      raise exception 'Line %: the department name is too long.', v_n using errcode = 'check_violation', hint = 'invalid';
    end if;
    begin
      insert into public.acc_budget_lines (org_id, budget_id, account_id, month, branch_code, department, amount)
      values (p_org_id, b.id, v_acc.id, v_month, v_branch, v_dept, v_amount);
    exception when unique_violation then
      raise exception 'Line %: the same account, month, branch and department appear twice.', v_n
        using errcode = 'check_violation', hint = 'duplicate_line';
    end;
  end loop;
  return jsonb_build_object('id', b.id, 'status', 'draft', 'lines', v_n);
end;
$$;
revoke all on function public.acc_budget_save(uuid, uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.acc_budget_save(uuid, uuid, uuid, jsonb, jsonb) to service_role;

-- approve (accounting.journals.approve, a different person from the preparer, quoting the hash they reviewed),
-- reopen (accounting.budgets.manage: back to draft, the reopener becomes the preparer), delete (a draft only).
create or replace function public.acc_budget_act(p_org_id uuid, p_budget_id uuid, p_user_id uuid, p_action text, p_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.acc_budgets;
  v_hash text;
begin
  select * into b from public.acc_budgets where id = p_budget_id and org_id = p_org_id for update;
  if not found then
    raise exception 'Budget not found.' using errcode = 'no_data_found', hint = 'not_found';
  end if;
  if p_action = 'approve' then
    if not app.user_has_perm(p_org_id, p_user_id, 'accounting.journals.approve') then
      raise exception 'You cannot approve budgets.' using errcode = 'check_violation', hint = 'not_permitted';
    end if;
    if b.status <> 'draft' then
      raise exception 'This budget is already approved.' using errcode = 'check_violation', hint = 'wrong_status';
    end if;
    if b.prepared_by is not null and b.prepared_by = p_user_id then
      raise exception 'Someone other than the preparer must approve it.' using errcode = 'check_violation', hint = 'budget_same_person';
    end if;
    if not exists (select 1 from public.acc_budget_lines l where l.budget_id = b.id) then
      raise exception 'The budget has no lines.' using errcode = 'check_violation', hint = 'budget_empty';
    end if;
    v_hash := public.acc_budget_hash(b.id);
    if p_hash is null or p_hash <> v_hash then
      raise exception 'The budget changed after you opened it; reload and check it again.' using errcode = 'check_violation', hint = 'budget_hash_mismatch';
    end if;
    update public.acc_budgets set status = 'approved', approved_by = p_user_id, approved_at = now(), approved_sha256 = v_hash
     where id = b.id;
    return jsonb_build_object('id', b.id, 'status', 'approved', 'sha256', v_hash);
  elsif p_action = 'reopen' then
    if not app.user_has_perm(p_org_id, p_user_id, 'accounting.budgets.manage') then
      raise exception 'You cannot change budgets.' using errcode = 'check_violation', hint = 'not_permitted';
    end if;
    if b.status <> 'approved' then
      raise exception 'Only an approved budget can be reopened.' using errcode = 'check_violation', hint = 'wrong_status';
    end if;
    update public.acc_budgets set status = 'draft', approved_by = null, approved_at = null, approved_sha256 = null,
                                  prepared_by = p_user_id, prepared_at = now()
     where id = b.id;
    return jsonb_build_object('id', b.id, 'status', 'draft');
  elsif p_action = 'delete' then
    if not app.user_has_perm(p_org_id, p_user_id, 'accounting.budgets.manage') then
      raise exception 'You cannot change budgets.' using errcode = 'check_violation', hint = 'not_permitted';
    end if;
    if b.status <> 'draft' then
      raise exception 'Reopen the budget before deleting it.' using errcode = 'check_violation', hint = 'budget_approved';
    end if;
    delete from public.acc_budgets where id = b.id;
    return jsonb_build_object('id', b.id, 'status', 'deleted');
  end if;
  raise exception 'Unknown action.' using errcode = 'check_violation', hint = 'invalid';
end;
$$;
revoke all on function public.acc_budget_act(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.acc_budget_act(uuid, uuid, uuid, text, text) to service_role;

-- Budget against actual for the budget's entity, per ledger and month (yyyy-mm) inside [p_from, p_to] (clamped to the
-- fiscal year; a range outside it means the whole year). Actuals in natural sign (income credit - debit, expense debit - credit), adjustment period included.
-- With p_branch / p_department, both sides are limited to lines carrying that branch / department; without, all of them.
-- Ledgers with actuals but no budget are included (unbudgeted). Variance and the highlight are computed in
-- lib/accounting/statements/budget.ts from the threshold returned here.
create or replace function public.acc_budget_vs_actual(p_org_id uuid, p_budget_id uuid, p_from date, p_to date,
                                                       p_branch text, p_department text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  b public.acc_budgets;
  v_from date;
  v_to date;
  v_fy_end date;
  v_branch text := nullif(btrim(coalesce(p_branch, '')), '');
  v_dept text := nullif(btrim(coalesce(p_department, '')), '');
  v jsonb;
begin
  select * into b from public.acc_budgets where id = p_budget_id and org_id = p_org_id;
  if not found then
    raise exception 'Budget not found.' using errcode = 'no_data_found', hint = 'not_found';
  end if;
  v_fy_end := (b.fy_start + interval '1 year' - interval '1 day')::date;
  v_from := greatest(coalesce(p_from, b.fy_start), b.fy_start);
  v_to := least(coalesce(p_to, v_fy_end), v_fy_end);
  if v_from > v_to then   -- a range outside the budget's year: the whole year
    v_from := b.fy_start;
    v_to := v_fy_end;
  end if;
  with bud as (
    select l.account_id, to_char(l.month, 'YYYY-MM') as m, sum(l.amount) as amount
    from public.acc_budget_lines l
    where l.budget_id = b.id and l.month between date_trunc('month', v_from)::date and v_to
      and (v_branch is null or l.branch_code = v_branch) and (v_dept is null or l.department = v_dept)
    group by l.account_id, to_char(l.month, 'YYYY-MM')
  ), act as (
    select l.account_id, to_char(j.journal_date, 'YYYY-MM') as m,
           sum(case when a.nature = 'income' then l.credit - l.debit else l.debit - l.credit end) as amount
    from public.acc_journal_lines l
    join public.acc_journals j on j.id = l.journal_id
    join public.acc_accounts a on a.id = l.account_id
    where j.org_id = p_org_id and j.entity_id = b.entity_id and j.status in ('posted', 'reversed')
      and j.journal_date between v_from and v_to and a.nature in ('income', 'expense')
      and (v_branch is null or l.branch_code = v_branch) and (v_dept is null or l.department = v_dept)
    group by l.account_id, to_char(j.journal_date, 'YYYY-MM')
  ), both_ as (
    select coalesce(bu.account_id, ac.account_id) as account_id, coalesce(bu.m, ac.m) as m,
           coalesce(bu.amount, 0) as budget, coalesce(ac.amount, 0) as actual
    from bud bu full join act ac on ac.account_id = bu.account_id and ac.m = bu.m
  )
  select jsonb_build_object(
    'budget_id', b.id, 'name', b.name, 'status', b.status, 'fy_start', b.fy_start, 'entity_id', b.entity_id,
    'from', v_from, 'to', v_to, 'branch', v_branch, 'department', v_dept,
    'threshold_pct', (app.acc_report_settings(p_org_id) ->> 'budget_variance_pct')::numeric,
    'provisional', not app.acc_range_final(p_org_id, b.entity_id, v_from, v_to),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object('account_id', x.account_id, 'month', x.m, 'budget', x.budget, 'actual', x.actual)
                       order by x.account_id, x.m)
      from both_ x where x.budget <> 0 or x.actual <> 0), '[]'::jsonb),
    'totals', (select jsonb_build_object(
                 'budget_income', coalesce(sum(case when a.nature = 'income' then x.budget end), 0),
                 'actual_income', coalesce(sum(case when a.nature = 'income' then x.actual end), 0),
                 'budget_expense', coalesce(sum(case when a.nature = 'expense' then x.budget end), 0),
                 'actual_expense', coalesce(sum(case when a.nature = 'expense' then x.actual end), 0))
               from both_ x join public.acc_accounts a on a.id = x.account_id))
  into v;
  return v;
end;
$$;
revoke all on function public.acc_budget_vs_actual(uuid, uuid, date, date, text, text) from public, anon, authenticated;
grant execute on function public.acc_budget_vs_actual(uuid, uuid, date, date, text, text) to service_role;

insert into supabase_migrations.schema_migrations (version, name) values ('20261109000400', 'accounting_statements') on conflict (version) do nothing;
