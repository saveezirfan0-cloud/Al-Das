-- Phase 22H: fixed assets, depreciation, prepayments and accruals (docs/22_ACCOUNTING_PLAN.md, slice 22H; notes in
-- docs/22_PHASE_22H_NOTES.md). Builds on the 22A ledger core (20261108000100).
--
--   * acc_asset_classes (seeded: medical equipment, IT equipment, furniture and fittings, leasehold improvements, motor
--     vehicles) and acc_assets (the fixed asset register, optionally linked to a 20D supplier invoice)
--   * acc_schedules: prepayments, accruals (optionally reversing on the 1st of the next month) and deferred revenue,
--     released monthly
--   * acc_depreciation_runs + acc_asset_run_lines: one run per entity, kind and month (depreciation | schedules |
--     reversing_accruals). Pulse computes the amounts (lib/accounting/assets/*, pure and unit-tested); the database
--     derives the accounts and dimensions itself, hashes the lines, and posts ONE journal per run through
--     acc_post_from_source('fixed_asset', <run id>, <version>, ...). Prepared by one person (or the monthly job), posted
--     by a different person holding accounting.journals.approve, bound to the sha256 of the lines they reviewed. A
--     changed month is re-prepared as a new version; posting it reverses the old journal and posts the new one.
--   * Disposals: prepared and posted by two people; the journal removes cost and accumulated depreciation, charges (or
--     writes back) depreciation up to the month before the disposal and books the gain or loss.
--   * If acc_post_from_source refuses with the hint before_ledger_start (the ledger start date, a central rule), the run
--     or disposal stays 'waiting_ledger_start' and can be posted again later.
--   * Leases: no IFRS 16 register in this slice (OQ-125, reporting framework). Enter a lease as a prepayment or accrual
--     schedule meanwhile.
--
-- Every state change is a SECURITY DEFINER function (search_path = '', service role only, jsonb results) called after
-- can(); register edits are server actions with the service role after can(), checked by guard triggers. Errors carry
-- a stable code in the HINT (lib/accounting/assets/errors.ts). No patient data anywhere in these tables.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table public.acc_asset_classes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,11}$'),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  cost_account_id uuid not null references public.acc_accounts (id),
  accum_account_id uuid not null references public.acc_accounts (id),       -- accumulated depreciation
  expense_account_id uuid not null references public.acc_accounts (id),     -- depreciation expense
  disposal_account_id uuid not null references public.acc_accounts (id),    -- gain or loss on disposal
  method text not null default 'straight_line' check (method in ('straight_line', 'reducing_balance')),
  life_months integer not null check (life_months between 1 and 600),
  residual_pct numeric(5, 2) not null default 0 check (residual_pct >= 0 and residual_pct < 100),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, code)
);
create unique index acc_asset_classes_name_uidx on public.acc_asset_classes (org_id, lower(btrim(name)));
create trigger acc_asset_classes_set_updated_at before update on public.acc_asset_classes
  for each row execute function app.set_updated_at();

create table public.acc_assets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  entity_id uuid not null references public.acc_entities (id),
  code text not null check (code ~ '^[A-Z0-9][A-Z0-9/_-]{0,19}$'),
  class_id uuid not null references public.acc_asset_classes (id),
  description text not null check (char_length(btrim(description)) between 1 and 200),   -- never patient data
  branch_code text check (branch_code is null or char_length(branch_code) between 1 and 20),
  department text check (department is null or char_length(department) between 1 and 60),
  acquisition_date date not null,
  in_service_date date not null,
  cost numeric(14, 2) not null check (cost > 0),
  residual numeric(14, 2) not null default 0 check (residual >= 0),
  life_months integer not null check (life_months between 1 and 600),
  method text not null check (method in ('straight_line', 'reducing_balance')),
  status text not null default 'active' check (status in ('active', 'disposed', 'fully_depreciated')),
  -- depreciation already in the books before Pulse (the Tally opening balance); runs only charge what is beyond it
  opening_accumulated numeric(14, 2) not null default 0 check (opening_accumulated >= 0),
  supplier_invoice_id uuid references public.fin_supplier_invoices (id),
  -- disposal: prepared by one person, posted by another
  disposal_status text check (disposal_status in ('prepared', 'posted', 'waiting_ledger_start')),
  disposal_date date,
  disposal_proceeds numeric(14, 2) check (disposal_proceeds >= 0),
  disposal_account_id uuid references public.acc_accounts (id),             -- where the proceeds go (bank, receivable)
  disposal_accumulated numeric(14, 2) check (disposal_accumulated >= 0),    -- schedule through the month before
  disposal_posted_accum numeric(14, 2) check (disposal_posted_accum >= 0),  -- what the runs had posted when prepared
  disposal_sha256 text check (disposal_sha256 is null or disposal_sha256 ~ '^[0-9a-f]{64}$'),
  disposal_prepared_by uuid references public.profiles (id) on delete set null,
  disposal_prepared_at timestamptz,
  disposal_posted_by uuid references public.profiles (id) on delete set null,
  disposal_posted_at timestamptz,
  disposal_journal_id uuid references public.acc_journals (id),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, code),
  check (residual < cost),
  check (opening_accumulated <= cost - residual),
  check (in_service_date >= acquisition_date),
  check ((status = 'disposed') = (disposal_status is not distinct from 'posted')),
  check ((disposal_status is null) = (disposal_date is null)),
  check (disposal_status is null or (disposal_proceeds is not null and disposal_accumulated is not null
                                     and disposal_posted_accum is not null and disposal_sha256 is not null)),
  check (disposal_status is distinct from 'posted' or disposal_journal_id is not null),
  check (disposal_posted_by is null or disposal_prepared_by is null or disposal_posted_by <> disposal_prepared_by)
);
create index acc_assets_class_idx on public.acc_assets (class_id);
create index acc_assets_invoice_idx on public.acc_assets (supplier_invoice_id) where supplier_invoice_id is not null;
create trigger acc_assets_set_updated_at before update on public.acc_assets
  for each row execute function app.set_updated_at();
create trigger acc_assets_entity_org_check before insert or update on public.acc_assets
  for each row execute function app.check_parent_org('acc_entities', 'entity_id');
create trigger acc_assets_class_org_check before insert or update on public.acc_assets
  for each row execute function app.check_parent_org('acc_asset_classes', 'class_id');
create trigger acc_assets_invoice_org_check before insert or update of supplier_invoice_id, org_id on public.acc_assets
  for each row execute function app.check_parent_org('fin_supplier_invoices', 'supplier_invoice_id');

-- Prepayments (Dr expense, Cr prepayment), accruals (Dr expense, Cr accrued liability) and deferred revenue (Dr deferred
-- revenue, Cr income), released evenly over `months` from start_month. A reversing accrual is posted each month and
-- reversed on the 1st of the next (acc_journals.auto_reverse_on, 22A).
create table public.acc_schedules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  entity_id uuid not null references public.acc_entities (id),
  kind text not null check (kind in ('prepayment', 'accrual', 'deferred_revenue')),
  description text not null check (char_length(btrim(description)) between 1 and 200),
  pl_account_id uuid not null references public.acc_accounts (id),          -- expense (or income for deferred revenue)
  bs_account_id uuid not null references public.acc_accounts (id),          -- prepayment, accrued or deferred balance
  total numeric(14, 2) not null check (total > 0),
  start_month date not null check (extract(day from start_month) = 1),
  months integer not null check (months between 1 and 600),
  branch_code text check (branch_code is null or char_length(branch_code) between 1 and 20),
  department text check (department is null or char_length(department) between 1 and 60),
  auto_reverse boolean not null default false,
  status text not null default 'active' check (status in ('active', 'completed', 'cancelled')),
  supplier_invoice_id uuid references public.fin_supplier_invoices (id),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not auto_reverse or kind = 'accrual')
);
create index acc_schedules_org_idx on public.acc_schedules (org_id, status);
create trigger acc_schedules_set_updated_at before update on public.acc_schedules
  for each row execute function app.set_updated_at();
create trigger acc_schedules_entity_org_check before insert or update on public.acc_schedules
  for each row execute function app.check_parent_org('acc_entities', 'entity_id');
create trigger acc_schedules_invoice_org_check before insert or update of supplier_invoice_id, org_id on public.acc_schedules
  for each row execute function app.check_parent_org('fin_supplier_invoices', 'supplier_invoice_id');

-- One run per entity, kind and month. `version` is the current content; `posted_version` the one whose journal is live.
create table public.acc_depreciation_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  entity_id uuid not null references public.acc_entities (id),
  kind text not null check (kind in ('depreciation', 'schedules', 'reversing_accruals')),
  period_month date not null check (extract(day from period_month) = 1),
  version integer not null default 1 check (version >= 1),
  status text not null default 'draft' check (status in ('draft', 'posted', 'waiting_ledger_start')),
  total numeric(14, 2) not null default 0 check (total >= 0),
  line_count integer not null default 0 check (line_count >= 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  prepared_by uuid references public.profiles (id) on delete set null,      -- null = the monthly job
  prepared_at timestamptz not null default now(),
  posted_by uuid references public.profiles (id) on delete set null,
  posted_at timestamptz,
  posted_version integer check (posted_version is null or (posted_version >= 1 and posted_version <= version)),
  posted_sha256 text check (posted_sha256 is null or posted_sha256 ~ '^[0-9a-f]{64}$'),
  journal_id uuid references public.acc_journals (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, entity_id, kind, period_month),
  check ((status = 'posted') = (posted_version is not distinct from version)),
  check ((posted_version is null) = (posted_at is null)),
  -- maker / checker for the version that is live (null-safe: a removed user's id becomes null; null preparer = the job)
  check (status <> 'posted' or posted_by is null or prepared_by is null or posted_by <> prepared_by)
);
create index acc_depreciation_runs_org_idx on public.acc_depreciation_runs (org_id, period_month desc);
create trigger acc_depreciation_runs_set_updated_at before update on public.acc_depreciation_runs
  for each row execute function app.set_updated_at();
create trigger acc_depreciation_runs_entity_org_check before insert or update on public.acc_depreciation_runs
  for each row execute function app.check_parent_org('acc_entities', 'entity_id');

-- The lines of a run version: one per asset or schedule. The accounts and dimensions come from the asset's class or the
-- schedule (derived by the database, never sent by the caller). Lines of the posted version are kept until a newer
-- version is posted; they are the books' per-asset accumulated depreciation.
create table public.acc_asset_run_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  run_id uuid not null references public.acc_depreciation_runs (id) on delete cascade,
  version integer not null check (version >= 1),
  asset_id uuid references public.acc_assets (id),
  schedule_id uuid references public.acc_schedules (id),
  debit_account_id uuid not null references public.acc_accounts (id),
  credit_account_id uuid not null references public.acc_accounts (id),
  branch_code text check (branch_code is null or char_length(branch_code) between 1 and 20),
  department text check (department is null or char_length(department) between 1 and 60),
  amount numeric(14, 2) not null check (amount > 0),
  created_at timestamptz not null default now(),
  check ((asset_id is null) <> (schedule_id is null))
);
create unique index acc_asset_run_lines_asset_uidx on public.acc_asset_run_lines (run_id, version, asset_id) where asset_id is not null;
create unique index acc_asset_run_lines_schedule_uidx on public.acc_asset_run_lines (run_id, version, schedule_id) where schedule_id is not null;
create index acc_asset_run_lines_asset_idx on public.acc_asset_run_lines (asset_id) where asset_id is not null;
create index acc_asset_run_lines_schedule_idx on public.acc_asset_run_lines (schedule_id) where schedule_id is not null;
create trigger acc_asset_run_lines_run_org_check before insert or update on public.acc_asset_run_lines
  for each row execute function app.check_parent_org('acc_depreciation_runs', 'run_id');

-- ---------------------------------------------------------------------------
-- 2. Helpers and guards (every role, including the service role; a row with no org passes so RLS answers the probe)
-- ---------------------------------------------------------------------------
-- The books' accumulated depreciation for one asset: the opening amount plus what the posted run versions hold.
create or replace function app.acc_asset_posted_accum(p_asset_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select a.opening_accumulated from public.acc_assets a where a.id = p_asset_id), 0)
       + coalesce((select sum(l.amount)
                   from public.acc_asset_run_lines l
                   join public.acc_depreciation_runs r on r.id = l.run_id
                   where l.asset_id = p_asset_id and r.posted_version is not null and l.version = r.posted_version), 0);
$$;
revoke all on function app.acc_asset_posted_accum(uuid) from public, anon, authenticated;

create or replace function app.acc_schedule_posted(p_schedule_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(l.amount), 0)
  from public.acc_asset_run_lines l
  join public.acc_depreciation_runs r on r.id = l.run_id
  where l.schedule_id = p_schedule_id and r.posted_version is not null and l.version = r.posted_version;
$$;
revoke all on function app.acc_schedule_posted(uuid) from public, anon, authenticated;

-- A ledger (not a group) of the org with the given nature(s); used by the guards.
create or replace function app.acc_ledger_nature(p_org_id uuid, p_account_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select a.nature from public.acc_accounts a
  where a.id = p_account_id and a.org_id = p_org_id and not a.is_group;
$$;
revoke all on function app.acc_ledger_nature(uuid, uuid) from public, anon, authenticated;

-- A branch must exist and book into the row's entity.
create or replace function app.acc_branch_in_entity(p_org_id uuid, p_entity_id uuid, p_branch text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_branch is null or (
    exists (select 1 from public.fin_ref_branches b where b.org_id = p_org_id and b.code = p_branch)
    and exists (select 1 from public.acc_entity_branches eb
                where eb.org_id = p_org_id and eb.branch_code = p_branch and eb.entity_id = p_entity_id));
$$;
revoke all on function app.acc_branch_in_entity(uuid, uuid, text) from public, anon, authenticated;

create or replace function app.acc_asset_class_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.org_id is null or new.cost_account_id is null then
    return new;   -- an incomplete row (the cross-org probe): row level security and NOT NULL answer
  end if;
  if app.acc_ledger_nature(new.org_id, new.cost_account_id) is distinct from 'asset'
     or app.acc_ledger_nature(new.org_id, new.accum_account_id) is distinct from 'asset'
     or app.acc_ledger_nature(new.org_id, new.expense_account_id) is distinct from 'expense'
     or app.acc_ledger_nature(new.org_id, new.disposal_account_id) not in ('income', 'expense')
     or app.acc_ledger_nature(new.org_id, new.disposal_account_id) is null
     or new.cost_account_id = new.accum_account_id then
    raise exception 'Choose an asset ledger for cost, another asset ledger for accumulated depreciation, an expense ledger for depreciation and an income or expense ledger for gains and losses.'
      using errcode = 'check_violation', hint = 'class_accounts';
  end if;
  return new;
end;
$$;
revoke all on function app.acc_asset_class_guard() from public, anon, authenticated;
create trigger acc_asset_classes_guard before insert or update on public.acc_asset_classes
  for each row execute function app.acc_asset_class_guard();

-- The register: the class and branch belong to the entity; the cost of the assets linked to a supplier invoice stays
-- within its net amount; once depreciation is posted for an asset its figures (cost, residual, life, method, dates,
-- class, entity) no longer change; status and disposal columns change only inside the functions below
-- (app.acc_asset_ctx); a disposed asset never changes; an asset with run lines is never deleted.
create or replace function app.acc_asset_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ctx text := coalesce(current_setting('app.acc_asset_ctx', true), '');
  v_prot text[] := array['status', 'disposal_status', 'disposal_date', 'disposal_proceeds', 'disposal_account_id',
                         'disposal_accumulated', 'disposal_posted_accum', 'disposal_sha256', 'disposal_prepared_at',
                         'disposal_posted_at', 'disposal_journal_id'];
  v_users text[] := array['disposal_prepared_by', 'disposal_posted_by', 'created_by'];
  v_fin text[] := array['cost', 'residual', 'life_months', 'method', 'in_service_date', 'acquisition_date', 'class_id',
                        'entity_id', 'opening_accumulated'];
  v_net numeric;
  v_used numeric;
  k text;
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.orgs o where o.id = old.org_id) and (
         exists (select 1 from public.acc_asset_run_lines l where l.asset_id = old.id)
         or old.disposal_status is not null) then
      raise exception 'This asset has depreciation or a disposal. It cannot be deleted.' using errcode = 'check_violation', hint = 'asset_in_use';
    end if;
    return old;
  end if;
  if new.org_id is null or new.entity_id is null or new.class_id is null then
    return new;   -- an incomplete row (the cross-org probe): row level security and NOT NULL answer
  end if;
  if tg_op = 'INSERT' then
    if v_ctx <> 'on' and (new.status <> 'active' or new.disposal_status is not null) then
      raise exception 'A new asset is active.' using errcode = 'check_violation', hint = 'invalid';
    end if;
  else
    -- a removed user's id nulled by the foreign key action
    foreach k in array v_users loop
      if to_jsonb(new) -> k is distinct from to_jsonb(old) -> k and to_jsonb(new) -> k <> 'null'::jsonb and v_ctx <> 'on' then
        raise exception 'Who prepared or posted is recorded by Pulse.' using errcode = 'check_violation', hint = 'invalid';
      end if;
    end loop;
    if v_ctx <> 'on' then
      foreach k in array v_prot loop
        if to_jsonb(new) -> k is distinct from to_jsonb(old) -> k then
          raise exception 'Status and disposal change through Pulse only.' using errcode = 'check_violation', hint = 'invalid';
        end if;
      end loop;
      if old.status = 'disposed' or old.disposal_status in ('posted', 'waiting_ledger_start') then
        if (to_jsonb(new) - v_users - 'updated_at') is distinct from (to_jsonb(old) - v_users - 'updated_at') then
          raise exception 'A disposed asset does not change.' using errcode = 'check_violation', hint = 'asset_disposed';
        end if;
      end if;
    end if;
    if exists (select 1 from public.acc_asset_run_lines l join public.acc_depreciation_runs r on r.id = l.run_id
               where l.asset_id = old.id and r.posted_version is not null and l.version = r.posted_version) then
      foreach k in array v_fin loop
        if to_jsonb(new) -> k is distinct from to_jsonb(old) -> k then
          raise exception 'Depreciation is posted for this asset; its cost, life, method and dates no longer change.'
            using errcode = 'check_violation', hint = 'asset_in_use';
        end if;
      end loop;
    end if;
  end if;
  if not app.acc_branch_in_entity(new.org_id, new.entity_id, new.branch_code) then
    raise exception 'The branch is unknown or books into another entity.' using errcode = 'check_violation', hint = 'branch_unknown';
  end if;
  if new.supplier_invoice_id is not null and (tg_op = 'INSERT' or new.supplier_invoice_id is distinct from old.supplier_invoice_id
                                               or new.cost <> old.cost) then
    select i.net into v_net from public.fin_supplier_invoices i where i.id = new.supplier_invoice_id and i.org_id = new.org_id;
    select coalesce(sum(a.cost), 0) into v_used from public.acc_assets a
     where a.supplier_invoice_id = new.supplier_invoice_id and a.id <> new.id;
    if v_net is null or v_used + new.cost > v_net then
      raise exception 'The assets linked to this bill would cost more than its net amount.' using errcode = 'check_violation', hint = 'invoice_over_capitalised';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.acc_asset_guard() from public, anon, authenticated;
create trigger acc_assets_guard before insert or update or delete on public.acc_assets
  for each row execute function app.acc_asset_guard();

-- Schedules: the accounts fit the kind; once a release is posted the amounts, months, accounts and kind no longer change
-- (cancel the schedule instead); a schedule with run lines is never deleted; 'completed' is set by the run.
create or replace function app.acc_schedule_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ctx text := coalesce(current_setting('app.acc_asset_ctx', true), '');
  v_pl text;
  v_bs text;
  v_fin text[] := array['kind', 'pl_account_id', 'bs_account_id', 'total', 'start_month', 'months', 'entity_id',
                        'auto_reverse'];
  k text;
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.orgs o where o.id = old.org_id)
       and exists (select 1 from public.acc_asset_run_lines l where l.schedule_id = old.id) then
      raise exception 'This schedule has releases. Cancel it instead.' using errcode = 'check_violation', hint = 'schedule_in_use';
    end if;
    return old;
  end if;
  if new.org_id is null or new.entity_id is null or new.pl_account_id is null or new.bs_account_id is null then
    return new;   -- an incomplete row (the cross-org probe): row level security and NOT NULL answer
  end if;
  v_pl := app.acc_ledger_nature(new.org_id, new.pl_account_id);
  v_bs := app.acc_ledger_nature(new.org_id, new.bs_account_id);
  if (new.kind = 'prepayment' and (v_pl is distinct from 'expense' or v_bs is distinct from 'asset'))
     or (new.kind = 'accrual' and (v_pl is distinct from 'expense' or v_bs is distinct from 'liability'))
     or (new.kind = 'deferred_revenue' and (v_pl is distinct from 'income' or v_bs is distinct from 'liability')) then
    raise exception 'A prepayment pairs an expense with an asset ledger, an accrual an expense with a liability, deferred revenue an income with a liability.'
      using errcode = 'check_violation', hint = 'schedule_accounts';
  end if;
  if not app.acc_branch_in_entity(new.org_id, new.entity_id, new.branch_code) then
    raise exception 'The branch is unknown or books into another entity.' using errcode = 'check_violation', hint = 'branch_unknown';
  end if;
  if tg_op = 'UPDATE' then
    if new.status = 'completed' and old.status <> 'completed' and v_ctx <> 'on' then
      raise exception 'A schedule is completed by its last release.' using errcode = 'check_violation', hint = 'invalid';
    end if;
    if old.status = 'cancelled' and new.status <> 'cancelled' and v_ctx <> 'on' then
      raise exception 'A cancelled schedule stays cancelled.' using errcode = 'check_violation', hint = 'invalid';
    end if;
    if exists (select 1 from public.acc_asset_run_lines l join public.acc_depreciation_runs r on r.id = l.run_id
               where l.schedule_id = old.id and r.posted_version is not null and l.version = r.posted_version) then
      foreach k in array v_fin loop
        if to_jsonb(new) -> k is distinct from to_jsonb(old) -> k then
          raise exception 'Releases are posted for this schedule; cancel it and enter a new one instead.'
            using errcode = 'check_violation', hint = 'schedule_in_use';
        end if;
      end loop;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.acc_schedule_guard() from public, anon, authenticated;
create trigger acc_schedules_guard before insert or update or delete on public.acc_schedules
  for each row execute function app.acc_schedule_guard();

-- Runs and their lines change only inside the functions below (a removed user's id nulled by the FK action and the org
-- cascade excepted).
create or replace function app.acc_run_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ctx text := coalesce(current_setting('app.acc_asset_ctx', true), '');
  v_users text[] := array['prepared_by', 'posted_by', 'updated_at'];
begin
  if v_ctx = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    if exists (select 1 from public.orgs o where o.id = old.org_id) then
      raise exception 'Runs change through Pulse only.' using errcode = '42501', hint = 'posted_immutable';
    end if;
    return old;
  end if;
  if new.org_id is null then
    return new;
  end if;
  -- a removed user's id nulled by the foreign key action (runs only; lines carry no user)
  if tg_op = 'UPDATE' and tg_table_name = 'acc_depreciation_runs' then
    if (to_jsonb(new) - v_users) = (to_jsonb(old) - v_users)
       and (to_jsonb(new) ->> 'prepared_by' is null or to_jsonb(new) -> 'prepared_by' = to_jsonb(old) -> 'prepared_by')
       and (to_jsonb(new) ->> 'posted_by' is null or to_jsonb(new) -> 'posted_by' = to_jsonb(old) -> 'posted_by') then
      return new;
    end if;
  end if;
  raise exception 'Runs change through Pulse only.' using errcode = '42501', hint = 'posted_immutable';
end;
$$;
revoke all on function app.acc_run_guard() from public, anon, authenticated;
create trigger acc_depreciation_runs_guard before insert or update or delete on public.acc_depreciation_runs
  for each row execute function app.acc_run_guard();
create trigger acc_asset_run_lines_guard before insert or update or delete on public.acc_asset_run_lines
  for each row execute function app.acc_run_guard();

-- A reversing-accrual run's journal reverses itself on the 1st of the next month. acc_post_from_source (22A) has no
-- parameter for that, so the run sets app.acc_asset_auto_reverse to '<source kind>|<source id>|<date>' for the length
-- of the call and this trigger stamps auto_reverse_on on that one journal while it is still a draft (before posting).
create or replace function app.acc_journal_asset_auto_reverse()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v text := coalesce(current_setting('app.acc_asset_auto_reverse', true), '');
  v_parts text[];
begin
  if v = '' or new.status <> 'draft' or new.source_kind is null then
    return new;
  end if;
  v_parts := string_to_array(v, '|');
  if array_length(v_parts, 1) = 3 and new.source_kind = v_parts[1] and new.source_id = v_parts[2] then
    new.auto_reverse_on := v_parts[3]::date;
  end if;
  return new;
end;
$$;
revoke all on function app.acc_journal_asset_auto_reverse() from public, anon, authenticated;
create trigger acc_journals_asset_auto_reverse before insert on public.acc_journals
  for each row execute function app.acc_journal_asset_auto_reverse();

-- ---------------------------------------------------------------------------
-- 3. Row level security: anyone with an accounting key reads (amounts, codes and dates only); no write policy
-- ---------------------------------------------------------------------------
alter table public.acc_asset_classes enable row level security;
alter table public.acc_assets enable row level security;
alter table public.acc_schedules enable row level security;
alter table public.acc_depreciation_runs enable row level security;
alter table public.acc_asset_run_lines enable row level security;

create policy acc_asset_classes_select on public.acc_asset_classes for select to authenticated using (app.acc_can_view(org_id));
create policy acc_assets_select on public.acc_assets for select to authenticated using (app.acc_can_view(org_id));
create policy acc_schedules_select on public.acc_schedules for select to authenticated using (app.acc_can_view(org_id));
create policy acc_depreciation_runs_select on public.acc_depreciation_runs for select to authenticated using (app.acc_can_view(org_id));
create policy acc_asset_run_lines_select on public.acc_asset_run_lines for select to authenticated using (app.acc_can_view(org_id));

-- ---------------------------------------------------------------------------
-- 4. Seed: fixed-asset ledgers, deferred revenue, the disposal gain / loss ledger and the five classes (idempotent)
-- ---------------------------------------------------------------------------
create or replace function public.acc_assets_seed(p_org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_accounts integer := 0;
  v_classes integer := 0;
  v_n integer;
  g record;
begin
  if not exists (select 1 from public.orgs o where o.id = p_org_id) then
    raise exception 'Organisation not found.' using errcode = 'no_data_found', hint = 'not_found';
  end if;
  for g in
    select * from (values
      ('1520', 'IT equipment',                                     'G-FA',   'asset'),
      ('1530', 'Leasehold improvements',                           'G-FA',   'asset'),
      ('1540', 'Motor vehicles',                                   'G-FA',   'asset'),
      ('1591', 'Accumulated depreciation - medical equipment',     'G-FA',   'asset'),
      ('1592', 'Accumulated depreciation - IT equipment',          'G-FA',   'asset'),
      ('1593', 'Accumulated depreciation - furniture and fittings', 'G-FA',  'asset'),
      ('1594', 'Accumulated depreciation - leasehold improvements', 'G-FA',  'asset'),
      ('1595', 'Accumulated depreciation - motor vehicles',        'G-FA',   'asset'),
      ('2310', 'Deferred revenue',                                 'G-CL',   'liability'),
      ('4910', 'Gain or loss on disposal of fixed assets',         'G-IINC', 'income')
    ) as t (code, name, parent, nature)
  loop
    v_accounts := v_accounts + app.acc_seed_account(p_org_id, g.code, g.name, g.parent, false, g.nature, null, null, false, 100);
  end loop;

  -- straight line, no residual by default; leasehold improvements: 60 months or the lease term, whichever is shorter
  insert into public.acc_asset_classes (org_id, code, name, cost_account_id, accum_account_id, expense_account_id,
                                        disposal_account_id, method, life_months, residual_pct)
  select p_org_id, t.code, t.name, c.id, a.id, e.id, d.id, 'straight_line', t.life, 0
  from (values
    ('MED',  'Medical equipment',      '1500', '1591', 60),
    ('IT',   'IT equipment',           '1520', '1592', 36),
    ('FURN', 'Furniture and fittings', '1510', '1593', 60),
    ('LHI',  'Leasehold improvements', '1530', '1594', 60),
    ('VEH',  'Motor vehicles',         '1540', '1595', 60)
  ) as t (code, name, cost_code, accum_code, life)
  join public.acc_accounts c on c.org_id = p_org_id and c.code = t.cost_code and not c.is_group and c.nature = 'asset'
  join public.acc_accounts a on a.org_id = p_org_id and a.code = t.accum_code and not a.is_group and a.nature = 'asset'
  join public.acc_accounts e on e.org_id = p_org_id and e.code = '6400' and not e.is_group and e.nature = 'expense'
  join public.acc_accounts d on d.org_id = p_org_id and d.code = '4910' and not d.is_group and d.nature in ('income', 'expense')
  on conflict do nothing;
  get diagnostics v_n = row_count;
  v_classes := v_n;
  return jsonb_build_object('accounts_added', v_accounts, 'classes_added', v_classes);
end;
$$;
revoke all on function public.acc_assets_seed(uuid) from public, anon, authenticated;
grant execute on function public.acc_assets_seed(uuid) to service_role;

-- New workspaces: after the chart (orgs_seed_finance_phase22 fires first; same-event triggers run in name order).
create or replace function app.acc_assets_seed_on_org_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.acc_assets_seed(new.id);
  return new;
end;
$$;
revoke all on function app.acc_assets_seed_on_org_insert() from public, anon, authenticated;
create trigger orgs_seed_finance_phase22h after insert on public.orgs
  for each row execute function app.acc_assets_seed_on_org_insert();

-- ---------------------------------------------------------------------------
-- 5. Runs: prepare (the amounts come from lib/accounting/assets; the database derives accounts and dimensions and
--    hashes the lines) and post (a different person with accounting.journals.approve, bound to the hash)
-- ---------------------------------------------------------------------------
-- The canonical text of a run's lines (jsonb array of resolved lines, any order) and its sha256.
create or replace function app.acc_run_lines_hash(p_kind text, p_entity_id uuid, p_month date, p_lines jsonb)
returns text
language sql
immutable
security definer
set search_path = ''
as $$
  select encode(sha256(convert_to(
    'pulse-acc-run-v1' || E'\n' || p_kind || '|' || p_entity_id::text || '|' || to_char(p_month, 'YYYY-MM') || E'\n' ||
    coalesce((select string_agg(
                coalesce(x ->> 'asset_id', '') || '|' || coalesce(x ->> 'schedule_id', '') || '|' ||
                (x ->> 'debit_account_id') || '|' || (x ->> 'credit_account_id') || '|' ||
                coalesce(x ->> 'branch_code', '') || '|' || coalesce(x ->> 'department', '') || '|' ||
                to_char((x ->> 'amount')::numeric, 'FM999999999990.00'),
                E'\n' order by coalesce(x ->> 'asset_id', x ->> 'schedule_id'))
              from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) as x), ''),
    'UTF8')), 'hex');
$$;
revoke all on function app.acc_run_lines_hash(text, uuid, date, jsonb) from public, anon, authenticated;

create or replace function app.acc_run_stored_lines(p_run_id uuid, p_version integer)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'asset_id', l.asset_id, 'schedule_id', l.schedule_id, 'debit_account_id', l.debit_account_id,
    'credit_account_id', l.credit_account_id, 'branch_code', l.branch_code, 'department', l.department,
    'amount', l.amount)), '[]'::jsonb)
  from public.acc_asset_run_lines l where l.run_id = p_run_id and l.version = p_version;
$$;
revoke all on function app.acc_run_stored_lines(uuid, integer) from public, anon, authenticated;

-- p_lines: [{ "asset_id": uuid, "amount": 123.45 }] for depreciation, [{ "schedule_id": uuid, "amount": ... }] for
-- schedules and reversing_accruals. p_user_id null = the monthly job. Idempotent: the same lines return the run
-- unchanged (changed: false). A posted month whose lines differ becomes a new draft version; a draft is replaced and its
-- editor becomes its preparer. A month before a later posted month of the same kind is refused (the later month already
-- caught up on it).
create or replace function public.acc_asset_run_prepare(
  p_org_id uuid, p_entity_id uuid, p_kind text, p_month date, p_user_id uuid, p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entity uuid := p_entity_id;
  v_month date;
  v_resolved jsonb := '[]'::jsonb;
  v_hash text;
  v_total numeric := 0;
  v_count integer := 0;
  r public.acc_depreciation_runs;
  it jsonb;
  v_amount numeric;
  v_ref uuid;
  a record;
  s record;
  v_version integer;
  v_found boolean;
begin
  if p_user_id is not null and not app.user_has_perm(p_org_id, p_user_id, 'accounting.assets.manage') then
    raise exception 'You cannot manage fixed assets.' using errcode = 'check_violation', hint = 'not_permitted';
  end if;
  if p_kind is null or p_kind not in ('depreciation', 'schedules', 'reversing_accruals') or p_month is null then
    raise exception 'Choose the run and the month.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  v_month := date_trunc('month', p_month)::date;
  if v_month > date_trunc('month', current_date)::date then
    raise exception 'A future month cannot be run yet.' using errcode = 'check_violation', hint = 'future_month';
  end if;
  if v_entity is null then
    select e.id into v_entity from public.acc_entities e where e.org_id = p_org_id and e.is_default;
  end if;
  if not exists (select 1 from public.acc_entities e where e.id = v_entity and e.org_id = p_org_id and e.active) then
    raise exception 'Entity not found.' using errcode = 'check_violation', hint = 'entity_unknown';
  end if;
  if jsonb_typeof(coalesce(p_lines, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) > 5000 then
    raise exception 'Too many lines.' using errcode = 'check_violation', hint = 'invalid';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || '|acc_run|' || v_entity::text || '|' || p_kind, 22));

  if exists (select 1 from public.acc_depreciation_runs x
             where x.org_id = p_org_id and x.entity_id = v_entity and x.kind = p_kind and x.period_month > v_month
               and x.posted_version is not null) then
    raise exception 'A later month is already posted; run that month instead.' using errcode = 'check_violation', hint = 'later_month_posted';
  end if;

  for it in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    begin
      v_amount := (it ->> 'amount')::numeric;
      v_ref := coalesce(it ->> 'asset_id', it ->> 'schedule_id')::uuid;
    exception when others then
      raise exception 'A line is not valid.' using errcode = 'check_violation', hint = 'invalid';
    end;
    if v_amount is null or v_amount <= 0 or v_amount <> round(v_amount, 2) or v_amount >= 1e12 then
      raise exception 'Amounts are positive with at most two decimals.' using errcode = 'check_violation', hint = 'bad_amount';
    end if;
    if p_kind = 'depreciation' then
      if it ? 'schedule_id' then
        raise exception 'A depreciation run holds assets only.' using errcode = 'check_violation', hint = 'invalid';
      end if;
      select x.id, x.branch_code, x.department, k.expense_account_id, k.accum_account_id, x.in_service_date
        into a
        from public.acc_assets x join public.acc_asset_classes k on k.id = x.class_id
       where x.id = v_ref and x.org_id = p_org_id and x.entity_id = v_entity;
      if not found then
        raise exception 'An asset is unknown or belongs to another entity.' using errcode = 'check_violation', hint = 'asset_unknown';
      end if;
      if date_trunc('month', a.in_service_date)::date > v_month then
        raise exception 'An asset is not in service in this month.' using errcode = 'check_violation', hint = 'asset_not_in_service';
      end if;
      v_resolved := v_resolved || jsonb_build_object('asset_id', a.id, 'schedule_id', null,
        'debit_account_id', a.expense_account_id, 'credit_account_id', a.accum_account_id,
        'branch_code', a.branch_code, 'department', a.department, 'amount', v_amount);
    else
      if it ? 'asset_id' then
        raise exception 'A schedule run holds schedules only.' using errcode = 'check_violation', hint = 'invalid';
      end if;
      select x.id, x.kind, x.auto_reverse, x.pl_account_id, x.bs_account_id, x.branch_code, x.department, x.start_month
        into s
        from public.acc_schedules x
       where x.id = v_ref and x.org_id = p_org_id and x.entity_id = v_entity;
      if not found then
        raise exception 'A schedule is unknown or belongs to another entity.' using errcode = 'check_violation', hint = 'schedule_unknown';
      end if;
      if (p_kind = 'reversing_accruals') <> (s.kind = 'accrual' and s.auto_reverse) or s.start_month > v_month then
        raise exception 'A schedule does not belong in this run or month.' using errcode = 'check_violation', hint = 'schedule_unknown';
      end if;
      v_resolved := v_resolved || jsonb_build_object('asset_id', null, 'schedule_id', s.id,
        'debit_account_id', case when s.kind = 'deferred_revenue' then s.bs_account_id else s.pl_account_id end,
        'credit_account_id', case when s.kind = 'deferred_revenue' then s.pl_account_id else s.bs_account_id end,
        'branch_code', s.branch_code, 'department', s.department, 'amount', v_amount);
    end if;
    v_total := v_total + v_amount;
    v_count := v_count + 1;
  end loop;
  if (select count(distinct coalesce(x ->> 'asset_id', x ->> 'schedule_id')) from jsonb_array_elements(v_resolved) x) <> v_count then
    raise exception 'An asset or schedule appears twice.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  v_hash := app.acc_run_lines_hash(p_kind, v_entity, v_month, v_resolved);

  select * into r from public.acc_depreciation_runs x
   where x.org_id = p_org_id and x.entity_id = v_entity and x.kind = p_kind and x.period_month = v_month
   for update;
  v_found := found;
  perform set_config('app.acc_asset_ctx', 'on', true);
  if not v_found then
    insert into public.acc_depreciation_runs (org_id, entity_id, kind, period_month, version, status, total, line_count,
                                              sha256, prepared_by)
    values (p_org_id, v_entity, p_kind, v_month, 1, 'draft', v_total, v_count, v_hash, p_user_id)
    returning * into r;
    v_version := 1;
  elsif r.status = 'posted' and r.posted_sha256 = v_hash then
    perform set_config('app.acc_asset_ctx', '', true);
    return jsonb_build_object('id', r.id, 'version', r.version, 'status', r.status, 'sha256', r.sha256,
                              'total', r.total, 'lines', r.line_count, 'changed', false);
  elsif r.status <> 'posted' and r.sha256 = v_hash then
    perform set_config('app.acc_asset_ctx', '', true);
    return jsonb_build_object('id', r.id, 'version', r.version, 'status', r.status, 'sha256', r.sha256,
                              'total', r.total, 'lines', r.line_count, 'changed', false);
  else
    v_version := case when r.status = 'posted' then r.version + 1 else r.version end;
    delete from public.acc_asset_run_lines l where l.run_id = r.id and l.version = v_version;
    update public.acc_depreciation_runs set version = v_version, status = 'draft', total = v_total, line_count = v_count,
      sha256 = v_hash, prepared_by = p_user_id, prepared_at = now()
    where id = r.id
    returning * into r;
  end if;
  insert into public.acc_asset_run_lines (org_id, run_id, version, asset_id, schedule_id, debit_account_id,
                                          credit_account_id, branch_code, department, amount)
  select p_org_id, r.id, v_version, nullif(x ->> 'asset_id', '')::uuid, nullif(x ->> 'schedule_id', '')::uuid,
         (x ->> 'debit_account_id')::uuid, (x ->> 'credit_account_id')::uuid, x ->> 'branch_code', x ->> 'department',
         (x ->> 'amount')::numeric
  from jsonb_array_elements(v_resolved) x;
  perform set_config('app.acc_asset_ctx', '', true);
  return jsonb_build_object('id', r.id, 'version', r.version, 'status', r.status, 'sha256', r.sha256, 'total', r.total,
                            'lines', r.line_count, 'changed', true);
end;
$$;
revoke all on function public.acc_asset_run_prepare(uuid, uuid, text, date, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.acc_asset_run_prepare(uuid, uuid, text, date, uuid, jsonb) to service_role;

-- Posts a prepared run (or retries one waiting for the ledger start). Check order: not_found, wrong_status,
-- not_permitted, same_person, hash_mismatch, later_month_posted, over_depreciated / asset_disposed, then the ledger rules
-- of acc_post_from_source. An empty run posts no journal (and reverses the previous version's, if any).
create or replace function public.acc_asset_run_post(p_org_id uuid, p_run_id uuid, p_user_id uuid, p_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.acc_depreciation_runs;
  v_lines jsonb;
  v_desc text;
  v_narration text;
  v_month_end date;
  v_res jsonb;
  v_hint text;
  v_old public.acc_journals;
  v_bad uuid;
begin
  select * into r from public.acc_depreciation_runs where id = p_run_id and org_id = p_org_id for update;
  if not found then
    raise exception 'Run not found.' using errcode = 'no_data_found', hint = 'not_found';
  end if;
  if r.status not in ('draft', 'waiting_ledger_start') then
    raise exception 'This run is already posted.' using errcode = 'check_violation', hint = 'wrong_status';
  end if;
  if not app.user_has_perm(p_org_id, p_user_id, 'accounting.journals.approve') then
    raise exception 'You cannot post journals.' using errcode = 'check_violation', hint = 'not_permitted';
  end if;
  if p_user_id is not distinct from r.prepared_by then
    raise exception 'The person who prepared the run cannot post it.' using errcode = 'check_violation', hint = 'same_person';
  end if;
  if p_hash is null or p_hash <> r.sha256
     or r.sha256 <> app.acc_run_lines_hash(r.kind, r.entity_id, r.period_month, app.acc_run_stored_lines(r.id, r.version)) then
    raise exception 'The run changed since you opened it; reload and review it again.' using errcode = 'check_violation', hint = 'hash_mismatch';
  end if;
  if exists (select 1 from public.acc_depreciation_runs x
             where x.org_id = p_org_id and x.entity_id = r.entity_id and x.kind = r.kind and x.period_month > r.period_month
               and x.posted_version is not null) then
    raise exception 'A later month is already posted.' using errcode = 'check_violation', hint = 'later_month_posted';
  end if;

  if r.kind = 'depreciation' then
    -- never beyond the depreciable amount, counting every other posted month and this run
    select l.asset_id into v_bad
      from public.acc_asset_run_lines l join public.acc_assets a on a.id = l.asset_id
     where l.run_id = r.id and l.version = r.version
       and l.amount + a.opening_accumulated + coalesce((select sum(o.amount) from public.acc_asset_run_lines o
                                join public.acc_depreciation_runs orun on orun.id = o.run_id
                                where o.asset_id = l.asset_id and orun.id <> r.id and orun.posted_version is not null
                                  and o.version = orun.posted_version), 0) > a.cost - a.residual
     limit 1;
    if v_bad is not null then
      raise exception 'An asset would be depreciated below its residual value.' using errcode = 'check_violation', hint = 'over_depreciated';
    end if;
    -- a disposed asset keeps exactly what the previous posted version of this month had (nothing new after disposal)
    select l.asset_id into v_bad
      from public.acc_asset_run_lines l join public.acc_assets a on a.id = l.asset_id
     where l.run_id = r.id and l.version = r.version and a.status = 'disposed'
       and l.amount is distinct from (select p.amount from public.acc_asset_run_lines p
                                      where p.run_id = r.id and p.version = r.posted_version and p.asset_id = l.asset_id)
     limit 1;
    if v_bad is not null then
      raise exception 'A disposed asset is not depreciated again.' using errcode = 'check_violation', hint = 'asset_disposed';
    end if;
  end if;

  v_month_end := (r.period_month + interval '1 month' - interval '1 day')::date;
  v_desc := case r.kind when 'depreciation' then 'Depreciation ' when 'schedules' then 'Schedule releases '
                        else 'Reversing accruals ' end || to_char(r.period_month, 'YYYY-MM');
  v_narration := case r.kind
    when 'depreciation' then 'Depreciation for ' || to_char(r.period_month, 'YYYY-MM')
    when 'schedules' then 'Prepayment, accrual and deferred revenue releases for ' || to_char(r.period_month, 'YYYY-MM')
    else 'Reversing accruals for ' || to_char(r.period_month, 'YYYY-MM') || ' (reversed on the 1st of the next month)' end
    || case when r.version > 1 then ' (version ' || r.version::text || ')' else '' end;

  -- one debit and one credit per account pair and dimension
  select coalesce(jsonb_agg(x.line order by x.k, x.side), '[]'::jsonb) into v_lines
  from (
    select g.k, s.side, case s.side
             when 1 then jsonb_build_object('account_id', g.debit_account_id, 'debit', g.amt, 'credit', 0,
                                            'branch_code', g.branch_code, 'department', g.department, 'description', v_desc)
             else jsonb_build_object('account_id', g.credit_account_id, 'debit', 0, 'credit', g.amt,
                                     'branch_code', g.branch_code, 'department', g.department, 'description', v_desc) end as line
    from (
      select l.debit_account_id, l.credit_account_id, l.branch_code, l.department, sum(l.amount) as amt,
             l.debit_account_id::text || '|' || l.credit_account_id::text || '|' || coalesce(l.branch_code, '') || '|' ||
             coalesce(l.department, '') as k
      from public.acc_asset_run_lines l where l.run_id = r.id and l.version = r.version
      group by l.debit_account_id, l.credit_account_id, l.branch_code, l.department
    ) g cross join (values (1), (2)) as s (side)
  ) x;

  begin
    if jsonb_array_length(v_lines) = 0 then
      -- nothing to post: the previous version's journal (if still live) is reversed
      select * into v_old from public.acc_journals j
       where j.org_id = p_org_id and j.source_kind = 'fixed_asset' and j.source_id = r.id::text and j.status = 'posted';
      if found then
        perform app.acc_reverse_internal(p_org_id, v_old.id, null, greatest(v_month_end, v_old.journal_date),
                                         'replaced by version ' || r.version::text || ' (no lines)');
      end if;
      v_res := jsonb_build_object('id', null, 'number', null);
    else
      if r.kind = 'reversing_accruals' then
        perform set_config('app.acc_asset_auto_reverse',
                           'fixed_asset|' || r.id::text || '|' || to_char(r.period_month + interval '1 month', 'YYYY-MM-DD'), true);
      end if;
      v_res := public.acc_post_from_source(p_org_id, r.entity_id, 'fixed_asset', r.id::text, r.version, v_month_end,
                                           'journal', v_narration, v_lines);
      perform set_config('app.acc_asset_auto_reverse', '', true);
    end if;
  exception when others then
    perform set_config('app.acc_asset_auto_reverse', '', true);
    get stacked diagnostics v_hint = pg_exception_hint;
    if v_hint = 'before_ledger_start' then
      perform set_config('app.acc_asset_ctx', 'on', true);
      update public.acc_depreciation_runs set status = 'waiting_ledger_start' where id = r.id;
      perform set_config('app.acc_asset_ctx', '', true);
      return jsonb_build_object('id', r.id, 'status', 'waiting_ledger_start', 'journal_id', null);
    end if;
    raise;
  end;

  perform set_config('app.acc_asset_ctx', 'on', true);
  update public.acc_depreciation_runs set status = 'posted', posted_by = p_user_id, posted_at = now(),
    posted_version = r.version, posted_sha256 = r.sha256, journal_id = nullif(v_res ->> 'id', '')::uuid
  where id = r.id;
  delete from public.acc_asset_run_lines l where l.run_id = r.id and l.version <> r.version;

  if r.kind = 'depreciation' then
    update public.acc_assets a set status = case when app.acc_asset_posted_accum(a.id) >= a.cost - a.residual
                                                 then 'fully_depreciated' else 'active' end
     where a.org_id = p_org_id and a.entity_id = r.entity_id and a.status in ('active', 'fully_depreciated')
       and a.status <> case when app.acc_asset_posted_accum(a.id) >= a.cost - a.residual
                            then 'fully_depreciated' else 'active' end;
  elsif r.kind = 'schedules' then
    update public.acc_schedules s set status = 'completed'
     where s.org_id = p_org_id and s.entity_id = r.entity_id and s.status = 'active'
       and not (s.kind = 'accrual' and s.auto_reverse) and app.acc_schedule_posted(s.id) >= s.total;
  else
    update public.acc_schedules s set status = 'completed'
     where s.org_id = p_org_id and s.entity_id = r.entity_id and s.status = 'active' and s.kind = 'accrual' and s.auto_reverse
       and (s.start_month + make_interval(months => s.months - 1))::date <= r.period_month;
  end if;
  perform set_config('app.acc_asset_ctx', '', true);
  return jsonb_build_object('id', r.id, 'status', 'posted', 'version', r.version, 'journal_id', v_res ->> 'id',
                            'number', v_res ->> 'number');
end;
$$;
revoke all on function public.acc_asset_run_post(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.acc_asset_run_post(uuid, uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Disposals: prepared by someone who manages assets, posted by a different person with journals.approve
-- ---------------------------------------------------------------------------
-- p_data: { disposal_date, proceeds, proceeds_account_id (required when proceeds > 0), accumulated }. `accumulated` is
-- the depreciation schedule through the month before the disposal month (lib/accounting/assets/depreciation.ts,
-- disposalFigures), raised to what is already in the books if that is more; the database records what was posted so
-- far and hashes everything.
create or replace function app.acc_disposal_hash(
  p_asset_id uuid, p_date date, p_proceeds numeric, p_account uuid, p_accum numeric, p_posted numeric, p_cost numeric
)
returns text
language sql
immutable
security definer
set search_path = ''
as $$
  select encode(sha256(convert_to('pulse-acc-disposal-v1|' || p_asset_id::text || '|' || p_date::text || '|' ||
    to_char(p_proceeds, 'FM999999999990.00') || '|' || coalesce(p_account::text, '') || '|' ||
    to_char(p_accum, 'FM999999999990.00') || '|' || to_char(p_posted, 'FM999999999990.00') || '|' ||
    to_char(p_cost, 'FM999999999990.00'), 'UTF8')), 'hex');
$$;
revoke all on function app.acc_disposal_hash(uuid, date, numeric, uuid, numeric, numeric, numeric) from public, anon, authenticated;

create or replace function public.acc_asset_disposal_prepare(p_org_id uuid, p_asset_id uuid, p_user_id uuid, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.acc_assets;
  v_date date;
  v_proceeds numeric;
  v_account uuid;
  v_accum numeric;
  v_posted numeric;
  v_hash text;
begin
  if not app.user_has_perm(p_org_id, p_user_id, 'accounting.assets.manage') then
    raise exception 'You cannot manage fixed assets.' using errcode = 'check_violation', hint = 'not_permitted';
  end if;
  select * into a from public.acc_assets where id = p_asset_id and org_id = p_org_id for update;
  if not found then
    raise exception 'Asset not found.' using errcode = 'no_data_found', hint = 'not_found';
  end if;
  if a.status = 'disposed' or a.disposal_status in ('posted', 'waiting_ledger_start') then
    raise exception 'This asset is already disposed of.' using errcode = 'check_violation', hint = 'asset_disposed';
  end if;
  begin
    v_date := (p_data ->> 'disposal_date')::date;
    v_proceeds := coalesce(nullif(p_data ->> 'proceeds', '')::numeric, 0);
    v_account := nullif(p_data ->> 'proceeds_account_id', '')::uuid;
    v_accum := (p_data ->> 'accumulated')::numeric;
  exception when others then
    raise exception 'Check the date and amounts.' using errcode = 'check_violation', hint = 'invalid';
  end;
  if v_date is null or v_date < a.acquisition_date or v_date > current_date then
    raise exception 'The disposal date is between the acquisition date and today.' using errcode = 'check_violation', hint = 'disposal_date';
  end if;
  if v_proceeds < 0 or v_proceeds <> round(v_proceeds, 2) or v_proceeds >= 1e12
     or v_accum is null or v_accum < 0 or v_accum <> round(v_accum, 2) or v_accum > a.cost - a.residual then
    raise exception 'Amounts are positive with at most two decimals.' using errcode = 'check_violation', hint = 'bad_amount';
  end if;
  if v_proceeds > 0 and (v_account is null or app.acc_ledger_nature(p_org_id, v_account) is null) then
    raise exception 'Choose the ledger the proceeds go to.' using errcode = 'check_violation', hint = 'proceeds_account';
  end if;
  if v_proceeds = 0 then
    v_account := null;
  end if;
  v_posted := app.acc_asset_posted_accum(a.id);
  -- posted depreciation is never written back (a month already charged stays charged)
  v_accum := greatest(v_accum, v_posted);
  v_hash := app.acc_disposal_hash(a.id, v_date, v_proceeds, v_account, v_accum, v_posted, a.cost);
  perform set_config('app.acc_asset_ctx', 'on', true);
  update public.acc_assets set disposal_status = 'prepared', disposal_date = v_date, disposal_proceeds = v_proceeds,
    disposal_account_id = v_account, disposal_accumulated = v_accum, disposal_posted_accum = v_posted,
    disposal_sha256 = v_hash, disposal_prepared_by = p_user_id, disposal_prepared_at = now(),
    disposal_posted_by = null, disposal_posted_at = null
  where id = a.id;
  perform set_config('app.acc_asset_ctx', '', true);
  return jsonb_build_object('id', a.id, 'status', 'prepared', 'sha256', v_hash, 'posted_accumulated', v_posted,
                            'nbv', a.cost - v_accum, 'gain', v_proceeds - (a.cost - v_accum));
end;
$$;
revoke all on function public.acc_asset_disposal_prepare(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.acc_asset_disposal_prepare(uuid, uuid, uuid, jsonb) to service_role;

create or replace function public.acc_asset_disposal_cancel(p_org_id uuid, p_asset_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.acc_assets;
begin
  if not app.user_has_perm(p_org_id, p_user_id, 'accounting.assets.manage') then
    raise exception 'You cannot manage fixed assets.' using errcode = 'check_violation', hint = 'not_permitted';
  end if;
  select * into a from public.acc_assets where id = p_asset_id and org_id = p_org_id for update;
  if not found then
    raise exception 'Asset not found.' using errcode = 'no_data_found', hint = 'not_found';
  end if;
  if a.disposal_status is distinct from 'prepared' then
    raise exception 'Only a prepared disposal can be withdrawn.' using errcode = 'check_violation', hint = 'wrong_status';
  end if;
  perform set_config('app.acc_asset_ctx', 'on', true);
  update public.acc_assets set disposal_status = null, disposal_date = null, disposal_proceeds = null,
    disposal_account_id = null, disposal_accumulated = null, disposal_posted_accum = null, disposal_sha256 = null,
    disposal_prepared_by = null, disposal_prepared_at = null
  where id = a.id;
  perform set_config('app.acc_asset_ctx', '', true);
  return jsonb_build_object('id', a.id, 'status', null);
end;
$$;
revoke all on function public.acc_asset_disposal_cancel(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.acc_asset_disposal_cancel(uuid, uuid, uuid) to service_role;

-- Posts the disposal journal (source fixed_asset, id 'disposal:<asset id>'):
--   Dr accumulated depreciation   the opening amount plus what the runs posted (the asset's accumulated depreciation
--                                 in the ledger goes to 0)
--   Dr depreciation expense       the schedule through the month before disposal minus that, when positive (catch-up;
--                                 posted depreciation is never written back)
--   Dr proceeds ledger            the proceeds
--   Cr asset cost                 the cost
--   Cr gain / Dr loss             proceeds - (cost - accumulated)
create or replace function public.acc_asset_disposal_post(p_org_id uuid, p_asset_id uuid, p_user_id uuid, p_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.acc_assets;
  k public.acc_asset_classes;
  v_posted numeric;
  v_catch numeric;
  v_gain numeric;
  v_lines jsonb := '[]'::jsonb;
  v_desc text;
  v_res jsonb;
  v_hint text;
  v_dim jsonb;
begin
  select * into a from public.acc_assets where id = p_asset_id and org_id = p_org_id for update;
  if not found then
    raise exception 'Asset not found.' using errcode = 'no_data_found', hint = 'not_found';
  end if;
  if a.disposal_status not in ('prepared', 'waiting_ledger_start') or a.disposal_status is null then
    raise exception 'No disposal is waiting to post.' using errcode = 'check_violation', hint = 'wrong_status';
  end if;
  if not app.user_has_perm(p_org_id, p_user_id, 'accounting.journals.approve') then
    raise exception 'You cannot post journals.' using errcode = 'check_violation', hint = 'not_permitted';
  end if;
  if p_user_id is not distinct from a.disposal_prepared_by then
    raise exception 'The person who prepared the disposal cannot post it.' using errcode = 'check_violation', hint = 'same_person';
  end if;
  if p_hash is null or p_hash <> a.disposal_sha256
     or a.disposal_sha256 <> app.acc_disposal_hash(a.id, a.disposal_date, a.disposal_proceeds, a.disposal_account_id,
                                                  a.disposal_accumulated, a.disposal_posted_accum, a.cost) then
    raise exception 'The disposal changed since you opened it; reload and review it again.' using errcode = 'check_violation', hint = 'hash_mismatch';
  end if;
  v_posted := app.acc_asset_posted_accum(a.id);
  if v_posted <> a.disposal_posted_accum then
    raise exception 'Depreciation was posted since the disposal was prepared; prepare it again.' using errcode = 'check_violation', hint = 'disposal_stale';
  end if;
  select * into k from public.acc_asset_classes where id = a.class_id;
  v_catch := a.disposal_accumulated - v_posted;
  v_gain := a.disposal_proceeds - (a.cost - a.disposal_accumulated);
  v_desc := left('Disposal of asset ' || a.code, 200);
  v_dim := jsonb_build_object('branch_code', a.branch_code, 'department', a.department, 'description', v_desc);
  if v_posted > 0 then
    v_lines := v_lines || (v_dim || jsonb_build_object('account_id', k.accum_account_id, 'debit', v_posted, 'credit', 0));
  end if;
  if v_catch > 0 then
    v_lines := v_lines || (v_dim || jsonb_build_object('account_id', k.expense_account_id, 'debit', v_catch, 'credit', 0));
  end if;
  if a.disposal_proceeds > 0 then
    v_lines := v_lines || (v_dim || jsonb_build_object('account_id', a.disposal_account_id, 'debit', a.disposal_proceeds, 'credit', 0));
  end if;
  v_lines := v_lines || (v_dim || jsonb_build_object('account_id', k.cost_account_id, 'debit', 0, 'credit', a.cost));
  if v_gain > 0 then
    v_lines := v_lines || (v_dim || jsonb_build_object('account_id', k.disposal_account_id, 'debit', 0, 'credit', v_gain));
  elsif v_gain < 0 then
    v_lines := v_lines || (v_dim || jsonb_build_object('account_id', k.disposal_account_id, 'debit', -v_gain, 'credit', 0));
  end if;

  begin
    v_res := public.acc_post_from_source(p_org_id, a.entity_id, 'fixed_asset', 'disposal:' || a.id::text, 1,
                                         a.disposal_date, 'journal', left('Disposal of fixed asset ' || a.code, 300), v_lines);
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    if v_hint = 'before_ledger_start' then
      perform set_config('app.acc_asset_ctx', 'on', true);
      update public.acc_assets set disposal_status = 'waiting_ledger_start' where id = a.id;
      perform set_config('app.acc_asset_ctx', '', true);
      return jsonb_build_object('id', a.id, 'status', 'waiting_ledger_start', 'journal_id', null);
    end if;
    raise;
  end;
  perform set_config('app.acc_asset_ctx', 'on', true);
  update public.acc_assets set status = 'disposed', disposal_status = 'posted', disposal_posted_by = p_user_id,
    disposal_posted_at = now(), disposal_journal_id = (v_res ->> 'id')::uuid
  where id = a.id;
  perform set_config('app.acc_asset_ctx', '', true);
  return jsonb_build_object('id', a.id, 'status', 'posted', 'journal_id', v_res ->> 'id', 'number', v_res ->> 'number',
                            'gain', v_gain);
end;
$$;
revoke all on function public.acc_asset_disposal_post(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.acc_asset_disposal_post(uuid, uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Who changed it (record_history on the register), the monthly job, and every existing workspace's seed
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
    when 'acc_assets' then app.acc_can_view(p_org_id)
    else exists (
      select 1 from public.portal_objects po
      where po.org_id = p_org_id and po.table_name = p_table and app.has_perm_wild(p_org_id, po.read_perm)
    )
  end;
$$;
grant execute on function app.can_view_record_history(uuid, text) to authenticated, service_role;

select app.enable_record_history('acc_assets');

-- Daily at 04:25 UTC: on or after the first working day of a month, prepares (never posts) last month's depreciation
-- and schedule runs, and posts due automatic reversals (lib/accounting/assets/job.ts).
select cron.schedule('pulse:accounting_assets', '25 4 * * *', $$select app.ping_jobs('accounting_assets')$$);

select public.acc_assets_seed(id) from public.orgs;
