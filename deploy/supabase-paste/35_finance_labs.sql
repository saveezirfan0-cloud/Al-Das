-- Paste into Supabase > SQL Editor > New query, then Run. Needs 34_finance_bank_ai.sql applied first.
-- The migration-history line is included at the bottom of this file.

-- Slice 20E: lab and external-referral reconciliation (docs/20_FINANCE_CONTROL_PLAN.md slice 20E, docs/20_PHASE_20E_NOTES.md).
--
--   * finance.labs.view (Finance, Finance Manager, CEO) and finance.labs.manage (Finance, Finance Manager)
--   * fin_providers: the in-house lab (fixed monthly fee, shared by test count or by billed revenue), send-out labs,
--     hospitals, radiology and other third parties
--   * fin_ref_provider_tests: per provider and test code, the expected turnaround in days and the agreed price (both
--     optional); thresholds live here and in fin_ref_finance_settings (lab_*), never in code
--   * fin_import_formats gains the kinds lab_activity and provider_invoice (field lists in lib/finance/import-kinds.ts:
--     dates, codes, PIN, doctor id, branch, amount, invoice number; NO name or ID-number field exists)
--   * fin_provider_statements: one reconciliation per provider and month (open -> reviewed -> posted); the figures are
--     frozen with their sha256 at review; posting needs a different person from the preparer (enforced here) and writes
--     the per-doctor costs into fin_doctor_charges (source lab_recon / referral_recon, reference = statement id),
--     replacing only that statement's rows
--   * fin_provider_files (sha256 of each file, never the file) and fin_provider_lines (sanitised rows only)
--   * fin_provider_notes: the reason for each unmatched line or billed test missing from the file
--
-- Matching, turnaround and allocation are computed in TypeScript (lib/finance/labs.ts) from fin_lab_unite_lines().
-- Staff read through RLS (select only); every write is a server action using the service role after can(), audited.
-- A locked month (fin_period_closes) refuses every change to its statements, files, lines, reasons and charges.
-- Codes, dates, amounts, Unite PINs and doctor ids only: no names, dates of birth, Emirates IDs or member ids.

-- ---------------------------------------------------------------------------
-- 1. Permissions for existing system roles (new orgs get them from lib/auth/permissions.ts)
-- ---------------------------------------------------------------------------
do $$
declare
  g record;
begin
  for g in
    select * from (values
      ('Finance', 'finance.labs.view'),
      ('Finance', 'finance.labs.manage'),
      ('Finance Manager', 'finance.labs.view'),
      ('Finance Manager', 'finance.labs.manage'),
      ('CEO', 'finance.labs.view')
    ) as t (role_name, perm)
  loop
    update public.roles r
       set permissions = r.permissions || to_jsonb(g.perm)
     where r.is_system and r.name = g.role_name and not (r.permissions ? g.perm);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Reference: providers, tests (turnaround and price), settings, file layouts
-- ---------------------------------------------------------------------------
create table public.fin_providers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  kind text not null check (kind in ('in_house_lab', 'send_out_lab', 'hospital', 'radiology', 'other')),
  fixed_monthly_fee numeric(14, 2) check (fixed_monthly_fee is null or (fixed_monthly_fee > 0 and fixed_monthly_fee <= 100000000)),
  allocation_basis text not null default 'test_count' check (allocation_basis in ('test_count', 'revenue')),
  active boolean not null default true,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name),
  check (kind = 'in_house_lab' or fixed_monthly_fee is null)        -- only the in-house lab has a fixed fee
);
create trigger fin_providers_set_updated_at before update on public.fin_providers
  for each row execute function app.set_updated_at();

create table public.fin_ref_provider_tests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  provider_id uuid not null references public.fin_providers (id) on delete cascade,
  code text not null check (code = upper(btrim(code)) and code ~ '^[A-Z0-9][A-Z0-9._/-]{0,39}$'),   -- CPT or Unite item code
  expected_days integer check (expected_days is null or expected_days between 0 and 365),
  agreed_price numeric(14, 2) check (agreed_price is null or (agreed_price >= 0 and agreed_price <= 100000000)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_id, code),
  check (expected_days is not null or agreed_price is not null)
);
create trigger fin_ref_provider_tests_set_updated_at before update on public.fin_ref_provider_tests
  for each row execute function app.set_updated_at();
create trigger fin_ref_provider_tests_provider_org_check before insert or update of provider_id, org_id on public.fin_ref_provider_tests
  for each row execute function app.check_parent_org('fin_providers', 'provider_id');

alter table public.fin_ref_finance_settings
  add column lab_date_window_days integer not null default 2 check (lab_date_window_days between 0 and 10),
  add column lab_price_tolerance numeric(12, 2) not null default 1.00 check (lab_price_tolerance between 0 and 10000);

-- the generic import engine (20C) learns the two lab kinds; the field lists live in lib/finance/import-kinds.ts
alter table public.fin_import_formats drop constraint fin_import_formats_kind_check;
alter table public.fin_import_formats add constraint fin_import_formats_kind_check
  check (kind in ('bank_statement', 'settlement', 'lab_activity', 'provider_invoice'));
drop policy fin_import_formats_select on public.fin_import_formats;
create policy fin_import_formats_select on public.fin_import_formats for select to authenticated
  using (app.has_perm(org_id, 'finance.bank.view') or app.has_perm(org_id, 'finance.bank.manage')
      or app.has_perm(org_id, 'finance.bank.signoff')
      or app.has_perm(org_id, 'finance.labs.view') or app.has_perm(org_id, 'finance.labs.manage'));

-- ---------------------------------------------------------------------------
-- 3. Statements (one per provider and month), their files and lines, and the reasons
-- ---------------------------------------------------------------------------
create table public.fin_provider_statements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  provider_id uuid not null references public.fin_providers (id) on delete restrict,
  month date not null check (month = date_trunc('month', month)::date),
  status text not null default 'open' check (status in ('open', 'reviewed', 'posted')),
  figures jsonb check (figures is null or jsonb_typeof(figures) = 'object'),
  figures_sha256 text,
  prepared_by uuid references public.profiles (id) on delete set null,
  prepared_at timestamptz,
  posted_by uuid references public.profiles (id) on delete set null,
  posted_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, provider_id, month),
  check (status = 'open' or (figures is not null and figures_sha256 is not null and prepared_at is not null)),
  check ((status = 'posted') = (posted_at is not null)),
  check (prepared_by is null or posted_by is null or prepared_by <> posted_by)
);
create index fin_provider_statements_org_idx on public.fin_provider_statements (org_id, month desc);
create trigger fin_provider_statements_set_updated_at before update on public.fin_provider_statements
  for each row execute function app.set_updated_at();
create trigger fin_provider_statements_provider_org_check before insert or update of provider_id, org_id on public.fin_provider_statements
  for each row execute function app.check_parent_org('fin_providers', 'provider_id');

create table public.fin_provider_files (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  statement_id uuid not null references public.fin_provider_statements (id) on delete cascade,
  kind text not null check (kind in ('lab_activity', 'provider_invoice')),
  format_id uuid references public.fin_import_formats (id) on delete set null,
  file_name text check (file_name is null or char_length(file_name) <= 200),
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  row_count integer not null default 0,
  total_amount numeric(16, 2) not null default 0,
  first_date date,
  last_date date,
  imported_by uuid references public.profiles (id) on delete set null,
  imported_at timestamptz not null default now(),
  unique (org_id, file_sha256)                          -- the same file twice is refused
);
create index fin_provider_files_statement_idx on public.fin_provider_files (statement_id);
create trigger fin_provider_files_statement_org_check before insert or update of statement_id, org_id on public.fin_provider_files
  for each row execute function app.check_parent_org('fin_provider_statements', 'statement_id');

-- Sanitised rows only: codes, dates, an amount, the Unite PIN and the doctor's DHA id. Never a name or an ID number.
create table public.fin_provider_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  statement_id uuid not null references public.fin_provider_statements (id) on delete cascade,
  file_id uuid not null references public.fin_provider_files (id) on delete cascade,
  row_no integer not null,
  service_date date not null,
  code text not null check (code = upper(btrim(code)) and code ~ '^[A-Z0-9][A-Z0-9._/-]{0,39}$'),
  patient_pin text check (patient_pin is null or (patient_pin ~ '^[A-Z0-9][A-Z0-9/-]{0,39}$' and patient_pin ~ '[0-9]')),
  doctor_dha_id text check (doctor_dha_id is null or (doctor_dha_id ~ '^[A-Z0-9][A-Z0-9/-]{0,39}$' and doctor_dha_id ~ '[0-9]')),
  branch_code text check (branch_code is null or char_length(branch_code) between 1 and 20),
  result_date date check (result_date is null or result_date >= service_date),
  amount numeric(14, 2) check (amount is null or (amount >= 0 and amount <= 100000000)),
  invoice_no text check (invoice_no is null or invoice_no ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$'),
  created_at timestamptz not null default now(),
  unique (file_id, row_no)
);
create index fin_provider_lines_statement_idx on public.fin_provider_lines (statement_id);
create trigger fin_provider_lines_file_org_check before insert or update of file_id, org_id on public.fin_provider_lines
  for each row execute function app.check_parent_org('fin_provider_files', 'file_id');

create table public.fin_provider_notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  statement_id uuid not null references public.fin_provider_statements (id) on delete cascade,
  item_key text not null check (item_key ~ '^(line|unite)\|[0-9a-f-]{36}$'),   -- line|<provider line id> or unite|<invoice line id>
  reason_code text not null check (reason_code in (
    'billed_other_month', 'not_billable', 'billed_other_code', 'billing_to_correct', 'provider_error', 'checked_by_hand', 'other')),
  note text check (note is null or (btrim(note) <> '' and char_length(note) <= 200)),
  decided_by uuid references public.profiles (id) on delete set null,
  decided_at timestamptz not null default now(),
  unique (statement_id, item_key),
  check (reason_code <> 'other' or note is not null)
);
create trigger fin_provider_notes_statement_org_check before insert or update of statement_id, org_id on public.fin_provider_notes
  for each row execute function app.check_parent_org('fin_provider_statements', 'statement_id');

-- ---------------------------------------------------------------------------
-- 4. Guards (run for every role, including the service role)
-- ---------------------------------------------------------------------------
-- A statement: provider and month never change; open -> reviewed (figures frozen, hash computed here) -> posted by a
-- different person; reviewed or posted -> open withdraws it (fin_lab_reopen removes the posted charges first).
-- A locked month refuses every change.
create or replace function app.fin_provider_statement_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.orgs o where o.id = old.org_id) then
      raise exception 'a provider statement cannot be deleted' using errcode = '42501';
    end if;
    return old;
  end if;
  if new.org_id is null or new.month is null then
    return new;   -- incomplete row (the security probe): RLS and NOT NULL answer
  end if;

  if tg_op = 'UPDATE' then
    -- the FK action that nulls a deleted user's id is always allowed
    if (to_jsonb(new) - 'prepared_by' - 'posted_by' - 'created_by' - 'updated_at')
       is not distinct from (to_jsonb(old) - 'prepared_by' - 'posted_by' - 'created_by' - 'updated_at')
       and (new.prepared_by is null or new.prepared_by = old.prepared_by)
       and (new.posted_by is null or new.posted_by = old.posted_by)
       and (new.created_by is null or new.created_by = old.created_by) then
      return new;
    end if;
  end if;

  if app.fin_month_is_locked(new.org_id, new.month) then
    raise exception 'the month of this statement is locked' using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'open' or new.figures is not null or new.prepared_by is not null or new.posted_by is not null then
      raise exception 'a statement starts open' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if (new.org_id, new.provider_id, new.month) is distinct from (old.org_id, old.provider_id, old.month) then
    raise exception 'the provider and month of a statement cannot change' using errcode = 'check_violation';
  end if;

  if old.status = new.status then
    if (new.figures, new.figures_sha256, new.prepared_by, new.prepared_at, new.posted_by, new.posted_at)
       is distinct from (old.figures, old.figures_sha256, old.prepared_by, old.prepared_at, old.posted_by, old.posted_at) then
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
    new.posted_by := null;
    new.posted_at := null;
  elsif old.status in ('reviewed', 'posted') and new.status = 'open' then
    new.figures := null;
    new.figures_sha256 := null;
    new.prepared_by := null;
    new.prepared_at := null;
    new.posted_by := null;
    new.posted_at := null;
  elsif old.status = 'reviewed' and new.status = 'posted' then
    if new.posted_by is null then
      raise exception 'posting needs the person who posts' using errcode = 'check_violation';
    end if;
    if new.posted_by = old.prepared_by then
      raise exception 'the preparer and the person who posts must be two different people' using errcode = 'check_violation';
    end if;
    if (new.figures, new.figures_sha256, new.prepared_by, new.prepared_at)
       is distinct from (old.figures, old.figures_sha256, old.prepared_by, old.prepared_at) then
      raise exception 'the figures cannot change when posting' using errcode = 'check_violation';
    end if;
    new.posted_at := now();
  else
    raise exception 'invalid statement transition % -> %', old.status, new.status using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function app.fin_provider_statement_guard() from public, anon, authenticated;
create trigger fin_provider_statements_guard before insert or update or delete on public.fin_provider_statements
  for each row execute function app.fin_provider_statement_guard();

-- Files, lines and reasons change only while their statement is open and its month is not locked. Lines never change
-- once stored (a wrong file is removed and uploaded again).
create or replace function app.fin_provider_child_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_statement uuid;
  v_status text;
  v_org uuid;
  v_month date;
begin
  if tg_op = 'UPDATE' and tg_table_name = 'fin_provider_lines' then
    raise exception 'a stored line cannot change; remove its file and upload it again' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    v_statement := old.statement_id;
  else
    v_statement := new.statement_id;
  end if;
  select s.status, s.org_id, s.month into v_status, v_org, v_month
  from public.fin_provider_statements s where s.id = v_statement;
  if found and exists (select 1 from public.orgs o where o.id = v_org) then
    if app.fin_month_is_locked(v_org, v_month) then
      raise exception 'the month of this statement is locked' using errcode = '42501';
    end if;
    if v_status <> 'open' then
      raise exception 'the statement is %; reopen it first', v_status using errcode = 'check_violation';
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
revoke all on function app.fin_provider_child_guard() from public, anon, authenticated;
create trigger fin_provider_files_guard before insert or update or delete on public.fin_provider_files
  for each row execute function app.fin_provider_child_guard();
create trigger fin_provider_lines_guard before insert or update or delete on public.fin_provider_lines
  for each row execute function app.fin_provider_child_guard();
create trigger fin_provider_notes_guard before insert or update or delete on public.fin_provider_notes
  for each row execute function app.fin_provider_child_guard();

-- ---------------------------------------------------------------------------
-- 5. RLS: staff with a labs permission read their org's rows; nobody writes directly (server actions, service role)
-- ---------------------------------------------------------------------------
alter table public.fin_providers enable row level security;
alter table public.fin_ref_provider_tests enable row level security;
alter table public.fin_provider_statements enable row level security;
alter table public.fin_provider_files enable row level security;
alter table public.fin_provider_lines enable row level security;
alter table public.fin_provider_notes enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['fin_providers', 'fin_ref_provider_tests', 'fin_provider_statements', 'fin_provider_files',
                           'fin_provider_lines', 'fin_provider_notes']
  loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (app.has_perm(org_id, %L) or app.has_perm(org_id, %L))',
      t || '_select', t, 'finance.labs.view', 'finance.labs.manage');
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Functions (SECURITY DEFINER, service role only; the server has run can() first)
-- ---------------------------------------------------------------------------
-- Current Unite invoice lines (invoice not deleted) dated p_from..p_to whose item code, line CPT or reference CPT is one
-- of p_codes (upper case). The doctor follows the configured doctor basis, as the revenue share does. No names.
create or replace function public.fin_lab_unite_lines(p_org_id uuid, p_from date, p_to date, p_codes text[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with basis as (select s.doctor_basis from public.fin_ref_finance_settings s where s.org_id = p_org_id)
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', l.id, 'invoice_id', i.id,
           'pin', upper(nullif(btrim(i.patient_pin), '')),
           'date', i.transaction_date,
           'item_code', upper(nullif(btrim(l.item_code), '')),
           'line_cpt', upper(nullif(btrim(l.cpt_code), '')),
           'ref_cpt', upper(nullif(btrim(s.cpt_code), '')),
           'net', coalesce(l.line_net, 0),
           'branch', nullif(btrim(i.branch_code), ''),
           'doctor', upper(nullif(btrim(case (select doctor_basis from basis)
                       when 'ordering' then coalesce(i.ordering_doctor_dha_id, i.doctor_dha_id)
                       when 'performing' then coalesce(i.performing_doctor_dha_id, i.doctor_dha_id)
                       else i.doctor_dha_id end), '')))
           order by i.transaction_date, l.id), '[]'::jsonb)
  from public.fin_invoices i
  join public.fin_invoice_lines l on l.invoice_id = i.id and l.is_current
  left join public.fin_ref_services s on s.org_id = i.org_id and s.item_code = l.item_code
  where i.org_id = p_org_id and not i.is_deleted
    and i.transaction_date between p_from and p_to
    and (upper(btrim(l.item_code)) = any (p_codes) or upper(btrim(l.cpt_code)) = any (p_codes)
         or upper(btrim(s.cpt_code)) = any (p_codes));
$$;
revoke all on function public.fin_lab_unite_lines(uuid, date, date, text[]) from public, anon, authenticated;
grant execute on function public.fin_lab_unite_lines(uuid, date, date, text[]) to service_role;

-- Stores one parsed file atomically into the provider's statement for the month (opened here when missing). p_rows are
-- the sanitised rows the server parsed: service_date, code, patient_pin, doctor_dha_id, branch_code, result_date, amount,
-- invoice_no. The same file twice (sha256) is refused; so is a statement that is not open, a locked month, and a
-- service date after the month or before the previous month.
create or replace function public.fin_provider_import(
  p_org_id uuid, p_provider_id uuid, p_month date, p_format_id uuid, p_file_name text, p_sha256 text,
  p_rows jsonb, p_user uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_file_kind text;
  v_month date := date_trunc('month', p_month)::date;
  v_statement uuid;
  v_status text;
  v_file uuid;
begin
  select p.kind into v_kind from public.fin_providers p where p.id = p_provider_id and p.org_id = p_org_id and p.active;
  if v_kind is null then
    raise exception 'provider not found' using errcode = 'invalid_parameter_value';
  end if;
  v_file_kind := case when v_kind = 'in_house_lab' then 'lab_activity' else 'provider_invoice' end;
  if not exists (select 1 from public.fin_import_formats f
                 where f.id = p_format_id and f.org_id = p_org_id and f.kind = v_file_kind) then
    raise exception 'this layout is not for this provider''s files' using errcode = 'invalid_parameter_value';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 20000 then
    raise exception 'a file holds 1 to 20000 rows' using errcode = 'invalid_parameter_value';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) r
             where (r ->> 'service_date')::date > (v_month + interval '1 month' - interval '1 day')::date
                or (r ->> 'service_date')::date < (v_month - interval '1 month')::date) then
    raise exception 'service dates must fall in the month or the month before' using errcode = 'check_violation';
  end if;
  if v_file_kind = 'provider_invoice' and exists (select 1 from jsonb_array_elements(p_rows) r where r ->> 'amount' is null) then
    raise exception 'every invoice line needs its amount' using errcode = 'check_violation';
  end if;

  select s.id, s.status into v_statement, v_status
  from public.fin_provider_statements s
  where s.org_id = p_org_id and s.provider_id = p_provider_id and s.month = v_month
  for update;
  if v_statement is null then
    insert into public.fin_provider_statements (org_id, provider_id, month, created_by)
    values (p_org_id, p_provider_id, v_month, p_user)
    returning id into v_statement;
  elsif v_status <> 'open' then
    raise exception 'the statement is %; reopen it first', v_status using errcode = 'check_violation';
  end if;

  insert into public.fin_provider_files (org_id, statement_id, kind, format_id, file_name, file_sha256, row_count,
                                         total_amount, first_date, last_date, imported_by)
  select p_org_id, v_statement, v_file_kind, p_format_id, left(p_file_name, 200), p_sha256, count(*),
         coalesce(sum((r ->> 'amount')::numeric), 0), min((r ->> 'service_date')::date), max((r ->> 'service_date')::date), p_user
  from jsonb_array_elements(p_rows) r
  returning id into v_file;
  insert into public.fin_provider_lines (org_id, statement_id, file_id, row_no, service_date, code, patient_pin,
                                         doctor_dha_id, branch_code, result_date, amount, invoice_no)
  select p_org_id, v_statement, v_file, x.n, (x.r ->> 'service_date')::date, x.r ->> 'code', nullif(x.r ->> 'patient_pin', ''),
         nullif(x.r ->> 'doctor_dha_id', ''), nullif(x.r ->> 'branch_code', ''), (x.r ->> 'result_date')::date,
         (x.r ->> 'amount')::numeric, nullif(x.r ->> 'invoice_no', '')
  from jsonb_array_elements(p_rows) with ordinality as x (r, n);
  return v_statement;
end;
$$;
revoke all on function public.fin_provider_import(uuid, uuid, date, uuid, text, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.fin_provider_import(uuid, uuid, date, uuid, text, text, jsonb, uuid) to service_role;

-- Posts a reviewed statement: the frozen per-doctor costs (figures -> 'doctors': [{doctor_dha_id, amount}]) become doctor
-- charges for the statement's month (kind lab for labs, referral for third parties). Bound to the sha256 the poster was
-- shown; the poster must not be the preparer. Idempotent: the statement's earlier charges are replaced, nothing else.
create or replace function public.fin_lab_post(p_org_id uuid, p_statement_id uuid, p_hash text, p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s record;
  v_provider_kind text;
  v_kind text;
  v_source text;
  v_removed integer;
  v_added integer;
begin
  select st.* into s from public.fin_provider_statements st
  where st.id = p_statement_id and st.org_id = p_org_id
  for update;
  if not found then
    raise exception 'statement not found' using errcode = 'invalid_parameter_value';
  end if;
  if s.status not in ('reviewed', 'posted') then
    raise exception 'only a reviewed statement can be posted' using errcode = 'check_violation';
  end if;
  if p_hash is null or s.figures_sha256 is distinct from p_hash then
    raise exception 'the figures changed; reload and check them again' using errcode = 'check_violation';
  end if;
  if p_user is null or p_user = s.prepared_by then
    raise exception 'the preparer and the person who posts must be two different people' using errcode = 'check_violation';
  end if;
  select p.kind into v_provider_kind from public.fin_providers p where p.id = s.provider_id;
  v_kind := case when v_provider_kind in ('in_house_lab', 'send_out_lab') then 'lab' else 'referral' end;
  v_source := case when v_kind = 'lab' then 'lab_recon' else 'referral_recon' end;

  delete from public.fin_doctor_charges c
   where c.org_id = p_org_id and c.source in ('lab_recon', 'referral_recon') and c.reference = s.id::text;
  get diagnostics v_removed = row_count;
  insert into public.fin_doctor_charges (org_id, month, doctor_dha_id, kind, amount, source, reference, created_by)
  select p_org_id, s.month, upper(btrim(d ->> 'doctor_dha_id')), v_kind, (d ->> 'amount')::numeric, v_source, s.id::text, p_user
  from jsonb_array_elements(coalesce(s.figures -> 'doctors', '[]'::jsonb)) d
  where (d ->> 'amount')::numeric > 0;
  get diagnostics v_added = row_count;

  if s.status = 'reviewed' then
    update public.fin_provider_statements set status = 'posted', posted_by = p_user where id = s.id;
  end if;
  return jsonb_build_object('removed', v_removed, 'added', v_added);
end;
$$;
revoke all on function public.fin_lab_post(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.fin_lab_post(uuid, uuid, text, uuid) to service_role;

-- Returns a reviewed or posted statement to open; a posted statement's charges are removed first (all or nothing).
create or replace function public.fin_lab_reopen(p_org_id uuid, p_statement_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  select st.status into v_status from public.fin_provider_statements st
  where st.id = p_statement_id and st.org_id = p_org_id
  for update;
  if v_status is null then
    raise exception 'statement not found' using errcode = 'invalid_parameter_value';
  end if;
  if v_status = 'open' then
    raise exception 'the statement is already open' using errcode = 'check_violation';
  end if;
  delete from public.fin_doctor_charges c
   where c.org_id = p_org_id and c.source in ('lab_recon', 'referral_recon') and c.reference = p_statement_id::text;
  update public.fin_provider_statements set status = 'open' where id = p_statement_id;
end;
$$;
revoke all on function public.fin_lab_reopen(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fin_lab_reopen(uuid, uuid) to service_role;

insert into supabase_migrations.schema_migrations (version, name) values ('20261105000100', 'finance_labs') on conflict (version) do nothing;
