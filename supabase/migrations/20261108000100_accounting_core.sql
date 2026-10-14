-- Phase 22A: accounting ledger core (docs/22_ACCOUNTING_PLAN.md, slice 22A; notes in docs/22_PHASE_22A_NOTES.md).
--
--   * permissions accounting.* (15 keys), the Accountant, Chief Accountant and Auditor presets, and the extra keys for the
--     Finance Manager (view, ledger, reports, approve) and the CEO (view, reports)
--   * acc_entities (+ acc_entity_branches), acc_fiscal_years, acc_periods: legal entities inside the org, fiscal years
--     (owner decision 13 Oct: July to June by default, configurable per entity) and monthly periods created on demand
--   * acc_accounts: one org-wide tree (Tally's 28 predefined groups, seeded as system groups, and the clinic ledgers),
--     acc_tax_codes, acc_cost_centres, acc_number_series (gap-free numbers allocated at posting)
--   * acc_journals + acc_journal_lines: double entry. A posted journal and its lines never change (trigger, every role);
--     corrections are reversals. Manual journals need a maker and a different checker; automatic postings arrive through
--     acc_post_from_source(), idempotent on (source_kind, source_id, source_version), the contract later slices build on.
--   * tally_guid / tally_alter_id on accounts and journals so the Tally import and the later live sync (22I, 22J) are
--     idempotent.
--
-- Every state change lives in SECURITY DEFINER functions (search_path = '', service role only, jsonb results). The server
-- runs can() first; the database enforces balance, the account rules, the period and month locks, maker / checker, the
-- content hash the checker saw and the numbering. Errors carry a stable code in the HINT (lib/accounting/errors.ts maps
-- it to a sentence). Reports (trial balance, ledger, day book) are aggregated here and returned as jsonb.

-- ---------------------------------------------------------------------------
-- 1. Permissions for existing system roles, and the three accounting presets (new orgs get them from
--    lib/auth/permissions.ts)
-- ---------------------------------------------------------------------------
do $$
declare
  g record;
begin
  for g in
    select * from (values
      ('Finance Manager', 'accounting.view'),
      ('Finance Manager', 'accounting.ledger.view'),
      ('Finance Manager', 'accounting.reports.view'),
      ('Finance Manager', 'accounting.journals.approve'),
      ('CEO', 'accounting.view'),
      ('CEO', 'accounting.reports.view')
    ) as t (role_name, perm)
  loop
    update public.roles r
       set permissions = r.permissions || to_jsonb(g.perm)
     where r.is_system and r.name = g.role_name and not (r.permissions ? g.perm);
  end loop;
end $$;

insert into public.roles (org_id, name, description, permissions, is_system)
select o.id, 'Accountant',
       'Keeps the books: prepares journals, sales, receipts, banking, assets and budgets, and reads the ledger and reports. Cannot post their own journals.',
       '["accounting.view","accounting.ledger.view","accounting.reports.view","accounting.journals.prepare","accounting.sales.manage","accounting.receipts.manage","accounting.banking.manage","accounting.assets.manage","accounting.budgets.manage"]'::jsonb,
       true
from public.orgs o
on conflict (org_id, name) do nothing;

insert into public.roles (org_id, name, description, permissions, is_system)
select o.id, 'Chief Accountant',
       'Everything in Accounting: the chart of accounts, posting journals someone else prepared, periods, tax, settings and the Tally import.',
       '["accounting.view","accounting.ledger.view","accounting.reports.view","accounting.coa.manage","accounting.journals.prepare","accounting.journals.approve","accounting.sales.manage","accounting.receipts.manage","accounting.banking.manage","accounting.assets.manage","accounting.budgets.manage","accounting.periods.manage","accounting.tax.manage","accounting.settings.manage","accounting.import"]'::jsonb,
       true
from public.orgs o
on conflict (org_id, name) do nothing;

insert into public.roles (org_id, name, description, permissions, is_system)
select o.id, 'Auditor',
       'Read-only: the chart of accounts, journals, the general ledger, the day book and the reports.',
       '["accounting.view","accounting.ledger.view","accounting.reports.view"]'::jsonb,
       true
from public.orgs o
on conflict (org_id, name) do nothing;

-- Who may read the accounting reference data (chart, entities, periods, tax codes, cost centres): anyone holding any
-- accounting key. Who may read journals and their lines: the ledger, prepare and approve keys.
create or replace function app.acc_can_view(p_org_id uuid)
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
        'accounting.view', 'accounting.ledger.view', 'accounting.reports.view', 'accounting.coa.manage',
        'accounting.journals.prepare', 'accounting.journals.approve', 'accounting.sales.manage',
        'accounting.receipts.manage', 'accounting.banking.manage', 'accounting.assets.manage', 'accounting.budgets.manage',
        'accounting.periods.manage', 'accounting.tax.manage', 'accounting.settings.manage', 'accounting.import'])
  );
$$;
revoke all on function app.acc_can_view(uuid) from public, anon;
grant execute on function app.acc_can_view(uuid) to authenticated, service_role;

create or replace function app.acc_can_read_journals(p_org_id uuid)
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
        'accounting.ledger.view', 'accounting.journals.prepare', 'accounting.journals.approve'])
  );
$$;
revoke all on function app.acc_can_read_journals(uuid) from public, anon;
grant execute on function app.acc_can_read_journals(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Small pure helpers (escaping, fiscal years, numbers)
-- ---------------------------------------------------------------------------
-- Text in the canonical journal content: backslash, newline, carriage return and the field separator are escaped.
create or replace function app.acc_esc(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select replace(replace(replace(replace(p, E'\\', E'\\\\'), E'\n', E'\\n'), E'\r', E'\\r'), '|', E'\\|');
$$;

-- First day of the fiscal year holding p_date, for a year that starts on the 1st of p_start_month.
create or replace function app.acc_fy_start(p_start_month integer, p_date date)
returns date
language sql
immutable
set search_path = ''
as $$
  select case
    when extract(month from p_date)::integer >= p_start_month
      then make_date(extract(year from p_date)::integer, p_start_month, 1)
    else make_date(extract(year from p_date)::integer - 1, p_start_month, 1)
  end;
$$;

-- The year part of a fiscal year: "2026" for a calendar year, "2026-27" for a year starting in any other month.
create or replace function app.acc_fy_code(p_start date)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when extract(month from p_start)::integer = 1 then extract(year from p_start)::integer::text
    else extract(year from p_start)::integer::text || '-' || lpad(((extract(year from p_start)::integer + 1) % 100)::text, 2, '0')
  end;
$$;

-- JV/2026-27/00001 (lib/accounting/numbering.ts formatJournalNumber builds the same).
create or replace function app.acc_format_number(p_prefix text, p_fy_code text, p_n integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select p_prefix || '/' || p_fy_code || '/' || lpad(p_n::text, greatest(5, char_length(p_n::text)), '0');
$$;

create or replace function app.acc_default_prefix(p_voucher_type text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_voucher_type
    when 'journal' then 'JV' when 'contra' then 'CTR' when 'payment' then 'PMT' when 'receipt' then 'RCT'
    when 'sales' then 'SAL' when 'purchase' then 'PUR' when 'credit_note' then 'CRN' when 'debit_note' then 'DBN'
    when 'opening' then 'OPB' else 'JV' end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Tables
-- ---------------------------------------------------------------------------
create table public.acc_entities (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  trn text check (trn is null or trn ~ '^[0-9A-Z-]{5,20}$'),            -- tax registration number
  base_currency text not null default 'AED' check (base_currency ~ '^[A-Z]{3}$'),
  -- owner decision (13 Oct 2026): the fiscal year runs July to June unless the entity says otherwise (1 = calendar year)
  fiscal_year_start_month integer not null default 7 check (fiscal_year_start_month between 1 and 12),
  is_default boolean not null default false,
  active boolean not null default true,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (active or not is_default)
);
create unique index acc_entities_default_uidx on public.acc_entities (org_id) where is_default;
create unique index acc_entities_name_uidx on public.acc_entities (org_id, lower(btrim(name)));
create trigger acc_entities_set_updated_at before update on public.acc_entities
  for each row execute function app.set_updated_at();

-- Which entity a branch (fin_ref_branches.code) books into. One entity per branch.
create table public.acc_entity_branches (
  org_id uuid not null references public.orgs (id) on delete cascade,
  entity_id uuid not null references public.acc_entities (id) on delete cascade,
  branch_code text not null check (char_length(branch_code) between 1 and 20),
  -- the VAT return (VAT 201 box 1) splits standard-rated supplies by emirate
  emirate text not null default 'Dubai' check (emirate in (
    'Abu Dhabi', 'Dubai', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah')),
  created_at timestamptz not null default now(),
  primary key (org_id, branch_code)
);
create index acc_entity_branches_entity_idx on public.acc_entity_branches (entity_id);
create trigger acc_entity_branches_entity_org_check before insert or update on public.acc_entity_branches
  for each row execute function app.check_parent_org('acc_entities', 'entity_id');

create table public.acc_fiscal_years (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  entity_id uuid not null references public.acc_entities (id),
  start_date date not null check (extract(day from start_date) = 1),
  end_date date not null,
  label text not null check (char_length(label) between 1 and 20),     -- "FY 2026-27" or "FY 2026"
  status text not null default 'open' check (status in ('open', 'closed')),   -- closed by the year-end close (22I)
  created_at timestamptz not null default now(),
  unique (entity_id, start_date),
  check (end_date = (start_date + interval '1 year' - interval '1 day')::date)
);
create index acc_fiscal_years_org_idx on public.acc_fiscal_years (org_id, start_date desc);
create trigger acc_fiscal_years_entity_org_check before insert or update on public.acc_fiscal_years
  for each row execute function app.check_parent_org('acc_entities', 'entity_id');

create table public.acc_periods (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  entity_id uuid not null references public.acc_entities (id),
  fiscal_year_id uuid not null references public.acc_fiscal_years (id),
  year integer not null check (year between 2000 and 2999),
  month integer not null check (month between 1 and 13),             -- 13 = the year's adjustment period
  -- an audit-adjustment period: dated the last day of the fiscal year, postable by accounting.periods.manage only, so
  -- adjustments after the year end do not reopen the last month
  is_adjustment boolean not null default false,
  start_date date not null,
  end_date date not null,
  status text not null default 'open' check (status in ('open', 'closed', 'locked')),
  closed_by uuid references public.profiles (id) on delete set null,
  closed_at timestamptz,
  locked_by uuid references public.profiles (id) on delete set null,
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (entity_id, year, month),
  check (is_adjustment = (month = 13)),
  check (case when is_adjustment then start_date = end_date
              else start_date = make_date(year, least(month, 12), 1)
                   and end_date = (start_date + interval '1 month' - interval '1 day')::date end),
  check (status = 'open' or closed_at is not null),
  check (status <> 'locked' or locked_at is not null)
);
create index acc_periods_org_idx on public.acc_periods (org_id, start_date desc);
create trigger acc_periods_set_updated_at before update on public.acc_periods
  for each row execute function app.set_updated_at();
create trigger acc_periods_entity_org_check before insert or update on public.acc_periods
  for each row execute function app.check_parent_org('acc_entities', 'entity_id');
create trigger acc_periods_fy_org_check before insert or update on public.acc_periods
  for each row execute function app.check_parent_org('acc_fiscal_years', 'fiscal_year_id');

-- The chart of accounts. Org-wide (every entity uses the same chart); entity_id narrows an account to one entity when set.
create table public.acc_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  entity_id uuid references public.acc_entities (id),
  parent_id uuid references public.acc_accounts (id),
  is_group boolean not null default false,
  code text not null check (code ~ '^[A-Z0-9][A-Z0-9._-]{0,19}$'),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  nature text not null check (nature in ('asset', 'liability', 'equity', 'income', 'expense')),
  tally_group text check (tally_group is null or char_length(tally_group) between 1 and 120),
  -- Tally's "affects gross profit" (Direct Incomes / Expenses, Sales / Purchase Accounts): the P&L shows gross profit
  affects_gross_profit boolean not null default false,
  control text check (control is null or control in (
    'receivable', 'payable', 'bank', 'cash', 'vat_output', 'vat_input', 'clearing', 'retained_earnings')),
  is_active boolean not null default true,
  is_system boolean not null default false,
  allow_manual boolean not null default true,
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),       -- null = the entity's base currency
  description text check (description is null or char_length(description) <= 300),
  sort_order integer not null default 100 check (sort_order between 0 and 100000),
  tally_guid text check (tally_guid is null or char_length(tally_guid) between 1 and 100),
  tally_alter_id bigint check (tally_alter_id is null or tally_alter_id >= 0),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, code),
  check (is_group or parent_id is not null),
  check (not is_group or control is null),
  check (not is_group or currency is null)
);
create unique index acc_accounts_name_uidx on public.acc_accounts (org_id, lower(btrim(name)));
create unique index acc_accounts_tally_guid_uidx on public.acc_accounts (org_id, tally_guid) where tally_guid is not null;
create index acc_accounts_parent_idx on public.acc_accounts (parent_id);
create trigger acc_accounts_set_updated_at before update on public.acc_accounts
  for each row execute function app.set_updated_at();

create table public.acc_tax_codes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9_-]{1,12}$'),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  rate numeric(5, 2) not null default 0 check (rate >= 0 and rate <= 100),
  -- blocked: input VAT that may not be recovered (entertainment, some vehicles); it is a cost, not input VAT
  kind text not null check (kind in ('standard', 'zero', 'exempt', 'out_of_scope', 'reverse_charge', 'blocked')),
  output_account_id uuid references public.acc_accounts (id),
  input_account_id uuid references public.acc_accounts (id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, code),
  check ((kind in ('standard', 'reverse_charge', 'blocked')) = (rate > 0))
);
create trigger acc_tax_codes_set_updated_at before update on public.acc_tax_codes
  for each row execute function app.set_updated_at();

create table public.acc_cost_centres (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, code)
);
create trigger acc_cost_centres_set_updated_at before update on public.acc_cost_centres
  for each row execute function app.set_updated_at();

-- One gap-free series per entity, voucher type and fiscal year. Rows are created at the first posting; next_number only
-- ever goes up, under a row lock, in the posting transaction (a rolled-back posting gives its number back).
create table public.acc_number_series (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  entity_id uuid not null references public.acc_entities (id),
  voucher_type text not null check (voucher_type in (
    'journal', 'contra', 'payment', 'receipt', 'sales', 'purchase', 'credit_note', 'debit_note', 'opening')),
  fiscal_year_id uuid not null references public.acc_fiscal_years (id),
  prefix text not null check (prefix ~ '^[A-Z]{1,6}$'),
  next_number integer not null default 1 check (next_number >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (entity_id, voucher_type, fiscal_year_id)
);
create trigger acc_number_series_set_updated_at before update on public.acc_number_series
  for each row execute function app.set_updated_at();
create trigger acc_number_series_entity_org_check before insert or update on public.acc_number_series
  for each row execute function app.check_parent_org('acc_entities', 'entity_id');
create trigger acc_number_series_fy_org_check before insert or update on public.acc_number_series
  for each row execute function app.check_parent_org('acc_fiscal_years', 'fiscal_year_id');

create table public.acc_journals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  entity_id uuid not null references public.acc_entities (id),
  voucher_type text not null default 'journal' check (voucher_type in (
    'journal', 'contra', 'payment', 'receipt', 'sales', 'purchase', 'credit_note', 'debit_note', 'opening')),
  number text check (number is null or char_length(number) between 1 and 40),
  journal_date date not null,
  period_id uuid references public.acc_periods (id),
  fiscal_year_id uuid references public.acc_fiscal_years (id),
  narration text not null check (char_length(btrim(narration)) between 1 and 300),
  -- posted in the fiscal year's adjustment period (dated the year's last day; accounting.periods.manage only)
  is_adjustment boolean not null default false,
  -- an accrual that undoes itself: acc_run_auto_reversals() posts the reversal on this date
  auto_reverse_on date,
  status text not null default 'draft' check (status in ('draft', 'posted', 'reversed')),
  -- null = a manual journal; otherwise the sub-ledger item it comes from (extend the list by migration)
  source_kind text check (source_kind is null or source_kind in (
    'unite_invoice', 'unite_payment', 'supplier_invoice', 'voucher', 'remittance', 'denial', 'revshare_run', 'lab_charge',
    'cashup', 'settlement', 'bank_line', 'opening', 'tally_import', 'fixed_asset', 'depreciation', 'sales_invoice',
    'receipt', 'payroll', 'reversal')),
  source_id text check (source_id is null or char_length(source_id) between 1 and 200),
  source_version integer check (source_version is null or source_version >= 1),
  reversal_of uuid references public.acc_journals (id),
  reversed_by uuid references public.acc_journals (id),
  prepared_by uuid references public.profiles (id) on delete set null,
  submitted_by uuid references public.profiles (id) on delete set null,
  submitted_at timestamptz,
  returned_by uuid references public.profiles (id) on delete set null,
  returned_at timestamptz,
  return_remarks text check (return_remarks is null or char_length(return_remarks) <= 500),
  approved_by uuid references public.profiles (id) on delete set null,     -- the person who posted it; null = the system
  posted_at timestamptz,
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  total numeric(14, 2) not null default 0 check (total >= 0),
  tally_guid text check (tally_guid is null or char_length(tally_guid) between 1 and 100),
  tally_alter_id bigint check (tally_alter_id is null or tally_alter_id >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'draft') = (number is null)),
  check (status = 'draft' or (posted_at is not null and sha256 is not null and period_id is not null and fiscal_year_id is not null)),
  check ((status = 'reversed') = (reversed_by is not null)),
  check ((source_kind is null) = (source_id is null) and (source_kind is null) = (source_version is null)),
  check ((source_kind = 'reversal') = (reversal_of is not null)),
  check (auto_reverse_on is null or auto_reverse_on > journal_date),
  check (auto_reverse_on is null or source_kind is distinct from 'reversal'),
  -- maker / checker for manual journals (null-safe: a removed user's id becomes null)
  check (source_kind is not null or approved_by is null or prepared_by is null or approved_by <> prepared_by),
  check (source_kind is not null or approved_by is null or submitted_by is null or approved_by <> submitted_by)
);
create unique index acc_journals_source_uidx on public.acc_journals (org_id, source_kind, source_id, source_version)
  where source_kind is not null;
-- at most one live (posted) journal per source item: a new version first reverses the old one
create unique index acc_journals_source_live_uidx on public.acc_journals (org_id, source_kind, source_id)
  where source_kind is not null and status = 'posted';
create unique index acc_journals_number_uidx on public.acc_journals (entity_id, number) where number is not null;
create unique index acc_journals_tally_guid_uidx on public.acc_journals (org_id, tally_guid)
  where tally_guid is not null and status in ('draft', 'posted');
create index acc_journals_org_date_idx on public.acc_journals (org_id, journal_date desc);
create index acc_journals_org_status_idx on public.acc_journals (org_id, status, journal_date desc);
create trigger acc_journals_set_updated_at before update on public.acc_journals
  for each row execute function app.set_updated_at();
create trigger acc_journals_entity_org_check before insert or update on public.acc_journals
  for each row execute function app.check_parent_org('acc_entities', 'entity_id');

create table public.acc_journal_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  journal_id uuid not null references public.acc_journals (id) on delete cascade,
  line_no integer not null check (line_no between 1 and 500),
  account_id uuid not null references public.acc_accounts (id),
  debit numeric(14, 2) not null default 0 check (debit >= 0),
  credit numeric(14, 2) not null default 0 check (credit >= 0),
  description text check (description is null or char_length(description) <= 200),
  tax_code_id uuid references public.acc_tax_codes (id),
  -- dimensions (no patient identity, ever)
  branch_code text check (branch_code is null or char_length(branch_code) between 1 and 20),
  department text check (department is null or char_length(department) between 1 and 60),
  doctor_id text check (doctor_id is null or char_length(doctor_id) between 1 and 40),        -- fin_ref_doctors.dha_id
  payer_id text check (payer_id is null or char_length(payer_id) between 1 and 40),          -- fin_ref_payers.payer_id
  supplier_id uuid references public.fin_suppliers (id),
  cost_centre_id uuid references public.acc_cost_centres (id),
  party_kind text check (party_kind is null or party_kind in ('customer', 'supplier', 'payer', 'doctor', 'employee', 'other')),
  party_id text check (party_id is null or char_length(party_id) between 1 and 64),
  -- foreign currency (informative; the base amounts above are authoritative)
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  fx_rate numeric(18, 8) check (fx_rate is null or fx_rate > 0),
  amount_fx numeric(16, 2) check (amount_fx is null or amount_fx >= 0),
  created_at timestamptz not null default now(),
  unique (journal_id, line_no),
  check ((debit > 0) <> (credit > 0)),
  check ((party_kind is null) = (party_id is null)),
  check ((currency is null) = (fx_rate is null) and (currency is null) = (amount_fx is null))
);
create index acc_journal_lines_account_idx on public.acc_journal_lines (account_id, journal_id);
create index acc_journal_lines_org_idx on public.acc_journal_lines (org_id);
create trigger acc_journal_lines_journal_org_check before insert or update on public.acc_journal_lines
  for each row execute function app.check_parent_org('acc_journals', 'journal_id');

-- ---------------------------------------------------------------------------
-- 4. Guards (run for every role, including the service role). A row with no org (the cross-org probe in the security
--    tests) passes through untouched so row level security answers.
-- ---------------------------------------------------------------------------
create or replace function app.acc_entity_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.orgs o where o.id = old.org_id) and old.is_default then
      raise exception 'The default entity cannot be removed.' using errcode = 'check_violation', hint = 'invalid';
    end if;
    return old;
  end if;
  if new.org_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if new.org_id <> old.org_id then
      raise exception 'An entity keeps its organisation.' using errcode = 'check_violation', hint = 'invalid';
    end if;
    if new.fiscal_year_start_month <> old.fiscal_year_start_month
       and exists (select 1 from public.acc_fiscal_years f where f.entity_id = old.id) then
      raise exception 'The fiscal year start cannot change once a fiscal year exists.' using errcode = 'check_violation', hint = 'fy_in_use';
    end if;
    if old.is_default and not new.is_default then
      raise exception 'Make another entity the default instead.' using errcode = 'check_violation', hint = 'invalid';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.acc_entity_guard() from public, anon, authenticated;
create trigger acc_entities_guard before insert or update or delete on public.acc_entities
  for each row execute function app.acc_entity_guard();

-- Fiscal years and periods are never deleted; their dates never change; a locked period stays locked.
create or replace function app.acc_period_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.orgs o where o.id = old.org_id) then
      raise exception 'Fiscal years and periods are never deleted.' using errcode = '42501', hint = 'period_status';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' or new.org_id is null then
    return new;
  end if;
  if tg_table_name = 'acc_fiscal_years' then
    if (new.org_id, new.entity_id, new.start_date, new.end_date) is distinct from (old.org_id, old.entity_id, old.start_date, old.end_date) then
      raise exception 'A fiscal year keeps its dates.' using errcode = '42501', hint = 'period_status';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - array['closed_by', 'locked_by', 'updated_at']) = (to_jsonb(old) - array['closed_by', 'locked_by', 'updated_at']) then
    return new;   -- a removed user's id nulled by the FK action
  end if;
  if (new.org_id, new.entity_id, new.fiscal_year_id, new.year, new.month, new.is_adjustment, new.start_date, new.end_date)
     is distinct from (old.org_id, old.entity_id, old.fiscal_year_id, old.year, old.month, old.is_adjustment, old.start_date, old.end_date) then
    raise exception 'A period keeps its dates.' using errcode = '42501', hint = 'period_status';
  end if;
  if old.status = 'locked' then
    raise exception 'A locked period stays locked.' using errcode = '42501', hint = 'period_locked';
  end if;
  return new;
end;
$$;
revoke all on function app.acc_period_guard() from public, anon, authenticated;
create trigger acc_fiscal_years_guard before insert or update or delete on public.acc_fiscal_years
  for each row execute function app.acc_period_guard();
create trigger acc_periods_guard before insert or update or delete on public.acc_periods
  for each row execute function app.acc_period_guard();

-- The account tree: same org, parents are groups, the nature comes from the parent and must match it, no cycles, Tally
-- group inherited; system groups keep their place, nature and Tally name; an account with lines keeps its nature and
-- stays a ledger, and is never deleted (deactivate it instead).
create or replace function app.acc_account_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.acc_accounts;
  v_cur uuid;
  v_depth integer := 0;
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.orgs o where o.id = old.org_id) then
      return old;
    end if;
    if old.is_system then
      raise exception 'A system group cannot be deleted.' using errcode = 'check_violation', hint = 'system_group';
    end if;
    if exists (select 1 from public.acc_journal_lines l where l.account_id = old.id) then
      raise exception 'This account has journal lines; deactivate it instead.' using errcode = 'check_violation', hint = 'has_lines';
    end if;
    if exists (select 1 from public.acc_accounts c where c.parent_id = old.id) then
      raise exception 'This group still holds accounts.' using errcode = 'check_violation', hint = 'has_children';
    end if;
    return old;
  end if;
  if new.org_id is null or new.code is null then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if (to_jsonb(new) - array['created_by', 'updated_at']) = (to_jsonb(old) - array['created_by', 'updated_at']) then
      return new;
    end if;
    if new.org_id <> old.org_id then
      raise exception 'An account keeps its organisation.' using errcode = 'check_violation', hint = 'invalid';
    end if;
    if new.is_system <> old.is_system
       or (old.is_system and (new.code, new.is_group, new.parent_id, new.nature, new.tally_group, new.affects_gross_profit)
                             is distinct from (old.code, old.is_group, old.parent_id, old.nature, old.tally_group, old.affects_gross_profit)) then
      raise exception 'A system group keeps its code, place, nature and Tally group.' using errcode = 'check_violation', hint = 'system_group';
    end if;
  elsif new.is_system and coalesce(current_setting('app.acc_seeding', true), '') <> 'on' then
    raise exception 'System groups are created by the chart seed only.' using errcode = 'check_violation', hint = 'system_group';
  end if;
  if new.parent_id is not null then
    select * into p from public.acc_accounts where id = new.parent_id;
    if not found or p.org_id <> new.org_id or not p.is_group then
      raise exception 'Choose a group as the parent.' using errcode = 'check_violation', hint = 'parent_not_group';
    end if;
    if new.nature is null then
      new.nature := p.nature;
    elsif new.nature <> p.nature then
      raise exception 'An account has the nature of its group.' using errcode = 'check_violation', hint = 'nature_mismatch';
    end if;
    if new.tally_group is null then
      new.tally_group := p.tally_group;
    end if;
    new.affects_gross_profit := p.affects_gross_profit;   -- always the group's
    if tg_op = 'UPDATE' then
      v_cur := p.id;
      while v_cur is not null and v_depth < 64 loop
        if v_cur = new.id then
          raise exception 'A group cannot sit inside itself.' using errcode = 'check_violation', hint = 'cycle';
        end if;
        select a.parent_id into v_cur from public.acc_accounts a where a.id = v_cur;
        v_depth := v_depth + 1;
      end loop;
    end if;
  end if;
  if new.entity_id is not null
     and not exists (select 1 from public.acc_entities e where e.id = new.entity_id and e.org_id = new.org_id) then
    raise exception 'Entity not found.' using errcode = 'check_violation', hint = 'entity_unknown';
  end if;
  if tg_op = 'UPDATE' then
    if (new.is_group <> old.is_group or new.nature <> old.nature)
       and exists (select 1 from public.acc_journal_lines l where l.account_id = old.id) then
      raise exception 'This account has journal lines; its nature and type cannot change.' using errcode = 'check_violation', hint = 'has_lines';
    end if;
    if (new.nature <> old.nature or (old.is_group and not new.is_group) or new.affects_gross_profit <> old.affects_gross_profit)
       and exists (select 1 from public.acc_accounts c where c.parent_id = old.id) then
      raise exception 'This group still holds accounts.' using errcode = 'check_violation', hint = 'has_children';
    end if;
    if new.entity_id is not null and new.entity_id is distinct from old.entity_id and exists (
      select 1 from public.acc_journal_lines l join public.acc_journals j on j.id = l.journal_id
      where l.account_id = old.id and j.entity_id <> new.entity_id) then
      raise exception 'Another entity already posted to this account.' using errcode = 'check_violation', hint = 'account_entity';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.acc_account_guard() from public, anon, authenticated;
create trigger acc_accounts_guard before insert or update or delete on public.acc_accounts
  for each row execute function app.acc_account_guard();

-- Tax codes point at ledgers (not groups) of the same org.
create or replace function app.acc_tax_code_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.org_id is null then
    return new;
  end if;
  if (new.output_account_id is not null and not exists (
        select 1 from public.acc_accounts a where a.id = new.output_account_id and a.org_id = new.org_id and not a.is_group))
     or (new.input_account_id is not null and not exists (
        select 1 from public.acc_accounts a where a.id = new.input_account_id and a.org_id = new.org_id and not a.is_group)) then
    raise exception 'Choose a ledger account of this organisation.' using errcode = 'check_violation', hint = 'account_not_found';
  end if;
  return new;
end;
$$;
revoke all on function app.acc_tax_code_guard() from public, anon, authenticated;
create trigger acc_tax_codes_guard before insert or update on public.acc_tax_codes
  for each row execute function app.acc_tax_code_guard();

-- Number series: never deleted, the next number only goes up, the prefix changes only before the first number.
create or replace function app.acc_series_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.orgs o where o.id = old.org_id) then
      raise exception 'Number series are never deleted.' using errcode = '42501', hint = 'invalid';
    end if;
    return old;
  end if;
  if new.next_number < old.next_number
     or (new.org_id, new.entity_id, new.voucher_type, new.fiscal_year_id) is distinct from (old.org_id, old.entity_id, old.voucher_type, old.fiscal_year_id)
     or (new.prefix <> old.prefix and old.next_number > 1) then
    raise exception 'A number series only moves forward.' using errcode = '42501', hint = 'invalid';
  end if;
  return new;
end;
$$;
revoke all on function app.acc_series_guard() from public, anon, authenticated;
create trigger acc_number_series_guard before update or delete on public.acc_number_series
  for each row execute function app.acc_series_guard();

-- Journals: a journal starts as a draft; a draft becomes posted only inside the posting function (app.acc_post_ctx names
-- it); a posted journal never changes except posted -> reversed (with reversed_by) inside the reversal function; posted
-- and reversed journals are never deleted.
create or replace function app.acc_journal_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ctx text := coalesce(current_setting('app.acc_post_ctx', true), '');
  v_users text[] := array['prepared_by', 'submitted_by', 'returned_by', 'approved_by', 'updated_at'];
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' and exists (select 1 from public.orgs o where o.id = old.org_id) then
      raise exception 'A posted journal is never deleted; reverse it instead.' using errcode = '42501', hint = 'posted_immutable';
    end if;
    return old;
  end if;
  if new.org_id is null or new.entity_id is null then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'draft' or new.number is not null or new.sha256 is not null or new.posted_at is not null
       or new.reversed_by is not null then
      raise exception 'A journal starts as a draft and is posted by acc_post_journal.' using errcode = '42501', hint = 'posted_immutable';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - v_users) = (to_jsonb(old) - v_users) then
    return new;   -- a removed user's id nulled by the FK action
  end if;
  if new.org_id <> old.org_id then
    raise exception 'A journal keeps its organisation.' using errcode = '42501', hint = 'posted_immutable';
  end if;
  if old.status = 'draft' then
    if new.status = 'draft' and new.number is null and new.sha256 is null and new.posted_at is null then
      return new;
    end if;
    if new.status = 'posted' and v_ctx = new.id::text then
      return new;
    end if;
    raise exception 'Journals are posted only by acc_post_journal.' using errcode = '42501', hint = 'posted_immutable';
  end if;
  if old.status = 'posted' and new.status = 'reversed' and new.reversed_by is not null and v_ctx = 'reverse:' || old.id::text
     and (to_jsonb(new) - (v_users || array['status', 'reversed_by'])) = (to_jsonb(old) - (v_users || array['status', 'reversed_by'])) then
    return new;
  end if;
  raise exception 'A posted journal cannot change; reverse it instead.' using errcode = '42501', hint = 'posted_immutable';
end;
$$;
revoke all on function app.acc_journal_guard() from public, anon, authenticated;
create trigger acc_journals_guard before insert or update or delete on public.acc_journals
  for each row execute function app.acc_journal_guard();

-- Lines change only while their journal is a draft, and belong to the journal's org.
create or replace function app.acc_line_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_org uuid;
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.orgs o where o.id = old.org_id) then
      return old;
    end if;
    select j.status into v_status from public.acc_journals j where j.id = old.journal_id;
    if found and v_status <> 'draft' then
      raise exception 'The lines of a posted journal cannot change.' using errcode = '42501', hint = 'posted_immutable';
    end if;
    return old;
  end if;
  if new.journal_id is null or new.org_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    select j.status into v_status from public.acc_journals j where j.id = old.journal_id;
    if found and v_status <> 'draft' then
      raise exception 'The lines of a posted journal cannot change.' using errcode = '42501', hint = 'posted_immutable';
    end if;
  end if;
  select j.status, j.org_id into v_status, v_org from public.acc_journals j where j.id = new.journal_id;
  if found then
    if v_status <> 'draft' then
      raise exception 'The lines of a posted journal cannot change.' using errcode = '42501', hint = 'posted_immutable';
    end if;
    if v_org <> new.org_id then
      raise exception 'A line belongs to its journal''s organisation.' using errcode = 'check_violation', hint = 'invalid';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.acc_line_guard() from public, anon, authenticated;
create trigger acc_journal_lines_guard before insert or update or delete on public.acc_journal_lines
  for each row execute function app.acc_line_guard();

-- ---------------------------------------------------------------------------
-- 5. Row level security: staff with an accounting key read; every write is a server action or a service-role function
--    after can()
-- ---------------------------------------------------------------------------
alter table public.acc_entities enable row level security;
alter table public.acc_entity_branches enable row level security;
alter table public.acc_fiscal_years enable row level security;
alter table public.acc_periods enable row level security;
alter table public.acc_accounts enable row level security;
alter table public.acc_tax_codes enable row level security;
alter table public.acc_cost_centres enable row level security;
alter table public.acc_number_series enable row level security;
alter table public.acc_journals enable row level security;
alter table public.acc_journal_lines enable row level security;

create policy acc_entities_select on public.acc_entities for select to authenticated using (app.acc_can_view(org_id));
create policy acc_entity_branches_select on public.acc_entity_branches for select to authenticated using (app.acc_can_view(org_id));
create policy acc_fiscal_years_select on public.acc_fiscal_years for select to authenticated using (app.acc_can_view(org_id));
create policy acc_periods_select on public.acc_periods for select to authenticated using (app.acc_can_view(org_id));
create policy acc_accounts_select on public.acc_accounts for select to authenticated using (app.acc_can_view(org_id));
create policy acc_tax_codes_select on public.acc_tax_codes for select to authenticated using (app.acc_can_view(org_id));
create policy acc_cost_centres_select on public.acc_cost_centres for select to authenticated using (app.acc_can_view(org_id));
create policy acc_number_series_select on public.acc_number_series for select to authenticated using (app.acc_can_view(org_id));
create policy acc_journals_select on public.acc_journals for select to authenticated using (app.acc_can_read_journals(org_id));
create policy acc_journal_lines_select on public.acc_journal_lines for select to authenticated using (app.acc_can_read_journals(org_id));

-- ---------------------------------------------------------------------------
-- 6. The default chart (Tally-compatible groups and a UAE clinic ledger set), idempotent; run for every org
-- ---------------------------------------------------------------------------
create or replace function app.acc_seed_account(
  p_org_id uuid, p_code text, p_name text, p_parent_code text, p_is_group boolean, p_nature text, p_control text,
  p_tally_group text, p_is_system boolean, p_sort integer, p_gross boolean default false
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent uuid;
  v_n integer;
begin
  if p_parent_code is not null then
    select a.id into v_parent from public.acc_accounts a where a.org_id = p_org_id and a.code = p_parent_code and a.is_group;
    if v_parent is null then
      return 0;    -- the parent was renamed away or removed by the clinic: leave this branch of the tree alone
    end if;
  end if;
  insert into public.acc_accounts (org_id, parent_id, is_group, code, name, nature, tally_group, control, is_system, sort_order,
                                   affects_gross_profit)
  values (p_org_id, v_parent, p_is_group, p_code, p_name, p_nature, p_tally_group, p_control, p_is_system, p_sort, p_gross)
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function app.acc_seed_account(uuid, text, text, text, boolean, text, text, text, boolean, integer, boolean)
  from public, anon, authenticated;

create or replace function public.acc_seed_chart(p_org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entity uuid;
  v_name text;
  v_accounts integer := 0;
  v_tax integer := 0;
  v_branches integer := 0;
  v_n integer;
  b record;
  g record;
begin
  if not exists (select 1 from public.orgs o where o.id = p_org_id) then
    raise exception 'Organisation not found.' using errcode = 'no_data_found', hint = 'not_found';
  end if;
  perform set_config('app.acc_seeding', 'on', true);

  -- one default entity (owner decision: Al Das is one legal entity; the fiscal year starts in July)
  select e.id into v_entity from public.acc_entities e where e.org_id = p_org_id and e.is_default;
  if v_entity is null then
    select left(btrim(o.name), 120) into v_name from public.orgs o where o.id = p_org_id;
    insert into public.acc_entities (org_id, name, fiscal_year_start_month, is_default)
    values (p_org_id, coalesce(nullif(v_name, ''), 'Main entity'), 7, true)
    on conflict do nothing
    returning id into v_entity;
    if v_entity is null then   -- an entity with the org's name exists but is not the default: make it the default
      update public.acc_entities e set is_default = true, active = true
       where e.id = (select x.id from public.acc_entities x where x.org_id = p_org_id order by x.created_at limit 1)
      returning e.id into v_entity;
    end if;
  end if;

  insert into public.acc_entity_branches (org_id, entity_id, branch_code)
  select p_org_id, v_entity, br.code from public.fin_ref_branches br where br.org_id = p_org_id
  on conflict do nothing;
  get diagnostics v_branches = row_count;

  -- Tally's predefined groups: 15 primary, then the sub-groups under them (lib/accounting/tally-groups.ts holds the same list)
  for g in
    select * from (values
      ('G-CAP',   'Capital Account',          null,     'equity',    10),
      ('G-CA',    'Current Assets',           null,     'asset',     20),
      ('G-CL',    'Current Liabilities',      null,     'liability', 30),
      ('G-DEXP',  'Direct Expenses',          null,     'expense',   40),
      ('G-DINC',  'Direct Incomes',           null,     'income',    50),
      ('G-FA',    'Fixed Assets',             null,     'asset',     60),
      ('G-IEXP',  'Indirect Expenses',        null,     'expense',   70),
      ('G-IINC',  'Indirect Incomes',         null,     'income',    80),
      ('G-INV',   'Investments',              null,     'asset',     90),
      ('G-LOAN',  'Loans (Liability)',        null,     'liability', 100),
      ('G-MISC',  'Misc. Expenses (ASSET)',   null,     'asset',     110),
      ('G-PUR',   'Purchase Accounts',        null,     'expense',   120),
      ('G-SAL',   'Sales Accounts',           null,     'income',    130),
      ('G-SUSP',  'Suspense A/c',             null,     'liability', 140),
      ('G-BR',    'Branch / Divisions',       null,     'liability', 150),
      ('G-BANK',  'Bank Accounts',            'G-CA',   'asset',     210),
      ('G-BOD',   'Bank OD A/c',              'G-LOAN', 'liability', 220),
      ('G-CASH',  'Cash-in-Hand',             'G-CA',   'asset',     230),
      ('G-DEP',   'Deposits (Asset)',         'G-CA',   'asset',     240),
      ('G-TAX',   'Duties & Taxes',           'G-CL',   'liability', 250),
      ('G-ADV',   'Loans & Advances (Asset)', 'G-CA',   'asset',     260),
      ('G-PROV',  'Provisions',               'G-CL',   'liability', 270),
      ('G-RES',   'Reserves & Surplus',       'G-CAP',  'equity',    280),
      ('G-SECL',  'Secured Loans',            'G-LOAN', 'liability', 290),
      ('G-STOCK', 'Stock-in-Hand',            'G-CA',   'asset',     300),
      ('G-CRED',  'Sundry Creditors',         'G-CL',   'liability', 310),
      ('G-DEBT',  'Sundry Debtors',           'G-CA',   'asset',     320),
      ('G-UNSL',  'Unsecured Loans',          'G-LOAN', 'liability', 330)
    ) as t (code, name, parent, nature, sort)
  loop
    v_accounts := v_accounts + app.acc_seed_account(p_org_id, g.code, g.name, g.parent, true, g.nature, null, g.name, true, g.sort,
                                                    g.code in ('G-DEXP', 'G-DINC', 'G-PUR', 'G-SAL'));
  end loop;

  -- the clinic's ledgers (editable: rename, move within the same nature, deactivate)
  for g in
    select * from (values
      ('3000', 'Share capital',                       'G-CAP',   'equity',    null),
      ('3100', 'Retained earnings',                   'G-RES',   'equity',    'retained_earnings'),
      ('1150', 'Bank - current account',              'G-BANK',  'asset',     'bank'),
      ('1200', 'Insurance receivable',                'G-DEBT',  'asset',     'receivable'),
      ('1210', 'Patient receivable',                  'G-DEBT',  'asset',     'receivable'),
      ('1300', 'Card settlement clearing',            'G-CA',    'asset',     'clearing'),
      ('1310', 'Tabby clearing',                      'G-CA',    'asset',     'clearing'),
      ('1320', 'EPG clearing',                        'G-CA',    'asset',     'clearing'),
      ('1400', 'Prepayments and advances',            'G-ADV',   'asset',     null),
      ('1410', 'Security deposits',                   'G-DEP',   'asset',     null),
      ('1500', 'Medical equipment',                   'G-FA',    'asset',     null),
      ('1510', 'Furniture and fittings',              'G-FA',    'asset',     null),
      ('1590', 'Accumulated depreciation',            'G-FA',    'asset',     null),
      ('2100', 'Supplier payables',                   'G-CRED',  'liability', 'payable'),
      ('2110', 'Doctor revenue-share payable',        'G-CRED',  'liability', 'payable'),
      ('2200', 'VAT output 5%',                       'G-TAX',   'liability', 'vat_output'),
      ('2210', 'VAT input',                           'G-TAX',   'liability', 'vat_input'),
      ('2300', 'Accrued expenses',                    'G-PROV',  'liability', null),
      ('4100', 'Consultation revenue',                'G-SAL',   'income',    null),
      ('4110', 'Procedure revenue',                   'G-SAL',   'income',    null),
      ('4120', 'Laboratory revenue',                  'G-SAL',   'income',    null),
      ('4130', 'Pharmacy revenue',                    'G-SAL',   'income',    null),
      ('4190', 'Other medical revenue',               'G-SAL',   'income',    null),
      ('4900', 'Other income',                        'G-IINC',  'income',    null),
      ('5100', 'Lab and referral costs',              'G-DEXP',  'expense',   null),
      ('5110', 'Doctor revenue share',                'G-DEXP',  'expense',   null),
      ('5120', 'Medical consumables',                 'G-DEXP',  'expense',   null),
      ('6100', 'Salaries and wages',                  'G-IEXP',  'expense',   null),
      ('6200', 'Rent',                                'G-IEXP',  'expense',   null),
      ('6300', 'Utilities',                           'G-IEXP',  'expense',   null),
      ('6400', 'Depreciation',                        'G-IEXP',  'expense',   null),
      ('6500', 'Bank and card charges',               'G-IEXP',  'expense',   null),
      ('6600', 'Discounts allowed',                   'G-IEXP',  'expense',   null),
      ('6610', 'Bad debts written off',               'G-IEXP',  'expense',   null),
      ('6900', 'Rounding off',                        'G-IEXP',  'expense',   null),
      ('9000', 'Suspense',                            'G-SUSP',  'liability', null),
      ('9100', 'Opening balance difference',          'G-SUSP',  'liability', null)
    ) as t (code, name, parent, nature, control)
  loop
    v_accounts := v_accounts + app.acc_seed_account(p_org_id, g.code, g.name, g.parent, false, g.nature, g.control, null, false, 100);
  end loop;

  -- cash per branch (or one cash ledger when there are no branches)
  if exists (select 1 from public.fin_ref_branches br where br.org_id = p_org_id) then
    for b in select br.code, br.name from public.fin_ref_branches br where br.org_id = p_org_id order by br.code loop
      v_accounts := v_accounts + app.acc_seed_account(p_org_id, '1100-' || b.code, left('Cash - ' || coalesce(nullif(btrim(b.name), ''), b.code), 120),
                                                      'G-CASH', false, 'asset', 'cash', null, false, 100);
    end loop;
  else
    v_accounts := v_accounts + app.acc_seed_account(p_org_id, '1100', 'Cash in hand', 'G-CASH', false, 'asset', 'cash', null, false, 100);
  end if;

  -- UAE VAT codes (which service is which is the tax adviser's call, OQ-120)
  -- reverse charge books both sides (output and input VAT); blocked VAT is part of the cost, so it has no VAT account
  insert into public.acc_tax_codes (org_id, code, name, rate, kind, output_account_id, input_account_id)
  select p_org_id, t.code, t.name, t.rate, t.kind,
         case when t.vat then (select a.id from public.acc_accounts a where a.org_id = p_org_id and a.code = '2200' and not a.is_group) end,
         case when t.vat then (select a.id from public.acc_accounts a where a.org_id = p_org_id and a.code = '2210' and not a.is_group) end
  from (values
    ('VAT5', 'VAT standard rate 5%',  5.00, 'standard',       true),
    ('ZR',   'Zero-rated 0%',         0.00, 'zero',           false),
    ('EX',   'Exempt',                0.00, 'exempt',         false),
    ('OOS',  'Out of scope',          0.00, 'out_of_scope',   false),
    ('RC5',  'Reverse charge 5%',     5.00, 'reverse_charge', true),
    ('BLK5', 'Blocked input VAT 5%',  5.00, 'blocked',        false)
  ) as t (code, name, rate, kind, vat)
  on conflict do nothing;
  get diagnostics v_n = row_count;
  v_tax := v_n;

  perform set_config('app.acc_seeding', '', true);
  return jsonb_build_object('entity_id', v_entity, 'accounts_added', v_accounts, 'tax_codes_added', v_tax,
                            'branches_mapped', v_branches);
end;
$$;
revoke all on function public.acc_seed_chart(uuid) from public, anon, authenticated;
grant execute on function public.acc_seed_chart(uuid) to service_role;

-- New workspaces get the chart after the finance reference seed (triggers on the same event fire in name order, so this
-- one runs after orgs_seed_finance, which seeds the branches).
create or replace function app.acc_seed_on_org_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.acc_seed_chart(new.id);
  return new;
end;
$$;
revoke all on function app.acc_seed_on_org_insert() from public, anon, authenticated;
create trigger orgs_seed_finance_phase22 after insert on public.orgs
  for each row execute function app.acc_seed_on_org_insert();

-- A branch added later books into the default entity and gets its cash ledger (only once the chart exists).
create or replace function app.acc_seed_on_branch_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.acc_entities e where e.org_id = new.org_id and e.is_default) then
    perform public.acc_seed_chart(new.org_id);
  end if;
  return new;
end;
$$;
revoke all on function app.acc_seed_on_branch_insert() from public, anon, authenticated;
create trigger fin_ref_branches_acc_seed after insert on public.fin_ref_branches
  for each row execute function app.acc_seed_on_branch_insert();

-- ---------------------------------------------------------------------------
-- 7. Fiscal years and periods (created on demand for a date)
-- ---------------------------------------------------------------------------
create or replace function public.acc_ensure_period(p_org_id uuid, p_entity_id uuid, p_date date)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  e public.acc_entities;
  v_start date;
  v_fy uuid;
  v_period uuid;
begin
  select * into e from public.acc_entities where id = p_entity_id and org_id = p_org_id;
  if not found then
    raise exception 'Entity not found.' using errcode = 'check_violation', hint = 'entity_unknown';
  end if;
  if p_date is null or p_date < date '2000-01-01' or p_date > date '2999-12-01' then
    raise exception 'Enter a valid date.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  v_start := app.acc_fy_start(e.fiscal_year_start_month, p_date);
  insert into public.acc_fiscal_years (org_id, entity_id, start_date, end_date, label)
  values (p_org_id, e.id, v_start, (v_start + interval '1 year' - interval '1 day')::date, 'FY ' || app.acc_fy_code(v_start))
  on conflict (entity_id, start_date) do nothing;
  select f.id into v_fy from public.acc_fiscal_years f where f.entity_id = e.id and f.start_date = v_start;
  insert into public.acc_periods (org_id, entity_id, fiscal_year_id, year, month, start_date, end_date)
  values (p_org_id, e.id, v_fy, extract(year from p_date)::integer, extract(month from p_date)::integer,
          date_trunc('month', p_date)::date, (date_trunc('month', p_date) + interval '1 month' - interval '1 day')::date)
  on conflict (entity_id, year, month) do nothing;
  select p.id into v_period from public.acc_periods p
   where p.entity_id = e.id and p.year = extract(year from p_date)::integer and p.month = extract(month from p_date)::integer;
  return v_period;
end;
$$;
revoke all on function public.acc_ensure_period(uuid, uuid, date) from public, anon, authenticated;
grant execute on function public.acc_ensure_period(uuid, uuid, date) to service_role;

-- open <-> closed by accounting.periods.manage; closed -> locked is final (refused for everyone afterwards).
create or replace function public.acc_set_period_status(p_org_id uuid, p_period_id uuid, p_user_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.acc_periods;
begin
  if not app.user_has_perm(p_org_id, p_user_id, 'accounting.periods.manage') then
    raise exception 'You cannot open, close or lock periods.' using errcode = 'check_violation', hint = 'not_permitted';
  end if;
  select * into p from public.acc_periods where id = p_period_id and org_id = p_org_id for update;
  if not found then
    raise exception 'Period not found.' using errcode = 'no_data_found', hint = 'not_found';
  end if;
  if p.status = 'locked' then
    raise exception 'A locked period stays locked.' using errcode = 'check_violation', hint = 'period_locked';
  end if;
  if p_status = 'closed' and p.status = 'open' then
    update public.acc_periods set status = 'closed', closed_by = p_user_id, closed_at = now() where id = p.id;
  elsif p_status = 'open' and p.status = 'closed' then
    update public.acc_periods set status = 'open', closed_by = null, closed_at = null where id = p.id;
  elsif p_status = 'locked' and p.status = 'closed' then
    update public.acc_periods set status = 'locked', locked_by = p_user_id, locked_at = now() where id = p.id;
  else
    raise exception 'That change is not possible (close a period before locking it).' using errcode = 'check_violation', hint = 'period_status';
  end if;
  return jsonb_build_object('id', p.id, 'from', p.status, 'to', p_status, 'year', p.year, 'month', p.month);
end;
$$;
revoke all on function public.acc_set_period_status(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.acc_set_period_status(uuid, uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 8. Content hash: the journal's header and every line (lib/accounting/canonical.ts journalCanonical() builds the same
--    text; a database test proves they agree). The number is not part of it (it is allocated at posting), so the hash
--    the checker approves is the hash frozen on the posted journal.
-- ---------------------------------------------------------------------------
create or replace function public.acc_journal_canonical(p_journal_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select concat_ws(E'\n',
    'pulse-journal-v1',
    'org:' || j.org_id::text,
    'entity:' || j.entity_id::text,
    'type:' || j.voucher_type,
    'date:' || to_char(j.journal_date, 'YYYY-MM-DD'),
    'narration:' || app.acc_esc(j.narration),
    'source:' || coalesce(j.source_kind, '-') || '/' || coalesce(app.acc_esc(j.source_id), '-') || '/'
              || coalesce(j.source_version::text, '-'),
    'reversal_of:' || coalesce(j.reversal_of::text, '-'),
    'adjustment:' || case when j.is_adjustment then 'yes' else 'no' end,
    'auto_reverse_on:' || coalesce(to_char(j.auto_reverse_on, 'YYYY-MM-DD'), '-'),
    'lines:' || (select count(*) from public.acc_journal_lines l where l.journal_id = j.id)::text,
    coalesce((
      select string_agg(concat_ws('|', 'L', l.line_no::text, l.account_id::text, l.debit::text, l.credit::text,
                                  coalesce(l.tax_code_id::text, '-'), coalesce(app.acc_esc(l.branch_code), '-'),
                                  coalesce(app.acc_esc(l.department), '-'), coalesce(app.acc_esc(l.doctor_id), '-'),
                                  coalesce(app.acc_esc(l.payer_id), '-'), coalesce(l.supplier_id::text, '-'),
                                  coalesce(l.cost_centre_id::text, '-'), coalesce(l.party_kind, '-'),
                                  coalesce(app.acc_esc(l.party_id), '-'), coalesce(l.currency, '-'),
                                  coalesce(l.fx_rate::text, '-'), coalesce(l.amount_fx::text, '-'),
                                  coalesce(app.acc_esc(l.description), '-')),
                        E'\n' order by l.line_no)
      from public.acc_journal_lines l where l.journal_id = j.id), ''))
  from public.acc_journals j
  where j.id = p_journal_id;
$$;
revoke all on function public.acc_journal_canonical(uuid) from public, anon, authenticated;
grant execute on function public.acc_journal_canonical(uuid) to service_role;

create or replace function public.acc_journal_compute_hash(p_journal_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select encode(sha256(convert_to(public.acc_journal_canonical(p_journal_id), 'UTF8')), 'hex');
$$;
revoke all on function public.acc_journal_compute_hash(uuid) from public, anon, authenticated;
grant execute on function public.acc_journal_compute_hash(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 9. Lines, validation and posting (internal helpers in app, the API in public)
-- ---------------------------------------------------------------------------
-- Writes a journal's lines from jsonb (the shape is documented in docs/22_PHASE_22A_NOTES.md). Line numbers follow the
-- array order. Amounts must already be rounded to 2 decimals; exactly one of debit / credit is above zero.
create or replace function app.acc_write_lines(p_org_id uuid, p_journal_id uuid, p_lines jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  it jsonb;
  v_no bigint;
  v_account uuid;
  v_tax uuid;
  v_cc uuid;
  v_supplier uuid;
  v_debit numeric;
  v_credit numeric;
  v_hint text;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'The lines are missing.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  if jsonb_array_length(p_lines) > 500 then
    raise exception 'A journal has at most 500 lines.' using errcode = 'check_violation', hint = 'too_many_lines';
  end if;
  for it, v_no in select x.value, x.ordinality from jsonb_array_elements(p_lines) with ordinality as x loop
    begin
      if jsonb_typeof(it) <> 'object' then
        raise exception 'bad line' using errcode = 'invalid_text_representation';
      end if;
      v_account := null; v_tax := null; v_cc := null; v_supplier := null;
      if nullif(it ->> 'account_id', '') is not null then
        select a.id into v_account from public.acc_accounts a where a.id = (it ->> 'account_id')::uuid and a.org_id = p_org_id;
      elsif nullif(it ->> 'account_code', '') is not null then
        select a.id into v_account from public.acc_accounts a where a.org_id = p_org_id and a.code = upper(btrim(it ->> 'account_code'));
      end if;
      if v_account is null then
        raise exception 'Line %: the account was not found.', v_no using errcode = 'check_violation', hint = 'account_not_found';
      end if;
      v_debit := coalesce(nullif(it ->> 'debit', '')::numeric, 0);
      v_credit := coalesce(nullif(it ->> 'credit', '')::numeric, 0);
      if v_debit < 0 or v_credit < 0 or round(v_debit, 2) <> v_debit or round(v_credit, 2) <> v_credit
         or v_debit >= 1e12 or v_credit >= 1e12 then
        raise exception 'Line %: amounts are positive with at most two decimals.', v_no using errcode = 'check_violation', hint = 'bad_amount';
      end if;
      if (v_debit > 0) = (v_credit > 0) then
        raise exception 'Line %: enter either a debit or a credit.', v_no using errcode = 'check_violation', hint = 'one_sided';
      end if;
      if nullif(it ->> 'tax_code_id', '') is not null then
        select t.id into v_tax from public.acc_tax_codes t where t.id = (it ->> 'tax_code_id')::uuid and t.org_id = p_org_id;
        if v_tax is null then
          raise exception 'Line %: tax code not found.', v_no using errcode = 'check_violation', hint = 'tax_code';
        end if;
      elsif nullif(it ->> 'tax_code', '') is not null then
        select t.id into v_tax from public.acc_tax_codes t where t.org_id = p_org_id and t.code = upper(btrim(it ->> 'tax_code'));
        if v_tax is null then
          raise exception 'Line %: tax code not found.', v_no using errcode = 'check_violation', hint = 'tax_code';
        end if;
      end if;
      if nullif(it ->> 'cost_centre_id', '') is not null then
        select c.id into v_cc from public.acc_cost_centres c where c.id = (it ->> 'cost_centre_id')::uuid and c.org_id = p_org_id;
        if v_cc is null then
          raise exception 'Line %: cost centre not found.', v_no using errcode = 'check_violation', hint = 'cost_centre';
        end if;
      elsif nullif(it ->> 'cost_centre', '') is not null then
        select c.id into v_cc from public.acc_cost_centres c where c.org_id = p_org_id and c.code = upper(btrim(it ->> 'cost_centre'));
        if v_cc is null then
          raise exception 'Line %: cost centre not found.', v_no using errcode = 'check_violation', hint = 'cost_centre';
        end if;
      end if;
      if nullif(it ->> 'supplier_id', '') is not null then
        select s.id into v_supplier from public.fin_suppliers s where s.id = (it ->> 'supplier_id')::uuid and s.org_id = p_org_id;
        if v_supplier is null then
          raise exception 'Line %: supplier not found.', v_no using errcode = 'check_violation', hint = 'supplier_unknown';
        end if;
      end if;
      insert into public.acc_journal_lines (
        org_id, journal_id, line_no, account_id, debit, credit, description, tax_code_id, branch_code, department, doctor_id,
        payer_id, supplier_id, cost_centre_id, party_kind, party_id, currency, fx_rate, amount_fx)
      values (
        p_org_id, p_journal_id, v_no::integer, v_account, v_debit, v_credit,
        nullif(btrim(coalesce(it ->> 'description', '')), ''),
        v_tax,
        nullif(upper(btrim(coalesce(it ->> 'branch_code', ''))), ''),
        nullif(btrim(coalesce(it ->> 'department', '')), ''),
        nullif(btrim(coalesce(it ->> 'doctor_id', '')), ''),
        nullif(btrim(coalesce(it ->> 'payer_id', '')), ''),
        v_supplier, v_cc,
        nullif(it ->> 'party_kind', ''),
        nullif(btrim(coalesce(it ->> 'party_id', '')), ''),
        nullif(upper(btrim(coalesce(it ->> 'currency', ''))), ''),
        nullif(it ->> 'fx_rate', '')::numeric,
        nullif(it ->> 'amount_fx', '')::numeric);
    exception
      when invalid_text_representation or numeric_value_out_of_range or invalid_datetime_format then
        raise exception 'Line %: a value could not be read.', v_no using errcode = 'check_violation', hint = 'invalid';
      when check_violation then
        get stacked diagnostics v_hint = pg_exception_hint;
        if coalesce(v_hint, '') = '' then   -- a table check (a text too long, a party without its id, ...)
          raise exception 'Line %: a value is too long or not allowed.', v_no using errcode = 'check_violation', hint = 'invalid';
        end if;
        raise;
    end;
  end loop;
end;
$$;
revoke all on function app.acc_write_lines(uuid, uuid, jsonb) from public, anon, authenticated;

-- Raises the first problem that stops a journal from being posted (or submitted). Reversals mirror lines that were valid
-- when posted, so they skip the "still active" checks.
create or replace function app.acc_validate(p_journal_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  j public.acc_journals;
  v_n integer;
  v_debit numeric;
  v_credit numeric;
  v_mirror boolean;
  r record;
begin
  select * into j from public.acc_journals where id = p_journal_id;
  v_mirror := j.source_kind = 'reversal';
  if not exists (select 1 from public.acc_entities e where e.id = j.entity_id and e.org_id = j.org_id and (e.active or v_mirror)) then
    raise exception 'The entity is not active.' using errcode = 'check_violation', hint = 'entity_unknown';
  end if;
  select count(*), coalesce(sum(l.debit), 0), coalesce(sum(l.credit), 0) into v_n, v_debit, v_credit
  from public.acc_journal_lines l where l.journal_id = j.id;
  if v_n < 2 then
    raise exception 'A journal needs at least two lines.' using errcode = 'check_violation', hint = 'too_few_lines';
  end if;
  if v_debit <> v_credit then
    raise exception 'Debits (%) and credits (%) must be equal.', v_debit, v_credit using errcode = 'check_violation', hint = 'unbalanced';
  end if;
  if v_debit <= 0 then
    raise exception 'A journal needs an amount above zero.' using errcode = 'check_violation', hint = 'zero_total';
  end if;
  for r in
    select l.line_no, l.branch_code, l.doctor_id, l.payer_id, l.tax_code_id, l.cost_centre_id, l.supplier_id,
           a.org_id as a_org, a.is_group, a.is_active, a.entity_id as a_entity, a.control, a.allow_manual,
           t.active as t_active, t.org_id as t_org, c.active as c_active, c.org_id as c_org, s.org_id as s_org
    from public.acc_journal_lines l
    join public.acc_accounts a on a.id = l.account_id
    left join public.acc_tax_codes t on t.id = l.tax_code_id
    left join public.acc_cost_centres c on c.id = l.cost_centre_id
    left join public.fin_suppliers s on s.id = l.supplier_id
    where l.journal_id = j.id
    order by l.line_no
  loop
    if r.a_org <> j.org_id then
      raise exception 'Line %: the account was not found.', r.line_no using errcode = 'check_violation', hint = 'account_not_found';
    end if;
    if r.is_group then
      raise exception 'Line %: post to a ledger, not to a group.', r.line_no using errcode = 'check_violation', hint = 'account_is_group';
    end if;
    if not r.is_active and not v_mirror then
      raise exception 'Line %: the account is inactive.', r.line_no using errcode = 'check_violation', hint = 'account_inactive';
    end if;
    if r.a_entity is not null and r.a_entity <> j.entity_id then
      raise exception 'Line %: the account belongs to another entity.', r.line_no using errcode = 'check_violation', hint = 'account_entity';
    end if;
    if j.source_kind is null and r.control is not null and j.voucher_type <> 'opening' then
      raise exception 'Line %: a control account takes automatic postings only (or an opening-balance journal).', r.line_no
        using errcode = 'check_violation', hint = 'control_account';
    end if;
    if j.source_kind is null and not r.allow_manual and j.voucher_type <> 'opening' then
      raise exception 'Line %: this account takes no manual journals.', r.line_no using errcode = 'check_violation', hint = 'manual_not_allowed';
    end if;
    if r.tax_code_id is not null and (r.t_org <> j.org_id or (not r.t_active and not v_mirror)) then
      raise exception 'Line %: the tax code is not active.', r.line_no using errcode = 'check_violation', hint = 'tax_code';
    end if;
    if r.cost_centre_id is not null and (r.c_org <> j.org_id or (not r.c_active and not v_mirror)) then
      raise exception 'Line %: the cost centre is not active.', r.line_no using errcode = 'check_violation', hint = 'cost_centre';
    end if;
    if r.supplier_id is not null and r.s_org <> j.org_id then
      raise exception 'Line %: supplier not found.', r.line_no using errcode = 'check_violation', hint = 'supplier_unknown';
    end if;
    if r.branch_code is not null then
      if not exists (select 1 from public.fin_ref_branches b where b.org_id = j.org_id and b.code = r.branch_code) then
        raise exception 'Line %: unknown branch.', r.line_no using errcode = 'check_violation', hint = 'branch_unknown';
      end if;
      if exists (select 1 from public.acc_entity_branches eb
                 where eb.org_id = j.org_id and eb.branch_code = r.branch_code and eb.entity_id <> j.entity_id) then
        raise exception 'Line %: the branch books into another entity.', r.line_no using errcode = 'check_violation', hint = 'branch_entity';
      end if;
    end if;
    if r.doctor_id is not null
       and not exists (select 1 from public.fin_ref_doctors d where d.org_id = j.org_id and d.dha_id = r.doctor_id) then
      raise exception 'Line %: unknown doctor.', r.line_no using errcode = 'check_violation', hint = 'doctor_unknown';
    end if;
    if r.payer_id is not null
       and not exists (select 1 from public.fin_ref_payers p where p.org_id = j.org_id and p.payer_id = r.payer_id) then
      raise exception 'Line %: unknown payer.', r.line_no using errcode = 'check_violation', hint = 'payer_unknown';
    end if;
  end loop;
end;
$$;
revoke all on function app.acc_validate(uuid) from public, anon, authenticated;

-- The fiscal year's adjustment period (month 13, dated its last day), created on first use.
create or replace function app.acc_ensure_adjustment_period(p_org_id uuid, p_entity_id uuid, p_date date)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fy uuid;
  v_period uuid;
begin
  v_period := public.acc_ensure_period(p_org_id, p_entity_id, p_date);   -- the year and its last month
  select p.fiscal_year_id into v_fy from public.acc_periods p where p.id = v_period;
  insert into public.acc_periods (org_id, entity_id, fiscal_year_id, year, month, is_adjustment, start_date, end_date)
  values (p_org_id, p_entity_id, v_fy, extract(year from p_date)::integer, 13, true, p_date, p_date)
  on conflict (entity_id, year, month) do nothing;
  select p.id into v_period from public.acc_periods p
   where p.entity_id = p_entity_id and p.year = extract(year from p_date)::integer and p.month = 13;
  return v_period;
end;
$$;
revoke all on function app.acc_ensure_adjustment_period(uuid, uuid, date) from public, anon, authenticated;

-- Posts a draft: validation, the period and month locks, the number, the frozen hash. p_user_id is the person posting
-- (null = the system, for postings from a source item).
create or replace function app.acc_post_internal(p_journal_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  j public.acc_journals;
  p public.acc_periods;
  s public.acc_number_series;
  v_period uuid;
  v_fy_start date;
  v_start_month integer;
  v_number text;
  v_hash text;
  v_total numeric;
begin
  select * into j from public.acc_journals where id = p_journal_id for update;
  if j.status <> 'draft' then
    raise exception 'Only a draft can be posted.' using errcode = 'check_violation', hint = 'wrong_status';
  end if;
  perform app.acc_validate(j.id);
  if j.is_adjustment then
    select e.fiscal_year_start_month into v_start_month from public.acc_entities e where e.id = j.entity_id;
    v_fy_start := app.acc_fy_start(v_start_month, j.journal_date);
    if j.journal_date <> (v_fy_start + interval '1 year' - interval '1 day')::date then
      raise exception 'An adjustment journal is dated the last day of the fiscal year.' using errcode = 'check_violation', hint = 'adjustment_date';
    end if;
    if p_user_id is null or not app.user_has_perm(j.org_id, p_user_id, 'accounting.periods.manage') then
      raise exception 'Only someone who manages periods posts to the adjustment period.' using errcode = 'check_violation', hint = 'adjustment_period';
    end if;
    v_period := app.acc_ensure_adjustment_period(j.org_id, j.entity_id, j.journal_date);
  else
    v_period := public.acc_ensure_period(j.org_id, j.entity_id, j.journal_date);
  end if;
  select * into p from public.acc_periods where id = v_period for share;
  if p.status = 'locked' then
    raise exception 'The period of this date is locked.' using errcode = 'check_violation', hint = 'period_locked';
  end if;
  if p.status = 'closed'
     and (p_user_id is null or not app.user_has_perm(j.org_id, p_user_id, 'accounting.periods.manage')) then
    raise exception 'The period of this date is closed.' using errcode = 'check_violation', hint = 'period_closed';
  end if;
  -- the adjustment period is the designed way to adjust a year after its last month was signed off, so the CEO month
  -- lock applies to ordinary periods only
  if not j.is_adjustment and app.fin_month_is_locked(j.org_id, j.journal_date) then
    raise exception 'The month of this date is locked by the CEO sign-off.' using errcode = 'check_violation', hint = 'month_locked';
  end if;

  insert into public.acc_number_series (org_id, entity_id, voucher_type, fiscal_year_id, prefix)
  values (j.org_id, j.entity_id, j.voucher_type, p.fiscal_year_id, app.acc_default_prefix(j.voucher_type))
  on conflict (entity_id, voucher_type, fiscal_year_id) do nothing;
  select * into s from public.acc_number_series
   where entity_id = j.entity_id and voucher_type = j.voucher_type and fiscal_year_id = p.fiscal_year_id
   for update;
  select f.start_date into v_fy_start from public.acc_fiscal_years f where f.id = p.fiscal_year_id;
  v_number := app.acc_format_number(s.prefix, app.acc_fy_code(v_fy_start), s.next_number);
  update public.acc_number_series set next_number = next_number + 1 where id = s.id;

  v_hash := public.acc_journal_compute_hash(j.id);
  select coalesce(sum(l.debit), 0) into v_total from public.acc_journal_lines l where l.journal_id = j.id;
  perform set_config('app.acc_post_ctx', j.id::text, true);
  update public.acc_journals set
    status = 'posted', number = v_number, period_id = p.id, fiscal_year_id = p.fiscal_year_id, posted_at = now(),
    approved_by = p_user_id, sha256 = v_hash, total = v_total
  where id = j.id;
  perform set_config('app.acc_post_ctx', '', true);
  return jsonb_build_object('id', j.id, 'number', v_number, 'status', 'posted', 'sha256', v_hash, 'total', v_total,
                            'journal_date', j.journal_date);
end;
$$;
revoke all on function app.acc_post_internal(uuid, uuid) from public, anon, authenticated;

-- Creates the mirror journal (debits and credits swapped), posts it and marks the original reversed.
create or replace function app.acc_reverse_internal(p_org_id uuid, p_journal_id uuid, p_user_id uuid, p_date date, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  j public.acc_journals;
  v_date date;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_new uuid;
  v_res jsonb;
begin
  select * into j from public.acc_journals where id = p_journal_id and org_id = p_org_id for update;
  if not found then
    raise exception 'Journal not found.' using errcode = 'no_data_found', hint = 'not_found';
  end if;
  if j.status = 'reversed' then
    raise exception 'This journal is already reversed.' using errcode = 'check_violation', hint = 'already_reversed';
  end if;
  if j.status <> 'posted' then
    raise exception 'Only a posted journal can be reversed.' using errcode = 'check_violation', hint = 'wrong_status';
  end if;
  if j.source_kind = 'reversal' then
    raise exception 'A reversal is not reversed again; post a new journal instead.' using errcode = 'check_violation', hint = 'is_reversal';
  end if;
  v_date := coalesce(p_date, j.journal_date);
  if v_date < j.journal_date then
    raise exception 'A reversal cannot be dated before the journal it reverses.' using errcode = 'check_violation', hint = 'reversal_before_original';
  end if;
  if v_reason is null or char_length(v_reason) < 3 then
    raise exception 'Say why the journal is reversed.' using errcode = 'check_violation', hint = 'remarks_required';
  end if;
  insert into public.acc_journals (org_id, entity_id, voucher_type, journal_date, narration, source_kind, source_id,
                                   source_version, reversal_of, prepared_by, is_adjustment)
  values (j.org_id, j.entity_id, j.voucher_type, v_date, left('Reversal of ' || j.number || ': ' || v_reason, 300),
          'reversal', j.id::text, 1, j.id, p_user_id, j.is_adjustment and v_date = j.journal_date)
  returning id into v_new;
  insert into public.acc_journal_lines (org_id, journal_id, line_no, account_id, debit, credit, description, tax_code_id,
                                        branch_code, department, doctor_id, payer_id, supplier_id, cost_centre_id, party_kind,
                                        party_id, currency, fx_rate, amount_fx)
  select l.org_id, v_new, l.line_no, l.account_id, l.credit, l.debit, l.description, l.tax_code_id, l.branch_code,
         l.department, l.doctor_id, l.payer_id, l.supplier_id, l.cost_centre_id, l.party_kind, l.party_id, l.currency,
         l.fx_rate, l.amount_fx
  from public.acc_journal_lines l where l.journal_id = j.id;
  v_res := app.acc_post_internal(v_new, p_user_id);
  perform set_config('app.acc_post_ctx', 'reverse:' || j.id::text, true);
  update public.acc_journals set status = 'reversed', reversed_by = v_new where id = j.id;
  perform set_config('app.acc_post_ctx', '', true);
  return v_res || jsonb_build_object('reversal_of', j.id, 'reversed_number', j.number);
end;
$$;
revoke all on function app.acc_reverse_internal(uuid, uuid, uuid, date, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 10. Manual journals: save a draft, submit, return, discard, post (a different person), reverse
-- ---------------------------------------------------------------------------
-- p_header: { entity_id?, voucher_type, journal_date, narration }. p_lines: see app.acc_write_lines. Editing a draft makes
-- the editor its preparer and takes it out of the approval queue.
create or replace function public.acc_journal_save(p_org_id uuid, p_user_id uuid, p_journal_id uuid, p_header jsonb, p_lines jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  j public.acc_journals;
  v_type text := coalesce(nullif(p_header ->> 'voucher_type', ''), 'journal');
  v_entity uuid;
  v_date date;
  v_auto date;
  v_adjustment boolean := coalesce(p_header ->> 'is_adjustment', 'false') = 'true';
  v_narration text := btrim(coalesce(p_header ->> 'narration', ''));
begin
  if not app.user_has_perm(p_org_id, p_user_id, 'accounting.journals.prepare') then
    raise exception 'You cannot prepare journals.' using errcode = 'check_violation', hint = 'not_permitted';
  end if;
  if v_type not in ('journal', 'contra', 'credit_note', 'debit_note', 'opening') then
    raise exception 'This voucher type is not entered as a manual journal.' using errcode = 'check_violation', hint = 'voucher_type_not_manual';
  end if;
  if v_type = 'opening' and not app.user_has_perm(p_org_id, p_user_id, 'accounting.import') then
    raise exception 'Opening balances need the import permission.' using errcode = 'check_violation', hint = 'not_permitted';
  end if;
  begin
    v_entity := nullif(p_header ->> 'entity_id', '')::uuid;
    v_date := nullif(p_header ->> 'journal_date', '')::date;
    v_auto := nullif(p_header ->> 'auto_reverse_on', '')::date;
  exception when others then
    raise exception 'Enter a valid date.' using errcode = 'check_violation', hint = 'invalid';
  end;
  if v_entity is null then
    select e.id into v_entity from public.acc_entities e where e.org_id = p_org_id and e.is_default;
  end if;
  if not exists (select 1 from public.acc_entities e where e.id = v_entity and e.org_id = p_org_id and e.active) then
    raise exception 'Entity not found.' using errcode = 'check_violation', hint = 'entity_unknown';
  end if;
  if v_date is null then
    raise exception 'Enter the journal date.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  if v_narration = '' or char_length(v_narration) > 300 then
    raise exception 'Say what the journal is for (up to 300 characters).' using errcode = 'check_violation', hint = 'invalid';
  end if;
  if v_auto is not null and v_auto <= v_date then
    raise exception 'The automatic reversal date must be after the journal date.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  if p_journal_id is null then
    insert into public.acc_journals (org_id, entity_id, voucher_type, journal_date, narration, prepared_by, is_adjustment,
                                     auto_reverse_on)
    values (p_org_id, v_entity, v_type, v_date, v_narration, p_user_id, v_adjustment, v_auto)
    returning * into j;
  else
    select * into j from public.acc_journals where id = p_journal_id and org_id = p_org_id for update;
    if not found then
      raise exception 'Journal not found.' using errcode = 'no_data_found', hint = 'not_found';
    end if;
    if j.status <> 'draft' or j.source_kind is not null then
      raise exception 'Only a manual draft can be edited.' using errcode = 'check_violation', hint = 'wrong_status';
    end if;
    update public.acc_journals set entity_id = v_entity, voucher_type = v_type, journal_date = v_date, narration = v_narration,
      is_adjustment = v_adjustment, auto_reverse_on = v_auto, prepared_by = p_user_id, submitted_by = null, submitted_at = null, returned_by = null, returned_at = null,
      return_remarks = null
    where id = j.id;
    delete from public.acc_journal_lines l where l.journal_id = j.id;
  end if;
  perform app.acc_write_lines(p_org_id, j.id, p_lines);
  update public.acc_journals set total = coalesce((select sum(l.debit) from public.acc_journal_lines l where l.journal_id = j.id), 0)
   where id = j.id;
  return jsonb_build_object('id', j.id, 'status', 'draft');
end;
$$;
revoke all on function public.acc_journal_save(uuid, uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.acc_journal_save(uuid, uuid, uuid, jsonb, jsonb) to service_role;

-- p_action: submit (the maker: checks the journal and puts it in the approval queue) | return (the checker sends it back
-- with remarks) | discard (deletes a draft).
create or replace function public.acc_journal_act(p_org_id uuid, p_journal_id uuid, p_user_id uuid, p_action text, p_remarks text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  j public.acc_journals;
  v_remarks text := nullif(btrim(coalesce(p_remarks, '')), '');
begin
  select * into j from public.acc_journals where id = p_journal_id and org_id = p_org_id for update;
  if not found then
    raise exception 'Journal not found.' using errcode = 'no_data_found', hint = 'not_found';
  end if;
  if j.status <> 'draft' or j.source_kind is not null then
    raise exception 'Only a manual draft can change.' using errcode = 'check_violation', hint = 'wrong_status';
  end if;
  if p_action = 'submit' then
    if not app.user_has_perm(p_org_id, p_user_id, 'accounting.journals.prepare') then
      raise exception 'You cannot prepare journals.' using errcode = 'check_violation', hint = 'not_permitted';
    end if;
    if j.submitted_at is not null then
      raise exception 'This journal is already waiting for approval.' using errcode = 'check_violation', hint = 'wrong_status';
    end if;
    perform app.acc_validate(j.id);
    update public.acc_journals set submitted_by = p_user_id, submitted_at = now(), returned_by = null, returned_at = null,
      return_remarks = null
    where id = j.id;
    return jsonb_build_object('id', j.id, 'action', 'submit', 'hash', public.acc_journal_compute_hash(j.id));
  elsif p_action = 'return' then
    if not app.user_has_perm(p_org_id, p_user_id, 'accounting.journals.approve') then
      raise exception 'You cannot approve journals.' using errcode = 'check_violation', hint = 'not_permitted';
    end if;
    if j.submitted_at is null then
      raise exception 'This journal is not waiting for approval.' using errcode = 'check_violation', hint = 'not_submitted';
    end if;
    if p_user_id = j.prepared_by or p_user_id = j.submitted_by then
      raise exception 'The maker edits the journal instead.' using errcode = 'check_violation', hint = 'same_person';
    end if;
    if v_remarks is null or char_length(v_remarks) < 3 then
      raise exception 'Say why the journal is sent back.' using errcode = 'check_violation', hint = 'remarks_required';
    end if;
    update public.acc_journals set submitted_by = null, submitted_at = null, returned_by = p_user_id, returned_at = now(),
      return_remarks = left(v_remarks, 500)
    where id = j.id;
    return jsonb_build_object('id', j.id, 'action', 'return');
  elsif p_action = 'discard' then
    if not app.user_has_perm(p_org_id, p_user_id, 'accounting.journals.prepare') then
      raise exception 'You cannot prepare journals.' using errcode = 'check_violation', hint = 'not_permitted';
    end if;
    delete from public.acc_journals where id = j.id;
    return jsonb_build_object('id', j.id, 'action', 'discard');
  end if;
  raise exception 'Unknown action.' using errcode = 'check_violation', hint = 'invalid';
end;
$$;
revoke all on function public.acc_journal_act(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.acc_journal_act(uuid, uuid, uuid, text, text) to service_role;

-- The checker posts a submitted manual journal: a different person from the maker, bound to the hash they reviewed.
-- Check order (mirrored by lib/accounting/errors.ts): not_found, wrong_status, not_permitted, same_person, not_submitted,
-- hash_mismatch, then the line rules, then period_locked / period_closed / month_locked.
create or replace function public.acc_post_journal(p_org_id uuid, p_journal_id uuid, p_user_id uuid, p_hash text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  j public.acc_journals;
begin
  select * into j from public.acc_journals where id = p_journal_id and org_id = p_org_id for update;
  if not found then
    raise exception 'Journal not found.' using errcode = 'no_data_found', hint = 'not_found';
  end if;
  if j.status <> 'draft' or j.source_kind is not null then
    raise exception 'Only a manual draft can be posted here.' using errcode = 'check_violation', hint = 'wrong_status';
  end if;
  if not app.user_has_perm(p_org_id, p_user_id, 'accounting.journals.approve') then
    raise exception 'You cannot post journals.' using errcode = 'check_violation', hint = 'not_permitted';
  end if;
  if p_user_id = j.prepared_by or p_user_id = j.submitted_by then
    raise exception 'The checker must be a different person from the maker.' using errcode = 'check_violation', hint = 'same_person';
  end if;
  if j.submitted_at is null then
    raise exception 'The maker has not submitted this journal.' using errcode = 'check_violation', hint = 'not_submitted';
  end if;
  if p_hash is null or p_hash is distinct from public.acc_journal_compute_hash(j.id) then
    raise exception 'The journal changed since you opened it; reload and review it again.' using errcode = 'check_violation', hint = 'hash_mismatch';
  end if;
  return app.acc_post_internal(j.id, p_user_id);
end;
$$;
revoke all on function public.acc_post_journal(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.acc_post_journal(uuid, uuid, uuid, text) to service_role;

create or replace function public.acc_reverse_journal(p_org_id uuid, p_journal_id uuid, p_user_id uuid, p_date date, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not app.user_has_perm(p_org_id, p_user_id, 'accounting.journals.approve') then
    raise exception 'You cannot reverse journals.' using errcode = 'check_violation', hint = 'not_permitted';
  end if;
  return app.acc_reverse_internal(p_org_id, p_journal_id, p_user_id, p_date, p_reason);
end;
$$;
revoke all on function public.acc_reverse_journal(uuid, uuid, uuid, date, text) from public, anon, authenticated;
grant execute on function public.acc_reverse_journal(uuid, uuid, uuid, date, text) to service_role;

-- Posts the reversal of every posted journal whose auto_reverse_on date has come (dated that day, by the system).
-- Idempotent: a reversed journal is not picked again. Each journal succeeds or fails on its own (a closed or locked
-- period refuses it; it is retried on the next run). The scheduling job comes with the posting engine (22D).
create or replace function public.acc_run_auto_reversals(p_org_id uuid, p_today date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_done jsonb := '[]'::jsonb;
  v_failed jsonb := '[]'::jsonb;
  v_hint text;
begin
  if p_today is null then
    raise exception 'Enter the date.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  for r in
    select j.id, j.auto_reverse_on from public.acc_journals j
    where j.org_id = p_org_id and j.status = 'posted' and j.auto_reverse_on is not null and j.auto_reverse_on <= p_today
    order by j.auto_reverse_on, j.posted_at
    limit 500
  loop
    begin
      perform app.acc_reverse_internal(p_org_id, r.id, null, r.auto_reverse_on, 'automatic reversal');
      v_done := v_done || to_jsonb(r.id::text);
    exception when others then
      get stacked diagnostics v_hint = pg_exception_hint;
      v_failed := v_failed || jsonb_build_object('id', r.id, 'code', coalesce(nullif(v_hint, ''), 'error'));
    end;
  end loop;
  return jsonb_build_object('done', v_done, 'failed', v_failed);
end;
$$;
revoke all on function public.acc_run_auto_reversals(uuid, date) from public, anon, authenticated;
grant execute on function public.acc_run_auto_reversals(uuid, date) to service_role;

-- ---------------------------------------------------------------------------
-- 11. THE API for later slices: post a journal for a source item. Idempotent on (source_kind, source_id, source_version):
--     the same key returns the existing journal. A newer version first reverses the live journal of the older version
--     (dated the later of the new date and the old journal's date), then posts. An older version arriving after a newer
--     one is refused (stale_version). All in one transaction; posted by the system (no person), so a closed period
--     refuses it. A 'tally_import' journal carries its Tally GUID (= source_id) in tally_guid.
-- ---------------------------------------------------------------------------
create or replace function public.acc_post_from_source(
  p_org_id uuid, p_entity_id uuid, p_source_kind text, p_source_id text, p_source_version integer, p_date date,
  p_voucher_type text, p_narration text, p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entity uuid := p_entity_id;
  v_existing public.acc_journals;
  v_old public.acc_journals;
  v_new uuid;
  v_res jsonb;
  v_narration text := btrim(coalesce(p_narration, ''));
begin
  if p_source_kind is null or p_source_kind = 'reversal' or p_source_kind not in (
    'unite_invoice', 'unite_payment', 'supplier_invoice', 'voucher', 'remittance', 'denial', 'revshare_run', 'lab_charge',
    'cashup', 'settlement', 'bank_line', 'opening', 'tally_import', 'fixed_asset', 'depreciation', 'sales_invoice',
    'receipt', 'payroll') then
    raise exception 'Unknown source kind.' using errcode = 'check_violation', hint = 'source_kind';
  end if;
  if nullif(btrim(coalesce(p_source_id, '')), '') is null or char_length(p_source_id) > 200
     or p_source_version is null or p_source_version < 1 or p_date is null
     or p_voucher_type is null or p_voucher_type not in (
       'journal', 'contra', 'payment', 'receipt', 'sales', 'purchase', 'credit_note', 'debit_note', 'opening')
     or v_narration = '' or char_length(v_narration) > 300 then
    raise exception 'The source, version, date, voucher type and narration are required.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  if v_entity is null then
    select e.id into v_entity from public.acc_entities e where e.org_id = p_org_id and e.is_default;
  end if;
  if not exists (select 1 from public.acc_entities e where e.id = v_entity and e.org_id = p_org_id and e.active) then
    raise exception 'Entity not found.' using errcode = 'check_violation', hint = 'entity_unknown';
  end if;

  -- one caller at a time per source item
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || '|' || p_source_kind || '|' || p_source_id, 22));

  select * into v_existing from public.acc_journals
   where org_id = p_org_id and source_kind = p_source_kind and source_id = p_source_id and source_version = p_source_version;
  if found then
    return jsonb_build_object('id', v_existing.id, 'number', v_existing.number, 'status', v_existing.status,
                              'created', false, 'replaced', null);
  end if;
  if exists (select 1 from public.acc_journals
             where org_id = p_org_id and source_kind = p_source_kind and source_id = p_source_id
               and source_version > p_source_version) then
    raise exception 'A newer version of this item is already posted.' using errcode = 'check_violation', hint = 'stale_version';
  end if;
  select * into v_old from public.acc_journals
   where org_id = p_org_id and source_kind = p_source_kind and source_id = p_source_id and status = 'posted';
  if found then
    perform app.acc_reverse_internal(p_org_id, v_old.id, null, greatest(p_date, v_old.journal_date),
                                     'replaced by version ' || p_source_version::text);
  end if;

  insert into public.acc_journals (org_id, entity_id, voucher_type, journal_date, narration, source_kind, source_id,
                                   source_version, tally_guid)
  values (p_org_id, v_entity, p_voucher_type, p_date, v_narration, p_source_kind, p_source_id, p_source_version,
          case when p_source_kind = 'tally_import' then p_source_id end)
  returning id into v_new;
  perform app.acc_write_lines(p_org_id, v_new, p_lines);
  v_res := app.acc_post_internal(v_new, null);
  return v_res || jsonb_build_object('created', true, 'replaced', v_old.id);
end;
$$;
revoke all on function public.acc_post_from_source(uuid, uuid, text, text, integer, date, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.acc_post_from_source(uuid, uuid, text, text, integer, date, text, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 12. Reports (posted and reversed journals both count: a reversal is its own posted journal)
-- ---------------------------------------------------------------------------
-- Trial balance for a date range. Balances are debit minus credit. Balance-sheet accounts open with everything before
-- p_from; income and expense accounts open with their movements since the start of the fiscal year holding p_from (each
-- entity's own year), and earlier years' profit or loss is one line ("earlier_years_pl") until the year-end close (22I)
-- moves it to retained earnings. The totals are zero when every journal balances.
create or replace function public.acc_trial_balance(p_org_id uuid, p_entity_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Choose a valid date range.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  if p_entity_id is not null and not exists (select 1 from public.acc_entities e where e.id = p_entity_id and e.org_id = p_org_id) then
    raise exception 'Entity not found.' using errcode = 'check_violation', hint = 'entity_unknown';
  end if;
  with ln as (
    select l.account_id, j.journal_date, l.debit, l.credit, a.nature,
           app.acc_fy_start(e.fiscal_year_start_month, p_from) as fy_start
    from public.acc_journal_lines l
    join public.acc_journals j on j.id = l.journal_id
    join public.acc_accounts a on a.id = l.account_id
    join public.acc_entities e on e.id = j.entity_id
    where j.org_id = p_org_id and j.status in ('posted', 'reversed') and j.journal_date <= p_to
      and (p_entity_id is null or j.entity_id = p_entity_id)
  ), per as (
    select account_id,
           sum(case when journal_date < p_from and (nature in ('asset', 'liability', 'equity') or journal_date >= fy_start)
                    then debit - credit else 0 end) as opening,
           sum(case when journal_date >= p_from then debit else 0 end) as debit,
           sum(case when journal_date >= p_from then credit else 0 end) as credit
    from ln group by account_id
  ), earlier as (
    select coalesce(sum(debit - credit), 0) as pl from ln where nature in ('income', 'expense') and journal_date < fy_start
  ), tot as (
    select coalesce(sum(opening), 0) as opening, coalesce(sum(debit), 0) as debit, coalesce(sum(credit), 0) as credit from per
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'entity_id', p_entity_id,
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'account_id', a.id, 'code', a.code, 'name', a.name, 'nature', a.nature, 'parent_id', a.parent_id,
               'opening', p.opening, 'debit', p.debit, 'credit', p.credit, 'closing', p.opening + p.debit - p.credit)
             order by a.code)
      from per p join public.acc_accounts a on a.id = p.account_id
      where p.opening <> 0 or p.debit <> 0 or p.credit <> 0), '[]'::jsonb),
    'earlier_years_pl', (select pl from earlier),
    'totals', (select jsonb_build_object(
                 'opening', t.opening + (select pl from earlier), 'debit', t.debit, 'credit', t.credit,
                 'closing', t.opening + (select pl from earlier) + t.debit - t.credit) from tot t))
  into v;
  return v;
end;
$$;
revoke all on function public.acc_trial_balance(uuid, uuid, date, date) from public, anon, authenticated;
grant execute on function public.acc_trial_balance(uuid, uuid, date, date) to service_role;

-- One account's ledger (a group shows every ledger under it): opening, lines in date order with a running balance,
-- closing. The running balance covers every line in the range even when only one page is returned.
create or replace function public.acc_ledger(p_org_id uuid, p_account_id uuid, p_from date, p_to date, p_limit integer, p_offset integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a public.acc_accounts;
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 1000);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v jsonb;
begin
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Choose a valid date range.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  select * into a from public.acc_accounts where id = p_account_id and org_id = p_org_id;
  if not found then
    raise exception 'Account not found.' using errcode = 'no_data_found', hint = 'not_found';
  end if;
  with recursive tree as (
    select x.id from public.acc_accounts x where x.id = a.id
    union all
    select c.id from public.acc_accounts c join tree t on c.parent_id = t.id
  ), ln as (
    select l.id, l.journal_id, l.line_no, l.debit, l.credit, l.description, l.branch_code, ac.code as account_code,
           ac.name as account_name, ac.nature, j.number, j.journal_date, j.voucher_type, j.narration, j.posted_at,
           j.status, j.source_kind, app.acc_fy_start(e.fiscal_year_start_month, p_from) as fy_start
    from public.acc_journal_lines l
    join public.acc_journals j on j.id = l.journal_id
    join public.acc_accounts ac on ac.id = l.account_id
    join public.acc_entities e on e.id = j.entity_id
    where l.account_id in (select id from tree) and j.org_id = p_org_id and j.status in ('posted', 'reversed')
      and j.journal_date <= p_to
  ), op as (
    select coalesce(sum(debit - credit), 0) as opening from ln
    where journal_date < p_from and (nature in ('asset', 'liability', 'equity') or journal_date >= fy_start)
  ), rng as (
    select ln.*, (select opening from op) + sum(debit - credit) over (
             order by journal_date, posted_at, number, line_no, id rows between unbounded preceding and current row) as balance,
           row_number() over (order by journal_date, posted_at, number, line_no, id) as rn
    from ln where journal_date >= p_from
  )
  select jsonb_build_object(
    'account', jsonb_build_object('id', a.id, 'code', a.code, 'name', a.name, 'nature', a.nature, 'is_group', a.is_group),
    'from', p_from, 'to', p_to,
    'opening', (select opening from op),
    'period_debit', (select coalesce(sum(debit), 0) from rng),
    'period_credit', (select coalesce(sum(credit), 0) from rng),
    'closing', (select opening from op) + (select coalesce(sum(debit - credit), 0) from rng),
    'total_lines', (select count(*) from rng),
    'limit', v_limit, 'offset', v_offset,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'line_id', r.id, 'journal_id', r.journal_id, 'number', r.number, 'date', r.journal_date,
               'voucher_type', r.voucher_type, 'narration', r.narration, 'description', r.description,
               'account_code', r.account_code, 'account_name', r.account_name, 'branch_code', r.branch_code,
               'status', r.status, 'source_kind', r.source_kind,
               'debit', r.debit, 'credit', r.credit, 'balance', r.balance) order by r.rn)
      from rng r where r.rn > v_offset and r.rn <= v_offset + v_limit), '[]'::jsonb))
  into v;
  return v;
end;
$$;
revoke all on function public.acc_ledger(uuid, uuid, date, date, integer, integer) from public, anon, authenticated;
grant execute on function public.acc_ledger(uuid, uuid, date, date, integer, integer) to service_role;

-- Every posted (or reversed) journal in a date range with its lines, in date and number order (at most 1000 journals;
-- "truncated" says when there were more).
create or replace function public.acc_day_book(p_org_id uuid, p_entity_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Choose a valid date range.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  with js as (
    select j.* from public.acc_journals j
    where j.org_id = p_org_id and j.status in ('posted', 'reversed') and j.journal_date between p_from and p_to
      and (p_entity_id is null or j.entity_id = p_entity_id)
    order by j.journal_date, j.posted_at, j.number
    limit 1001
  ), numbered as (
    select js.*, row_number() over (order by journal_date, posted_at, number) as rn from js
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'entity_id', p_entity_id,
    'truncated', (select count(*) from numbered) > 1000,
    'journals', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', n.id, 'number', n.number, 'date', n.journal_date, 'voucher_type', n.voucher_type,
               'narration', n.narration, 'status', n.status, 'total', n.total, 'source_kind', n.source_kind,
               'reversal_of', n.reversal_of, 'reversed_by', n.reversed_by,
               'lines', (select jsonb_agg(jsonb_build_object(
                                 'line_no', l.line_no, 'account_code', a.code, 'account_name', a.name,
                                 'debit', l.debit, 'credit', l.credit, 'description', l.description) order by l.line_no)
                         from public.acc_journal_lines l join public.acc_accounts a on a.id = l.account_id
                         where l.journal_id = n.id)) order by n.rn)
      from numbered n where n.rn <= 1000), '[]'::jsonb))
  into v;
  return v;
end;
$$;
revoke all on function public.acc_day_book(uuid, uuid, date, date) from public, anon, authenticated;
grant execute on function public.acc_day_book(uuid, uuid, date, date) to service_role;

-- ---------------------------------------------------------------------------
-- 13. Who changed it (record_history) and who opened it (the access log learns about journals)
-- ---------------------------------------------------------------------------
create or replace function app.can_view_record_history(p_org_id uuid, p_table text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_table
    when 'appointments' then app.has_perm(p_org_id, 'appointments.view')
    when 'enquiries' then app.has_perm(p_org_id, 'enquiries.view')
    when 'tasks' then app.has_perm(p_org_id, 'tasks.view')
    when 'wa_templates' then app.has_perm(p_org_id, 'templates.manage')
    when 'flows' then app.has_perm(p_org_id, 'flows.manage')
    when 'fin_pre_authorisations' then app.has_perm(p_org_id, 'finance.preauth.manage')
    when 'fin_eligibility_checks' then app.has_perm(p_org_id, 'finance.eligibility.manage')
    when 'ins_denial_cases' then app.has_perm(p_org_id, 'finance.denials.manage')
    when 'fin_period_closes' then app.has_perm(p_org_id, 'finance.close.view')
    when 'acc_accounts' then app.acc_can_view(p_org_id)
    when 'acc_journals' then app.acc_can_read_journals(p_org_id)
    else exists (
      select 1 from public.portal_objects po
      where po.org_id = p_org_id and po.table_name = p_table and app.has_perm_wild(p_org_id, po.read_perm)
    )
  end;
$$;
grant execute on function app.can_view_record_history(uuid, text) to authenticated, service_role;

-- Every org now holds tracked rows (its chart), so deleting an org (the cascade) must not try to write history for the
-- org that is going away (the row would fail its foreign key). Body as in 20261011000200 plus the first check.
create or replace function app.record_history_capture()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_changes jsonb := '{}'::jsonb;
  v_skip text[] := array['updated_at', 'created_at', 'search', 'embedding'];
  v_key text;
  v_actor uuid;
  v_headers jsonb;
  v_role text;
  v_row jsonb;
begin
  if TG_OP = 'DELETE' and not exists (select 1 from public.orgs o where o.id = (to_jsonb(OLD) ->> 'org_id')::uuid) then
    return null;                                                   -- the org cascade: its history goes with it
  end if;
  if TG_NARGS > 0 and TG_ARGV[0] <> '' then
    v_skip := v_skip || string_to_array(TG_ARGV[0], ',');
  end if;

  v_actor := auth.uid();
  if v_actor is null then
    v_role := coalesce(
      nullif(current_setting('request.jwt.claim.role', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
    );
    if v_role = 'service_role' then
      begin
        v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
        v_actor := nullif(v_headers ->> 'x-pulse-actor', '')::uuid;
      exception when others then
        v_actor := null;                                           -- a malformed header must never break the write
      end;
    end if;
  end if;
  -- The actor must be a real user; a stale or forged id would otherwise fail the foreign key.
  if v_actor is not null and not exists (select 1 from auth.users u where u.id = v_actor) then
    v_actor := null;
  end if;

  if TG_OP = 'UPDATE' then
    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);
    for v_key in select jsonb_object_keys(v_new) loop
      continue when v_key = any (v_skip);
      if v_new -> v_key is distinct from v_old -> v_key then
        v_changes := v_changes || jsonb_build_object(
          v_key, jsonb_build_object('from', app.history_value(v_old -> v_key), 'to', app.history_value(v_new -> v_key))
        );
      end if;
    end loop;
    if v_changes = '{}'::jsonb then
      return null;                                                 -- only noise columns changed
    end if;
  end if;

  v_row := to_jsonb(case when TG_OP = 'DELETE' then OLD else NEW end);
  insert into public.record_history (org_id, table_name, record_id, op, actor_id, changes)
  values ((v_row ->> 'org_id')::uuid, TG_TABLE_NAME, (v_row ->> 'id')::uuid, lower(TG_OP), v_actor, v_changes);
  return null;
end;
$$;
revoke all on function app.record_history_capture() from public, anon, authenticated;

select app.enable_record_history('acc_accounts');
select app.enable_record_history('acc_journals');

do $$
declare
  c record;
  v_list text[];
begin
  for c in
    select con.conname, pg_get_constraintdef(con.oid) as def
    from pg_constraint con
    where con.conrelid = 'public.record_access_log'::regclass and con.contype = 'c' and pg_get_constraintdef(con.oid) like '%entity%'
      and pg_get_constraintdef(con.oid) not like '%action%'
  loop
    select array_agg(distinct m[1]) into v_list from regexp_matches(c.def, '''([a-z_]+)''', 'g') as m;
    execute format('alter table public.record_access_log drop constraint %I', c.conname);
  end loop;
  v_list := coalesce(v_list, array['contact', 'conversation', 'finance_claim', 'finance_invoice', 'document', 'enquiry',
                                   'appointment', 'portal_record', 'export', 'activity_log', 'finance_document']);
  if not ('accounting_journal' = any (v_list)) then
    v_list := array_append(v_list, 'accounting_journal');
  end if;
  execute format('alter table public.record_access_log add constraint record_access_log_entity_check check (entity in (%s))',
    (select string_agg(quote_literal(x), ', ' order by x) from unnest(v_list) as x));
end $$;

-- ---------------------------------------------------------------------------
-- 14. Every existing workspace gets its chart now
-- ---------------------------------------------------------------------------
select public.acc_seed_chart(id) from public.orgs;
