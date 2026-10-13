-- Paste into Supabase > SQL Editor > New query, then Run. Needs 22_finance_flash.sql applied first.
-- The migration-history line is included at the bottom of this file.

-- Phase 20D: payables and zero-paper approvals (docs/20_FINANCE_CONTROL_PLAN.md slice 20D, CEO directive
-- "Zero Paper. Full Accountability", OQ-90 / 91 / 92).
--
--   * permissions finance.payables.* / finance.vouchers.* / finance.tally.export, the Finance Manager (checker) and
--     Department head presets
--   * fin_documents + private bucket `finance-documents`: one generic store for finance evidence (supplier invoices,
--     voucher backup; bank statements later in 20B). Supplier invoices and bank statements are not patient data, but are
--     confidential: service-only writes, signed links, the access log. File names are never stored.
--   * fin_suppliers, fin_supplier_invoices
--   * fin_payment_vouchers (+ fin_voucher_invoices, fin_voucher_documents, fin_voucher_events, fin_voucher_counters):
--     maker, checker, department head, CEO; delegation of authority in fin_ref_approval_tiers; approvals bound to the
--     voucher's content sha256 (fields + every attachment's sha256); append-only event trail
--   * fin_ref_tally_ledgers (Pulse key -> TallyPrime ledger name) and fin_tally_exports (one-way XML exports)
--   * fin_ref_finance_settings: approval_mode ('pulse' | 'tally', OQ-90), report thresholds, Tally company and cost
--     category
--
-- The state machine lives in SECURITY DEFINER functions (search_path = '', service role only, jsonb results). The server
-- runs can() first; the database enforces the order, distinct people at every step, mandatory rejection remarks, the hash
-- binding, the delegation-of-authority routing, Tier-1-only bulk checks and the month lock. Errors carry a stable code in
-- the HINT (lib/finance/vouchers.ts maps it to a sentence); the pure mirror in lib/finance/vouchers.ts is parity-tested
-- against these functions with tests/unit/finance/fixtures/phase20d-vouchers.synthetic.json.

-- ---------------------------------------------------------------------------
-- 1. Permissions for existing system roles, and the two new presets (new orgs get them from lib/auth/permissions.ts)
-- ---------------------------------------------------------------------------
do $$
declare
  g record;
begin
  for g in
    select * from (values
      ('Finance', 'finance.payables.view'),
      ('Finance', 'finance.payables.manage'),
      ('Finance', 'finance.vouchers.prepare'),
      ('Finance', 'finance.vouchers.pay'),
      ('Finance', 'finance.tally.export'),
      ('CEO', 'finance.payables.view'),
      ('CEO', 'finance.vouchers.approve_ceo')
    ) as t (role_name, perm)
  loop
    update public.roles r
       set permissions = r.permissions || to_jsonb(g.perm)
     where r.is_system and r.name = g.role_name and not (r.permissions ? g.perm);
  end loop;
end $$;

-- The checker. Holds what Finance holds plus finance.vouchers.check and the approval settings, so the person who
-- prepares vouchers (Finance) is not automatically the person who verifies them.
insert into public.roles (org_id, name, description, permissions, is_system)
select o.id, 'Finance Manager',
       'Everything Finance does, plus verifying payment vouchers (the checker) and the delegation-of-authority settings.',
       '["reports.view","finance.view","finance.invoices.view","finance.claims.view","finance.reference.manage","finance.preauth.manage","finance.denials.manage","finance.remittance.manage","finance.scorecards.view","finance.forecast.view","finance.recovery.manage","finance.recovery.approve","finance.payment_links","finance.close.view","finance.close.manage","finance.close.signoff.finance","finance.cashup.manage","finance.revenue.view","finance.export.run","finance.costs.manage","finance.costs.view","finance.costs.compensation","finance.profit.view","finance.profit.approve","finance.flash.view","finance.targets.manage","finance.payables.view","finance.payables.manage","finance.vouchers.prepare","finance.vouchers.check","finance.vouchers.pay","finance.vouchers.settings","finance.tally.export"]'::jsonb,
       true
from public.orgs o
on conflict (org_id, name) do nothing;

insert into public.roles (org_id, name, description, permissions, is_system)
select o.id, 'Department head',
       'Approves Tier 2 payment vouchers for their department after the Finance Manager has verified them.',
       '["finance.vouchers.approve_dept"]'::jsonb, true
from public.orgs o
on conflict (org_id, name) do nothing;

-- Does this user (not necessarily the caller) hold a permission in the org? Same wildcard rules as lib/auth/can.ts.
-- Used by the voucher functions, which run as the service role on behalf of a named user.
create or replace function app.user_has_perm(p_org_id uuid, p_user_id uuid, p_perm text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user_id is not null and exists (
    select 1
    from public.memberships m
    join public.roles r on r.id = m.role_id
    cross join lateral jsonb_array_elements_text(r.permissions) as perm(key)
    where m.org_id = p_org_id
      and m.user_id = p_user_id
      and m.status = 'active'
      and (
        perm.key = '*'
        or perm.key = p_perm
        or (perm.key like '%.*' and p_perm like replace(perm.key, '.*', '.%'))
        or (perm.key like '%.*.%' and p_perm ~ ('^' || replace(replace(perm.key, '.', '\.'), '*', '[^.]+') || '$'))
      )
  );
$$;
revoke all on function app.user_has_perm(uuid, uuid, text) from public, anon, authenticated;

-- Who may read payables and vouchers (the caller, for RLS).
create or replace function app.fin_can_read_payables(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.has_perm(p_org_id, 'finance.payables.view') or app.has_perm(p_org_id, 'finance.payables.manage')
      or app.has_perm(p_org_id, 'finance.vouchers.prepare') or app.has_perm(p_org_id, 'finance.vouchers.check')
      or app.has_perm(p_org_id, 'finance.vouchers.approve_dept') or app.has_perm(p_org_id, 'finance.vouchers.approve_ceo')
      or app.has_perm(p_org_id, 'finance.vouchers.pay') or app.has_perm(p_org_id, 'finance.tally.export');
$$;
revoke all on function app.fin_can_read_payables(uuid) from public, anon;
grant execute on function app.fin_can_read_payables(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Finance documents (generic; 20B intake files will use the same table)
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_tables where schemaname = 'storage' and tablename = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'finance-documents', 'finance-documents', false, 20971520,
      array[
        'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      ]
    )
    on conflict (id) do nothing;
  end if;
end $$;

create table public.fin_documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  kind text not null check (kind in ('supplier_invoice', 'voucher_backup', 'bank_statement', 'other')),
  source text not null default 'upload' check (source in ('upload', 'email')),
  storage_path text not null unique,              -- <org>/<document>.<ext>, built by lib/media/paths.ts
  mime_type text not null check (char_length(mime_type) between 1 and 100),
  size_bytes bigint not null check (size_bytes > 0),
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'ready', 'rejected')),
  scan_status text not null default 'unscanned' check (scan_status in ('unscanned', 'clean', 'infected', 'error')),
  scanned_at timestamptz,
  scan_engine text check (scan_engine is null or char_length(scan_engine) <= 40),
  uploaded_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'ready' or sha256 is not null)
);
-- the same file is held once per organisation (a second upload of it is refused as a duplicate)
create unique index fin_documents_sha_uidx on public.fin_documents (org_id, sha256) where sha256 is not null;
create index fin_documents_org_idx on public.fin_documents (org_id, created_at desc);
create index fin_documents_pending_idx on public.fin_documents (created_at) where status = 'pending';
create trigger fin_documents_set_updated_at before update on public.fin_documents
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Tally exports (referenced by invoices and vouchers once exported)
-- ---------------------------------------------------------------------------
create table public.fin_tally_exports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  voucher_count integer not null check (voucher_count >= 0),
  invoice_count integer not null check (invoice_count >= 0),
  total_amount numeric(16, 2) not null default 0,
  checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
  xml text not null,                               -- amounts, ledger and supplier names only; read by the download route
  exported_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  check (voucher_count + invoice_count > 0)
);
create index fin_tally_exports_org_idx on public.fin_tally_exports (org_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 4. Suppliers and supplier invoices
-- ---------------------------------------------------------------------------
create table public.fin_suppliers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  trn text check (trn is null or trn ~ '^[0-9A-Z-]{5,20}$'),         -- tax registration number
  default_category text check (default_category is null or char_length(default_category) between 1 and 60),
  payment_terms_days integer check (payment_terms_days is null or payment_terms_days between 0 and 365),
  active boolean not null default true,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index fin_suppliers_name_uidx on public.fin_suppliers (org_id, lower(btrim(name)));
create trigger fin_suppliers_set_updated_at before update on public.fin_suppliers
  for each row execute function app.set_updated_at();

create table public.fin_supplier_invoices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  supplier_id uuid not null references public.fin_suppliers (id),
  invoice_number text not null check (char_length(btrim(invoice_number)) between 1 and 60),
  invoice_date date not null,
  due_date date,
  category text not null check (char_length(btrim(category)) between 1 and 60),
  net numeric(14, 2) not null check (net >= 0),
  vat numeric(14, 2) not null default 0 check (vat >= 0),
  total numeric(14, 2) generated always as (net + vat) stored,
  currency text not null default 'AED' check (currency ~ '^[A-Z]{3}$'),
  branch_code text check (branch_code is null or char_length(branch_code) between 1 and 20),
  cost_centre text check (cost_centre is null or char_length(cost_centre) between 1 and 40),
  doctor_dha_id text check (doctor_dha_id is null or char_length(doctor_dha_id) between 1 and 40),
  document_id uuid references public.fin_documents (id),
  status text not null default 'open' check (status in ('open', 'on_voucher', 'paid', 'void')),
  tally_export_id uuid references public.fin_tally_exports (id),
  tally_exported_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (due_date is null or due_date >= invoice_date),
  check (net + vat > 0),
  check ((tally_export_id is null) = (tally_exported_at is null))
);
create unique index fin_supplier_invoices_number_uidx
  on public.fin_supplier_invoices (org_id, supplier_id, upper(btrim(invoice_number)));
create index fin_supplier_invoices_org_idx on public.fin_supplier_invoices (org_id, invoice_date desc);
create trigger fin_supplier_invoices_set_updated_at before update on public.fin_supplier_invoices
  for each row execute function app.set_updated_at();
create trigger fin_supplier_invoices_supplier_org_check before insert or update of supplier_id, org_id on public.fin_supplier_invoices
  for each row execute function app.check_parent_org('fin_suppliers', 'supplier_id');
create trigger fin_supplier_invoices_document_org_check before insert or update of document_id, org_id on public.fin_supplier_invoices
  for each row execute function app.check_parent_org('fin_documents', 'document_id');

-- ---------------------------------------------------------------------------
-- 5. Delegation of authority and Tally ledgers (reference data, editable, seeded with the directive's defaults)
-- ---------------------------------------------------------------------------
create table public.fin_ref_approval_tiers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9_]{1,12}$'),
  label text not null check (char_length(btrim(label)) between 1 and 60),
  -- an amount band (special_category null, min_amount set) or a special category that applies at any amount
  special_category text check (special_category is null or special_category in ('payroll', 'intercompany', 'related_party')),
  min_amount numeric(14, 2) check (min_amount is null or min_amount >= 0),
  max_amount numeric(14, 2) check (max_amount is null or max_amount > 0),
  needs_dept_head boolean not null default false,
  needs_ceo boolean not null default false,
  -- bulk verification only for routes that need no approval beyond the Finance Manager (Tier 1)
  bulk_allowed boolean not null default false,
  description text check (description is null or char_length(description) <= 300),
  sort_order integer not null default 100 check (sort_order between 0 and 10000),
  active boolean not null default true,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, code),
  check ((special_category is null) = (min_amount is not null)),
  check (special_category is null or max_amount is null),
  check (max_amount is null or min_amount is null or max_amount >= min_amount),
  check (not bulk_allowed or (not needs_dept_head and not needs_ceo and special_category is null))
);
create unique index fin_ref_approval_tiers_special_uidx on public.fin_ref_approval_tiers (org_id, special_category)
  where special_category is not null;
create trigger fin_ref_approval_tiers_set_updated_at before update on public.fin_ref_approval_tiers
  for each row execute function app.set_updated_at();

create table public.fin_ref_tally_ledgers (
  org_id uuid not null references public.orgs (id) on delete cascade,
  -- supplier: key = supplier id; category: expense category; bank: the "pay from" account key;
  -- cost_centre: branch code; vat_input: key '*'
  kind text not null check (kind in ('supplier', 'category', 'bank', 'cost_centre', 'vat_input')),
  key text not null check (char_length(key) between 1 and 80),
  ledger_name text not null check (char_length(btrim(ledger_name)) between 1 and 120),
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (org_id, kind, key)
);
create trigger fin_ref_tally_ledgers_set_updated_at before update on public.fin_ref_tally_ledgers
  for each row execute function app.set_updated_at();

alter table public.fin_ref_finance_settings
  add column approval_mode text not null default 'pulse' check (approval_mode in ('pulse', 'tally')),
  add column voucher_duplicate_window_days integer not null default 30 check (voucher_duplicate_window_days between 0 and 365),
  add column voucher_mismatch_tolerance numeric(12, 2) not null default 1.00 check (voucher_mismatch_tolerance >= 0),
  add column voucher_large_amount numeric(14, 2) not null default 50000.00 check (voucher_large_amount > 0),
  add column tally_company_name text check (tally_company_name is null or char_length(tally_company_name) between 1 and 120),
  add column tally_cost_category text not null default 'Primary Cost Category'
    check (char_length(btrim(tally_cost_category)) between 1 and 120);

-- ---------------------------------------------------------------------------
-- 6. Payment vouchers
-- ---------------------------------------------------------------------------
create table public.fin_payment_vouchers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  voucher_no text not null check (voucher_no ~ '^PV-[0-9]{4}-[0-9]{4,}$'),
  voucher_date date not null,
  payee_name text not null check (char_length(btrim(payee_name)) between 1 and 120),
  supplier_id uuid references public.fin_suppliers (id),
  amount numeric(14, 2) not null check (amount > 0),
  currency text not null default 'AED' check (currency ~ '^[A-Z]{3}$'),
  category text not null check (char_length(btrim(category)) between 1 and 60),
  special_category text not null default 'none' check (special_category in ('none', 'payroll', 'intercompany', 'related_party')),
  branch_code text check (branch_code is null or char_length(branch_code) between 1 and 20),
  cost_centre text check (cost_centre is null or char_length(cost_centre) between 1 and 40),
  pay_from text check (pay_from is null or char_length(pay_from) between 1 and 40),
  payment_method text not null default 'bank_transfer' check (payment_method in ('bank_transfer', 'cheque', 'card', 'cash')),
  narration text not null check (char_length(btrim(narration)) between 1 and 500),
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'checked', 'dept_approved', 'approved', 'for_tally', 'paid', 'rejected', 'cancelled')),
  route text check (route is null or route in ('pulse', 'tally')),
  tier_code text,
  needs_dept boolean,
  needs_ceo boolean,
  bulk_allowed boolean,
  content_sha256 text check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
  prepared_by uuid references public.profiles (id) on delete set null,
  submitted_by uuid references public.profiles (id) on delete set null,
  submitted_at timestamptz,
  checked_by uuid references public.profiles (id) on delete set null,
  checked_at timestamptz,
  dept_approved_by uuid references public.profiles (id) on delete set null,
  dept_approved_at timestamptz,
  ceo_approved_by uuid references public.profiles (id) on delete set null,
  ceo_approved_at timestamptz,
  approved_at timestamptz,
  rejected_by uuid references public.profiles (id) on delete set null,
  rejected_at timestamptz,
  rejection_remarks text check (rejection_remarks is null or char_length(rejection_remarks) <= 1000),
  paid_by uuid references public.profiles (id) on delete set null,
  paid_at timestamptz,
  payment_date date,
  payment_reference text check (payment_reference is null or char_length(btrim(payment_reference)) between 1 and 60),
  cancelled_by uuid references public.profiles (id) on delete set null,
  cancelled_at timestamptz,
  tally_export_id uuid references public.fin_tally_exports (id),
  tally_exported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, voucher_no),
  check ((tally_export_id is null) = (tally_exported_at is null)),
  check (status <> 'paid' or (payment_date is not null and payment_reference is not null and paid_at is not null)),
  check (status not in ('submitted', 'checked', 'dept_approved', 'approved', 'for_tally', 'paid')
         or (content_sha256 is not null and submitted_at is not null and route is not null)),
  check (status <> 'rejected' or (rejected_at is not null and rejection_remarks is not null)),
  -- different people at every step (null-safe: a deleted user's id becomes null)
  check (checked_by is null or (checked_by is distinct from submitted_by and checked_by is distinct from prepared_by)),
  check (dept_approved_by is null or (dept_approved_by is distinct from submitted_by and dept_approved_by is distinct from prepared_by
                                      and dept_approved_by is distinct from checked_by)),
  check (ceo_approved_by is null or (ceo_approved_by is distinct from submitted_by and ceo_approved_by is distinct from prepared_by
                                     and ceo_approved_by is distinct from checked_by and ceo_approved_by is distinct from dept_approved_by))
);
create index fin_payment_vouchers_org_status_idx on public.fin_payment_vouchers (org_id, status, voucher_date desc);
create index fin_payment_vouchers_org_date_idx on public.fin_payment_vouchers (org_id, voucher_date desc);
create trigger fin_payment_vouchers_set_updated_at before update on public.fin_payment_vouchers
  for each row execute function app.set_updated_at();
create trigger fin_payment_vouchers_supplier_org_check before insert or update of supplier_id, org_id on public.fin_payment_vouchers
  for each row execute function app.check_parent_org('fin_suppliers', 'supplier_id');

create table public.fin_voucher_invoices (
  org_id uuid not null references public.orgs (id) on delete cascade,
  voucher_id uuid not null references public.fin_payment_vouchers (id) on delete cascade,
  supplier_invoice_id uuid not null references public.fin_supplier_invoices (id),
  created_at timestamptz not null default now(),
  primary key (voucher_id, supplier_invoice_id)
);
create index fin_voucher_invoices_invoice_idx on public.fin_voucher_invoices (supplier_invoice_id);
create trigger fin_voucher_invoices_voucher_org_check before insert or update on public.fin_voucher_invoices
  for each row execute function app.check_parent_org('fin_payment_vouchers', 'voucher_id');
create trigger fin_voucher_invoices_invoice_org_check before insert or update on public.fin_voucher_invoices
  for each row execute function app.check_parent_org('fin_supplier_invoices', 'supplier_invoice_id');

create table public.fin_voucher_documents (
  org_id uuid not null references public.orgs (id) on delete cascade,
  voucher_id uuid not null references public.fin_payment_vouchers (id) on delete cascade,
  document_id uuid not null references public.fin_documents (id),
  added_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (voucher_id, document_id)
);
create index fin_voucher_documents_document_idx on public.fin_voucher_documents (document_id);
create trigger fin_voucher_documents_voucher_org_check before insert or update on public.fin_voucher_documents
  for each row execute function app.check_parent_org('fin_payment_vouchers', 'voucher_id');
create trigger fin_voucher_documents_document_org_check before insert or update on public.fin_voucher_documents
  for each row execute function app.check_parent_org('fin_documents', 'document_id');

-- The trail: who did what, when, with which remarks, on which content hash. Append-only (trigger below).
create table public.fin_voucher_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs (id) on delete cascade,
  voucher_id uuid not null references public.fin_payment_vouchers (id) on delete cascade,
  action text not null check (action in (
    'created', 'edited', 'returned_to_draft', 'submitted', 'sent_to_tally', 'checked', 'dept_approved', 'ceo_approved',
    'rejected', 'reopened', 'cancelled', 'paid', 'exported'
  )),
  actor_id uuid references public.profiles (id) on delete set null,
  from_status text,
  to_status text,
  remarks text check (remarks is null or char_length(remarks) <= 1000),
  content_sha256 text check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
  at timestamptz not null default now()
);
create index fin_voucher_events_voucher_idx on public.fin_voucher_events (voucher_id, id);
create index fin_voucher_events_org_idx on public.fin_voucher_events (org_id, at desc);

-- Per-org, per-year voucher number counter. Service role only (touched by fin_voucher_save).
create table public.fin_voucher_counters (
  org_id uuid not null references public.orgs (id) on delete cascade,
  year integer not null check (year between 2000 and 2999),
  last_no integer not null default 0 check (last_no >= 0),
  primary key (org_id, year)
);

-- ---------------------------------------------------------------------------
-- 7. Guards (run for every role, including the service role)
-- ---------------------------------------------------------------------------
-- Vouchers: never deleted (cancelled instead); nothing dated in a locked month changes; content cannot change once the
-- voucher left draft unless the same update returns it to draft; an exported voucher's content never changes.
-- A row with no org or date (the cross-org probe in the security tests) passes through untouched so RLS answers.
create or replace function app.fin_voucher_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_content_changed boolean;
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.orgs o where o.id = old.org_id) then
      raise exception 'payment vouchers are cancelled, never deleted' using errcode = '42501';
    end if;
    return old;
  end if;
  if new.org_id is null or new.voucher_date is null then
    return new;
  end if;
  -- the FK action that nulls a deleted user's id is always permitted
  if tg_op = 'UPDATE' and (to_jsonb(new) - array['prepared_by', 'submitted_by', 'checked_by', 'dept_approved_by', 'ceo_approved_by',
                                                   'rejected_by', 'paid_by', 'cancelled_by', 'updated_at'])
                        = (to_jsonb(old) - array['prepared_by', 'submitted_by', 'checked_by', 'dept_approved_by', 'ceo_approved_by',
                                                   'rejected_by', 'paid_by', 'cancelled_by', 'updated_at']) then
    return new;
  end if;
  if app.fin_month_is_locked(new.org_id, new.voucher_date)
     or (tg_op = 'UPDATE' and app.fin_month_is_locked(old.org_id, old.voucher_date)) then
    raise exception 'the month of this voucher is locked' using errcode = '42501', hint = 'month_locked';
  end if;
  if tg_op = 'UPDATE' then
    if new.org_id <> old.org_id or new.voucher_no <> old.voucher_no then
      raise exception 'a voucher keeps its organisation and number' using errcode = 'check_violation';
    end if;
    v_content_changed := (new.voucher_date, new.payee_name, new.supplier_id, new.amount, new.currency, new.category,
                          new.special_category, new.branch_code, new.cost_centre, new.pay_from, new.payment_method, new.narration)
      is distinct from (old.voucher_date, old.payee_name, old.supplier_id, old.amount, old.currency, old.category,
                        old.special_category, old.branch_code, old.cost_centre, old.pay_from, old.payment_method, old.narration);
    if v_content_changed then
      if old.tally_export_id is not null then
        raise exception 'an exported voucher cannot change' using errcode = 'check_violation', hint = 'exported';
      end if;
      if old.status not in ('draft', 'rejected') and new.status <> 'draft' then
        raise exception 'a submitted voucher changes only by returning to draft' using errcode = 'check_violation', hint = 'wrong_status';
      end if;
      if old.status in ('paid', 'cancelled') then
        raise exception 'a % voucher cannot change', old.status using errcode = 'check_violation', hint = 'wrong_status';
      end if;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.fin_voucher_guard() from public, anon, authenticated;
create trigger fin_payment_vouchers_guard before insert or update or delete on public.fin_payment_vouchers
  for each row execute function app.fin_voucher_guard();

-- Links (invoices and attachments) change only while the voucher is a draft (or rejected) and its month is open.
create or replace function app.fin_voucher_link_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_voucher uuid;
  v public.fin_payment_vouchers;
begin
  if tg_op = 'DELETE' then
    v_voucher := old.voucher_id;
  else
    v_voucher := new.voucher_id;
  end if;
  if v_voucher is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'UPDATE' and (to_jsonb(new) - 'added_by') = (to_jsonb(old) - 'added_by') then
    return new;   -- a deleted user's id nulled by the FK action
  end if;
  select * into v from public.fin_payment_vouchers where id = v_voucher;
  if found and exists (select 1 from public.orgs o where o.id = v.org_id) then
    if app.fin_month_is_locked(v.org_id, v.voucher_date) then
      raise exception 'the month of this voucher is locked' using errcode = '42501', hint = 'month_locked';
    end if;
    if v.status not in ('draft', 'rejected') then
      raise exception 'attachments and invoices change only while the voucher is a draft' using errcode = 'check_violation', hint = 'wrong_status';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke all on function app.fin_voucher_link_guard() from public, anon, authenticated;
create trigger fin_voucher_invoices_guard before insert or update or delete on public.fin_voucher_invoices
  for each row execute function app.fin_voucher_link_guard();
create trigger fin_voucher_documents_guard before insert or update or delete on public.fin_voucher_documents
  for each row execute function app.fin_voucher_link_guard();

-- Events are append-only: no update (except the FK nulling a deleted user's id) and no delete (except the org cascade).
create or replace function app.fin_voucher_events_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.orgs o where o.id = old.org_id) then
      raise exception 'the voucher trail is append-only' using errcode = '42501';
    end if;
    return old;
  end if;
  if (to_jsonb(new) - 'actor_id') is not distinct from (to_jsonb(old) - 'actor_id') and new.actor_id is null then
    return new;
  end if;
  raise exception 'the voucher trail is append-only' using errcode = '42501';
end;
$$;
revoke all on function app.fin_voucher_events_append_only() from public, anon, authenticated;
create trigger fin_voucher_events_append_only before update or delete on public.fin_voucher_events
  for each row execute function app.fin_voucher_events_append_only();

-- Supplier invoices: nothing dated in a locked month changes; an invoice on a voucher beyond draft, paid or exported
-- keeps its content; only open or void invoices that were never exported may be deleted.
create or replace function app.fin_supplier_invoice_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_busy boolean;
begin
  if tg_op = 'INSERT' then
    if new.org_id is not null and new.invoice_date is not null and app.fin_month_is_locked(new.org_id, new.invoice_date) then
      raise exception 'the month of this invoice is locked' using errcode = '42501', hint = 'month_locked';
    end if;
    return new;
  end if;
  if not exists (select 1 from public.orgs o where o.id = old.org_id) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'UPDATE' and (to_jsonb(new) - array['created_by', 'updated_at']) = (to_jsonb(old) - array['created_by', 'updated_at']) then
    return new;   -- a deleted user's id nulled by the FK action
  end if;
  if app.fin_month_is_locked(old.org_id, old.invoice_date)
     or (tg_op = 'UPDATE' and app.fin_month_is_locked(new.org_id, new.invoice_date)) then
    raise exception 'the month of this invoice is locked' using errcode = '42501', hint = 'month_locked';
  end if;
  v_busy := old.tally_export_id is not null or exists (
    select 1 from public.fin_voucher_invoices l join public.fin_payment_vouchers v on v.id = l.voucher_id
    where l.supplier_invoice_id = old.id and v.status not in ('draft', 'rejected', 'cancelled'));
  if tg_op = 'DELETE' then
    if v_busy or old.status not in ('open', 'void') or exists (
      select 1 from public.fin_voucher_invoices l join public.fin_payment_vouchers v on v.id = l.voucher_id
      where l.supplier_invoice_id = old.id and v.status <> 'cancelled') then
      raise exception 'this invoice is on a voucher or was exported; void it instead' using errcode = 'check_violation', hint = 'wrong_status';
    end if;
    return old;
  end if;
  if v_busy and (new.supplier_id, new.invoice_number, new.invoice_date, new.category, new.net, new.vat, new.currency,
                 new.branch_code, new.cost_centre, new.doctor_dha_id, new.document_id)
     is distinct from (old.supplier_id, old.invoice_number, old.invoice_date, old.category, old.net, old.vat, old.currency,
                       old.branch_code, old.cost_centre, old.doctor_dha_id, old.document_id) then
    raise exception 'this invoice is on a voucher being approved, paid or exported; it cannot change' using errcode = 'check_violation', hint = 'wrong_status';
  end if;
  return new;
end;
$$;
revoke all on function app.fin_supplier_invoice_guard() from public, anon, authenticated;
create trigger fin_supplier_invoices_guard before insert or update or delete on public.fin_supplier_invoices
  for each row execute function app.fin_supplier_invoice_guard();

-- ---------------------------------------------------------------------------
-- 8. RLS: staff with a payables or voucher permission read; every write is a server action (service role after can())
-- ---------------------------------------------------------------------------
alter table public.fin_documents enable row level security;
alter table public.fin_tally_exports enable row level security;
alter table public.fin_suppliers enable row level security;
alter table public.fin_supplier_invoices enable row level security;
alter table public.fin_ref_approval_tiers enable row level security;
alter table public.fin_ref_tally_ledgers enable row level security;
alter table public.fin_payment_vouchers enable row level security;
alter table public.fin_voucher_invoices enable row level security;
alter table public.fin_voucher_documents enable row level security;
alter table public.fin_voucher_events enable row level security;
alter table public.fin_voucher_counters enable row level security;   -- no policy: service role only

create policy fin_documents_select on public.fin_documents for select to authenticated
  using (app.fin_can_read_payables(org_id));
create policy fin_tally_exports_select on public.fin_tally_exports for select to authenticated
  using (app.has_perm(org_id, 'finance.tally.export'));
create policy fin_suppliers_select on public.fin_suppliers for select to authenticated
  using (app.fin_can_read_payables(org_id));
create policy fin_supplier_invoices_select on public.fin_supplier_invoices for select to authenticated
  using (app.fin_can_read_payables(org_id));
create policy fin_ref_approval_tiers_select on public.fin_ref_approval_tiers for select to authenticated
  using (app.fin_can_read_payables(org_id) or app.has_perm(org_id, 'finance.vouchers.settings'));
create policy fin_ref_tally_ledgers_select on public.fin_ref_tally_ledgers for select to authenticated
  using (app.has_perm(org_id, 'finance.tally.export') or app.has_perm(org_id, 'finance.vouchers.settings'));
create policy fin_payment_vouchers_select on public.fin_payment_vouchers for select to authenticated
  using (app.fin_can_read_payables(org_id));
create policy fin_voucher_invoices_select on public.fin_voucher_invoices for select to authenticated
  using (app.fin_can_read_payables(org_id));
create policy fin_voucher_documents_select on public.fin_voucher_documents for select to authenticated
  using (app.fin_can_read_payables(org_id));
create policy fin_voucher_events_select on public.fin_voucher_events for select to authenticated
  using (app.fin_can_read_payables(org_id));

-- ---------------------------------------------------------------------------
-- 9. Seed: the directive's delegation of authority (editable under Finance, Voucher settings)
-- ---------------------------------------------------------------------------
create or replace function app.fin_seed_payables(p_org_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.fin_ref_approval_tiers
    (org_id, code, label, special_category, min_amount, max_amount, needs_dept_head, needs_ceo, bulk_allowed, description, sort_order) values
    (p_org_id, 'T1', 'Tier 1', null, 0.00, 5000.00, false, false, true,
     'Up to AED 5,000: consumables, utilities, petrol / Salik, minor supplies. Finance Manager; no CEO.', 10),
    (p_org_id, 'T2', 'Tier 2', null, 5000.01, 15000.00, true, false, false,
     'AED 5,001 to 15,000: marketing, IT maintenance, training, minor equipment. Finance Manager and department head; no CEO.', 20),
    (p_org_id, 'T3', 'Tier 3', null, 15000.01, 50000.00, false, true, false,
     'AED 15,001 to 50,000: insurance premiums, revenue sharing, major vendor contracts. Finance Manager verifies, CEO authorises.', 30),
    (p_org_id, 'T4', 'Tier 4', null, 50000.01, null, false, true, false,
     'Over AED 50,000: capital items, large contracts. Finance Manager verifies, CEO authorises.', 40),
    (p_org_id, 'SP_PAYROLL', 'Special: payroll', 'payroll', null, null, false, true, false,
     'Payroll at any amount: CEO always.', 50),
    (p_org_id, 'SP_INTERCO', 'Special: intercompany', 'intercompany', null, null, false, true, false,
     'Intercompany transfers at any amount: CEO always.', 60),
    (p_org_id, 'SP_RELATED', 'Special: related party', 'related_party', null, null, false, true, false,
     'Related-party transactions at any amount: CEO always.', 70)
  on conflict (org_id, code) do nothing;
end;
$$;
revoke all on function app.fin_seed_payables(uuid) from public, anon, authenticated;

-- seed_finance_reference (called for every new org by the orgs insert trigger and by `pnpm finance:seed`) now also seeds
-- the tiers. Body as in 20261021000100 plus the last line.
create or replace function public.seed_finance_reference(p_org_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.fin_ref_branches (org_id, code, name) values
    (p_org_id, 'P', 'Palm Jumeirah'),
    (p_org_id, 'M', 'Meadows'),
    (p_org_id, 'G', 'Golden Mile')
  on conflict (org_id, code) do nothing;

  insert into public.fin_ref_exception_rules (org_id, rule_code, description, owner_role, threshold_days) values
    (p_org_id, 'E01', 'Insurance invoice with no claim activity after N days',                         'insurance', 30),
    (p_org_id, 'E02', 'Claim activity with no matching Unite invoice',                                 'insurance', null),
    (p_org_id, 'E03', 'Claimed amount differs from invoiced line amount, or ambiguous line match',     'billing',   null),
    (p_org_id, 'E04', 'Rejected or partially rejected claim not resubmitted after N days',             'insurance', 14),
    (p_org_id, 'E05', 'Outstanding insurance balance older than N days',                               'insurance', 60),
    (p_org_id, 'E06', 'Claim activity in the previous Diligence file but missing from the latest',     'insurance', null),
    (p_org_id, 'E07', 'Unknown clinic / branch on an invoice',                                         'admin',     null),
    (p_org_id, 'E08', 'AppointmentId not found in appointments',                                       'admin',     null),
    (p_org_id, 'E09', 'Capture failure, count mismatch, or gap in the invoice number sequence',        'admin',     null),
    (p_org_id, 'E10', 'Diligence file failed validation',                                              'insurance', null),
    (p_org_id, 'E11', 'Billed service with no visit record for the patient and date (review signal)',   'insurance', null),
    (p_org_id, 'E12', 'Recorded visit with no invoice for the patient and date (review signal)',        'billing',   null),
    (p_org_id, 'E13', 'The same service billed more than once on one invoice',                          'billing',   null),
    (p_org_id, 'E14', 'Claim matched an invoice but no invoice line for the claimed service',           'billing',   null)
  on conflict (org_id, rule_code) do nothing;

  insert into public.fin_capture_settings (org_id) values (p_org_id)
  on conflict (org_id) do nothing;

  -- Phase 18
  insert into public.fin_ref_finance_settings (org_id) values (p_org_id)
  on conflict (org_id) do nothing;

  -- Starter denial-code families. PLACEHOLDERS: replace with the payers' real code lists (Finance, Reference data).
  insert into public.fin_ref_denial_codes (org_id, code, is_family, description, category, default_owner_role, resubmit_days, appealable, is_placeholder) values
    (p_org_id, 'AUTH', true, 'Prior authorisation missing or not valid for the service', 'authorization',     'insurance', 30, true,  true),
    (p_org_id, 'ELIG', true, 'Member not eligible or cover not active on the service date', 'eligibility',     'billing',   30, true,  true),
    (p_org_id, 'MNEC', true, 'Service not considered medically necessary',                'medical_necessity', 'insurance', 30, true,  true),
    (p_org_id, 'CODE', true, 'Coding or billing error (code, modifier, quantity)',         'coding',            'billing',   30, true,  true),
    (p_org_id, 'CLAI', true, 'Claim documentation missing or incomplete',                  'documentation',     'insurance', 30, true,  true),
    (p_org_id, 'DUPL', true, 'Duplicate of a claim already submitted or paid',             'duplicate',         'billing',   15, false, true),
    (p_org_id, 'TIME', true, 'Submitted after the payer''s filing limit',                  'timely_filing',     'finance',   15, false, true),
    (p_org_id, 'PRCE', true, 'Price differs from the agreed payer price list',             'pricing',           'finance',   30, true,  true)
  on conflict (org_id, code) do nothing;

  -- Phase 20D: delegation of authority
  perform app.fin_seed_payables(p_org_id);
end;
$$;
revoke all on function public.seed_finance_reference(uuid) from public, anon, authenticated;
grant execute on function public.seed_finance_reference(uuid) to service_role;

select public.seed_finance_reference(id) from public.orgs;

-- ---------------------------------------------------------------------------
-- 10. The access log learns about finance documents (signed-link opens are recorded)
-- ---------------------------------------------------------------------------
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
                                   'appointment', 'portal_record', 'export', 'activity_log']);
  if not ('finance_document' = any (v_list)) then
    v_list := array_append(v_list, 'finance_document');
  end if;
  execute format('alter table public.record_access_log add constraint record_access_log_entity_check check (entity in (%s))',
    (select string_agg(quote_literal(x), ', ' order by x) from unnest(v_list) as x));
end $$;

-- ---------------------------------------------------------------------------
-- 11. Content hash: the voucher's fields, its linked supplier invoices (id and total) and the sha256 of every attachment
--     (its own and its invoices'). lib/finance/vouchers.ts voucherCanonical() builds the same text; a database test
--     proves they agree. Text fields escape backslash, newline and carriage return; lists are sorted bytewise.
-- ---------------------------------------------------------------------------
create or replace function app.fin_esc(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select replace(replace(replace(coalesce(p, ''), E'\\', E'\\\\'), E'\n', E'\\n'), E'\r', E'\\r');
$$;

create or replace function public.fin_voucher_canonical(p_voucher_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select concat_ws(E'\n',
    'pulse-voucher-v1',
    'id:' || v.id::text,
    'org:' || v.org_id::text,
    'number:' || v.voucher_no,
    'date:' || to_char(v.voucher_date, 'YYYY-MM-DD'),
    'payee:' || app.fin_esc(v.payee_name),
    'supplier:' || coalesce(v.supplier_id::text, '-'),
    'amount:' || v.amount::text,
    'currency:' || v.currency,
    'category:' || app.fin_esc(v.category),
    'special:' || v.special_category,
    'branch:' || coalesce(app.fin_esc(v.branch_code), '-'),
    'cost_centre:' || coalesce(app.fin_esc(v.cost_centre), '-'),
    'pay_from:' || coalesce(app.fin_esc(v.pay_from), '-'),
    'method:' || v.payment_method,
    'narration:' || app.fin_esc(v.narration),
    'invoices:' || coalesce((
      select string_agg(si.id::text || '=' || si.total::text, ',' order by si.id::text collate "C")
      from public.fin_voucher_invoices l join public.fin_supplier_invoices si on si.id = l.supplier_invoice_id
      where l.voucher_id = v.id), ''),
    'documents:' || coalesce((
      select string_agg(s.sha256, ',' order by s.sha256 collate "C")
      from (
        select d.sha256 from public.fin_voucher_documents vd join public.fin_documents d on d.id = vd.document_id
        where vd.voucher_id = v.id and d.sha256 is not null
        union
        select d.sha256 from public.fin_voucher_invoices l
        join public.fin_supplier_invoices si on si.id = l.supplier_invoice_id
        join public.fin_documents d on d.id = si.document_id
        where l.voucher_id = v.id and d.sha256 is not null
      ) s), ''))
  from public.fin_payment_vouchers v
  where v.id = p_voucher_id;
$$;
revoke all on function public.fin_voucher_canonical(uuid) from public, anon, authenticated;
grant execute on function public.fin_voucher_canonical(uuid) to service_role;

create or replace function public.fin_voucher_compute_hash(p_voucher_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select encode(sha256(convert_to(public.fin_voucher_canonical(p_voucher_id), 'UTF8')), 'hex');
$$;
revoke all on function public.fin_voucher_compute_hash(uuid) from public, anon, authenticated;
grant execute on function public.fin_voucher_compute_hash(uuid) to service_role;

-- Which approvals a voucher needs (delegation of authority). Fails closed: no matching rule, or more than one, is null.
create or replace function app.fin_voucher_rule(p_org_id uuid, p_amount numeric, p_special text)
returns public.fin_ref_approval_tiers
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rows public.fin_ref_approval_tiers[];
begin
  if coalesce(p_special, 'none') <> 'none' then
    select array_agg(t) into v_rows from public.fin_ref_approval_tiers t
     where t.org_id = p_org_id and t.active and t.special_category = p_special;
  else
    select array_agg(t) into v_rows from public.fin_ref_approval_tiers t
     where t.org_id = p_org_id and t.active and t.special_category is null
       and t.min_amount <= p_amount and (t.max_amount is null or p_amount <= t.max_amount);
  end if;
  if coalesce(cardinality(v_rows), 0) <> 1 then
    return null;
  end if;
  return v_rows[1];
end;
$$;
revoke all on function app.fin_voucher_rule(uuid, numeric, text) from public, anon, authenticated;

create or replace function app.fin_voucher_number(p_year integer, p_n integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select 'PV-' || p_year::text || '-' || lpad(p_n::text, greatest(4, char_length(p_n::text)), '0');
$$;

-- Anyone who shaped the voucher's content (created it, edited it, submitted it or reopened it) is a maker.
create or replace function app.fin_voucher_is_maker(p_voucher_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.fin_payment_vouchers v
    where v.id = p_voucher_id and (v.prepared_by = p_user_id or v.submitted_by = p_user_id)
  ) or exists (
    select 1 from public.fin_voucher_events e
    where e.voucher_id = p_voucher_id and e.actor_id = p_user_id
      and e.action in ('created', 'edited', 'returned_to_draft', 'submitted', 'sent_to_tally', 'reopened')
  );
$$;
revoke all on function app.fin_voucher_is_maker(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 12. Create or edit a voucher (the maker). p_fields: voucher_date, payee_name, supplier_id, amount, currency, category,
--     special_category, branch_code, cost_centre, pay_from, payment_method, narration. The invoice and document lists
--     replace the current links. Editing a voucher that is waiting for (or has) approvals returns it to draft and clears
--     them; a paid, cancelled or exported voucher cannot be edited.
-- ---------------------------------------------------------------------------
create or replace function public.fin_voucher_save(
  p_org_id uuid, p_user_id uuid, p_voucher_id uuid, p_fields jsonb, p_invoice_ids uuid[], p_document_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.fin_payment_vouchers;
  v_date date := (p_fields ->> 'voucher_date')::date;
  v_year integer;
  v_no integer;
  v_returned boolean := false;
  v_from text;
  v_bad integer;
begin
  if not app.user_has_perm(p_org_id, p_user_id, 'finance.vouchers.prepare') then
    raise exception 'You cannot prepare payment vouchers.' using errcode = 'check_violation', hint = 'not_permitted';
  end if;
  if v_date is null then
    raise exception 'Enter the voucher date.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  if p_voucher_id is null then
    v_year := extract(year from v_date)::integer;
    insert into public.fin_voucher_counters (org_id, year, last_no) values (p_org_id, v_year, 1)
    on conflict (org_id, year) do update set last_no = public.fin_voucher_counters.last_no + 1
    returning last_no into v_no;
    insert into public.fin_payment_vouchers (
      org_id, voucher_no, voucher_date, payee_name, supplier_id, amount, currency, category, special_category,
      branch_code, cost_centre, pay_from, payment_method, narration, status, prepared_by)
    values (
      p_org_id, app.fin_voucher_number(v_year, v_no), v_date, btrim(p_fields ->> 'payee_name'),
      nullif(p_fields ->> 'supplier_id', '')::uuid, (p_fields ->> 'amount')::numeric,
      coalesce(nullif(p_fields ->> 'currency', ''), 'AED'), btrim(p_fields ->> 'category'),
      coalesce(nullif(p_fields ->> 'special_category', ''), 'none'),
      nullif(btrim(coalesce(p_fields ->> 'branch_code', '')), ''), nullif(btrim(coalesce(p_fields ->> 'cost_centre', '')), ''),
      nullif(btrim(coalesce(p_fields ->> 'pay_from', '')), ''), coalesce(nullif(p_fields ->> 'payment_method', ''), 'bank_transfer'),
      btrim(p_fields ->> 'narration'), 'draft', p_user_id)
    returning * into v;
    v_from := null;
    insert into public.fin_voucher_events (org_id, voucher_id, action, actor_id, from_status, to_status)
    values (p_org_id, v.id, 'created', p_user_id, null, 'draft');
  else
    select * into v from public.fin_payment_vouchers where id = p_voucher_id and org_id = p_org_id for update;
    if not found then
      raise exception 'Voucher not found.' using errcode = 'no_data_found', hint = 'not_found';
    end if;
    if app.fin_month_is_locked(p_org_id, v.voucher_date) or app.fin_month_is_locked(p_org_id, v_date) then
      raise exception 'The month of this voucher is locked.' using errcode = 'check_violation', hint = 'month_locked';
    end if;
    if v.status in ('paid', 'cancelled') or v.tally_export_id is not null then
      raise exception 'A paid, cancelled or exported voucher cannot be edited.' using errcode = 'check_violation', hint = 'wrong_status';
    end if;
    v_from := v.status;
    v_returned := v.status not in ('draft', 'rejected');
    update public.fin_payment_vouchers set
      voucher_date = v_date,
      payee_name = btrim(p_fields ->> 'payee_name'),
      supplier_id = nullif(p_fields ->> 'supplier_id', '')::uuid,
      amount = (p_fields ->> 'amount')::numeric,
      currency = coalesce(nullif(p_fields ->> 'currency', ''), 'AED'),
      category = btrim(p_fields ->> 'category'),
      special_category = coalesce(nullif(p_fields ->> 'special_category', ''), 'none'),
      branch_code = nullif(btrim(coalesce(p_fields ->> 'branch_code', '')), ''),
      cost_centre = nullif(btrim(coalesce(p_fields ->> 'cost_centre', '')), ''),
      pay_from = nullif(btrim(coalesce(p_fields ->> 'pay_from', '')), ''),
      payment_method = coalesce(nullif(p_fields ->> 'payment_method', ''), 'bank_transfer'),
      narration = btrim(p_fields ->> 'narration'),
      status = 'draft', route = null, tier_code = null, needs_dept = null, needs_ceo = null, bulk_allowed = null,
      content_sha256 = null, submitted_by = null, submitted_at = null, checked_by = null, checked_at = null,
      dept_approved_by = null, dept_approved_at = null, ceo_approved_by = null, ceo_approved_at = null, approved_at = null
    where id = v.id
    returning * into v;
    insert into public.fin_voucher_events (org_id, voucher_id, action, actor_id, from_status, to_status, remarks)
    values (p_org_id, v.id, case when v_returned then 'returned_to_draft' else 'edited' end, p_user_id, v_from, 'draft',
            case when v_returned then 'Edited after submission; approvals cleared' else null end);
  end if;

  -- invoices: same org, same supplier family is not required, must be open (or already on this voucher)
  select count(*) into v_bad from unnest(coalesce(p_invoice_ids, '{}')) as x(id)
   where not exists (
     select 1 from public.fin_supplier_invoices si
     where si.id = x.id and si.org_id = p_org_id
       and (si.status = 'open' or exists (select 1 from public.fin_voucher_invoices l where l.voucher_id = v.id and l.supplier_invoice_id = si.id
                                          and si.status = 'on_voucher')));
  if v_bad > 0 then
    raise exception 'An invoice is not available (already on another voucher, paid or void).' using errcode = 'check_violation', hint = 'invoice_unavailable';
  end if;
  select count(*) into v_bad from unnest(coalesce(p_document_ids, '{}')) as x(id)
   where not exists (select 1 from public.fin_documents d where d.id = x.id and d.org_id = p_org_id and d.status = 'ready'
                       and d.scan_status <> 'infected');
  if v_bad > 0 then
    raise exception 'An attachment is not available.' using errcode = 'check_violation', hint = 'document_unavailable';
  end if;

  update public.fin_supplier_invoices si set status = 'open'
   where si.id in (select l.supplier_invoice_id from public.fin_voucher_invoices l where l.voucher_id = v.id)
     and not (si.id = any (coalesce(p_invoice_ids, '{}'))) and si.status = 'on_voucher';
  delete from public.fin_voucher_invoices l where l.voucher_id = v.id and not (l.supplier_invoice_id = any (coalesce(p_invoice_ids, '{}')));
  insert into public.fin_voucher_invoices (org_id, voucher_id, supplier_invoice_id)
  select p_org_id, v.id, x.id from unnest(coalesce(p_invoice_ids, '{}')) as x(id)
  on conflict do nothing;
  update public.fin_supplier_invoices set status = 'on_voucher' where id = any (coalesce(p_invoice_ids, '{}')) and status = 'open';

  delete from public.fin_voucher_documents vd where vd.voucher_id = v.id and not (vd.document_id = any (coalesce(p_document_ids, '{}')));
  insert into public.fin_voucher_documents (org_id, voucher_id, document_id, added_by)
  select p_org_id, v.id, x.id, p_user_id from unnest(coalesce(p_document_ids, '{}')) as x(id)
  on conflict do nothing;

  return jsonb_build_object('id', v.id, 'voucher_no', v.voucher_no, 'status', 'draft', 'returned_to_draft', v_returned);
end;
$$;
revoke all on function public.fin_voucher_save(uuid, uuid, uuid, jsonb, uuid[], uuid[]) from public, anon, authenticated;
grant execute on function public.fin_voucher_save(uuid, uuid, uuid, jsonb, uuid[], uuid[]) to service_role;

-- ---------------------------------------------------------------------------
-- 13. The state machine. p_action: submit | check | approve_dept | approve_ceo | reject | reopen | cancel | pay.
--     p_hash: the content hash the person was looking at (check, approvals, pay). p_payment: {"date", "reference"}.
--     Check order (mirrored by voucherTransition in lib/finance/vouchers.ts): month lock, then per action.
-- ---------------------------------------------------------------------------
create or replace function public.fin_voucher_act(
  p_org_id uuid, p_voucher_id uuid, p_user_id uuid, p_action text, p_hash text, p_remarks text, p_payment jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.fin_payment_vouchers;
  r public.fin_ref_approval_tiers;
  v_mode text;
  v_hash text;
  v_to text;
  v_event text;
  v_remarks text := nullif(btrim(coalesce(p_remarks, '')), '');
  v_docs integer;
  v_blocked integer;
  v_pay_date date;
  v_pay_ref text;
  v_perm text;
begin
  select * into v from public.fin_payment_vouchers where id = p_voucher_id and org_id = p_org_id for update;
  if not found then
    raise exception 'Voucher not found.' using errcode = 'no_data_found', hint = 'not_found';
  end if;
  if app.fin_month_is_locked(p_org_id, v.voucher_date) then
    raise exception 'The month of this voucher is locked.' using errcode = 'check_violation', hint = 'month_locked';
  end if;
  v_hash := public.fin_voucher_compute_hash(v.id);

  if p_action = 'submit' then
    if not app.user_has_perm(p_org_id, p_user_id, 'finance.vouchers.prepare') then
      raise exception 'You cannot submit payment vouchers.' using errcode = 'check_violation', hint = 'not_permitted';
    end if;
    if v.status not in ('draft', 'rejected') then
      raise exception 'Only a draft can be submitted.' using errcode = 'check_violation', hint = 'wrong_status';
    end if;
    select count(*), count(*) filter (where d.scan_status = 'infected' or d.status <> 'ready') into v_docs, v_blocked from (
      select vd.document_id as id from public.fin_voucher_documents vd where vd.voucher_id = v.id
      union
      select si.document_id from public.fin_voucher_invoices l join public.fin_supplier_invoices si on si.id = l.supplier_invoice_id
      where l.voucher_id = v.id and si.document_id is not null
    ) x join public.fin_documents d on d.id = x.id;
    if v_docs = 0 then
      raise exception 'Attach the supporting document first (zero paper: the backup travels with the voucher).'
        using errcode = 'check_violation', hint = 'no_attachment';
    end if;
    if v_blocked > 0 then
      raise exception 'An attachment was blocked by the malware scan.' using errcode = 'check_violation', hint = 'attachment_blocked';
    end if;
    select s.approval_mode into v_mode from public.fin_ref_finance_settings s where s.org_id = p_org_id;
    if coalesce(v_mode, 'pulse') = 'tally' then
      v_to := 'for_tally';
      v_event := 'sent_to_tally';
      update public.fin_payment_vouchers set
        status = v_to, route = 'tally', tier_code = null, needs_dept = false, needs_ceo = false, bulk_allowed = false,
        content_sha256 = v_hash, submitted_by = p_user_id, submitted_at = now(),
        rejected_by = null, rejected_at = null, rejection_remarks = null
      where id = v.id;
    else
      r := app.fin_voucher_rule(p_org_id, v.amount, v.special_category);
      if r.id is null then
        raise exception 'No approval rule covers this amount or category. Fix the delegation-of-authority settings.'
          using errcode = 'check_violation', hint = 'no_rule';
      end if;
      v_to := 'submitted';
      v_event := 'submitted';
      update public.fin_payment_vouchers set
        status = v_to, route = 'pulse', tier_code = r.code, needs_dept = r.needs_dept_head, needs_ceo = r.needs_ceo,
        bulk_allowed = r.bulk_allowed, content_sha256 = v_hash, submitted_by = p_user_id, submitted_at = now(),
        rejected_by = null, rejected_at = null, rejection_remarks = null
      where id = v.id;
    end if;

  elsif p_action = 'check' then
    if not app.user_has_perm(p_org_id, p_user_id, 'finance.vouchers.check') then
      raise exception 'Only the Finance Manager verifies vouchers.' using errcode = 'check_violation', hint = 'not_permitted';
    end if;
    if v.status <> 'submitted' then
      raise exception 'This voucher is not waiting for verification.' using errcode = 'check_violation', hint = 'wrong_status';
    end if;
    if app.fin_voucher_is_maker(v.id, p_user_id) then
      raise exception 'The checker must be a different person from the maker.' using errcode = 'check_violation', hint = 'same_person';
    end if;
    if p_hash is distinct from v.content_sha256 or v_hash is distinct from v.content_sha256 then
      raise exception 'The voucher changed since you opened it; reload and review it again.' using errcode = 'check_violation', hint = 'hash_mismatch';
    end if;
    v_to := case when coalesce(v.needs_dept, false) or coalesce(v.needs_ceo, false) then 'checked' else 'approved' end;
    v_event := 'checked';
    update public.fin_payment_vouchers set status = v_to, checked_by = p_user_id, checked_at = now(),
      approved_at = case when v_to = 'approved' then now() else null end
    where id = v.id;

  elsif p_action = 'approve_dept' then
    if not app.user_has_perm(p_org_id, p_user_id, 'finance.vouchers.approve_dept') then
      raise exception 'Only a department head approves this step.' using errcode = 'check_violation', hint = 'not_permitted';
    end if;
    if v.status <> 'checked' or not coalesce(v.needs_dept, false) then
      raise exception 'This voucher is not waiting for a department head.' using errcode = 'check_violation', hint = 'wrong_status';
    end if;
    if app.fin_voucher_is_maker(v.id, p_user_id) or p_user_id = v.checked_by then
      raise exception 'Each step must be a different person.' using errcode = 'check_violation', hint = 'same_person';
    end if;
    if p_hash is distinct from v.content_sha256 or v_hash is distinct from v.content_sha256 then
      raise exception 'The voucher changed since you opened it; reload and review it again.' using errcode = 'check_violation', hint = 'hash_mismatch';
    end if;
    v_to := case when coalesce(v.needs_ceo, false) then 'dept_approved' else 'approved' end;
    v_event := 'dept_approved';
    update public.fin_payment_vouchers set status = v_to, dept_approved_by = p_user_id, dept_approved_at = now(),
      approved_at = case when v_to = 'approved' then now() else null end
    where id = v.id;

  elsif p_action = 'approve_ceo' then
    if not app.user_has_perm(p_org_id, p_user_id, 'finance.vouchers.approve_ceo') then
      raise exception 'Only the CEO authorises this step.' using errcode = 'check_violation', hint = 'not_permitted';
    end if;
    if not coalesce(v.needs_ceo, false)
       or v.status <> (case when coalesce(v.needs_dept, false) then 'dept_approved' else 'checked' end) then
      raise exception 'This voucher is not waiting for the CEO.' using errcode = 'check_violation', hint = 'wrong_status';
    end if;
    if app.fin_voucher_is_maker(v.id, p_user_id) or p_user_id = v.checked_by or p_user_id = v.dept_approved_by then
      raise exception 'Each step must be a different person.' using errcode = 'check_violation', hint = 'same_person';
    end if;
    if p_hash is distinct from v.content_sha256 or v_hash is distinct from v.content_sha256 then
      raise exception 'The voucher changed since you opened it; reload and review it again.' using errcode = 'check_violation', hint = 'hash_mismatch';
    end if;
    v_to := 'approved';
    v_event := 'ceo_approved';
    update public.fin_payment_vouchers set status = v_to, ceo_approved_by = p_user_id, ceo_approved_at = now(), approved_at = now()
    where id = v.id;

  elsif p_action = 'reject' then
    if v.status not in ('submitted', 'checked', 'dept_approved') then
      raise exception 'Only a voucher waiting for a decision can be rejected.' using errcode = 'check_violation', hint = 'wrong_status';
    end if;
    v_perm := case
      when v.status = 'submitted' then 'finance.vouchers.check'
      when v.status = 'checked' and coalesce(v.needs_dept, false) then 'finance.vouchers.approve_dept'
      else 'finance.vouchers.approve_ceo' end;
    if not app.user_has_perm(p_org_id, p_user_id, v_perm) then
      raise exception 'You cannot decide this step.' using errcode = 'check_violation', hint = 'not_permitted';
    end if;
    if v_remarks is null or char_length(v_remarks) < 3 then
      raise exception 'Say why the voucher is rejected (remarks are required).' using errcode = 'check_violation', hint = 'remarks_required';
    end if;
    if app.fin_voucher_is_maker(v.id, p_user_id) then
      raise exception 'The maker cannot reject their own voucher; edit it instead.' using errcode = 'check_violation', hint = 'same_person';
    end if;
    v_to := 'rejected';
    v_event := 'rejected';
    update public.fin_payment_vouchers set status = v_to, rejected_by = p_user_id, rejected_at = now(),
      rejection_remarks = left(v_remarks, 1000),
      checked_by = null, checked_at = null, dept_approved_by = null, dept_approved_at = null,
      ceo_approved_by = null, ceo_approved_at = null, approved_at = null
    where id = v.id;

  elsif p_action = 'reopen' then
    if not app.user_has_perm(p_org_id, p_user_id, 'finance.vouchers.prepare') then
      raise exception 'You cannot prepare payment vouchers.' using errcode = 'check_violation', hint = 'not_permitted';
    end if;
    if v.status <> 'rejected' then
      raise exception 'Only a rejected voucher can be reopened.' using errcode = 'check_violation', hint = 'wrong_status';
    end if;
    v_to := 'draft';
    v_event := 'reopened';
    update public.fin_payment_vouchers set status = v_to, route = null, tier_code = null, needs_dept = null, needs_ceo = null,
      bulk_allowed = null, content_sha256 = null, submitted_by = null, submitted_at = null
    where id = v.id;

  elsif p_action = 'cancel' then
    if not app.user_has_perm(p_org_id, p_user_id, 'finance.vouchers.prepare') then
      raise exception 'You cannot prepare payment vouchers.' using errcode = 'check_violation', hint = 'not_permitted';
    end if;
    if v.status not in ('draft', 'rejected', 'for_tally') or v.tally_export_id is not null then
      raise exception 'Only a draft, a rejected voucher or one not yet exported to Tally can be cancelled.' using errcode = 'check_violation', hint = 'wrong_status';
    end if;
    if v_remarks is null or char_length(v_remarks) < 3 then
      raise exception 'Say why the voucher is cancelled (remarks are required).' using errcode = 'check_violation', hint = 'remarks_required';
    end if;
    v_to := 'cancelled';
    v_event := 'cancelled';
    update public.fin_payment_vouchers set status = v_to, cancelled_by = p_user_id, cancelled_at = now() where id = v.id;
    update public.fin_supplier_invoices si set status = 'open'
     where si.status = 'on_voucher' and si.id in (select l.supplier_invoice_id from public.fin_voucher_invoices l where l.voucher_id = v.id);

  elsif p_action = 'pay' then
    if not app.user_has_perm(p_org_id, p_user_id, 'finance.vouchers.pay') then
      raise exception 'You cannot record payments.' using errcode = 'check_violation', hint = 'not_permitted';
    end if;
    if v.status not in ('approved', 'for_tally') then
      raise exception 'Only an approved voucher can be paid.' using errcode = 'check_violation', hint = 'wrong_status';
    end if;
    v_pay_date := nullif(p_payment ->> 'date', '')::date;
    v_pay_ref := nullif(btrim(coalesce(p_payment ->> 'reference', '')), '');
    if v_pay_date is null or v_pay_ref is null or char_length(v_pay_ref) > 60 then
      raise exception 'Enter the payment date and the bank reference.' using errcode = 'check_violation', hint = 'payment_details_required';
    end if;
    if p_hash is distinct from v.content_sha256 or v_hash is distinct from v.content_sha256 then
      raise exception 'The voucher changed since you opened it; reload and review it again.' using errcode = 'check_violation', hint = 'hash_mismatch';
    end if;
    if app.fin_month_is_locked(p_org_id, v_pay_date) then
      raise exception 'The month of the payment date is locked.' using errcode = 'check_violation', hint = 'month_locked';
    end if;
    v_to := 'paid';
    v_event := 'paid';
    update public.fin_payment_vouchers set status = v_to, paid_by = p_user_id, paid_at = now(),
      payment_date = v_pay_date, payment_reference = v_pay_ref
    where id = v.id;
    update public.fin_supplier_invoices si set status = 'paid'
     where si.id in (select l.supplier_invoice_id from public.fin_voucher_invoices l where l.voucher_id = v.id);
    v_remarks := coalesce(v_remarks, 'Payment reference ' || v_pay_ref);

  else
    raise exception 'Unknown action.' using errcode = 'check_violation', hint = 'unknown_action';
  end if;

  insert into public.fin_voucher_events (org_id, voucher_id, action, actor_id, from_status, to_status, remarks, content_sha256)
  values (p_org_id, v.id, v_event, p_user_id, v.status, v_to, left(v_remarks, 1000),
          case when v_event in ('reopened') then null else v_hash end);

  return (select jsonb_build_object('id', x.id, 'voucher_no', x.voucher_no, 'from', v.status, 'to', x.status, 'hash', v_hash,
                                    'needs_dept', coalesce(x.needs_dept, false), 'needs_ceo', coalesce(x.needs_ceo, false),
                                    'prepared_by', x.prepared_by, 'submitted_by', x.submitted_by)
          from public.fin_payment_vouchers x where x.id = v.id);
end;
$$;
revoke all on function public.fin_voucher_act(uuid, uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.fin_voucher_act(uuid, uuid, uuid, text, text, text, jsonb) to service_role;

-- Bulk verification for routine items: only vouchers whose rule allows it (Tier 1: no approval beyond the Finance
-- Manager), each bound to the hash the checker saw. Each voucher succeeds or fails on its own.
-- p_items: [{ "id": uuid, "hash": text }], at most 200.
create or replace function public.fin_voucher_bulk_check(p_org_id uuid, p_user_id uuid, p_items jsonb, p_remarks text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  it jsonb;
  v_id uuid;
  v_ok jsonb := '[]'::jsonb;
  v_failed jsonb := '[]'::jsonb;
  v_hint text;
  v_allowed boolean;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 200 then
    raise exception 'Choose at most 200 vouchers.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  for it in select * from jsonb_array_elements(p_items) loop
    v_id := (it ->> 'id')::uuid;
    begin
      select coalesce(v.bulk_allowed, false) and v.route = 'pulse' and v.special_category = 'none'
        into v_allowed from public.fin_payment_vouchers v where v.id = v_id and v.org_id = p_org_id;
      if not coalesce(v_allowed, false) then
        raise exception 'Only Tier 1 vouchers can be verified in bulk.' using errcode = 'check_violation', hint = 'bulk_not_allowed';
      end if;
      perform public.fin_voucher_act(p_org_id, v_id, p_user_id, 'check', it ->> 'hash', p_remarks, null);
      v_ok := v_ok || to_jsonb(v_id::text);
    exception when others then
      get stacked diagnostics v_hint = pg_exception_hint;
      v_failed := v_failed || jsonb_build_object('id', v_id, 'code', coalesce(nullif(v_hint, ''), 'error'));
    end;
  end loop;
  return jsonb_build_object('done', v_ok, 'failed', v_failed);
end;
$$;
revoke all on function public.fin_voucher_bulk_check(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.fin_voucher_bulk_check(uuid, uuid, jsonb, text) to service_role;

-- ---------------------------------------------------------------------------
-- 14. Record a Tally export atomically: every listed voucher and invoice must still be eligible and not yet exported,
--     otherwise nothing is recorded (the export is built again). Eligible: vouchers approved, paid or for_tally; supplier
--     invoices that are not void.
-- ---------------------------------------------------------------------------
create or replace function public.fin_tally_record_export(
  p_org_id uuid, p_user_id uuid, p_voucher_ids uuid[], p_invoice_ids uuid[], p_checksum text, p_xml text, p_total numeric
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_n integer;
begin
  if not app.user_has_perm(p_org_id, p_user_id, 'finance.tally.export') then
    raise exception 'You cannot export to Tally.' using errcode = 'check_violation', hint = 'not_permitted';
  end if;
  perform 1 from public.fin_payment_vouchers where org_id = p_org_id and id = any (coalesce(p_voucher_ids, '{}')) for update;
  perform 1 from public.fin_supplier_invoices where org_id = p_org_id and id = any (coalesce(p_invoice_ids, '{}')) for update;
  select count(*) into v_n from public.fin_payment_vouchers
   where org_id = p_org_id and id = any (coalesce(p_voucher_ids, '{}'))
     and status in ('approved', 'paid', 'for_tally') and tally_export_id is null;
  if v_n <> coalesce(cardinality(p_voucher_ids), 0) then
    raise exception 'Something changed while the file was built; build it again.' using errcode = 'check_violation', hint = 'stale_export';
  end if;
  select count(*) into v_n from public.fin_supplier_invoices
   where org_id = p_org_id and id = any (coalesce(p_invoice_ids, '{}')) and status <> 'void' and tally_export_id is null;
  if v_n <> coalesce(cardinality(p_invoice_ids), 0) then
    raise exception 'Something changed while the file was built; build it again.' using errcode = 'check_violation', hint = 'stale_export';
  end if;
  insert into public.fin_tally_exports (org_id, voucher_count, invoice_count, total_amount, checksum, xml, exported_by)
  values (p_org_id, coalesce(cardinality(p_voucher_ids), 0), coalesce(cardinality(p_invoice_ids), 0), coalesce(p_total, 0),
          p_checksum, p_xml, p_user_id)
  returning id into v_id;
  update public.fin_payment_vouchers set tally_export_id = v_id, tally_exported_at = now()
   where org_id = p_org_id and id = any (coalesce(p_voucher_ids, '{}'));
  update public.fin_supplier_invoices set tally_export_id = v_id, tally_exported_at = now()
   where org_id = p_org_id and id = any (coalesce(p_invoice_ids, '{}'));
  insert into public.fin_voucher_events (org_id, voucher_id, action, actor_id, from_status, to_status, remarks, content_sha256)
  select p_org_id, v.id, 'exported', p_user_id, v.status, v.status, 'Exported to Tally', v.content_sha256
  from public.fin_payment_vouchers v where v.org_id = p_org_id and v.id = any (coalesce(p_voucher_ids, '{}'));
  return v_id;
end;
$$;
revoke all on function public.fin_tally_record_export(uuid, uuid, uuid[], uuid[], text, text, numeric) from public, anon, authenticated;
grant execute on function public.fin_tally_record_export(uuid, uuid, uuid[], uuid[], text, text, numeric) to service_role;

-- Abandoned uploads (pending for more than a day) are removed by the documents_maintenance task in the application.

insert into supabase_migrations.schema_migrations (version, name) values ('20261024000100', 'finance_payables') on conflict (version) do nothing;
