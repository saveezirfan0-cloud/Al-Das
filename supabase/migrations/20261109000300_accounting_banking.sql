-- Phase 22F: banking and cash (docs/22_ACCOUNTING_PLAN.md, slice 22F; notes in docs/22_PHASE_22F_NOTES.md).
--
--   * fin_bank_accounts.gl_account_id: each 20C bank account points at its ledger (control 'bank', under "Bank Accounts"
--     or "Bank OD A/c"); acc_bank_create_ledger() makes that ledger
--   * acc_bank_statement_balances: the closing balance printed on the bank statement, typed in per date (20C keeps lines,
--     not balances), for the book-to-bank summary
--   * acc_bank_transfers (Contra): bank to bank, cash deposits and withdrawals, petty cash top-ups
--   * acc_bank_entries: bank charges, interest received and paid, direct debits and credits, optionally made from an
--     unmatched 20C statement line (the line then counts as matched in the reconciliation)
--   * petty cash: acc_petty_cash_floats (one cash ledger each), acc_petty_cash_expenses (with a receipt in
--     fin_documents), acc_petty_cash_counts (monthly count against the book, two people)
--   * cheques: acc_cheque_books, acc_cheques (issued and received; post-dated cheques post on their date; bounced,
--     cancelled and stale cheques reverse their journal), acc_party_flags (a bounced cheque flags the party)
--
-- Every posting goes through acc_post_from_source() (22A) with the new source kinds bank_transfer, bank_entry,
-- petty_cash and cheque, so it is idempotent and checked like every other journal. When the ledger refuses a date before
-- its start (hint before_ledger_start, a central rule added in parallel) the item is kept as waiting_ledger_start and
-- posted later by acc_banking_sweep(); the person's action never fails for that reason. Every state change lives in
-- SECURITY DEFINER functions (search_path = '', service role only, jsonb results); the server runs can() first and the
-- functions check accounting.banking.manage again for the named user.

-- ---------------------------------------------------------------------------
-- 1. The new source kinds (the CHECK on acc_journals and the list inside acc_post_from_source). Patched in place so a
--    rule another slice adds to acc_post_from_source is kept; fails loudly if the list is not where 22A put it.
-- ---------------------------------------------------------------------------
do $$
declare
  c record;
  v_list text[];
begin
  for c in
    select con.conname, pg_get_constraintdef(con.oid) as def
    from pg_constraint con
    where con.conrelid = 'public.acc_journals'::regclass and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%source_kind%' and pg_get_constraintdef(con.oid) like '%unite_invoice%'
  loop
    select array_agg(distinct m[1]) into v_list from regexp_matches(c.def, '''([a-z_]+)''', 'g') as m;
    execute format('alter table public.acc_journals drop constraint %I', c.conname);
  end loop;
  if v_list is null then
    raise exception 'acc_journals source_kind check not found';
  end if;
  v_list := array(select distinct x from unnest(v_list || array['bank_transfer', 'bank_entry', 'petty_cash', 'cheque']) as x order by x);
  execute format('alter table public.acc_journals add constraint acc_journals_source_kind_check check (source_kind is null or source_kind in (%s))',
    (select string_agg(quote_literal(x), ', ' order by x) from unnest(v_list) as x));
end $$;

do $$
declare
  v_def text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.acc_post_from_source(uuid, uuid, text, text, integer, date, text, text, jsonb)'::regprocedure);
  if position('''bank_transfer''' in v_def) = 0 then
    v_new := regexp_replace(v_def, '''payroll''\)', '''payroll'', ''bank_transfer'', ''bank_entry'', ''petty_cash'', ''cheque'')');
    if v_new = v_def then
      raise exception 'acc_post_from_source: the source-kind list was not found';
    end if;
    execute v_new;
  end if;
end $$;

-- Who reads the banking registers: the people who keep them, and those who read the ledger or post journals.
create or replace function app.acc_can_read_banking(p_org_id uuid)
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
        'accounting.banking.manage', 'accounting.ledger.view', 'accounting.journals.approve'])
  );
$$;
revoke all on function app.acc_can_read_banking(uuid) from public, anon;
grant execute on function app.acc_can_read_banking(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------
-- The ledger of each 20C bank account (one ledger per bank account).
alter table public.fin_bank_accounts add column gl_account_id uuid references public.acc_accounts (id);
create unique index fin_bank_accounts_gl_uidx on public.fin_bank_accounts (gl_account_id) where gl_account_id is not null;

create table public.acc_bank_statement_balances (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  bank_account_id uuid not null references public.fin_bank_accounts (id) on delete cascade,
  as_of date not null,
  balance numeric(16, 2) not null,                      -- as the bank prints it: positive in funds, negative overdrawn
  entered_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bank_account_id, as_of)
);
create trigger acc_bank_statement_balances_set_updated_at before update on public.acc_bank_statement_balances
  for each row execute function app.set_updated_at();
create trigger acc_bank_statement_balances_account_org_check before insert or update on public.acc_bank_statement_balances
  for each row execute function app.check_parent_org('fin_bank_accounts', 'bank_account_id');

create table public.acc_petty_cash_floats (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  branch_code text check (branch_code is null or char_length(branch_code) between 1 and 20),
  account_id uuid not null unique references public.acc_accounts (id),
  imprest_amount numeric(14, 2) not null default 0 check (imprest_amount >= 0),   -- the float topped back up to
  custodian_id uuid references public.profiles (id) on delete set null,
  active boolean not null default true,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index acc_petty_cash_floats_name_uidx on public.acc_petty_cash_floats (org_id, lower(btrim(name)));
create trigger acc_petty_cash_floats_set_updated_at before update on public.acc_petty_cash_floats
  for each row execute function app.set_updated_at();
create trigger acc_petty_cash_floats_account_org_check before insert or update on public.acc_petty_cash_floats
  for each row execute function app.check_parent_org('acc_accounts', 'account_id');

-- Contra: money moved between two bank or cash ledgers (Dr to, Cr from).
create table public.acc_bank_transfers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  kind text not null check (kind in ('transfer', 'cash_deposit', 'cash_withdrawal', 'petty_cash_topup')),
  transfer_date date not null,
  from_account_id uuid not null references public.acc_accounts (id),
  to_account_id uuid not null references public.acc_accounts (id),
  float_id uuid references public.acc_petty_cash_floats (id),
  amount numeric(14, 2) not null check (amount > 0),
  reference text check (reference is null or char_length(reference) <= 60),
  narration text not null check (char_length(btrim(narration)) between 1 and 300),
  branch_code text check (branch_code is null or char_length(branch_code) between 1 and 20),
  status text not null default 'posted' check (status in ('posted', 'waiting_ledger_start', 'cancelled')),
  journal_id uuid references public.acc_journals (id),
  cancel_reason text check (cancel_reason is null or char_length(cancel_reason) <= 300),
  cancelled_by uuid references public.profiles (id) on delete set null,
  cancelled_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (from_account_id <> to_account_id),
  check (status <> 'posted' or journal_id is not null),
  check ((status = 'cancelled') = (cancelled_at is not null)),
  check ((kind = 'petty_cash_topup') = (float_id is not null))
);
create index acc_bank_transfers_org_idx on public.acc_bank_transfers (org_id, transfer_date desc);
create trigger acc_bank_transfers_set_updated_at before update on public.acc_bank_transfers
  for each row execute function app.set_updated_at();
create trigger acc_bank_transfers_from_org_check before insert or update on public.acc_bank_transfers
  for each row execute function app.check_parent_org('acc_accounts', 'from_account_id');
create trigger acc_bank_transfers_to_org_check before insert or update on public.acc_bank_transfers
  for each row execute function app.check_parent_org('acc_accounts', 'to_account_id');
create trigger acc_bank_transfers_float_org_check before insert or update on public.acc_bank_transfers
  for each row execute function app.check_parent_org('acc_petty_cash_floats', 'float_id');

-- Bank items no other slice posts: charges, interest, direct debits and credits.
create table public.acc_bank_entries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  bank_account_id uuid not null references public.fin_bank_accounts (id),
  entry_date date not null,
  kind text not null check (kind in ('bank_charge', 'interest_paid', 'direct_debit', 'interest_received', 'direct_credit')),
  amount numeric(14, 2) not null check (amount > 0),                   -- as on the statement (VAT included)
  account_id uuid not null references public.acc_accounts (id),       -- the other side (expense, income, a loan, ...)
  tax_code_id uuid references public.acc_tax_codes (id),
  reference text check (reference is null or char_length(reference) <= 60),
  narration text not null check (char_length(btrim(narration)) between 1 and 300),
  branch_code text check (branch_code is null or char_length(branch_code) between 1 and 20),
  bank_line_id uuid references public.fin_bank_lines (id) on delete set null,   -- the 20C statement line it explains
  cheque_id uuid,                                                       -- the bounced cheque whose charge this is
  status text not null default 'posted' check (status in ('posted', 'waiting_ledger_start', 'cancelled')),
  journal_id uuid references public.acc_journals (id),
  cancel_reason text check (cancel_reason is null or char_length(cancel_reason) <= 300),
  cancelled_by uuid references public.profiles (id) on delete set null,
  cancelled_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'posted' or journal_id is not null),
  check ((status = 'cancelled') = (cancelled_at is not null))
);
create unique index acc_bank_entries_line_uidx on public.acc_bank_entries (bank_line_id)
  where bank_line_id is not null and status <> 'cancelled';
create index acc_bank_entries_org_idx on public.acc_bank_entries (org_id, entry_date desc);
create trigger acc_bank_entries_set_updated_at before update on public.acc_bank_entries
  for each row execute function app.set_updated_at();
create trigger acc_bank_entries_bank_org_check before insert or update on public.acc_bank_entries
  for each row execute function app.check_parent_org('fin_bank_accounts', 'bank_account_id');
create trigger acc_bank_entries_account_org_check before insert or update on public.acc_bank_entries
  for each row execute function app.check_parent_org('acc_accounts', 'account_id');
create trigger acc_bank_entries_line_org_check before insert or update on public.acc_bank_entries
  for each row execute function app.check_parent_org('fin_bank_lines', 'bank_line_id');

create table public.acc_petty_cash_expenses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  float_id uuid not null references public.acc_petty_cash_floats (id),
  expense_date date not null,
  amount numeric(14, 2) not null check (amount > 0),                   -- paid out, VAT included
  account_id uuid not null references public.acc_accounts (id),
  tax_code_id uuid references public.acc_tax_codes (id),
  reference text check (reference is null or char_length(reference) <= 60),   -- the receipt's number
  narration text not null check (char_length(btrim(narration)) between 1 and 300),
  branch_code text check (branch_code is null or char_length(branch_code) between 1 and 20),
  document_id uuid references public.fin_documents (id) on delete set null,   -- the receipt (20D finance documents)
  status text not null default 'posted' check (status in ('posted', 'waiting_ledger_start', 'cancelled')),
  journal_id uuid references public.acc_journals (id),
  cancel_reason text check (cancel_reason is null or char_length(cancel_reason) <= 300),
  cancelled_by uuid references public.profiles (id) on delete set null,
  cancelled_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'posted' or journal_id is not null),
  check ((status = 'cancelled') = (cancelled_at is not null))
);
create index acc_petty_cash_expenses_float_idx on public.acc_petty_cash_expenses (float_id, expense_date desc);
create index acc_petty_cash_expenses_org_idx on public.acc_petty_cash_expenses (org_id);
create trigger acc_petty_cash_expenses_set_updated_at before update on public.acc_petty_cash_expenses
  for each row execute function app.set_updated_at();
create trigger acc_petty_cash_expenses_float_org_check before insert or update on public.acc_petty_cash_expenses
  for each row execute function app.check_parent_org('acc_petty_cash_floats', 'float_id');
create trigger acc_petty_cash_expenses_account_org_check before insert or update on public.acc_petty_cash_expenses
  for each row execute function app.check_parent_org('acc_accounts', 'account_id');
create trigger acc_petty_cash_expenses_document_org_check before insert or update on public.acc_petty_cash_expenses
  for each row execute function app.check_parent_org('fin_documents', 'document_id');

-- The monthly count of a float against its book balance; prepared by one person, signed by another.
create table public.acc_petty_cash_counts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  float_id uuid not null references public.acc_petty_cash_floats (id),
  month date not null check (month = date_trunc('month', month)::date),
  count_date date not null,
  counted_amount numeric(14, 2) not null check (counted_amount >= 0),
  book_balance numeric(16, 2) not null,
  difference numeric(16, 2) not null,                                   -- counted minus book
  explanation text check (explanation is null or char_length(explanation) <= 500),
  status text not null default 'prepared' check (status in ('prepared', 'signed')),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  prepared_by uuid references public.profiles (id) on delete set null,
  prepared_at timestamptz not null default now(),
  signed_by uuid references public.profiles (id) on delete set null,
  signed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (float_id, month),
  check (date_trunc('month', count_date)::date = month),
  check (difference = counted_amount - book_balance),
  check (difference = 0 or char_length(btrim(coalesce(explanation, ''))) >= 3),
  check ((status = 'signed') = (signed_at is not null)),
  check (prepared_by is null or signed_by is null or prepared_by <> signed_by)
);
create index acc_petty_cash_counts_org_idx on public.acc_petty_cash_counts (org_id, month desc);
create trigger acc_petty_cash_counts_set_updated_at before update on public.acc_petty_cash_counts
  for each row execute function app.set_updated_at();
create trigger acc_petty_cash_counts_float_org_check before insert or update on public.acc_petty_cash_counts
  for each row execute function app.check_parent_org('acc_petty_cash_floats', 'float_id');

create table public.acc_cheque_books (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  bank_account_id uuid not null references public.fin_bank_accounts (id),
  first_number bigint not null check (first_number >= 0),
  last_number bigint not null,
  next_number bigint not null,
  width integer not null default 6 check (width between 1 and 12),
  active boolean not null default true,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (last_number >= first_number and last_number - first_number < 10000),
  check (next_number between first_number and last_number + 1),
  check (char_length(last_number::text) <= width)
);
create index acc_cheque_books_account_idx on public.acc_cheque_books (bank_account_id);
create trigger acc_cheque_books_set_updated_at before update on public.acc_cheque_books
  for each row execute function app.set_updated_at();
create trigger acc_cheque_books_account_org_check before insert or update on public.acc_cheque_books
  for each row execute function app.check_parent_org('fin_bank_accounts', 'bank_account_id');

create table public.acc_cheques (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  direction text not null check (direction in ('issued', 'received')),
  bank_account_id uuid not null references public.fin_bank_accounts (id),   -- drawn on (issued) or deposited to (received)
  cheque_book_id uuid references public.acc_cheque_books (id),
  cheque_no text not null check (cheque_no ~ '^[0-9]{1,12}$'),
  cheque_date date not null,                                                 -- the date written on the cheque
  recorded_on date not null,                                                 -- written out or received
  post_dated boolean generated always as (cheque_date > recorded_on) stored,
  amount numeric(14, 2) not null check (amount > 0),
  -- who: a patient is recorded by the Unite PIN only (never a name); others by name and / or their id
  party_kind text not null check (party_kind in ('supplier', 'payer', 'customer', 'doctor', 'employee', 'patient', 'other')),
  party_ref text check (party_ref is null or char_length(party_ref) between 1 and 64),
  party_name text check (party_name is null or char_length(btrim(party_name)) between 1 and 120),
  counter_account_id uuid not null references public.acc_accounts (id),       -- payables, receivables, an expense ...
  voucher_id uuid unique references public.fin_payment_vouchers (id),         -- the 20D voucher it pays
  narration text check (narration is null or char_length(narration) <= 300),
  status text not null check (status in ('issued', 'received', 'presented', 'cleared', 'bounced', 'cancelled', 'stale')),
  -- not_due: dated in the future, posts on its date; not_posted: ended before it ever posted
  posting text not null default 'not_due' check (posting in ('not_due', 'posted', 'waiting_ledger_start', 'reversed', 'not_posted')),
  journal_id uuid references public.acc_journals (id),
  presented_on date,
  cleared_on date,
  bounced_on date,
  cancelled_on date,
  stale_on date,
  status_reason text check (status_reason is null or char_length(status_reason) <= 300),
  charge_entry_id uuid references public.acc_bank_entries (id),
  created_by uuid references public.profiles (id) on delete set null,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status not in ('issued', 'received') or status = direction),
  check (direction = 'issued' or cheque_book_id is null),
  check (party_kind <> 'patient' or (party_name is null and party_ref ~ '^[A-Za-z0-9-]{1,20}$')),
  check (party_ref is not null or party_name is not null),
  check ((posting in ('posted', 'reversed')) = (journal_id is not null)),
  check ((status = 'bounced') = (bounced_on is not null)),
  check ((status = 'cancelled') = (cancelled_on is not null)),
  check ((status = 'stale') = (stale_on is not null))
);
-- a leaf of our own cheque book is used once (also when it was cancelled)
create unique index acc_cheques_issued_no_uidx on public.acc_cheques (bank_account_id, cheque_no) where direction = 'issued';
create index acc_cheques_org_idx on public.acc_cheques (org_id, cheque_date desc);
create index acc_cheques_due_idx on public.acc_cheques (cheque_date) where posting in ('not_due', 'waiting_ledger_start');
create trigger acc_cheques_set_updated_at before update on public.acc_cheques
  for each row execute function app.set_updated_at();
create trigger acc_cheques_bank_org_check before insert or update on public.acc_cheques
  for each row execute function app.check_parent_org('fin_bank_accounts', 'bank_account_id');
create trigger acc_cheques_book_org_check before insert or update on public.acc_cheques
  for each row execute function app.check_parent_org('acc_cheque_books', 'cheque_book_id');
create trigger acc_cheques_account_org_check before insert or update on public.acc_cheques
  for each row execute function app.check_parent_org('acc_accounts', 'counter_account_id');
create trigger acc_cheques_voucher_org_check before insert or update on public.acc_cheques
  for each row execute function app.check_parent_org('fin_payment_vouchers', 'voucher_id');
alter table public.acc_bank_entries add constraint acc_bank_entries_cheque_fk foreign key (cheque_id) references public.acc_cheques (id);

-- A party whose cheque bounced (cleared by a person with a reason).
create table public.acc_party_flags (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  cheque_id uuid not null unique references public.acc_cheques (id),
  reason text not null check (reason in ('bounced_cheque_received', 'bounced_cheque_issued')),
  party_kind text not null,
  party_ref text,
  party_name text,
  cleared_at timestamptz,
  cleared_by uuid references public.profiles (id) on delete set null,
  clear_reason text check (clear_reason is null or char_length(clear_reason) <= 300),
  created_at timestamptz not null default now(),
  check ((cleared_at is null) = (clear_reason is null))
);
create index acc_party_flags_open_idx on public.acc_party_flags (org_id) where cleared_at is null;
create trigger acc_party_flags_cheque_org_check before insert or update on public.acc_party_flags
  for each row execute function app.check_parent_org('acc_cheques', 'cheque_id');

-- ---------------------------------------------------------------------------
-- 3. Guards (every role, including the service role). A row with no org passes through so row level security answers.
-- ---------------------------------------------------------------------------
-- The ledger of a bank account is a bank ledger of the same org.
create or replace function app.fin_bank_account_gl_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.org_id is null or new.gl_account_id is null then
    return new;
  end if;
  if not exists (select 1 from public.acc_accounts a
                 where a.id = new.gl_account_id and a.org_id = new.org_id and not a.is_group and a.control = 'bank') then
    raise exception 'Choose a bank ledger of this organisation.' using errcode = 'check_violation', hint = 'not_bank_ledger';
  end if;
  return new;
end;
$$;
revoke all on function app.fin_bank_account_gl_guard() from public, anon, authenticated;
create trigger fin_bank_accounts_gl_guard before insert or update of gl_account_id on public.fin_bank_accounts
  for each row execute function app.fin_bank_account_gl_guard();

-- Banking items are never deleted and their content never changes. TG_ARGV[0]: the columns the functions move
-- (status, journal, cancellation; and a generated column, which a BEFORE trigger sees as null); TG_ARGV[1]: references
-- that may only be nulled (a removed user or file). A cancelled item, and a bounced, cancelled or stale cheque, is final.
create or replace function app.acc_banking_item_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_move text[] := string_to_array(tg_argv[0], ',') || array['updated_at'];
  v_null text[] := string_to_array(coalesce(nullif(tg_argv[1], ''), 'created_by'), ',');
  v_old jsonb;
  v_new jsonb;
  k text;
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.orgs o where o.id = old.org_id) then
      raise exception 'Banking records are never deleted; cancel them instead.' using errcode = '42501', hint = 'banking_immutable';
    end if;
    return old;
  end if;
  if new.org_id is null then
    return new;
  end if;
  v_old := to_jsonb(old);
  v_new := to_jsonb(new);
  -- references nulled by their foreign key action
  foreach k in array v_null loop
    if not (k = any (v_move)) and v_new -> k is distinct from v_old -> k then
      if jsonb_typeof(v_new -> k) is distinct from 'null' then
        raise exception 'This record cannot change.' using errcode = '42501', hint = 'banking_immutable';
      end if;
    end if;
  end loop;
  if (v_new - v_null - v_move) <> (v_old - v_null - v_move) then
    raise exception 'This record cannot change; cancel it and enter it again.' using errcode = '42501', hint = 'banking_immutable';
  end if;
  if (v_new - v_null) <> (v_old - v_null)
     and (old.status in ('cancelled', 'bounced', 'stale')) then
    raise exception 'This record is final.' using errcode = '42501', hint = 'banking_immutable';
  end if;
  return new;
end;
$$;
revoke all on function app.acc_banking_item_guard() from public, anon, authenticated;
create trigger acc_bank_transfers_guard before update or delete on public.acc_bank_transfers
  for each row execute function app.acc_banking_item_guard('status,journal_id,cancel_reason,cancelled_by,cancelled_at', 'created_by,cancelled_by');
create trigger acc_bank_entries_guard before update or delete on public.acc_bank_entries
  for each row execute function app.acc_banking_item_guard('status,journal_id,cancel_reason,cancelled_by,cancelled_at', 'created_by,cancelled_by,bank_line_id');
create trigger acc_petty_cash_expenses_guard before update or delete on public.acc_petty_cash_expenses
  for each row execute function app.acc_banking_item_guard('status,journal_id,cancel_reason,cancelled_by,cancelled_at', 'created_by,cancelled_by,document_id');
create trigger acc_cheques_guard before update or delete on public.acc_cheques
  for each row execute function app.acc_banking_item_guard(
    'status,posting,journal_id,presented_on,cleared_on,bounced_on,cancelled_on,stale_on,status_reason,charge_entry_id,updated_by,post_dated',
    'created_by,updated_by');

-- A signed count is final; counts are never deleted; a float keeps its ledger; a cheque book's range never changes once
-- used and its next number only goes up.
create or replace function app.acc_banking_ref_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.orgs o where o.id = old.org_id) then
      raise exception 'This record is never deleted.' using errcode = '42501', hint = 'banking_immutable';
    end if;
    return old;
  end if;
  if new.org_id is null then
    return new;
  end if;
  if new.org_id <> old.org_id then
    raise exception 'A record keeps its organisation.' using errcode = '42501', hint = 'banking_immutable';
  end if;
  if tg_table_name = 'acc_petty_cash_counts' then
    if old.status = 'signed'
       and (to_jsonb(new) - array['prepared_by', 'signed_by', 'updated_at']) <> (to_jsonb(old) - array['prepared_by', 'signed_by', 'updated_at']) then
      raise exception 'A signed count is final.' using errcode = '42501', hint = 'count_signed';
    end if;
  elsif tg_table_name = 'acc_petty_cash_floats' then
    if new.account_id <> old.account_id then
      raise exception 'A float keeps its ledger.' using errcode = '42501', hint = 'banking_immutable';
    end if;
  elsif tg_table_name = 'acc_cheque_books' then
    if new.bank_account_id <> old.bank_account_id or new.next_number < old.next_number
       or (old.next_number > old.first_number and (new.first_number, new.last_number, new.width) <> (old.first_number, old.last_number, old.width)) then
      raise exception 'A cheque book only moves forward.' using errcode = '42501', hint = 'banking_immutable';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.acc_banking_ref_guard() from public, anon, authenticated;
create trigger acc_petty_cash_counts_guard before update or delete on public.acc_petty_cash_counts
  for each row execute function app.acc_banking_ref_guard();
create trigger acc_petty_cash_floats_guard before update or delete on public.acc_petty_cash_floats
  for each row execute function app.acc_banking_ref_guard();
create trigger acc_cheque_books_guard before update or delete on public.acc_cheque_books
  for each row execute function app.acc_banking_ref_guard();

-- A 20C statement line is matched when a reconciliation matched it OR a live bank entry explains it. Replaces the 20C
-- trigger body (fin_bank_matches) and is called by the bank-entry functions.
create or replace function app.fin_bank_line_refresh(p_ids uuid[])
returns void
language sql
security definer
set search_path = ''
as $$
  update public.fin_bank_lines l
     set match_status = case
       when exists (select 1 from public.fin_bank_matches m where m.bank_line_id = l.id and m.status = 'matched')
         or exists (select 1 from public.acc_bank_entries e where e.bank_line_id = l.id and e.status <> 'cancelled')
       then 'matched' else 'unmatched' end
   where l.id = any (p_ids);
$$;
revoke all on function app.fin_bank_line_refresh(uuid[]) from public, anon, authenticated;

create or replace function app.fin_bank_line_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform app.fin_bank_line_refresh(array[new.bank_line_id]);
  elsif tg_op = 'DELETE' then
    perform app.fin_bank_line_refresh(array[old.bank_line_id]);
  else
    perform app.fin_bank_line_refresh(array[old.bank_line_id, new.bank_line_id]);
  end if;
  return null;
end;
$$;
revoke all on function app.fin_bank_line_status() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Row level security: banking staff and ledger readers read; nobody writes directly
-- ---------------------------------------------------------------------------
alter table public.acc_bank_statement_balances enable row level security;
alter table public.acc_petty_cash_floats enable row level security;
alter table public.acc_bank_transfers enable row level security;
alter table public.acc_bank_entries enable row level security;
alter table public.acc_petty_cash_expenses enable row level security;
alter table public.acc_petty_cash_counts enable row level security;
alter table public.acc_cheque_books enable row level security;
alter table public.acc_cheques enable row level security;
alter table public.acc_party_flags enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['acc_bank_statement_balances', 'acc_petty_cash_floats', 'acc_bank_transfers', 'acc_bank_entries',
                           'acc_petty_cash_expenses', 'acc_petty_cash_counts', 'acc_cheque_books', 'acc_cheques', 'acc_party_flags']
  loop
    execute format('create policy %I on public.%I for select to authenticated using (app.acc_can_read_banking(org_id))',
                   t || '_select', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Internal helpers
-- ---------------------------------------------------------------------------
create or replace function app.acc_banking_require(p_org_id uuid, p_user_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not app.user_has_perm(p_org_id, p_user_id, 'accounting.banking.manage') then
    raise exception 'You cannot manage banking.' using errcode = 'check_violation', hint = 'not_permitted';
  end if;
end;
$$;
revoke all on function app.acc_banking_require(uuid, uuid) from public, anon, authenticated;

-- A positive amount with at most two decimals (refused, never rounded).
create or replace function app.acc_banking_amount(p jsonb)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  v numeric;
begin
  begin
    v := nullif(p #>> '{}', '')::numeric;
  exception when others then
    v := null;
  end;
  if v is null or v <= 0 or round(v, 2) <> v or v >= 1e12 then
    raise exception 'Enter an amount above zero with at most two decimals.' using errcode = 'check_violation', hint = 'bad_amount';
  end if;
  return v;
end;
$$;
revoke all on function app.acc_banking_amount(jsonb) from public, anon, authenticated;

-- A bank or cash ledger of the org (the money side of every banking posting).
create or replace function app.acc_banking_money_account(p_org_id uuid, p_account_id uuid)
returns public.acc_accounts
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a public.acc_accounts;
begin
  select * into a from public.acc_accounts where id = p_account_id and org_id = p_org_id;
  if not found or a.is_group or not a.is_active or a.control is distinct from 'bank' and a.control is distinct from 'cash' then
    raise exception 'Choose an active bank or cash ledger.' using errcode = 'check_violation', hint = 'not_money_account';
  end if;
  return a;
end;
$$;
revoke all on function app.acc_banking_money_account(uuid, uuid) from public, anon, authenticated;

-- The other side of a bank entry, petty cash expense or cheque: an active ledger of the org that is not a bank or cash
-- account (that is a transfer) and not VAT or retained earnings; p_controls lists the control kinds allowed.
create or replace function app.acc_banking_counter_account(p_org_id uuid, p_account_id uuid, p_controls text[])
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a public.acc_accounts;
begin
  select * into a from public.acc_accounts where id = p_account_id and org_id = p_org_id;
  if not found or a.is_group or not a.is_active then
    raise exception 'Choose an active ledger account.' using errcode = 'check_violation', hint = 'account_not_found';
  end if;
  if a.control is not null and not (a.control = any (p_controls)) then
    raise exception 'That control account cannot be used here.' using errcode = 'check_violation', hint = 'counter_not_allowed';
  end if;
end;
$$;
revoke all on function app.acc_banking_counter_account(uuid, uuid, text[]) from public, anon, authenticated;

-- The ledger linked to a 20C bank account.
create or replace function app.acc_banking_bank_ledger(p_org_id uuid, p_bank_account_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_gl uuid;
begin
  select b.gl_account_id into v_gl from public.fin_bank_accounts b where b.id = p_bank_account_id and b.org_id = p_org_id;
  if not found then
    raise exception 'Bank account not found.' using errcode = 'check_violation', hint = 'not_found';
  end if;
  if v_gl is null then
    raise exception 'Link the bank account to its ledger first.' using errcode = 'check_violation', hint = 'bank_not_linked';
  end if;
  perform app.acc_banking_money_account(p_org_id, v_gl);
  return v_gl;
end;
$$;
revoke all on function app.acc_banking_bank_ledger(uuid, uuid) from public, anon, authenticated;

-- Lines for an amount paid out of (p_in false) or into (p_in true) a bank or cash ledger against one ledger, with VAT
-- split out when the tax code is standard-rated (the amount includes it). lib/accounting/banking.ts vatLines() builds the
-- same lines. Reverse charge is refused here (it needs both VAT sides; use a journal).
create or replace function app.acc_banking_lines(
  p_org_id uuid, p_money_account uuid, p_ledger uuid, p_amount numeric, p_tax_code_id uuid, p_in boolean, p_branch text,
  p_description text, p_party jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  t public.acc_tax_codes;
  v_net numeric := p_amount;
  v_vat numeric := 0;
  v_vat_account uuid;
  v_side text := case when p_in then 'credit' else 'debit' end;
  v_other text := case when p_in then 'debit' else 'credit' end;
  v_ledger jsonb;
  v_money jsonb;
  v_lines jsonb;
begin
  if p_tax_code_id is not null then
    select * into t from public.acc_tax_codes where id = p_tax_code_id and org_id = p_org_id;
    if not found or not t.active then
      raise exception 'The tax code is unknown or inactive.' using errcode = 'check_violation', hint = 'tax_code';
    end if;
    if t.kind = 'reverse_charge' then
      raise exception 'Reverse-charge VAT is entered as a journal.' using errcode = 'check_violation', hint = 'tax_code_not_allowed';
    end if;
    if t.kind = 'standard' then
      v_vat_account := case when p_in then t.output_account_id else t.input_account_id end;
      if v_vat_account is null then
        raise exception 'The tax code has no VAT account.' using errcode = 'check_violation', hint = 'tax_code';
      end if;
      v_net := round(p_amount * 100 / (100 + t.rate), 2);
      v_vat := p_amount - v_net;
    end if;
  end if;
  v_ledger := jsonb_strip_nulls(jsonb_build_object('account_id', p_ledger, v_side, v_net, 'tax_code_id', p_tax_code_id,
                                                   'branch_code', p_branch, 'description', p_description))
              || coalesce(p_party, '{}'::jsonb);
  v_money := jsonb_strip_nulls(jsonb_build_object('account_id', p_money_account, v_other, p_amount, 'branch_code', p_branch,
                                                  'description', p_description));
  if p_in then
    v_lines := jsonb_build_array(v_money, v_ledger);
  else
    v_lines := jsonb_build_array(v_ledger);
  end if;
  if v_vat > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'account_id', v_vat_account, v_side, v_vat, 'tax_code_id', p_tax_code_id, 'branch_code', p_branch)));
  end if;
  if not p_in then
    v_lines := v_lines || jsonb_build_array(v_money);
  end if;
  return v_lines;
end;
$$;
revoke all on function app.acc_banking_lines(uuid, uuid, uuid, numeric, uuid, boolean, text, text, jsonb) from public, anon, authenticated;

-- Posts through acc_post_from_source. A date before the ledger starts (hint before_ledger_start) is not an error here:
-- the item waits ({status: waiting_ledger_start}) and acc_banking_sweep() posts it later. Every other refusal is raised.
create or replace function app.acc_banking_post(
  p_org_id uuid, p_kind text, p_id uuid, p_date date, p_voucher_type text, p_narration text, p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_res jsonb;
  v_hint text;
begin
  begin
    v_res := public.acc_post_from_source(p_org_id, null, p_kind, p_id::text, 1, p_date, p_voucher_type,
                                         left(btrim(p_narration), 300), p_lines);
    return jsonb_build_object('status', 'posted', 'journal_id', v_res ->> 'id', 'number', v_res ->> 'number');
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    if v_hint = 'before_ledger_start' then
      return jsonb_build_object('status', 'waiting_ledger_start', 'journal_id', null, 'number', null);
    end if;
    raise;
  end;
end;
$$;
revoke all on function app.acc_banking_post(uuid, text, uuid, date, text, text, jsonb) from public, anon, authenticated;

-- The balance (debit minus credit) of one ledger up to a date, posted and reversed journals both counting.
create or replace function app.acc_account_balance(p_account_id uuid, p_as_of date)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(l.debit - l.credit), 0)
  from public.acc_journal_lines l
  join public.acc_journals j on j.id = l.journal_id
  where l.account_id = p_account_id and j.status in ('posted', 'reversed') and j.journal_date <= p_as_of;
$$;
revoke all on function app.acc_account_balance(uuid, date) from public, anon, authenticated;

-- Posting of one item (built from the stored row, so a retry posts exactly the same journal).
create or replace function app.acc_banking_post_item(p_kind text, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  tr public.acc_bank_transfers;
  e public.acc_bank_entries;
  x public.acc_petty_cash_expenses;
  ch public.acc_cheques;
  v_money uuid;
  v_lines jsonb;
  v_party jsonb := '{}'::jsonb;
  v_desc text;
begin
  if p_kind = 'transfer' then
    select * into tr from public.acc_bank_transfers where id = p_id;
    v_lines := jsonb_build_array(
      jsonb_strip_nulls(jsonb_build_object('account_id', tr.to_account_id, 'debit', tr.amount, 'branch_code', tr.branch_code,
                                           'description', tr.reference)),
      jsonb_strip_nulls(jsonb_build_object('account_id', tr.from_account_id, 'credit', tr.amount, 'branch_code', tr.branch_code,
                                           'description', tr.reference)));
    return app.acc_banking_post(tr.org_id, 'bank_transfer', tr.id, tr.transfer_date, 'contra', tr.narration, v_lines);
  elsif p_kind = 'entry' then
    select * into e from public.acc_bank_entries where id = p_id;
    v_money := app.acc_banking_bank_ledger(e.org_id, e.bank_account_id);
    v_lines := app.acc_banking_lines(e.org_id, v_money, e.account_id, e.amount, e.tax_code_id,
                                     e.kind in ('interest_received', 'direct_credit'), e.branch_code, e.reference);
    return app.acc_banking_post(e.org_id, 'bank_entry', e.id, e.entry_date,
                                case when e.kind in ('interest_received', 'direct_credit') then 'receipt' else 'payment' end,
                                e.narration, v_lines);
  elsif p_kind = 'expense' then
    select * into x from public.acc_petty_cash_expenses where id = p_id;
    select f.account_id into v_money from public.acc_petty_cash_floats f where f.id = x.float_id;
    v_lines := app.acc_banking_lines(x.org_id, v_money, x.account_id, x.amount, x.tax_code_id, false, x.branch_code, x.reference);
    return app.acc_banking_post(x.org_id, 'petty_cash', x.id, x.expense_date, 'payment', x.narration, v_lines);
  elsif p_kind = 'cheque' then
    select * into ch from public.acc_cheques where id = p_id;
    v_money := app.acc_banking_bank_ledger(ch.org_id, ch.bank_account_id);
    if ch.party_kind = 'supplier' and ch.party_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      v_party := jsonb_build_object('supplier_id', ch.party_ref);
    elsif ch.party_kind <> 'patient' and ch.party_ref is not null then
      v_party := jsonb_build_object('party_kind', ch.party_kind, 'party_id', ch.party_ref);
    end if;
    v_desc := 'Cheque ' || ch.cheque_no;
    v_lines := app.acc_banking_lines(ch.org_id, v_money, ch.counter_account_id, ch.amount, null, ch.direction = 'received',
                                     null, v_desc, v_party);
    -- never a patient's identity in the ledger; other parties by the name typed on the cheque
    return app.acc_banking_post(ch.org_id, 'cheque', ch.id, ch.cheque_date,
                                case when ch.direction = 'received' then 'receipt' else 'payment' end,
                                left(v_desc || case when ch.direction = 'received' then ' received' else ' issued' end
                                     || case when ch.party_kind = 'patient' then ' (patient)'
                                             when ch.party_name is not null then ': ' || ch.party_name else '' end
                                     || case when ch.narration is not null then ' - ' || ch.narration else '' end, 300),
                                v_lines);
  end if;
  raise exception 'Unknown item.' using errcode = 'check_violation', hint = 'invalid';
end;
$$;
revoke all on function app.acc_banking_post_item(text, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Bank accounts: ledger link, a new ledger, the statement balance
-- ---------------------------------------------------------------------------
create or replace function public.acc_bank_link_gl(p_org_id uuid, p_user_id uuid, p_bank_account_id uuid, p_account_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.acc_banking_require(p_org_id, p_user_id);
  if p_account_id is not null then
    perform app.acc_banking_money_account(p_org_id, p_account_id);
    if not exists (select 1 from public.acc_accounts a where a.id = p_account_id and a.control = 'bank') then
      raise exception 'Choose a bank ledger.' using errcode = 'check_violation', hint = 'not_bank_ledger';
    end if;
    if exists (select 1 from public.fin_bank_accounts b where b.gl_account_id = p_account_id and b.id <> p_bank_account_id) then
      raise exception 'That ledger belongs to another bank account.' using errcode = 'check_violation', hint = 'ledger_in_use';
    end if;
  end if;
  update public.fin_bank_accounts set gl_account_id = p_account_id where id = p_bank_account_id and org_id = p_org_id;
  if not found then
    raise exception 'Bank account not found.' using errcode = 'check_violation', hint = 'not_found';
  end if;
  return jsonb_build_object('bank_account_id', p_bank_account_id, 'gl_account_id', p_account_id);
end;
$$;
revoke all on function public.acc_bank_link_gl(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.acc_bank_link_gl(uuid, uuid, uuid, uuid) to service_role;

-- A new ledger (control bank) under "Bank Accounts" (p_group 'bank') or "Bank OD A/c" ('od'), linked to the account.
create or replace function public.acc_bank_create_ledger(
  p_org_id uuid, p_user_id uuid, p_bank_account_id uuid, p_group text, p_code text, p_name text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.fin_bank_accounts;
  v_parent uuid;
  v_id uuid;
begin
  perform app.acc_banking_require(p_org_id, p_user_id);
  select * into b from public.fin_bank_accounts where id = p_bank_account_id and org_id = p_org_id for update;
  if not found then
    raise exception 'Bank account not found.' using errcode = 'check_violation', hint = 'not_found';
  end if;
  if b.gl_account_id is not null then
    raise exception 'This bank account already has its ledger.' using errcode = 'check_violation', hint = 'already_linked';
  end if;
  select a.id into v_parent from public.acc_accounts a
   where a.org_id = p_org_id and a.is_group and a.code = case p_group when 'od' then 'G-BOD' else 'G-BANK' end
     and p_group in ('bank', 'od');
  if v_parent is null then
    raise exception 'The bank group was not found in the chart.' using errcode = 'check_violation', hint = 'parent_not_group';
  end if;
  insert into public.acc_accounts (org_id, parent_id, is_group, code, name, control, currency, created_by,
                                   description)
  values (p_org_id, v_parent, false, upper(btrim(p_code)), btrim(p_name), 'bank',
          case when b.currency = 'AED' then null else b.currency end, p_user_id,
          left('Bank account ' || b.bank_name || ' ending ' || b.last4, 300))
  returning id into v_id;
  update public.fin_bank_accounts set gl_account_id = v_id where id = b.id;
  return jsonb_build_object('bank_account_id', b.id, 'gl_account_id', v_id);
end;
$$;
revoke all on function public.acc_bank_create_ledger(uuid, uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.acc_bank_create_ledger(uuid, uuid, uuid, text, text, text) to service_role;

create or replace function public.acc_bank_statement_balance_save(
  p_org_id uuid, p_user_id uuid, p_bank_account_id uuid, p_as_of date, p_balance numeric
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform app.acc_banking_require(p_org_id, p_user_id);
  if p_as_of is null or p_balance is null or round(p_balance, 2) <> p_balance or abs(p_balance) >= 1e13 then
    raise exception 'Enter the date and the balance (two decimals).' using errcode = 'check_violation', hint = 'invalid';
  end if;
  if not exists (select 1 from public.fin_bank_accounts b where b.id = p_bank_account_id and b.org_id = p_org_id) then
    raise exception 'Bank account not found.' using errcode = 'check_violation', hint = 'not_found';
  end if;
  insert into public.acc_bank_statement_balances (org_id, bank_account_id, as_of, balance, entered_by)
  values (p_org_id, p_bank_account_id, p_as_of, p_balance, p_user_id)
  on conflict (bank_account_id, as_of) do update set balance = excluded.balance, entered_by = excluded.entered_by
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end;
$$;
revoke all on function public.acc_bank_statement_balance_save(uuid, uuid, uuid, date, numeric) from public, anon, authenticated;
grant execute on function public.acc_bank_statement_balance_save(uuid, uuid, uuid, date, numeric) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Transfers (Contra) and bank entries
-- ---------------------------------------------------------------------------
-- p: { kind, transfer_date, from_account_id, to_account_id, amount, reference?, narration, branch_code?, float_id? }
-- cash_deposit: cash -> bank; cash_withdrawal: bank -> cash; petty_cash_topup: any bank or cash ledger -> the float.
create or replace function public.acc_bank_transfer_create(p_org_id uuid, p_user_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text := p ->> 'kind';
  v_from public.acc_accounts;
  v_to public.acc_accounts;
  v_float public.acc_petty_cash_floats;
  v_amount numeric;
  v_id uuid;
  v_res jsonb;
begin
  perform app.acc_banking_require(p_org_id, p_user_id);
  v_amount := app.acc_banking_amount(p -> 'amount');
  if v_kind is null or v_kind not in ('transfer', 'cash_deposit', 'cash_withdrawal', 'petty_cash_topup')
     or nullif(p ->> 'transfer_date', '') is null or nullif(btrim(coalesce(p ->> 'narration', '')), '') is null then
    raise exception 'The kind, date and narration are required.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  v_from := app.acc_banking_money_account(p_org_id, nullif(p ->> 'from_account_id', '')::uuid);
  if v_kind = 'petty_cash_topup' then
    select * into v_float from public.acc_petty_cash_floats where id = nullif(p ->> 'float_id', '')::uuid and org_id = p_org_id;
    if not found or not v_float.active then
      raise exception 'Choose an active petty cash float.' using errcode = 'check_violation', hint = 'not_found';
    end if;
    v_to := app.acc_banking_money_account(p_org_id, v_float.account_id);
  else
    v_to := app.acc_banking_money_account(p_org_id, nullif(p ->> 'to_account_id', '')::uuid);
  end if;
  if v_from.id = v_to.id then
    raise exception 'Choose two different accounts.' using errcode = 'check_violation', hint = 'same_account';
  end if;
  if (v_kind = 'cash_deposit' and (v_from.control <> 'cash' or v_to.control <> 'bank'))
     or (v_kind = 'cash_withdrawal' and (v_from.control <> 'bank' or v_to.control <> 'cash')) then
    raise exception 'A deposit moves cash to a bank; a withdrawal moves a bank to cash.' using errcode = 'check_violation', hint = 'transfer_direction';
  end if;
  insert into public.acc_bank_transfers (org_id, kind, transfer_date, from_account_id, to_account_id, float_id, amount, reference,
                                         narration, branch_code, status, created_by)
  values (p_org_id, v_kind, (p ->> 'transfer_date')::date, v_from.id, v_to.id, v_float.id, v_amount,
          nullif(btrim(coalesce(p ->> 'reference', '')), ''), btrim(p ->> 'narration'),
          coalesce(nullif(upper(btrim(coalesce(p ->> 'branch_code', ''))), ''), v_float.branch_code),
          'waiting_ledger_start', p_user_id)
  returning id into v_id;
  v_res := app.acc_banking_post_item('transfer', v_id);
  update public.acc_bank_transfers set status = v_res ->> 'status', journal_id = (v_res ->> 'journal_id')::uuid where id = v_id;
  return v_res || jsonb_build_object('id', v_id);
end;
$$;
revoke all on function public.acc_bank_transfer_create(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.acc_bank_transfer_create(uuid, uuid, jsonb) to service_role;

-- p: { bank_account_id, entry_date, kind, amount, account_id, tax_code_id?, reference?, narration, branch_code?,
--      bank_line_id? }. With a statement line: same account, date, amount and direction, and the line is still unmatched.
create or replace function app.acc_bank_entry_insert(p_org_id uuid, p_user_id uuid, p jsonb, p_cheque_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text := p ->> 'kind';
  v_in boolean;
  v_amount numeric;
  v_bank uuid := nullif(p ->> 'bank_account_id', '')::uuid;
  v_line public.fin_bank_lines;
  v_id uuid;
  v_res jsonb;
begin
  v_amount := app.acc_banking_amount(p -> 'amount');
  if v_kind is null or v_kind not in ('bank_charge', 'interest_paid', 'direct_debit', 'interest_received', 'direct_credit')
     or nullif(p ->> 'entry_date', '') is null or nullif(btrim(coalesce(p ->> 'narration', '')), '') is null then
    raise exception 'The kind, date and narration are required.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  v_in := v_kind in ('interest_received', 'direct_credit');
  perform app.acc_banking_bank_ledger(p_org_id, v_bank);
  perform app.acc_banking_counter_account(p_org_id, nullif(p ->> 'account_id', '')::uuid, array[]::text[]);
  if nullif(p ->> 'bank_line_id', '') is not null then
    select * into v_line from public.fin_bank_lines l
     where l.id = (p ->> 'bank_line_id')::uuid and l.org_id = p_org_id for update;
    if not found or v_line.account_id <> v_bank then
      raise exception 'Statement line not found on this account.' using errcode = 'check_violation', hint = 'line_mismatch';
    end if;
    if v_line.match_status = 'matched' then
      raise exception 'That statement line is already matched.' using errcode = 'check_violation', hint = 'line_matched';
    end if;
    if abs(v_line.amount) <> v_amount or (v_line.amount > 0) <> v_in or v_line.value_date <> (p ->> 'entry_date')::date then
      raise exception 'The entry must have the line''s date, amount and direction.' using errcode = 'check_violation', hint = 'line_mismatch';
    end if;
  end if;
  insert into public.acc_bank_entries (org_id, bank_account_id, entry_date, kind, amount, account_id, tax_code_id, reference,
                                       narration, branch_code, bank_line_id, cheque_id, status, created_by)
  values (p_org_id, v_bank, (p ->> 'entry_date')::date, v_kind, v_amount, (p ->> 'account_id')::uuid,
          nullif(p ->> 'tax_code_id', '')::uuid, nullif(btrim(coalesce(p ->> 'reference', '')), ''), btrim(p ->> 'narration'),
          nullif(upper(btrim(coalesce(p ->> 'branch_code', ''))), ''), v_line.id, p_cheque_id, 'waiting_ledger_start', p_user_id)
  returning id into v_id;
  v_res := app.acc_banking_post_item('entry', v_id);
  update public.acc_bank_entries set status = v_res ->> 'status', journal_id = (v_res ->> 'journal_id')::uuid where id = v_id;
  if v_line.id is not null then
    perform app.fin_bank_line_refresh(array[v_line.id]);
  end if;
  return v_res || jsonb_build_object('id', v_id);
end;
$$;
revoke all on function app.acc_bank_entry_insert(uuid, uuid, jsonb, uuid) from public, anon, authenticated;

create or replace function public.acc_bank_entry_create(p_org_id uuid, p_user_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.acc_banking_require(p_org_id, p_user_id);
  return app.acc_bank_entry_insert(p_org_id, p_user_id, p, null);
end;
$$;
revoke all on function public.acc_bank_entry_create(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.acc_bank_entry_create(uuid, uuid, jsonb) to service_role;

-- Cancels a transfer, bank entry or petty cash expense: a posted one is reversed (dated p_date, on or after its own date);
-- a waiting one simply stops waiting. A bank entry's statement line becomes unmatched again.
create or replace function public.acc_banking_cancel(p_org_id uuid, p_user_id uuid, p_kind text, p_id uuid, p_date date, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table text;
  v_status text;
  v_journal uuid;
  v_line uuid;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform app.acc_banking_require(p_org_id, p_user_id);
  v_table := case p_kind when 'transfer' then 'acc_bank_transfers' when 'entry' then 'acc_bank_entries'
                         when 'expense' then 'acc_petty_cash_expenses' end;
  if v_table is null then
    raise exception 'Unknown item.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  if v_reason is null or char_length(v_reason) < 3 or char_length(v_reason) > 300 then
    raise exception 'Say why it is cancelled.' using errcode = 'check_violation', hint = 'remarks_required';
  end if;
  execute format('select status, journal_id from public.%I where id = $1 and org_id = $2 for update', v_table)
    into v_status, v_journal using p_id, p_org_id;
  if v_status is null then
    raise exception 'Not found.' using errcode = 'check_violation', hint = 'not_found';
  end if;
  if v_status = 'cancelled' then
    raise exception 'Already cancelled.' using errcode = 'check_violation', hint = 'wrong_status';
  end if;
  if v_status = 'posted' then
    perform app.acc_reverse_internal(p_org_id, v_journal, p_user_id, coalesce(p_date, current_date), 'cancelled: ' || v_reason);
  end if;
  execute format('update public.%I set status = ''cancelled'', cancel_reason = $1, cancelled_by = $2, cancelled_at = now() where id = $3',
                 v_table) using v_reason, p_user_id, p_id;
  if p_kind = 'entry' then
    select e.bank_line_id into v_line from public.acc_bank_entries e where e.id = p_id;
    if v_line is not null then
      perform app.fin_bank_line_refresh(array[v_line]);
    end if;
  end if;
  return jsonb_build_object('id', p_id, 'status', 'cancelled', 'reversed', v_status = 'posted');
end;
$$;
revoke all on function public.acc_banking_cancel(uuid, uuid, text, uuid, date, text) from public, anon, authenticated;
grant execute on function public.acc_banking_cancel(uuid, uuid, text, uuid, date, text) to service_role;

-- ---------------------------------------------------------------------------
-- 8. Petty cash
-- ---------------------------------------------------------------------------
-- p: { id?, name, branch_code?, imprest_amount, custodian_id?, active?, code? }. A new float gets its own cash ledger
-- (code p.code) under "Cash-in-Hand".
create or replace function public.acc_petty_cash_float_save(p_org_id uuid, p_user_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_branch text := nullif(upper(btrim(coalesce(p ->> 'branch_code', ''))), '');
  v_name text := btrim(coalesce(p ->> 'name', ''));
  v_imprest numeric := coalesce(nullif(p ->> 'imprest_amount', '')::numeric, 0);
  v_custodian uuid := nullif(p ->> 'custodian_id', '')::uuid;
  v_parent uuid;
  v_account uuid;
begin
  perform app.acc_banking_require(p_org_id, p_user_id);
  if v_name = '' or v_imprest < 0 or round(v_imprest, 2) <> v_imprest then
    raise exception 'Enter a name and the float amount.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  if v_branch is not null and not exists (select 1 from public.fin_ref_branches b where b.org_id = p_org_id and b.code = v_branch) then
    raise exception 'Unknown branch.' using errcode = 'check_violation', hint = 'branch_unknown';
  end if;
  if v_custodian is not null and not exists (
    select 1 from public.memberships m where m.org_id = p_org_id and m.user_id = v_custodian and m.status = 'active') then
    raise exception 'The custodian is not a member of this workspace.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  if v_id is null then
    select a.id into v_parent from public.acc_accounts a where a.org_id = p_org_id and a.is_group and a.code = 'G-CASH';
    if v_parent is null then
      raise exception 'The Cash-in-Hand group was not found in the chart.' using errcode = 'check_violation', hint = 'parent_not_group';
    end if;
    insert into public.acc_accounts (org_id, parent_id, is_group, code, name, control, created_by, description)
    values (p_org_id, v_parent, false, upper(btrim(coalesce(p ->> 'code', ''))), left('Petty cash - ' || v_name, 120), 'cash',
            p_user_id, 'Petty cash float')
    returning id into v_account;
    insert into public.acc_petty_cash_floats (org_id, name, branch_code, account_id, imprest_amount, custodian_id, created_by)
    values (p_org_id, v_name, v_branch, v_account, v_imprest, v_custodian, p_user_id)
    returning id into v_id;
  else
    update public.acc_petty_cash_floats
       set name = v_name, branch_code = v_branch, imprest_amount = v_imprest, custodian_id = v_custodian,
           active = coalesce((p ->> 'active')::boolean, active)
     where id = v_id and org_id = p_org_id
    returning account_id into v_account;
    if v_account is null then
      raise exception 'Float not found.' using errcode = 'check_violation', hint = 'not_found';
    end if;
  end if;
  return jsonb_build_object('id', v_id, 'account_id', v_account);
end;
$$;
revoke all on function public.acc_petty_cash_float_save(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.acc_petty_cash_float_save(uuid, uuid, jsonb) to service_role;

-- p: { float_id, expense_date, amount, account_id, tax_code_id?, reference?, narration, branch_code?, document_id? }
create or replace function public.acc_petty_cash_expense_create(p_org_id uuid, p_user_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.acc_petty_cash_floats;
  v_amount numeric;
  v_doc uuid := nullif(p ->> 'document_id', '')::uuid;
  v_id uuid;
  v_res jsonb;
begin
  perform app.acc_banking_require(p_org_id, p_user_id);
  v_amount := app.acc_banking_amount(p -> 'amount');
  select * into f from public.acc_petty_cash_floats where id = nullif(p ->> 'float_id', '')::uuid and org_id = p_org_id;
  if not found or not f.active then
    raise exception 'Choose an active petty cash float.' using errcode = 'check_violation', hint = 'not_found';
  end if;
  if nullif(p ->> 'expense_date', '') is null or nullif(btrim(coalesce(p ->> 'narration', '')), '') is null then
    raise exception 'The date and narration are required.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  perform app.acc_banking_counter_account(p_org_id, nullif(p ->> 'account_id', '')::uuid, array[]::text[]);
  if v_doc is not null and not exists (
    select 1 from public.fin_documents d where d.id = v_doc and d.org_id = p_org_id and d.status = 'ready' and d.scan_status <> 'infected') then
    raise exception 'The receipt was not found.' using errcode = 'check_violation', hint = 'document_unknown';
  end if;
  insert into public.acc_petty_cash_expenses (org_id, float_id, expense_date, amount, account_id, tax_code_id, reference, narration,
                                              branch_code, document_id, status, created_by)
  values (p_org_id, f.id, (p ->> 'expense_date')::date, v_amount, (p ->> 'account_id')::uuid, nullif(p ->> 'tax_code_id', '')::uuid,
          nullif(btrim(coalesce(p ->> 'reference', '')), ''), btrim(p ->> 'narration'),
          coalesce(nullif(upper(btrim(coalesce(p ->> 'branch_code', ''))), ''), f.branch_code), v_doc, 'waiting_ledger_start', p_user_id)
  returning id into v_id;
  v_res := app.acc_banking_post_item('expense', v_id);
  update public.acc_petty_cash_expenses set status = v_res ->> 'status', journal_id = (v_res ->> 'journal_id')::uuid where id = v_id;
  return v_res || jsonb_build_object('id', v_id);
end;
$$;
revoke all on function public.acc_petty_cash_expense_create(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.acc_petty_cash_expense_create(uuid, uuid, jsonb) to service_role;

-- The text the signer's fingerprint covers (ids, dates and amounts; the explanation escaped like journal text).
create or replace function app.acc_petty_cash_count_hash(
  p_float uuid, p_month date, p_count_date date, p_counted numeric, p_book numeric, p_explanation text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(
    'pulse.petty_cash_count.v1|' || p_float::text || '|' || to_char(p_month, 'YYYY-MM-DD') || '|' || to_char(p_count_date, 'YYYY-MM-DD')
    || '|' || to_char(p_counted, 'FM999999999999990.00') || '|' || to_char(p_book, 'FM9999999999999990.00')
    || '|' || to_char(p_counted - p_book, 'FM9999999999999990.00')
    || '|' || app.acc_esc(coalesce(p_explanation, '')), 'UTF8')), 'hex');
$$;
revoke all on function app.acc_petty_cash_count_hash(uuid, date, date, numeric, numeric, text) from public, anon, authenticated;

-- Prepares (or prepares again, while unsigned) the month's count: the book balance is taken from the ledger up to the
-- count date. Whoever prepares it last is its preparer.
create or replace function public.acc_petty_cash_count_prepare(
  p_org_id uuid, p_user_id uuid, p_float_id uuid, p_count_date date, p_counted numeric, p_explanation text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.acc_petty_cash_floats;
  v_month date := date_trunc('month', p_count_date)::date;
  v_book numeric;
  v_expl text := nullif(btrim(coalesce(p_explanation, '')), '');
  v_hash text;
  v_id uuid;
begin
  perform app.acc_banking_require(p_org_id, p_user_id);
  select * into f from public.acc_petty_cash_floats where id = p_float_id and org_id = p_org_id;
  if not found then
    raise exception 'Float not found.' using errcode = 'check_violation', hint = 'not_found';
  end if;
  if p_count_date is null or p_counted is null or p_counted < 0 or round(p_counted, 2) <> p_counted or p_counted >= 1e12 then
    raise exception 'Enter the count date and the cash counted.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  if exists (select 1 from public.acc_petty_cash_counts c where c.float_id = f.id and c.month = v_month and c.status = 'signed') then
    raise exception 'This month''s count is already signed.' using errcode = 'check_violation', hint = 'count_signed';
  end if;
  v_book := app.acc_account_balance(f.account_id, p_count_date);
  if p_counted <> v_book and (v_expl is null or char_length(v_expl) < 3) then
    raise exception 'Explain the difference between the count and the book.' using errcode = 'check_violation', hint = 'explanation_required';
  end if;
  v_hash := app.acc_petty_cash_count_hash(f.id, v_month, p_count_date, p_counted, v_book, v_expl);
  insert into public.acc_petty_cash_counts (org_id, float_id, month, count_date, counted_amount, book_balance, difference,
                                            explanation, sha256, prepared_by, prepared_at)
  values (p_org_id, f.id, v_month, p_count_date, p_counted, v_book, p_counted - v_book, v_expl, v_hash, p_user_id, now())
  on conflict (float_id, month) do update
    set count_date = excluded.count_date, counted_amount = excluded.counted_amount, book_balance = excluded.book_balance,
        difference = excluded.difference, explanation = excluded.explanation, sha256 = excluded.sha256,
        prepared_by = excluded.prepared_by, prepared_at = excluded.prepared_at
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'book_balance', v_book, 'difference', p_counted - v_book, 'sha256', v_hash);
end;
$$;
revoke all on function public.acc_petty_cash_count_prepare(uuid, uuid, uuid, date, numeric, text) from public, anon, authenticated;
grant execute on function public.acc_petty_cash_count_prepare(uuid, uuid, uuid, date, numeric, text) to service_role;

-- A different person signs the fingerprint they were shown. A posting since the count changed the book balance: refused
-- (prepare it again).
create or replace function public.acc_petty_cash_count_sign(p_org_id uuid, p_user_id uuid, p_count_id uuid, p_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.acc_petty_cash_counts;
  v_account uuid;
begin
  perform app.acc_banking_require(p_org_id, p_user_id);
  select * into c from public.acc_petty_cash_counts where id = p_count_id and org_id = p_org_id for update;
  if not found then
    raise exception 'Count not found.' using errcode = 'check_violation', hint = 'not_found';
  end if;
  if c.status = 'signed' then
    raise exception 'This count is already signed.' using errcode = 'check_violation', hint = 'count_signed';
  end if;
  if c.prepared_by is not distinct from p_user_id or c.prepared_by is null then
    raise exception 'A different person from the one who counted signs it.' using errcode = 'check_violation', hint = 'same_person';
  end if;
  if p_sha256 is distinct from c.sha256 then
    raise exception 'The count changed since you opened it.' using errcode = 'check_violation', hint = 'hash_mismatch';
  end if;
  select f.account_id into v_account from public.acc_petty_cash_floats f where f.id = c.float_id;
  if app.acc_account_balance(v_account, c.count_date) <> c.book_balance then
    raise exception 'The book balance changed since the count; prepare it again.' using errcode = 'check_violation', hint = 'count_stale';
  end if;
  update public.acc_petty_cash_counts set status = 'signed', signed_by = p_user_id, signed_at = now() where id = c.id;
  return jsonb_build_object('id', c.id, 'status', 'signed');
end;
$$;
revoke all on function public.acc_petty_cash_count_sign(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.acc_petty_cash_count_sign(uuid, uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 9. Cheques
-- ---------------------------------------------------------------------------
-- p: { id?, bank_account_id, first_number, last_number, width?, active? }. Ranges of one account never overlap.
create or replace function public.acc_cheque_book_save(p_org_id uuid, p_user_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_bank uuid := nullif(p ->> 'bank_account_id', '')::uuid;
  v_first bigint;
  v_last bigint;
begin
  perform app.acc_banking_require(p_org_id, p_user_id);
  if v_id is not null then
    update public.acc_cheque_books set active = coalesce((p ->> 'active')::boolean, active)
     where id = v_id and org_id = p_org_id;
    if not found then
      raise exception 'Cheque book not found.' using errcode = 'check_violation', hint = 'not_found';
    end if;
    return jsonb_build_object('id', v_id);
  end if;
  begin
    v_first := (p ->> 'first_number')::bigint;
    v_last := (p ->> 'last_number')::bigint;
  exception when others then
    v_first := null;
  end;
  if v_first is null or v_last is null or v_first < 0 or v_last < v_first or v_last - v_first >= 10000 then
    raise exception 'Enter the first and last cheque numbers (at most 10,000 leaves).' using errcode = 'check_violation', hint = 'invalid';
  end if;
  if not exists (select 1 from public.fin_bank_accounts b where b.id = v_bank and b.org_id = p_org_id) then
    raise exception 'Bank account not found.' using errcode = 'check_violation', hint = 'not_found';
  end if;
  if exists (select 1 from public.acc_cheque_books k where k.bank_account_id = v_bank
             and k.first_number <= v_last and k.last_number >= v_first) then
    raise exception 'That range overlaps another cheque book of the account.' using errcode = 'check_violation', hint = 'book_overlap';
  end if;
  insert into public.acc_cheque_books (org_id, bank_account_id, first_number, last_number, next_number, width, created_by)
  values (p_org_id, v_bank, v_first, v_last, v_first,
          greatest(coalesce(nullif(p ->> 'width', '')::integer, 6), char_length(v_last::text)), p_user_id)
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end;
$$;
revoke all on function public.acc_cheque_book_save(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.acc_cheque_book_save(uuid, uuid, jsonb) to service_role;

-- Posts a cheque that is due (its date has come) and not yet posted; records the outcome on the row.
create or replace function app.acc_cheque_post_due(p_cheque_id uuid, p_today date)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  ch public.acc_cheques;
  v_res jsonb;
begin
  select * into ch from public.acc_cheques where id = p_cheque_id for update;
  if ch.posting not in ('not_due', 'waiting_ledger_start') or ch.cheque_date > p_today
     or ch.status not in ('issued', 'received', 'presented', 'cleared') then
    return ch.posting;
  end if;
  v_res := app.acc_banking_post_item('cheque', ch.id);
  update public.acc_cheques set posting = case when v_res ->> 'status' = 'posted' then 'posted' else 'waiting_ledger_start' end,
                                journal_id = (v_res ->> 'journal_id')::uuid
   where id = ch.id;
  return case when v_res ->> 'status' = 'posted' then 'posted' else 'waiting_ledger_start' end;
end;
$$;
revoke all on function app.acc_cheque_post_due(uuid, date) from public, anon, authenticated;

-- p: { direction, bank_account_id, cheque_book_id?, cheque_no?, cheque_date, recorded_on, amount, party_kind, party_ref?,
--      party_name?, counter_account_id, voucher_id?, narration? }. An issued cheque without a number takes the book's
-- next leaf. A cheque dated today or earlier posts now (dated its own date); a post-dated one posts on its date.
create or replace function public.acc_cheque_register(p_org_id uuid, p_user_id uuid, p jsonb, p_today date default current_date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dir text := p ->> 'direction';
  v_bank uuid := nullif(p ->> 'bank_account_id', '')::uuid;
  v_book public.acc_cheque_books;
  v_no text := nullif(btrim(coalesce(p ->> 'cheque_no', '')), '');
  v_kind text := p ->> 'party_kind';
  v_ref text := nullif(btrim(coalesce(p ->> 'party_ref', '')), '');
  v_name text := nullif(btrim(coalesce(p ->> 'party_name', '')), '');
  v_voucher public.fin_payment_vouchers;
  v_amount numeric;
  v_date date;
  v_recorded date;
  v_id uuid;
  v_posting text := 'not_due';
  v_flagged boolean;
begin
  perform app.acc_banking_require(p_org_id, p_user_id);
  v_amount := app.acc_banking_amount(p -> 'amount');
  if v_dir is null or v_dir not in ('issued', 'received') then
    raise exception 'Issued or received?' using errcode = 'check_violation', hint = 'invalid';
  end if;
  begin
    v_date := (p ->> 'cheque_date')::date;
    v_recorded := coalesce(nullif(p ->> 'recorded_on', '')::date, p_today);
  exception when others then
    v_date := null;
  end;
  if v_date is null then
    raise exception 'Enter the date on the cheque.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  if p_today > (v_date + interval '6 months')::date then
    raise exception 'A cheque older than six months is stale.' using errcode = 'check_violation', hint = 'cheque_stale';
  end if;
  perform app.acc_banking_bank_ledger(p_org_id, v_bank);
  perform app.acc_banking_counter_account(p_org_id, nullif(p ->> 'counter_account_id', '')::uuid,
                                          array['receivable', 'payable', 'clearing']);
  -- who: a patient by PIN only
  if v_kind is null or v_kind not in ('supplier', 'payer', 'customer', 'doctor', 'employee', 'patient', 'other') then
    raise exception 'Say who the cheque is from or to.' using errcode = 'check_violation', hint = 'party_invalid';
  end if;
  if v_kind = 'patient' then
    if v_name is not null or v_ref is null or v_ref !~ '^[A-Za-z0-9-]{1,20}$' then
      raise exception 'A patient is recorded by the Unite PIN only, never by name.' using errcode = 'check_violation', hint = 'party_patient';
    end if;
  elsif v_ref is null and v_name is null then
    raise exception 'Say who the cheque is from or to.' using errcode = 'check_violation', hint = 'party_invalid';
  end if;
  if v_kind = 'supplier' and v_ref is not null and not exists (
    select 1 from public.fin_suppliers s where s.org_id = p_org_id and s.id::text = v_ref) then
    raise exception 'Supplier not found.' using errcode = 'check_violation', hint = 'supplier_unknown';
  end if;
  if v_kind = 'payer' and v_ref is not null and not exists (
    select 1 from public.fin_ref_payers x where x.org_id = p_org_id and x.payer_id = v_ref) then
    raise exception 'Payer not found.' using errcode = 'check_violation', hint = 'payer_unknown';
  end if;
  -- the 20D voucher it pays
  if nullif(p ->> 'voucher_id', '') is not null then
    select * into v_voucher from public.fin_payment_vouchers v where v.id = (p ->> 'voucher_id')::uuid and v.org_id = p_org_id;
    if not found or v_dir <> 'issued' or v_voucher.payment_method <> 'cheque' or v_voucher.amount <> v_amount
       or v_voucher.status not in ('approved', 'for_tally', 'paid') then
      raise exception 'That voucher is not an approved cheque payment of this amount.' using errcode = 'check_violation', hint = 'voucher_mismatch';
    end if;
  end if;
  -- the leaf
  if nullif(p ->> 'cheque_book_id', '') is not null then
    if v_dir <> 'issued' then
      raise exception 'Only cheques we issue come from a cheque book.' using errcode = 'check_violation', hint = 'invalid';
    end if;
    select * into v_book from public.acc_cheque_books k where k.id = (p ->> 'cheque_book_id')::uuid and k.org_id = p_org_id for update;
    if not found or v_book.bank_account_id <> v_bank or not v_book.active then
      raise exception 'Choose an active cheque book of this account.' using errcode = 'check_violation', hint = 'book_invalid';
    end if;
    if v_no is null then
      if v_book.next_number > v_book.last_number then
        raise exception 'This cheque book is used up.' using errcode = 'check_violation', hint = 'book_exhausted';
      end if;
      v_no := lpad(v_book.next_number::text, v_book.width, '0');
    elsif v_no !~ '^[0-9]{1,12}$' or v_no::bigint < v_book.first_number or v_no::bigint > v_book.last_number then
      raise exception 'That number is not in the cheque book.' using errcode = 'check_violation', hint = 'book_invalid';
    end if;
    update public.acc_cheque_books set next_number = greatest(next_number, v_no::bigint + 1) where id = v_book.id;
  end if;
  if v_no is null or v_no !~ '^[0-9]{1,12}$' then
    raise exception 'Enter the cheque number (digits only).' using errcode = 'check_violation', hint = 'cheque_no';
  end if;
  begin
    insert into public.acc_cheques (org_id, direction, bank_account_id, cheque_book_id, cheque_no, cheque_date, recorded_on, amount,
                                    party_kind, party_ref, party_name, counter_account_id, voucher_id, narration, status, created_by,
                                    updated_by)
    values (p_org_id, v_dir, v_bank, v_book.id, v_no, v_date, v_recorded, v_amount, v_kind, v_ref, v_name,
            (p ->> 'counter_account_id')::uuid, v_voucher.id, nullif(btrim(coalesce(p ->> 'narration', '')), ''), v_dir,
            p_user_id, p_user_id)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'That cheque is already in the register.' using errcode = 'check_violation', hint = 'cheque_duplicate';
  end;
  if v_date <= p_today then
    v_posting := app.acc_cheque_post_due(v_id, p_today);
  end if;
  select exists (select 1 from public.acc_party_flags g
                 where g.org_id = p_org_id and g.cleared_at is null and g.party_kind = v_kind
                   and ((v_ref is not null and g.party_ref = v_ref) or (v_name is not null and lower(g.party_name) = lower(v_name))))
    into v_flagged;
  return jsonb_build_object('id', v_id, 'cheque_no', v_no, 'posting', v_posting, 'party_flagged', v_flagged);
end;
$$;
revoke all on function public.acc_cheque_register(uuid, uuid, jsonb, date) from public, anon, authenticated;
grant execute on function public.acc_cheque_register(uuid, uuid, jsonb, date) to service_role;

-- Ends a cheque's posting: a posted journal is reversed (dated p_date), anything not yet posted is never posted.
create or replace function app.acc_cheque_unpost(p_cheque public.acc_cheques, p_user_id uuid, p_date date, p_reason text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_cheque.posting = 'posted' then
    perform app.acc_reverse_internal(p_cheque.org_id, p_cheque.journal_id, p_user_id, p_date, p_reason);
    return 'reversed';
  end if;
  if p_cheque.posting = 'reversed' then
    return 'reversed';
  end if;
  return 'not_posted';
end;
$$;
revoke all on function app.acc_cheque_unpost(public.acc_cheques, uuid, date, text) from public, anon, authenticated;

-- One step in a cheque's life (lib/accounting/banking.ts CHEQUE_TRANSITIONS holds the same table):
--   present: issued / received -> presented        clear: issued / received / presented -> cleared
--   bounce: issued / received / presented / cleared -> bounced (reverses the posting, flags the party, optional charge)
--   cancel: issued / received -> cancelled (reverses)  stale: issued / received, six months after its date (reverses)
-- p_charge: { amount, account_id?, tax_code_id? } for a bounce charge (a bank entry on the cheque's account).
create or replace function public.acc_cheque_act(
  p_org_id uuid, p_user_id uuid, p_cheque_id uuid, p_action text, p_date date, p_reason text,
  p_charge jsonb default null, p_today date default current_date
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  ch public.acc_cheques;
  v_date date := coalesce(p_date, p_today);
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_to text;
  v_posting text;
  v_charge jsonb;
  v_charge_id uuid;
begin
  perform app.acc_banking_require(p_org_id, p_user_id);
  select * into ch from public.acc_cheques where id = p_cheque_id and org_id = p_org_id for update;
  if not found then
    raise exception 'Cheque not found.' using errcode = 'check_violation', hint = 'not_found';
  end if;
  v_to := case
    when p_action = 'present' and ch.status in ('issued', 'received') then 'presented'
    when p_action = 'clear' and ch.status in ('issued', 'received', 'presented') then 'cleared'
    when p_action = 'bounce' and ch.status in ('issued', 'received', 'presented', 'cleared') then 'bounced'
    when p_action = 'cancel' and ch.status in ('issued', 'received') then 'cancelled'
    when p_action = 'stale' and ch.status in ('issued', 'received') then 'stale'
  end;
  if v_to is null then
    raise exception 'That step is not possible for this cheque now.' using errcode = 'check_violation', hint = 'cheque_transition';
  end if;
  if v_date > p_today then
    raise exception 'The date cannot be in the future.' using errcode = 'check_violation', hint = 'date_future';
  end if;
  if v_to in ('presented', 'cleared', 'bounced') and v_date < ch.cheque_date then
    raise exception 'A post-dated cheque cannot be presented, cleared or bounced before its date.' using errcode = 'check_violation', hint = 'cheque_not_due';
  end if;
  if v_to = 'stale' and v_date <= (ch.cheque_date + interval '6 months')::date then
    raise exception 'A cheque goes stale six months after its date.' using errcode = 'check_violation', hint = 'cheque_not_stale';
  end if;
  if v_to in ('bounced', 'cancelled') and (v_reason is null or char_length(v_reason) < 3) then
    raise exception 'Say why.' using errcode = 'check_violation', hint = 'remarks_required';
  end if;

  if v_to in ('presented', 'cleared') then
    v_posting := app.acc_cheque_post_due(ch.id, p_today);
    update public.acc_cheques
       set status = v_to,
           presented_on = case when v_to = 'presented' then v_date else coalesce(presented_on, v_date) end,
           cleared_on = case when v_to = 'cleared' then v_date else cleared_on end,
           updated_by = p_user_id
     where id = ch.id;
  else
    if ch.journal_id is not null and v_date < ch.cheque_date then
      v_date := ch.cheque_date;   -- a reversal is never dated before the journal it reverses
    end if;
    v_posting := app.acc_cheque_unpost(ch, p_user_id, v_date,
                                       left(v_to || ' cheque ' || ch.cheque_no || coalesce(': ' || v_reason, ''), 300));
    -- the bank's charge for a bounce: a bank entry on the cheque's account (before the cheque becomes final)
    if v_to = 'bounced' and p_charge is not null and nullif(p_charge ->> 'amount', '') is not null then
      v_charge := app.acc_bank_entry_insert(p_org_id, p_user_id, jsonb_build_object(
        'bank_account_id', ch.bank_account_id, 'entry_date', v_date, 'kind', 'bank_charge', 'amount', p_charge -> 'amount',
        'account_id', coalesce(nullif(p_charge ->> 'account_id', ''),
                               (select a.id::text from public.acc_accounts a where a.org_id = p_org_id and a.code = '6500')),
        'tax_code_id', nullif(p_charge ->> 'tax_code_id', ''),
        'narration', 'Bounced cheque charge ' || ch.cheque_no), ch.id);
      v_charge_id := (v_charge ->> 'id')::uuid;
    end if;
    update public.acc_cheques
       set status = v_to, posting = v_posting,
           bounced_on = case when v_to = 'bounced' then v_date end,
           cancelled_on = case when v_to = 'cancelled' then v_date end,
           stale_on = case when v_to = 'stale' then v_date end,
           status_reason = coalesce(v_reason, case when v_to = 'stale' then 'six months after its date' end),
           charge_entry_id = v_charge_id,
           updated_by = p_user_id
     where id = ch.id;
    if v_to = 'bounced' then
      insert into public.acc_party_flags (org_id, cheque_id, reason, party_kind, party_ref, party_name)
      values (p_org_id, ch.id, case when ch.direction = 'received' then 'bounced_cheque_received' else 'bounced_cheque_issued' end,
              ch.party_kind, ch.party_ref, ch.party_name)
      on conflict (cheque_id) do nothing;
    end if;
  end if;
  return jsonb_build_object('id', ch.id, 'status', v_to, 'posting', v_posting, 'charge_entry_id', v_charge_id);
end;
$$;
revoke all on function public.acc_cheque_act(uuid, uuid, uuid, text, date, text, jsonb, date) from public, anon, authenticated;
grant execute on function public.acc_cheque_act(uuid, uuid, uuid, text, date, text, jsonb, date) to service_role;

create or replace function public.acc_party_flag_clear(p_org_id uuid, p_user_id uuid, p_flag_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform app.acc_banking_require(p_org_id, p_user_id);
  if v_reason is null or char_length(v_reason) < 3 or char_length(v_reason) > 300 then
    raise exception 'Say why the flag is cleared.' using errcode = 'check_violation', hint = 'remarks_required';
  end if;
  update public.acc_party_flags set cleared_at = now(), cleared_by = p_user_id, clear_reason = v_reason
   where id = p_flag_id and org_id = p_org_id and cleared_at is null;
  if not found then
    raise exception 'Flag not found.' using errcode = 'check_violation', hint = 'not_found';
  end if;
  return jsonb_build_object('id', p_flag_id);
end;
$$;
revoke all on function public.acc_party_flag_clear(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.acc_party_flag_clear(uuid, uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 10. The daily sweep: post cheques whose date has come, retry items waiting for the ledger start, mark stale cheques.
--     Idempotent; each item succeeds or fails on its own (the failure code is returned, the item is retried next run).
-- ---------------------------------------------------------------------------
create or replace function public.acc_banking_sweep(p_org_id uuid, p_today date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_res jsonb;
  v_hint text;
  v_posted integer := 0;
  v_waiting integer := 0;
  v_stale integer := 0;
  v_failed jsonb := '[]'::jsonb;
  v_ch public.acc_cheques;
begin
  if p_today is null then
    raise exception 'Enter the date.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  -- cheques that are due (post-dated ones reaching their date, and ones waiting for the ledger start)
  for r in
    select c.id from public.acc_cheques c
    where c.org_id = p_org_id and c.posting in ('not_due', 'waiting_ledger_start') and c.cheque_date <= p_today
      and c.status in ('issued', 'received', 'presented', 'cleared')
    order by c.cheque_date, c.id limit 500
  loop
    begin
      if app.acc_cheque_post_due(r.id, p_today) = 'posted' then v_posted := v_posted + 1; else v_waiting := v_waiting + 1; end if;
    exception when others then
      get stacked diagnostics v_hint = pg_exception_hint;
      v_failed := v_failed || jsonb_build_object('kind', 'cheque', 'id', r.id, 'code', coalesce(nullif(v_hint, ''), 'error'));
    end;
  end loop;
  -- transfers, entries and expenses waiting for the ledger start
  for r in
    select 'transfer' as kind, t.id from public.acc_bank_transfers t where t.org_id = p_org_id and t.status = 'waiting_ledger_start'
    union all
    select 'entry', e.id from public.acc_bank_entries e where e.org_id = p_org_id and e.status = 'waiting_ledger_start'
    union all
    select 'expense', x.id from public.acc_petty_cash_expenses x where x.org_id = p_org_id and x.status = 'waiting_ledger_start'
    limit 1500
  loop
    begin
      v_res := app.acc_banking_post_item(r.kind, r.id);
      if v_res ->> 'status' = 'posted' then
        execute format('update public.%I set status = ''posted'', journal_id = $1 where id = $2 and status = ''waiting_ledger_start''',
                       case r.kind when 'transfer' then 'acc_bank_transfers' when 'entry' then 'acc_bank_entries'
                                   else 'acc_petty_cash_expenses' end)
          using (v_res ->> 'journal_id')::uuid, r.id;
        v_posted := v_posted + 1;
      else
        v_waiting := v_waiting + 1;
      end if;
    exception when others then
      get stacked diagnostics v_hint = pg_exception_hint;
      v_failed := v_failed || jsonb_build_object('kind', r.kind, 'id', r.id, 'code', coalesce(nullif(v_hint, ''), 'error'));
    end;
  end loop;
  -- stale: six months after the cheque's date and never presented
  for r in
    select c.id from public.acc_cheques c
    where c.org_id = p_org_id and c.status in ('issued', 'received') and (c.cheque_date + interval '6 months')::date < p_today
    order by c.cheque_date, c.id limit 500
  loop
    begin
      select * into v_ch from public.acc_cheques where id = r.id for update;
      update public.acc_cheques
         set status = 'stale', stale_on = p_today, status_reason = 'six months after its date',
             posting = app.acc_cheque_unpost(v_ch, null, p_today, 'stale cheque ' || v_ch.cheque_no)
       where id = r.id;
      v_stale := v_stale + 1;
    exception when others then
      get stacked diagnostics v_hint = pg_exception_hint;
      v_failed := v_failed || jsonb_build_object('kind', 'cheque', 'id', r.id, 'code', coalesce(nullif(v_hint, ''), 'error'));
    end;
  end loop;
  return jsonb_build_object('posted', v_posted, 'waiting', v_waiting, 'stale', v_stale, 'failed', v_failed);
end;
$$;
revoke all on function public.acc_banking_sweep(uuid, date) from public, anon, authenticated;
grant execute on function public.acc_banking_sweep(uuid, date) to service_role;

-- ---------------------------------------------------------------------------
-- 11. Reading: ledger balances, and the bank position (book to bank) per bank account
-- ---------------------------------------------------------------------------
create or replace function public.acc_account_balances(p_org_id uuid, p_account_ids uuid[], p_as_of date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(a.id, app.acc_account_balance(a.id, p_as_of)), '{}'::jsonb)
  from public.acc_accounts a
  where a.org_id = p_org_id and a.id = any (p_account_ids) and not a.is_group;
$$;
revoke all on function public.acc_account_balances(uuid, uuid[], date) from public, anon, authenticated;
grant execute on function public.acc_account_balances(uuid, uuid[], date) to service_role;

-- For each bank account: its ledger balance today (p_as_of), the latest statement balance on or before it and, at that
-- statement date, the ledger balance and the cheques in the books but not yet through the bank (uncleared). The
-- book-to-bank arithmetic is lib/accounting/banking.ts bookToBank(). Also the unmatched statement lines and the latest
-- 20C reconciliation. Amounts and counts only.
create or replace function public.acc_bank_position(p_org_id uuid, p_as_of date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with acct as (
    select b.id, b.name, b.bank_name, b.last4, b.currency, b.active, b.gl_account_id,
           (select s.as_of from public.acc_bank_statement_balances s
             where s.bank_account_id = b.id and s.as_of <= p_as_of order by s.as_of desc limit 1) as stmt_date
    from public.fin_bank_accounts b
    where b.org_id = p_org_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'bank_account_id', a.id,
    'name', a.name, 'bank_name', a.bank_name, 'last4', a.last4, 'currency', a.currency, 'active', a.active,
    'gl_account_id', a.gl_account_id,
    'gl_code', (select x.code from public.acc_accounts x where x.id = a.gl_account_id),
    'gl_name', (select x.name from public.acc_accounts x where x.id = a.gl_account_id),
    'gl_balance', case when a.gl_account_id is not null then app.acc_account_balance(a.gl_account_id, p_as_of) end,
    'statement_date', a.stmt_date,
    'statement_balance', (select s.balance from public.acc_bank_statement_balances s where s.bank_account_id = a.id and s.as_of = a.stmt_date),
    'gl_at_statement', case when a.gl_account_id is not null and a.stmt_date is not null
                            then app.acc_account_balance(a.gl_account_id, a.stmt_date) end,
    'uncleared_issued', (select jsonb_build_object('count', count(*), 'amount', coalesce(sum(c.amount), 0))
                         from public.acc_cheques c
                         where c.bank_account_id = a.id and c.direction = 'issued' and c.posting in ('posted', 'reversed')
                           and c.cheque_date <= coalesce(a.stmt_date, p_as_of)
                           and (c.cleared_on is null or c.cleared_on > coalesce(a.stmt_date, p_as_of))
                           and (coalesce(c.bounced_on, c.cancelled_on, c.stale_on) is null
                                or coalesce(c.bounced_on, c.cancelled_on, c.stale_on) > coalesce(a.stmt_date, p_as_of))),
    'uncleared_received', (select jsonb_build_object('count', count(*), 'amount', coalesce(sum(c.amount), 0))
                           from public.acc_cheques c
                           where c.bank_account_id = a.id and c.direction = 'received' and c.posting in ('posted', 'reversed')
                             and c.cheque_date <= coalesce(a.stmt_date, p_as_of)
                             and (c.cleared_on is null or c.cleared_on > coalesce(a.stmt_date, p_as_of))
                             and (coalesce(c.bounced_on, c.cancelled_on, c.stale_on) is null
                                  or coalesce(c.bounced_on, c.cancelled_on, c.stale_on) > coalesce(a.stmt_date, p_as_of))),
    'post_dated', (select jsonb_build_object('count', count(*), 'issued', coalesce(sum(c.amount) filter (where c.direction = 'issued'), 0),
                                             'received', coalesce(sum(c.amount) filter (where c.direction = 'received'), 0))
                   from public.acc_cheques c
                   where c.bank_account_id = a.id and c.posting = 'not_due' and c.status in ('issued', 'received', 'presented')),
    'unmatched_lines', (select jsonb_build_object('count', count(*),
                                                  'credits', coalesce(sum(l.amount) filter (where l.amount > 0), 0),
                                                  'debits', coalesce(-sum(l.amount) filter (where l.amount < 0), 0))
                        from public.fin_bank_lines l
                        where l.account_id = a.id and l.match_status = 'unmatched' and l.value_date <= coalesce(a.stmt_date, p_as_of)),
    'last_statement_line', (select max(l.value_date) from public.fin_bank_lines l where l.account_id = a.id),
    'latest_rec', (select jsonb_build_object('id', r.id, 'month', r.month, 'status', r.status)
                   from public.fin_bank_recs r where r.account_id = a.id order by r.month desc limit 1)
  ) order by a.name), '[]'::jsonb)
  from acct a;
$$;
revoke all on function public.acc_bank_position(uuid, date) from public, anon, authenticated;
grant execute on function public.acc_bank_position(uuid, date) to service_role;

-- ---------------------------------------------------------------------------
-- 12. History: transfers, entries and cheques (who changed what)
-- ---------------------------------------------------------------------------
select app.enable_record_history('acc_bank_transfers');
select app.enable_record_history('acc_bank_entries');
select app.enable_record_history('acc_cheques');

-- app.can_view_record_history: the three tables for banking readers. Patched in place after the acc_journals line so
-- the cases other slices add are kept.
do $$
declare
  v_def text;
  v_new text;
begin
  v_def := pg_get_functiondef('app.can_view_record_history(uuid, text)'::regprocedure);
  if position('acc_bank_transfers' in v_def) = 0 then
    v_new := replace(v_def, 'when ''acc_journals'' then app.acc_can_read_journals(p_org_id)',
      'when ''acc_journals'' then app.acc_can_read_journals(p_org_id)
    when ''acc_bank_transfers'' then app.acc_can_read_banking(p_org_id)
    when ''acc_bank_entries'' then app.acc_can_read_banking(p_org_id)
    when ''acc_cheques'' then app.acc_can_read_banking(p_org_id)');
    if v_new = v_def then
      raise exception 'can_view_record_history: the acc_journals case was not found';
    end if;
    execute v_new;
  end if;
end $$;
