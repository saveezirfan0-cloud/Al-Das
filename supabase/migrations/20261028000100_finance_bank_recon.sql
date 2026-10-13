-- Phase 20C: bank and settlement reconciliation (docs/20_FINANCE_CONTROL_PLAN.md slice 20C, docs/20_PHASE_20C_NOTES.md).
--
--   * finance.bank.view (Finance, CEO), finance.bank.manage and finance.bank.signoff (Finance)
--   * fin_import_formats: a column mapping per file layout ({field: header text}); the FIELD LIST per kind lives in code
--     (lib/finance/import-kinds.ts). Generic so lab, referral and POS files can reuse it later.
--   * fin_bank_accounts (last 4 digits only), fin_bank_imports (sha256 of the file, never the file), fin_bank_lines
--     (amount, date, reference, redacted description), fin_settlement_lines (processor reports, optional per mode)
--   * fin_ref_settlement_rules: per Unite payment mode, lag in WORKING days, expected fee %, which bank account, whether
--     the processor report (rather than Unite's collections) is the expectation. Seeded by fin_seed_settlement_rules().
--   * fin_ref_finance_settings: weekend days, date window, amount tolerance, auto-accept score, month cut-off day
--   * fin_bank_recs: one reconciliation per account and month (open -> reviewed -> signed); the figures are frozen with
--     their sha256 at review, and the signer must be a different person from the preparer (enforced here)
--   * fin_bank_matches / fin_bank_rec_notes: the people's decisions (accepted, automatic and rejected pairs; reasons)
--
-- Expected receipts and match scores are computed in TypeScript (lib/finance/bank-recon.ts) from the SQL-aggregated
-- collections (fin_bank_collections). Staff read through RLS (select only); every write is a server action using the
-- service role after can(), audited. A locked month (fin_period_closes) refuses every reconciliation change.

-- ---------------------------------------------------------------------------
-- 1. Permissions for existing system roles (new orgs get them from lib/auth/permissions.ts)
-- ---------------------------------------------------------------------------
do $$
declare
  g record;
begin
  for g in
    select * from (values
      ('Finance', 'finance.bank.view'),
      ('Finance', 'finance.bank.manage'),
      ('Finance', 'finance.bank.signoff'),
      ('CEO', 'finance.bank.view')
    ) as t (role_name, perm)
  loop
    update public.roles r
       set permissions = r.permissions || to_jsonb(g.perm)
     where r.is_system and r.name = g.role_name and not (r.permissions ? g.perm);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Reference: bank accounts, import formats, settlement rules, settings
-- ---------------------------------------------------------------------------
create table public.fin_bank_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  bank_name text not null check (char_length(btrim(bank_name)) between 1 and 60),
  last4 text not null check (last4 ~ '^[0-9]{4}$'),                 -- never the full account number or IBAN
  currency text not null default 'AED' check (currency ~ '^[A-Z]{3}$'),
  ledger_name text check (ledger_name is null or char_length(ledger_name) <= 100),
  receives_insurance boolean not null default false,               -- insurers' bulk payments arrive here
  active boolean not null default true,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);
create unique index fin_bank_accounts_insurance_uidx on public.fin_bank_accounts (org_id) where receives_insurance;
create trigger fin_bank_accounts_set_updated_at before update on public.fin_bank_accounts
  for each row execute function app.set_updated_at();

create table public.fin_import_formats (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  kind text not null check (kind in ('bank_statement', 'settlement')),
  name text not null check (char_length(btrim(name)) between 1 and 60),
  mapping jsonb not null check (jsonb_typeof(mapping) = 'object'),   -- {field: header text}; fields from import-kinds.ts
  date_format text not null check (date_format in ('DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD')),
  amount_style text not null default 'signed' check (amount_style in ('signed', 'debit_credit')),
  active boolean not null default true,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);
create trigger fin_import_formats_set_updated_at before update on public.fin_import_formats
  for each row execute function app.set_updated_at();

create table public.fin_ref_settlement_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  payment_mode text not null check (char_length(btrim(payment_mode)) between 1 and 60),   -- as Unite writes it
  lag_days integer check (lag_days is null or lag_days between 0 and 30),                 -- working days; null = to configure
  fee_pct numeric(6, 3) check (fee_pct is null or fee_pct between 0 and 20),              -- percent; null = to configure
  account_id uuid references public.fin_bank_accounts (id) on delete set null,
  settles_to_bank boolean not null default true,      -- false: never paid into a bank as such (insurance credit)
  source text not null default 'collections' check (source in ('collections', 'settlement')),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index fin_ref_settlement_rules_mode_uidx on public.fin_ref_settlement_rules (org_id, lower(btrim(payment_mode)));
create trigger fin_ref_settlement_rules_set_updated_at before update on public.fin_ref_settlement_rules
  for each row execute function app.set_updated_at();
create trigger fin_ref_settlement_rules_account_org_check before insert or update of account_id, org_id on public.fin_ref_settlement_rules
  for each row execute function app.check_parent_org('fin_bank_accounts', 'account_id');

alter table public.fin_ref_finance_settings
  add column bank_weekend_days smallint[] not null default '{0,6}'
    check (bank_weekend_days <@ '{0,1,2,3,4,5,6}'::smallint[] and cardinality(bank_weekend_days) <= 3),
  add column bank_date_window_days integer not null default 3 check (bank_date_window_days between 0 and 10),
  add column bank_amount_tolerance numeric(12, 2) not null default 1.00 check (bank_amount_tolerance between 0 and 1000),
  add column bank_amount_tolerance_pct numeric(5, 2) not null default 0.00 check (bank_amount_tolerance_pct between 0 and 5),
  add column bank_auto_accept_score integer not null default 80 check (bank_auto_accept_score between 50 and 100),
  add column bank_cutoff_day integer not null default 30 check (bank_cutoff_day between 1 and 31);

-- ---------------------------------------------------------------------------
-- 3. Imported statements and processor reports (the file itself is never stored)
-- ---------------------------------------------------------------------------
create table public.fin_bank_imports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  kind text not null check (kind in ('bank_statement', 'settlement')),
  account_id uuid references public.fin_bank_accounts (id) on delete restrict,
  payment_mode text check (payment_mode is null or char_length(payment_mode) between 1 and 60),
  format_id uuid references public.fin_import_formats (id) on delete set null,
  file_name text check (file_name is null or char_length(file_name) <= 200),
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  row_count integer not null default 0,
  sum_credits numeric(16, 2) not null default 0,     -- settlement report: total net
  sum_debits numeric(16, 2) not null default 0,      -- settlement report: total fees
  first_date date,
  last_date date,
  imported_by uuid references public.profiles (id) on delete set null,
  imported_at timestamptz not null default now(),
  unique (org_id, file_sha256),                        -- the same file twice is refused
  check (kind <> 'bank_statement' or account_id is not null),
  check (kind <> 'settlement' or payment_mode is not null)
);
create index fin_bank_imports_org_idx on public.fin_bank_imports (org_id, imported_at desc);
create trigger fin_bank_imports_account_org_check before insert or update of account_id, org_id on public.fin_bank_imports
  for each row execute function app.check_parent_org('fin_bank_accounts', 'account_id');

create table public.fin_bank_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  account_id uuid not null references public.fin_bank_accounts (id) on delete restrict,
  import_id uuid not null references public.fin_bank_imports (id) on delete cascade,
  row_no integer not null,
  value_date date not null,
  amount numeric(14, 2) not null check (amount <> 0),           -- signed: credit (money in) > 0
  reference text check (reference is null or char_length(reference) <= 80),
  description text check (description is null or char_length(description) <= 200),   -- redacted before storage
  match_status text not null default 'unmatched' check (match_status in ('unmatched', 'matched')),
  created_at timestamptz not null default now(),
  unique (import_id, row_no)
);
create index fin_bank_lines_account_date_idx on public.fin_bank_lines (org_id, account_id, value_date);
create trigger fin_bank_lines_import_org_check before insert or update of import_id, org_id on public.fin_bank_lines
  for each row execute function app.check_parent_org('fin_bank_imports', 'import_id');

create table public.fin_settlement_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  import_id uuid not null references public.fin_bank_imports (id) on delete cascade,
  row_no integer not null,
  payment_mode text not null check (char_length(payment_mode) between 1 and 60),
  txn_date date not null,
  settlement_date date not null,
  gross numeric(14, 2) not null,
  fee numeric(14, 2) not null default 0,
  net numeric(14, 2) not null,
  reference text check (reference is null or char_length(reference) <= 80),
  created_at timestamptz not null default now(),
  unique (import_id, row_no)
);
create index fin_settlement_lines_mode_idx on public.fin_settlement_lines (org_id, payment_mode, settlement_date);
create index fin_settlement_lines_txn_idx on public.fin_settlement_lines (org_id, payment_mode, txn_date);
create trigger fin_settlement_lines_import_org_check before insert or update of import_id, org_id on public.fin_settlement_lines
  for each row execute function app.check_parent_org('fin_bank_imports', 'import_id');

-- ---------------------------------------------------------------------------
-- 4. Reconciliation runs and decisions
-- ---------------------------------------------------------------------------
create table public.fin_bank_recs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  account_id uuid not null references public.fin_bank_accounts (id) on delete restrict,
  month date not null check (month = date_trunc('month', month)::date),
  period_start date not null,
  period_end date not null,
  status text not null default 'open' check (status in ('open', 'reviewed', 'signed')),
  figures jsonb check (figures is null or jsonb_typeof(figures) = 'object'),
  figures_sha256 text,
  prepared_by uuid references public.profiles (id) on delete set null,
  prepared_at timestamptz,
  signed_by uuid references public.profiles (id) on delete set null,
  signed_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, account_id, month),
  check (period_start <= period_end),
  check (status = 'open' or (figures is not null and figures_sha256 is not null and prepared_at is not null)),
  check ((status = 'signed') = (signed_at is not null)),
  check (prepared_by is null or signed_by is null or prepared_by <> signed_by)
);
create index fin_bank_recs_org_idx on public.fin_bank_recs (org_id, month desc);
create trigger fin_bank_recs_set_updated_at before update on public.fin_bank_recs
  for each row execute function app.set_updated_at();
create trigger fin_bank_recs_account_org_check before insert or update of account_id, org_id on public.fin_bank_recs
  for each row execute function app.check_parent_org('fin_bank_accounts', 'account_id');

create table public.fin_bank_matches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  rec_id uuid not null references public.fin_bank_recs (id) on delete cascade,
  bank_line_id uuid not null references public.fin_bank_lines (id) on delete cascade,
  expected_key text not null check (char_length(expected_key) between 1 and 160),
  expected_kind text not null check (expected_kind in ('collection', 'payout', 'insurance')),
  expected_date date not null,
  expected_amount numeric(14, 2) not null,
  bank_amount numeric(14, 2) not null,
  score integer not null check (score between 0 and 100),
  reasons jsonb not null default '[]'::jsonb check (jsonb_typeof(reasons) = 'array'),
  status text not null check (status in ('matched', 'rejected')),
  auto boolean not null default false,
  decided_by uuid references public.profiles (id) on delete set null,
  decided_at timestamptz not null default now(),
  unique (rec_id, expected_key, bank_line_id),
  check (not (auto and status = 'rejected'))
);
create unique index fin_bank_matches_line_uidx on public.fin_bank_matches (bank_line_id) where status = 'matched';
create unique index fin_bank_matches_item_uidx on public.fin_bank_matches (rec_id, expected_key) where status = 'matched';
create index fin_bank_matches_rec_idx on public.fin_bank_matches (rec_id);
create trigger fin_bank_matches_rec_org_check before insert or update of rec_id, org_id on public.fin_bank_matches
  for each row execute function app.check_parent_org('fin_bank_recs', 'rec_id');
create trigger fin_bank_matches_line_org_check before insert or update of bank_line_id, org_id on public.fin_bank_matches
  for each row execute function app.check_parent_org('fin_bank_lines', 'bank_line_id');

create table public.fin_bank_rec_notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  rec_id uuid not null references public.fin_bank_recs (id) on delete cascade,
  item_key text not null check (char_length(item_key) between 1 and 160),   -- an expected item key or bank|<line id>
  reason_code text not null check (reason_code in (
    'in_transit', 'fee_difference', 'chargeback', 'refunded', 'unite_correction', 'bank_query',
    'other_account', 'other_period', 'internal_transfer', 'other_income', 'other')),
  note text check (note is null or char_length(note) <= 200),
  decided_by uuid references public.profiles (id) on delete set null,
  decided_at timestamptz not null default now(),
  unique (rec_id, item_key),
  check (reason_code <> 'other' or char_length(btrim(coalesce(note, ''))) > 0)
);
create trigger fin_bank_rec_notes_rec_org_check before insert or update of rec_id, org_id on public.fin_bank_rec_notes
  for each row execute function app.check_parent_org('fin_bank_recs', 'rec_id');

-- ---------------------------------------------------------------------------
-- 5. Guards (run for every role, including the service role)
-- ---------------------------------------------------------------------------
-- A run: the account and period never change; open -> reviewed (figures frozen, hash computed here) -> signed by a
-- different person; reviewed -> open withdraws the review. Signed is final. A locked month refuses every change.
create or replace function app.fin_bank_rec_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.orgs o where o.id = old.org_id) then
      raise exception 'a bank reconciliation cannot be deleted' using errcode = '42501';
    end if;
    return old;
  end if;
  if new.org_id is null or new.month is null then
    return new;   -- incomplete row (the security probe): RLS and NOT NULL answer
  end if;

  if tg_op = 'UPDATE' then
    -- the FK action that nulls a deleted user's id is always allowed
    if (to_jsonb(new) - 'prepared_by' - 'signed_by' - 'created_by' - 'updated_at')
       is not distinct from (to_jsonb(old) - 'prepared_by' - 'signed_by' - 'created_by' - 'updated_at')
       and (new.prepared_by is null or new.prepared_by = old.prepared_by)
       and (new.signed_by is null or new.signed_by = old.signed_by)
       and (new.created_by is null or new.created_by = old.created_by) then
      return new;
    end if;
  end if;

  if app.fin_month_is_locked(new.org_id, new.month) then
    raise exception 'the month of this reconciliation is locked' using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'open' or new.figures is not null or new.signed_by is not null then
      raise exception 'a reconciliation starts open' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if (new.org_id, new.account_id, new.month, new.period_start, new.period_end)
     is distinct from (old.org_id, old.account_id, old.month, old.period_start, old.period_end) then
    raise exception 'the account and period of a reconciliation cannot change' using errcode = 'check_violation';
  end if;
  if old.status = 'signed' then
    raise exception 'a signed reconciliation is final' using errcode = '42501';
  end if;

  if old.status = new.status then
    if (new.figures, new.figures_sha256, new.prepared_by, new.prepared_at, new.signed_by, new.signed_at)
       is distinct from (old.figures, old.figures_sha256, old.prepared_by, old.prepared_at, old.signed_by, old.signed_at) then
      raise exception 'change the status to change the figures' using errcode = 'check_violation';
    end if;
  elsif old.status = 'open' and new.status = 'reviewed' then
    if new.figures is null or new.prepared_by is null then
      raise exception 'a review needs the figures and the preparer' using errcode = 'check_violation';
    end if;
    if jsonb_array_length(coalesce(new.figures -> 'problems', '[]'::jsonb)) > 0 then
      raise exception 'resolve the open items before the review' using errcode = 'check_violation';
    end if;
    new.figures_sha256 := encode(sha256(convert_to(new.figures::text, 'UTF8')), 'hex');
    new.prepared_at := now();
    new.signed_by := null;
    new.signed_at := null;
  elsif old.status = 'reviewed' and new.status = 'open' then
    new.figures := null;
    new.figures_sha256 := null;
    new.prepared_by := null;
    new.prepared_at := null;
  elsif old.status = 'reviewed' and new.status = 'signed' then
    if new.signed_by is null then
      raise exception 'the sign-off needs the signer' using errcode = 'check_violation';
    end if;
    if new.signed_by = old.prepared_by then
      raise exception 'the preparer and the signer must be two different people' using errcode = 'check_violation';
    end if;
    if (new.figures, new.figures_sha256, new.prepared_by, new.prepared_at)
       is distinct from (old.figures, old.figures_sha256, old.prepared_by, old.prepared_at) then
      raise exception 'the figures cannot change at sign-off' using errcode = 'check_violation';
    end if;
    new.signed_at := now();
  else
    raise exception 'invalid reconciliation transition % -> %', old.status, new.status using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function app.fin_bank_rec_guard() from public, anon, authenticated;
create trigger fin_bank_recs_guard before insert or update or delete on public.fin_bank_recs
  for each row execute function app.fin_bank_rec_guard();

-- Decisions change only while their run is open and its month is not locked.
create or replace function app.fin_bank_decision_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rec uuid;
  v_status text;
  v_org uuid;
  v_month date;
begin
  if tg_op = 'DELETE' then
    v_rec := old.rec_id;
  else
    v_rec := new.rec_id;
  end if;
  select r.status, r.org_id, r.month into v_status, v_org, v_month from public.fin_bank_recs r where r.id = v_rec;
  if found and exists (select 1 from public.orgs o where o.id = v_org) then
    if app.fin_month_is_locked(v_org, v_month) then
      raise exception 'the month of this reconciliation is locked' using errcode = '42501';
    end if;
    if v_status <> 'open' then
      raise exception 'the reconciliation is %; reopen it first', v_status using errcode = 'check_violation';
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
revoke all on function app.fin_bank_decision_guard() from public, anon, authenticated;
create trigger fin_bank_matches_guard before insert or update or delete on public.fin_bank_matches
  for each row execute function app.fin_bank_decision_guard();
create trigger fin_bank_rec_notes_guard before insert or update or delete on public.fin_bank_rec_notes
  for each row execute function app.fin_bank_decision_guard();

-- fin_bank_lines.match_status follows the matches table.
create or replace function app.fin_bank_line_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  if tg_op = 'INSERT' then
    v_ids := array[new.bank_line_id];
  elsif tg_op = 'DELETE' then
    v_ids := array[old.bank_line_id];
  else
    v_ids := array[old.bank_line_id, new.bank_line_id];
  end if;
  update public.fin_bank_lines l
     set match_status = case when exists (select 1 from public.fin_bank_matches m
                                          where m.bank_line_id = l.id and m.status = 'matched')
                             then 'matched' else 'unmatched' end
   where l.id = any (v_ids);
  return null;
end;
$$;
revoke all on function app.fin_bank_line_status() from public, anon, authenticated;
create trigger fin_bank_matches_line_status after insert or update or delete on public.fin_bank_matches
  for each row execute function app.fin_bank_line_status();

-- A matched bank line cannot disappear (deleting its import is refused until the match is undone).
create or replace function app.fin_bank_line_delete_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.match_status = 'matched' and exists (select 1 from public.orgs o where o.id = old.org_id) then
    raise exception 'a matched bank line cannot be removed; undo the match first' using errcode = '42501';
  end if;
  return old;
end;
$$;
revoke all on function app.fin_bank_line_delete_guard() from public, anon, authenticated;
create trigger fin_bank_lines_delete_guard before delete on public.fin_bank_lines
  for each row execute function app.fin_bank_line_delete_guard();

-- ---------------------------------------------------------------------------
-- 6. RLS: staff with a bank permission read their org's rows; nobody writes directly (server actions, service role)
-- ---------------------------------------------------------------------------
alter table public.fin_bank_accounts enable row level security;
alter table public.fin_import_formats enable row level security;
alter table public.fin_ref_settlement_rules enable row level security;
alter table public.fin_bank_imports enable row level security;
alter table public.fin_bank_lines enable row level security;
alter table public.fin_settlement_lines enable row level security;
alter table public.fin_bank_recs enable row level security;
alter table public.fin_bank_matches enable row level security;
alter table public.fin_bank_rec_notes enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['fin_bank_accounts', 'fin_import_formats', 'fin_ref_settlement_rules', 'fin_bank_imports',
                           'fin_bank_lines', 'fin_settlement_lines', 'fin_bank_recs', 'fin_bank_matches', 'fin_bank_rec_notes']
  loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (app.has_perm(org_id, %L) or app.has_perm(org_id, %L) or app.has_perm(org_id, %L))',
      t || '_select', t, 'finance.bank.view', 'finance.bank.manage', 'finance.bank.signoff');
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 7. Functions (SECURITY DEFINER, service role only; the server has run can() first)
-- ---------------------------------------------------------------------------
-- Unite collections per payment mode and day across branches: paid by paid date, refunds by refund date (as the cash-up).
create or replace function public.fin_bank_collections(p_org_id uuid, p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with paid as (
    select coalesce(nullif(btrim(p.payment_mode), ''), '(unknown)') as mode, p.paid_date as day,
           sum(p.paid) as amount, count(*) as payments
    from public.fin_payments p
    join public.fin_invoices i on i.id = p.invoice_id
    where p.org_id = p_org_id and p.is_current and not i.is_deleted
      and p.paid_date between p_from and p_to and coalesce(p.paid, 0) <> 0
    group by 1, 2
  ), refunded as (
    select coalesce(nullif(btrim(p.payment_mode), ''), '(unknown)') as mode, coalesce(p.refund_date, p.paid_date) as day,
           sum(p.refund) as amount
    from public.fin_payments p
    join public.fin_invoices i on i.id = p.invoice_id
    where p.org_id = p_org_id and p.is_current and not i.is_deleted
      and coalesce(p.refund_date, p.paid_date) between p_from and p_to and coalesce(p.refund, 0) <> 0
    group by 1, 2
  ), k as (
    select mode, day from paid union select mode, day from refunded
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'mode', k.mode, 'date', k.day,
           'paid', round(coalesce(pd.amount, 0), 2), 'refunds', round(coalesce(rf.amount, 0), 2),
           'payments', coalesce(pd.payments, 0)) order by k.mode, k.day), '[]'::jsonb)
  from k
  left join paid pd on pd.mode = k.mode and pd.day = k.day
  left join refunded rf on rf.mode = k.mode and rf.day = k.day;
$$;
revoke all on function public.fin_bank_collections(uuid, date, date) from public, anon, authenticated;
grant execute on function public.fin_bank_collections(uuid, date, date) to service_role;

-- Stores one parsed file atomically. p_rows are the sanitised rows the server parsed (bank: value_date, amount,
-- reference, description; settlement: txn_date, settlement_date, gross, fee, net, reference). The same file twice
-- (sha256) and a file overlapping dates already imported for the account (or the mode) are refused.
create or replace function public.fin_bank_import(
  p_org_id uuid, p_kind text, p_account_id uuid, p_payment_mode text, p_format_id uuid,
  p_file_name text, p_sha256 text, p_rows jsonb, p_user uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_first date;
  v_last date;
  v_mode text := nullif(btrim(coalesce(p_payment_mode, '')), '');
begin
  if p_kind not in ('bank_statement', 'settlement') then
    raise exception 'unknown import kind' using errcode = 'invalid_parameter_value';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 20000 then
    raise exception 'an import holds 1 to 20000 rows' using errcode = 'invalid_parameter_value';
  end if;
  if p_format_id is not null and not exists (
    select 1 from public.fin_import_formats f where f.id = p_format_id and f.org_id = p_org_id and f.kind = p_kind) then
    raise exception 'format not found' using errcode = 'invalid_parameter_value';
  end if;

  if p_kind = 'bank_statement' then
    if not exists (select 1 from public.fin_bank_accounts a where a.id = p_account_id and a.org_id = p_org_id) then
      raise exception 'account not found' using errcode = 'invalid_parameter_value';
    end if;
    select min((r ->> 'value_date')::date), max((r ->> 'value_date')::date) into v_first, v_last
    from jsonb_array_elements(p_rows) r;
    if exists (select 1 from public.fin_bank_lines l
               where l.org_id = p_org_id and l.account_id = p_account_id and l.value_date between v_first and v_last) then
      raise exception 'this statement overlaps dates already imported for the account' using errcode = 'check_violation';
    end if;
    insert into public.fin_bank_imports (org_id, kind, account_id, format_id, file_name, file_sha256, row_count,
                                         sum_credits, sum_debits, first_date, last_date, imported_by)
    select p_org_id, p_kind, p_account_id, p_format_id, left(p_file_name, 200), p_sha256, count(*),
           coalesce(sum((r ->> 'amount')::numeric) filter (where (r ->> 'amount')::numeric > 0), 0),
           coalesce(-sum((r ->> 'amount')::numeric) filter (where (r ->> 'amount')::numeric < 0), 0),
           v_first, v_last, p_user
    from jsonb_array_elements(p_rows) r
    returning id into v_id;
    insert into public.fin_bank_lines (org_id, account_id, import_id, row_no, value_date, amount, reference, description)
    select p_org_id, p_account_id, v_id, x.n, (x.r ->> 'value_date')::date, (x.r ->> 'amount')::numeric,
           nullif(x.r ->> 'reference', ''), nullif(x.r ->> 'description', '')
    from jsonb_array_elements(p_rows) with ordinality as x (r, n);
  else
    if v_mode is null then
      raise exception 'a settlement report needs its payment mode' using errcode = 'invalid_parameter_value';
    end if;
    select min((r ->> 'txn_date')::date), max((r ->> 'txn_date')::date) into v_first, v_last
    from jsonb_array_elements(p_rows) r;
    if exists (select 1 from public.fin_settlement_lines s
               where s.org_id = p_org_id and lower(s.payment_mode) = lower(v_mode) and s.txn_date between v_first and v_last) then
      raise exception 'this report overlaps transaction dates already imported for the mode' using errcode = 'check_violation';
    end if;
    insert into public.fin_bank_imports (org_id, kind, payment_mode, format_id, file_name, file_sha256, row_count,
                                         sum_credits, sum_debits, first_date, last_date, imported_by)
    select p_org_id, p_kind, v_mode, p_format_id, left(p_file_name, 200), p_sha256, count(*),
           coalesce(sum((r ->> 'net')::numeric), 0), coalesce(sum((r ->> 'fee')::numeric), 0), v_first, v_last, p_user
    from jsonb_array_elements(p_rows) r
    returning id into v_id;
    insert into public.fin_settlement_lines (org_id, import_id, row_no, payment_mode, txn_date, settlement_date, gross, fee, net, reference)
    select p_org_id, v_id, x.n, v_mode, (x.r ->> 'txn_date')::date, (x.r ->> 'settlement_date')::date,
           (x.r ->> 'gross')::numeric, coalesce((x.r ->> 'fee')::numeric, 0), (x.r ->> 'net')::numeric,
           nullif(x.r ->> 'reference', '')
    from jsonb_array_elements(p_rows) with ordinality as x (r, n);
  end if;
  return v_id;
end;
$$;
revoke all on function public.fin_bank_import(uuid, text, uuid, text, uuid, text, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.fin_bank_import(uuid, text, uuid, text, uuid, text, text, jsonb, uuid) to service_role;

-- Starter settlement rules (idempotent, never overwrites Finance's edits). The payment-mode texts must be checked against
-- what Unite really writes; fee % and the bank account are left blank on purpose: a mode is reconciled only once Finance
-- has set them (Settings, Bank reconciliation).
create or replace function public.fin_seed_settlement_rules(p_org_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.fin_ref_settlement_rules (org_id, payment_mode, lag_days, fee_pct, settles_to_bank) values
    (p_org_id, 'Card', 2, null, true),
    (p_org_id, 'EPG', 2, null, true),
    (p_org_id, 'Tabby', 6, null, true),
    (p_org_id, 'Cash', 1, 0, true),
    (p_org_id, 'rePG', null, null, true),
    (p_org_id, 'MX', null, null, true),
    (p_org_id, 'Insurance credit', null, null, false)
  on conflict do nothing;
$$;
revoke all on function public.fin_seed_settlement_rules(uuid) from public, anon, authenticated;
grant execute on function public.fin_seed_settlement_rules(uuid) to service_role;

select public.fin_seed_settlement_rules(id) from public.orgs;
