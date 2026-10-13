-- Phase 22E: receivables (docs/22_ACCOUNTING_PLAN.md, slice 22E; notes in docs/22_PHASE_22E_NOTES.md).
--
--   * acc_customers: insurers (linked to fin_ref_payers), corporates, tenants and other business customers. No patients:
--     patient invoices are issued by Unite and are never re-issued here.
--   * acc_sales_invoices (+ lines): sales invoices and credit notes in AED with UAE VAT worked out per line (2 decimals,
--     half away from zero; the same formulas as lib/accounting/sales.ts, re-checked here). Gap-free numbers per entity,
--     document kind and fiscal year (SI/2026-27/00001, CN/..., RV/...), allocated at issue. Draft -> issued -> part paid /
--     paid -> void (void = a credit note in full). Issuing posts the journal through acc_post_from_source('sales_invoice');
--     a refusal with hint before_ledger_start (the ledger start date rule) keeps the document issued and marks its posting
--     waiting_ledger_start (it is in Tally, through the bridge). Above the approval limit (acc_ar_settings) a different
--     person with accounting.journals.approve issues it, bound to the content hash they reviewed.
--   * acc_receipts + acc_allocations: money received from a customer, posted through acc_post_from_source('receipt'),
--     allocated oldest invoice first by default or by hand; what is left is an advance on account.
--   * acc_ar_open_items / acc_ar_statement: the data for the ageing, statements and balance-confirmation letters.
--
-- Every write is a SECURITY DEFINER function (service role only, search_path = '') or a server action after can();
-- the tables have select policies only. Errors carry a stable code in the HINT (lib/accounting/errors.ts).

-- ---------------------------------------------------------------------------
-- 1. Who reads receivables
-- ---------------------------------------------------------------------------
create or replace function app.acc_can_read_receivables(p_org_id uuid)
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
        'accounting.sales.manage', 'accounting.receipts.manage', 'accounting.ledger.view', 'accounting.reports.view',
        'accounting.journals.approve'])
  );
$$;
revoke all on function app.acc_can_read_receivables(uuid) from public, anon;
grant execute on function app.acc_can_read_receivables(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------
-- One row per org: the approval limit and the document settings (FTA: simplified invoices up to AED 10,000; credit notes
-- within 14 days of the event).
create table public.acc_ar_settings (
  org_id uuid primary key references public.orgs (id) on delete cascade,
  issue_approval_threshold numeric(14, 2) not null default 50000 check (issue_approval_threshold >= 0),
  simplified_invoice_limit numeric(14, 2) not null default 10000 check (simplified_invoice_limit between 0 and 10000),
  credit_note_days integer not null default 14 check (credit_note_days between 1 and 365),
  invoice_prefix text not null default 'SI' check (invoice_prefix ~ '^[A-Z]{1,6}$'),
  credit_note_prefix text not null default 'CN' check (credit_note_prefix ~ '^[A-Z]{1,6}$'),
  receipt_prefix text not null default 'RV' check (receipt_prefix ~ '^[A-Z]{1,6}$'),
  -- the supplier's address on the tax invoice (the name and TRN come from the entity)
  seller_address text check (seller_address is null or char_length(seller_address) <= 300),
  -- how to pay (the clinic's own bank details), printed on invoices and statements
  payment_instructions text check (payment_instructions is null or char_length(payment_instructions) <= 500),
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (invoice_prefix <> credit_note_prefix and invoice_prefix <> receipt_prefix and credit_note_prefix <> receipt_prefix)
);
create trigger acc_ar_settings_set_updated_at before update on public.acc_ar_settings
  for each row execute function app.set_updated_at();

create table public.acc_customers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  kind text not null check (kind in ('insurer', 'corporate', 'tenant', 'other')),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  trn text check (trn is null or trn ~ '^[0-9A-Z-]{5,20}$'),                 -- tax registration number (registered = set)
  emirate text check (emirate is null or emirate in (
    'Abu Dhabi', 'Dubai', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah')),
  address_line1 text check (address_line1 is null or char_length(address_line1) <= 120),
  address_line2 text check (address_line2 is null or char_length(address_line2) <= 120),
  city text check (city is null or char_length(city) <= 60),
  country text not null default 'United Arab Emirates' check (char_length(country) between 2 and 60),
  -- a business contact address (never logged; masked wherever it is shown in a log)
  email text check (email is null or (char_length(email) <= 200 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  credit_terms_days integer not null default 30 check (credit_terms_days between 0 and 365),
  -- UAE corporate tax: a connected person (transfer-pricing disclosure)
  connected_person boolean not null default false,
  payer_id text check (payer_id is null or char_length(payer_id) between 1 and 40),   -- fin_ref_payers.payer_id
  receivable_account_id uuid references public.acc_accounts (id),           -- null = Customer receivables (1220)
  active boolean not null default true,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (payer_id is null or kind = 'insurer')
);
create unique index acc_customers_name_uidx on public.acc_customers (org_id, lower(btrim(name)));
create unique index acc_customers_payer_uidx on public.acc_customers (org_id, payer_id) where payer_id is not null;
create trigger acc_customers_set_updated_at before update on public.acc_customers
  for each row execute function app.set_updated_at();

-- Gap-free document numbers per entity, kind and fiscal year; next_number only goes up, under a row lock, in the issuing
-- transaction (a refused or rolled-back issue gives its number back).
create table public.acc_ar_number_series (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  entity_id uuid not null references public.acc_entities (id),
  doc_kind text not null check (doc_kind in ('invoice', 'credit_note', 'receipt')),
  fiscal_year_id uuid not null references public.acc_fiscal_years (id),
  prefix text not null check (prefix ~ '^[A-Z]{1,6}$'),
  next_number integer not null default 1 check (next_number >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (entity_id, doc_kind, fiscal_year_id)
);
create trigger acc_ar_number_series_set_updated_at before update on public.acc_ar_number_series
  for each row execute function app.set_updated_at();
create trigger acc_ar_number_series_entity_org_check before insert or update on public.acc_ar_number_series
  for each row execute function app.check_parent_org('acc_entities', 'entity_id');

create table public.acc_sales_invoices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  entity_id uuid not null references public.acc_entities (id),
  kind text not null default 'invoice' check (kind in ('invoice', 'credit_note')),
  customer_id uuid not null references public.acc_customers (id),
  original_invoice_id uuid references public.acc_sales_invoices (id),     -- a credit note -> the invoice it credits
  number text check (number is null or char_length(number) between 1 and 40),
  invoice_date date not null,
  supply_date date,                                                        -- printed when it differs from the date
  due_date date,
  event_date date,                                       -- a credit note: the event the 14-day rule counts from
  credit_reason text check (credit_reason is null or char_length(credit_reason) <= 200),
  reference text check (reference is null or char_length(reference) <= 60),         -- the customer's PO or contract
  notes text check (notes is null or char_length(notes) <= 500),
  currency text not null default 'AED' check (currency = 'AED'),
  receivable_account_id uuid references public.acc_accounts (id),         -- fixed at issue
  invoice_form text check (invoice_form is null or invoice_form in ('full', 'simplified')),   -- decided at issue
  status text not null default 'draft' check (status in ('draft', 'issued', 'part_paid', 'paid', 'void')),
  subtotal numeric(14, 2) not null default 0 check (subtotal >= 0),
  discount_total numeric(14, 2) not null default 0 check (discount_total >= 0),
  net_total numeric(14, 2) not null default 0 check (net_total >= 0),
  vat_total numeric(14, 2) not null default 0 check (vat_total >= 0),
  total numeric(14, 2) not null default 0 check (total >= 0),
  amount_paid numeric(14, 2) not null default 0 check (amount_paid >= 0),
  amount_credited numeric(14, 2) not null default 0 check (amount_credited >= 0),
  content_sha256 text check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
  approval_required boolean not null default false,
  prepared_by uuid references public.profiles (id) on delete set null,
  approved_by uuid references public.profiles (id) on delete set null,
  issued_by uuid references public.profiles (id) on delete set null,
  issued_at timestamptz,
  voided_by uuid references public.profiles (id) on delete set null,
  voided_at timestamptz,
  void_reason text check (void_reason is null or char_length(void_reason) <= 200),
  void_credit_note_id uuid references public.acc_sales_invoices (id),
  journal_id uuid references public.acc_journals (id),
  posting_status text not null default 'not_posted'
    check (posting_status in ('not_posted', 'posted', 'waiting_ledger_start')),
  -- UAE e-invoicing (OQ-122): not wired to an accredited service provider yet
  einvoice_status text not null default 'not_applicable'
    check (einvoice_status in ('not_applicable', 'pending', 'sent', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'draft') = (number is null)),
  check (status = 'draft' or (issued_at is not null and invoice_form is not null and receivable_account_id is not null)),
  check ((kind = 'credit_note') = (original_invoice_id is not null)),
  check (kind = 'invoice' or status in ('draft', 'issued')),
  check (due_date is null or due_date >= invoice_date),
  check ((posting_status = 'posted') = (journal_id is not null)),
  -- maker / checker above the approval limit (null-safe: a removed user's id becomes null)
  check (not approval_required or approved_by is null or prepared_by is null or approved_by <> prepared_by),
  check (not approval_required or status = 'draft' or approved_by is not null or issued_by is null)
);
create unique index acc_sales_invoices_number_uidx on public.acc_sales_invoices (entity_id, number) where number is not null;
create index acc_sales_invoices_customer_idx on public.acc_sales_invoices (org_id, customer_id, invoice_date);
create index acc_sales_invoices_status_idx on public.acc_sales_invoices (org_id, status, invoice_date desc);
create index acc_sales_invoices_original_idx on public.acc_sales_invoices (original_invoice_id) where original_invoice_id is not null;
create trigger acc_sales_invoices_set_updated_at before update on public.acc_sales_invoices
  for each row execute function app.set_updated_at();
create trigger acc_sales_invoices_entity_org_check before insert or update on public.acc_sales_invoices
  for each row execute function app.check_parent_org('acc_entities', 'entity_id');
create trigger acc_sales_invoices_customer_org_check before insert or update on public.acc_sales_invoices
  for each row execute function app.check_parent_org('acc_customers', 'customer_id');

create table public.acc_sales_invoice_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  invoice_id uuid not null references public.acc_sales_invoices (id) on delete cascade,
  line_no integer not null check (line_no between 1 and 200),
  description text not null check (char_length(btrim(description)) between 1 and 200),
  quantity numeric(12, 3) not null check (quantity > 0),
  unit_price numeric(14, 2) not null check (unit_price >= 0),
  discount numeric(14, 2) not null default 0 check (discount >= 0),
  gross numeric(14, 2) not null,
  net numeric(14, 2) not null check (net >= 0),
  vat_rate numeric(5, 2) not null check (vat_rate >= 0 and vat_rate <= 100),
  vat_amount numeric(14, 2) not null check (vat_amount >= 0),
  line_total numeric(14, 2) not null,
  income_account_id uuid not null references public.acc_accounts (id),
  tax_code_id uuid not null references public.acc_tax_codes (id),
  branch_code text check (branch_code is null or char_length(branch_code) between 1 and 20),
  department text check (department is null or char_length(department) between 1 and 60),
  cost_centre_id uuid references public.acc_cost_centres (id),
  created_at timestamptz not null default now(),
  unique (invoice_id, line_no),
  check (gross = round(quantity * unit_price, 2)),
  check (discount <= gross and net = gross - discount),
  check (vat_amount = round(net * vat_rate / 100, 2) and line_total = net + vat_amount)
);
create index acc_sales_invoice_lines_org_idx on public.acc_sales_invoice_lines (org_id);
create trigger acc_sales_invoice_lines_invoice_org_check before insert or update on public.acc_sales_invoice_lines
  for each row execute function app.check_parent_org('acc_sales_invoices', 'invoice_id');

create table public.acc_receipts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  entity_id uuid not null references public.acc_entities (id),
  customer_id uuid not null references public.acc_customers (id),
  number text not null check (char_length(number) between 1 and 40),
  receipt_date date not null,
  account_id uuid not null references public.acc_accounts (id),           -- the bank, cash or clearing ledger
  receivable_account_id uuid not null references public.acc_accounts (id),
  amount numeric(14, 2) not null check (amount > 0),
  amount_allocated numeric(14, 2) not null default 0 check (amount_allocated >= 0),
  mode text not null check (mode in ('bank_transfer', 'cheque', 'card', 'cash', 'other')),
  reference text check (reference is null or char_length(reference) <= 60),
  notes text check (notes is null or char_length(notes) <= 300),
  status text not null default 'active' check (status in ('active', 'void')),
  journal_id uuid references public.acc_journals (id),
  posting_status text not null default 'not_posted'
    check (posting_status in ('not_posted', 'posted', 'waiting_ledger_start')),
  prepared_by uuid references public.profiles (id) on delete set null,
  voided_by uuid references public.profiles (id) on delete set null,
  voided_at timestamptz,
  void_reason text check (void_reason is null or char_length(void_reason) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (amount_allocated <= amount),
  check (status = 'active' or (voided_at is not null and amount_allocated = 0)),
  check (journal_id is null or posting_status = 'posted')
);
create unique index acc_receipts_number_uidx on public.acc_receipts (entity_id, number);
create index acc_receipts_customer_idx on public.acc_receipts (org_id, customer_id, receipt_date);
create trigger acc_receipts_set_updated_at before update on public.acc_receipts
  for each row execute function app.set_updated_at();
create trigger acc_receipts_entity_org_check before insert or update on public.acc_receipts
  for each row execute function app.check_parent_org('acc_entities', 'entity_id');
create trigger acc_receipts_customer_org_check before insert or update on public.acc_receipts
  for each row execute function app.check_parent_org('acc_customers', 'customer_id');

create table public.acc_allocations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  receipt_id uuid not null references public.acc_receipts (id) on delete cascade,
  invoice_id uuid not null references public.acc_sales_invoices (id),
  amount numeric(14, 2) not null check (amount > 0),
  allocated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (receipt_id, invoice_id)
);
create index acc_allocations_invoice_idx on public.acc_allocations (invoice_id);
create index acc_allocations_org_idx on public.acc_allocations (org_id);
create trigger acc_allocations_receipt_org_check before insert or update on public.acc_allocations
  for each row execute function app.check_parent_org('acc_receipts', 'receipt_id');
create trigger acc_allocations_invoice_org_check before insert or update on public.acc_allocations
  for each row execute function app.check_parent_org('acc_sales_invoices', 'invoice_id');

-- ---------------------------------------------------------------------------
-- 3. Guards (every role, including the service role)
-- ---------------------------------------------------------------------------
create or replace function app.acc_customer_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.org_id is null then
    return new;
  end if;
  if new.payer_id is not null and (new.kind <> 'insurer' or not exists (
    select 1 from public.fin_ref_payers p where p.org_id = new.org_id and p.payer_id = new.payer_id)) then
    raise exception 'Only an insurer is linked to a payer, and the payer must exist.' using errcode = 'check_violation', hint = 'customer_payer';
  end if;
  if new.receivable_account_id is not null and not exists (
    select 1 from public.acc_accounts a
    where a.id = new.receivable_account_id and a.org_id = new.org_id and not a.is_group and a.is_active
      and a.control = 'receivable') then
    raise exception 'The receivable account must be an active receivables ledger.' using errcode = 'check_violation', hint = 'receivable_account';
  end if;
  return new;
end;
$$;
revoke all on function app.acc_customer_guard() from public, anon, authenticated;
create trigger acc_customers_guard before insert or update on public.acc_customers
  for each row execute function app.acc_customer_guard();

-- An issued document keeps its content: after issue only the payment and void fields, the posting and the e-invoice
-- status change. Only a draft is deleted (the org cascade passes).
create or replace function app.acc_sales_invoice_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.orgs o where o.id = old.org_id) or old.status = 'draft' then
      return old;
    end if;
    raise exception 'An issued document is never deleted; void it or issue a credit note.' using errcode = 'check_violation', hint = 'posted_immutable';
  end if;
  if tg_op = 'UPDATE' and old.status <> 'draft' then
    if (to_jsonb(new) - array['status', 'amount_paid', 'amount_credited', 'journal_id', 'posting_status', 'einvoice_status',
                              'voided_by', 'voided_at', 'void_reason', 'void_credit_note_id', 'updated_at'])
       is distinct from
       (to_jsonb(old) - array['status', 'amount_paid', 'amount_credited', 'journal_id', 'posting_status', 'einvoice_status',
                              'voided_by', 'voided_at', 'void_reason', 'void_credit_note_id', 'updated_at']) then
      raise exception 'An issued document cannot change; issue a credit note instead.' using errcode = 'check_violation', hint = 'posted_immutable';
    end if;
    if new.status = 'draft' or (old.status = 'void' and new.status <> 'void') then
      raise exception 'An issued document does not go back.' using errcode = 'check_violation', hint = 'wrong_status';
    end if;
  end if;
  return coalesce(new, old);
end;
$$;
revoke all on function app.acc_sales_invoice_guard() from public, anon, authenticated;
create trigger acc_sales_invoices_guard before update or delete on public.acc_sales_invoices
  for each row execute function app.acc_sales_invoice_guard();

create or replace function app.acc_sales_line_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  select i.status into v_status from public.acc_sales_invoices i
   where i.id = case when tg_op = 'DELETE' then old.invoice_id else new.invoice_id end;
  if v_status is null or v_status = 'draft' then
    return coalesce(new, old);       -- a draft, or the parent is being deleted (a draft or the org cascade)
  end if;
  raise exception 'The lines of an issued document cannot change.' using errcode = 'check_violation', hint = 'posted_immutable';
end;
$$;
revoke all on function app.acc_sales_line_guard() from public, anon, authenticated;
create trigger acc_sales_invoice_lines_guard before insert or update or delete on public.acc_sales_invoice_lines
  for each row execute function app.acc_sales_line_guard();

create or replace function app.acc_receipt_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.orgs o where o.id = old.org_id) then
      return old;
    end if;
    raise exception 'A receipt is never deleted; void it.' using errcode = 'check_violation', hint = 'posted_immutable';
  end if;
  if (to_jsonb(new) - array['status', 'amount_allocated', 'journal_id', 'posting_status', 'voided_by', 'voided_at',
                            'void_reason', 'updated_at'])
     is distinct from
     (to_jsonb(old) - array['status', 'amount_allocated', 'journal_id', 'posting_status', 'voided_by', 'voided_at',
                            'void_reason', 'updated_at']) then
    raise exception 'A receipt cannot change; void it and record it again.' using errcode = 'check_violation', hint = 'posted_immutable';
  end if;
  if old.status = 'void' and (new.status <> 'void' or new.amount_allocated <> 0) then
    raise exception 'A void receipt stays void.' using errcode = 'check_violation', hint = 'wrong_status';
  end if;
  return new;
end;
$$;
revoke all on function app.acc_receipt_guard() from public, anon, authenticated;
create trigger acc_receipts_guard before update or delete on public.acc_receipts
  for each row execute function app.acc_receipt_guard();

-- ---------------------------------------------------------------------------
-- 4. Row level security: select only; every write is a function or a server action after can()
-- ---------------------------------------------------------------------------
alter table public.acc_ar_settings enable row level security;
alter table public.acc_customers enable row level security;
alter table public.acc_ar_number_series enable row level security;
alter table public.acc_sales_invoices enable row level security;
alter table public.acc_sales_invoice_lines enable row level security;
alter table public.acc_receipts enable row level security;
alter table public.acc_allocations enable row level security;

create policy acc_ar_settings_select on public.acc_ar_settings for select to authenticated
  using (app.acc_can_read_receivables(org_id) or app.has_perm(org_id, 'accounting.settings.manage'));
create policy acc_customers_select on public.acc_customers for select to authenticated
  using (app.acc_can_read_receivables(org_id));
create policy acc_ar_number_series_select on public.acc_ar_number_series for select to authenticated
  using (app.acc_can_read_receivables(org_id));
create policy acc_sales_invoices_select on public.acc_sales_invoices for select to authenticated
  using (app.acc_can_read_receivables(org_id));
create policy acc_sales_invoice_lines_select on public.acc_sales_invoice_lines for select to authenticated
  using (app.acc_can_read_receivables(org_id));
create policy acc_receipts_select on public.acc_receipts for select to authenticated
  using (app.acc_can_read_receivables(org_id));
create policy acc_allocations_select on public.acc_allocations for select to authenticated
  using (app.acc_can_read_receivables(org_id));

-- ---------------------------------------------------------------------------
-- 5. Seed: the customer receivables control ledger, a rental income ledger and the settings row, for every org now and
--    for new orgs after the chart (triggers on the same event fire in name order: ..._phase22 before ..._phase22e)
-- ---------------------------------------------------------------------------
create or replace function public.acc_seed_receivables(p_org_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v integer := 0;
begin
  if not exists (select 1 from public.orgs o where o.id = p_org_id) then
    raise exception 'Organisation not found.' using errcode = 'no_data_found', hint = 'not_found';
  end if;
  v := v + app.acc_seed_account(p_org_id, '1220', 'Customer receivables', 'G-DEBT', false, 'asset', 'receivable', null, false, 100);
  v := v + app.acc_seed_account(p_org_id, '4910', 'Rental income', 'G-IINC', false, 'income', null, null, false, 100);
  insert into public.acc_ar_settings (org_id) values (p_org_id) on conflict do nothing;
  return v;
end;
$$;
revoke all on function public.acc_seed_receivables(uuid) from public, anon, authenticated;
grant execute on function public.acc_seed_receivables(uuid) to service_role;

create or replace function app.acc_ar_seed_on_org_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.acc_seed_receivables(new.id);
  return new;
end;
$$;
revoke all on function app.acc_ar_seed_on_org_insert() from public, anon, authenticated;
create trigger orgs_seed_finance_phase22e after insert on public.orgs
  for each row execute function app.acc_ar_seed_on_org_insert();

-- ---------------------------------------------------------------------------
-- 6. Helpers
-- ---------------------------------------------------------------------------
create or replace function app.acc_ar_settings_of(p_org_id uuid)
returns public.acc_ar_settings
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s public.acc_ar_settings;
begin
  select * into s from public.acc_ar_settings where org_id = p_org_id;
  if not found then
    s.org_id := p_org_id;
    s.issue_approval_threshold := 50000;
    s.simplified_invoice_limit := 10000;
    s.credit_note_days := 14;
    s.invoice_prefix := 'SI';
    s.credit_note_prefix := 'CN';
    s.receipt_prefix := 'RV';
  end if;
  return s;
end;
$$;
revoke all on function app.acc_ar_settings_of(uuid) from public, anon, authenticated;

-- The receivable ledger of a customer: its own, or Customer receivables (1220).
create or replace function app.acc_ar_receivable_account(p_org_id uuid, p_customer_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v uuid;
begin
  select c.receivable_account_id into v from public.acc_customers c where c.id = p_customer_id and c.org_id = p_org_id;
  if v is null then
    select a.id into v from public.acc_accounts a
     where a.org_id = p_org_id and a.code = '1220' and not a.is_group and a.is_active and a.control = 'receivable';
  end if;
  if v is null then
    raise exception 'The receivable account must be an active receivables ledger.' using errcode = 'check_violation', hint = 'receivable_account';
  end if;
  return v;
end;
$$;
revoke all on function app.acc_ar_receivable_account(uuid, uuid) from public, anon, authenticated;

-- The next gap-free number of a series (row lock; returns the number given back on rollback).
create or replace function app.acc_ar_next_number(p_org_id uuid, p_entity_id uuid, p_kind text, p_date date)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  st public.acc_ar_settings := app.acc_ar_settings_of(p_org_id);
  v_period uuid;
  v_fy uuid;
  v_fy_start date;
  s public.acc_ar_number_series;
begin
  v_period := public.acc_ensure_period(p_org_id, p_entity_id, p_date);
  select p.fiscal_year_id into v_fy from public.acc_periods p where p.id = v_period;
  insert into public.acc_ar_number_series (org_id, entity_id, doc_kind, fiscal_year_id, prefix)
  values (p_org_id, p_entity_id, p_kind, v_fy,
          case p_kind when 'invoice' then st.invoice_prefix when 'credit_note' then st.credit_note_prefix else st.receipt_prefix end)
  on conflict (entity_id, doc_kind, fiscal_year_id) do nothing;
  select * into s from public.acc_ar_number_series
   where entity_id = p_entity_id and doc_kind = p_kind and fiscal_year_id = v_fy for update;
  select f.start_date into v_fy_start from public.acc_fiscal_years f where f.id = v_fy;
  update public.acc_ar_number_series set next_number = next_number + 1 where id = s.id;
  return app.acc_format_number(s.prefix, app.acc_fy_code(v_fy_start), s.next_number);
end;
$$;
revoke all on function app.acc_ar_next_number(uuid, uuid, text, date) from public, anon, authenticated;

-- The canonical content of a sales document (what an approver reviews), and its sha256.
create or replace function app.acc_sales_doc_hash(p_doc_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select encode(sha256(convert_to(concat_ws(E'\n',
    'pulse-sales-v1',
    'org:' || d.org_id::text,
    'entity:' || d.entity_id::text,
    'kind:' || d.kind,
    'customer:' || d.customer_id::text,
    'original:' || coalesce(d.original_invoice_id::text, '-'),
    'date:' || to_char(d.invoice_date, 'YYYY-MM-DD'),
    'supply:' || coalesce(to_char(d.supply_date, 'YYYY-MM-DD'), '-'),
    'due:' || coalesce(to_char(d.due_date, 'YYYY-MM-DD'), '-'),
    'event:' || coalesce(to_char(d.event_date, 'YYYY-MM-DD'), '-'),
    'reason:' || coalesce(app.acc_esc(d.credit_reason), '-'),
    'reference:' || coalesce(app.acc_esc(d.reference), '-'),
    'notes:' || coalesce(app.acc_esc(d.notes), '-'),
    'total:' || d.total::text || '/' || d.vat_total::text,
    coalesce((
      select string_agg(concat_ws('|', 'L', l.line_no::text, app.acc_esc(l.description), l.quantity::text,
                                  l.unit_price::text, l.discount::text, l.income_account_id::text, l.tax_code_id::text,
                                  coalesce(app.acc_esc(l.branch_code), '-'), coalesce(app.acc_esc(l.department), '-'),
                                  coalesce(l.cost_centre_id::text, '-'), l.net::text, l.vat_amount::text),
                        E'\n' order by l.line_no)
      from public.acc_sales_invoice_lines l where l.invoice_id = d.id), '')), 'UTF8')), 'hex')
  from public.acc_sales_invoices d
  where d.id = p_doc_id;
$$;
revoke all on function app.acc_sales_doc_hash(uuid) from public, anon, authenticated;

-- Payments, credits and status of an invoice from its allocations and credit notes. Once void, it stays void.
create or replace function app.acc_ar_refresh_invoice(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  i public.acc_sales_invoices;
  v_paid numeric;
  v_cred numeric;
  v_status text;
begin
  select * into i from public.acc_sales_invoices where id = p_invoice_id for update;
  if not found or i.kind <> 'invoice' or i.status = 'draft' then
    return;
  end if;
  select coalesce(sum(a.amount), 0) into v_paid
    from public.acc_allocations a join public.acc_receipts r on r.id = a.receipt_id
   where a.invoice_id = i.id and r.status = 'active';
  select coalesce(sum(cn.total), 0) into v_cred
    from public.acc_sales_invoices cn
   where cn.original_invoice_id = i.id and cn.kind = 'credit_note' and cn.status <> 'draft';
  v_status := case
    when i.status = 'void' or v_cred >= i.total then 'void'
    when v_paid > 0 and v_paid + v_cred >= i.total then 'paid'
    when v_paid > 0 then 'part_paid'
    else 'issued' end;
  update public.acc_sales_invoices set amount_paid = v_paid, amount_credited = v_cred, status = v_status
   where id = i.id and (amount_paid, amount_credited, status) is distinct from (v_paid, v_cred, v_status);
end;
$$;
revoke all on function app.acc_ar_refresh_invoice(uuid) from public, anon, authenticated;

-- What is still open on an invoice (total - credited - paid by active receipts), optionally ignoring one receipt.
create or replace function app.acc_ar_invoice_open(p_invoice_id uuid, p_except_receipt uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select i.total
         - coalesce((select sum(cn.total) from public.acc_sales_invoices cn
                     where cn.original_invoice_id = i.id and cn.kind = 'credit_note' and cn.status <> 'draft'), 0)
         - coalesce((select sum(a.amount) from public.acc_allocations a join public.acc_receipts r on r.id = a.receipt_id
                     where a.invoice_id = i.id and r.status = 'active'
                       and (p_except_receipt is null or r.id <> p_except_receipt)), 0)
  from public.acc_sales_invoices i where i.id = p_invoice_id;
$$;
revoke all on function app.acc_ar_invoice_open(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Posting (through the 22A contract). A refusal with hint before_ledger_start keeps the document and marks its posting
--    waiting_ledger_start: before the ledger start date the books are Tally's and the document reaches them through the
--    bridge. Any other refusal is raised (the whole issue is refused with the reason).
-- ---------------------------------------------------------------------------
create or replace function app.acc_sales_doc_post(p_doc_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.acc_sales_invoices;
  c public.acc_customers;
  v_orig text;
  v_inv boolean;
  v_lines jsonb := '[]'::jsonb;
  v_res jsonb;
  v_hint text;
  l record;
begin
  select * into d from public.acc_sales_invoices where id = p_doc_id for update;
  if d.status = 'draft' or d.posting_status = 'posted' then
    return d.posting_status;
  end if;
  select * into c from public.acc_customers where id = d.customer_id;
  v_inv := d.kind = 'invoice';
  if not v_inv then
    select o.number into v_orig from public.acc_sales_invoices o where o.id = d.original_invoice_id;
  end if;
  -- the receivable, against the customer (and the payer for an insurer)
  v_lines := v_lines || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
    'account_id', d.receivable_account_id,
    'debit', case when v_inv then d.total else 0 end,
    'credit', case when v_inv then 0 else d.total end,
    'description', d.number,
    'payer_id', c.payer_id,
    'party_kind', 'customer', 'party_id', c.id::text)));
  -- income per line, net of discount
  for l in select * from public.acc_sales_invoice_lines where invoice_id = d.id and net > 0 order by line_no loop
    v_lines := v_lines || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'account_id', l.income_account_id,
      'debit', case when v_inv then 0 else l.net end,
      'credit', case when v_inv then l.net else 0 end,
      'description', left(l.description, 200),
      'tax_code_id', l.tax_code_id,
      'branch_code', l.branch_code,
      'department', l.department,
      'cost_centre_id', l.cost_centre_id,
      'party_kind', 'customer', 'party_id', c.id::text)));
  end loop;
  -- output VAT per tax code
  for l in
    select t.id as tax_code_id, t.output_account_id, sum(x.vat_amount) as vat
    from public.acc_sales_invoice_lines x join public.acc_tax_codes t on t.id = x.tax_code_id
    where x.invoice_id = d.id and x.vat_amount > 0
    group by t.id, t.output_account_id, t.code order by t.code
  loop
    if l.output_account_id is null then
      raise exception 'A tax code has no output VAT account.' using errcode = 'check_violation', hint = 'sales_tax_code';
    end if;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', l.output_account_id,
      'debit', case when v_inv then 0 else l.vat end,
      'credit', case when v_inv then l.vat else 0 end,
      'description', 'Output VAT ' || d.number,
      'tax_code_id', l.tax_code_id));
  end loop;

  begin
    v_res := public.acc_post_from_source(
      d.org_id, d.entity_id, 'sales_invoice', d.id::text, 1, d.invoice_date,
      case when v_inv then 'sales' else 'credit_note' end,
      case when v_inv then 'Sales invoice ' || d.number else 'Credit note ' || d.number || ' against ' || coalesce(v_orig, '-') end,
      v_lines);
    update public.acc_sales_invoices set journal_id = (v_res ->> 'id')::uuid, posting_status = 'posted' where id = d.id;
    return 'posted';
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    if v_hint = 'before_ledger_start' then
      update public.acc_sales_invoices set posting_status = 'waiting_ledger_start' where id = d.id;
      return 'waiting_ledger_start';
    end if;
    raise;
  end;
end;
$$;
revoke all on function app.acc_sales_doc_post(uuid) from public, anon, authenticated;

create or replace function app.acc_receipt_post(p_receipt_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.acc_receipts;
  c public.acc_customers;
  v_res jsonb;
  v_hint text;
begin
  select * into r from public.acc_receipts where id = p_receipt_id for update;
  if r.status <> 'active' or r.posting_status = 'posted' then
    return r.posting_status;
  end if;
  select * into c from public.acc_customers where id = r.customer_id;
  begin
    v_res := public.acc_post_from_source(
      r.org_id, r.entity_id, 'receipt', r.id::text, 1, r.receipt_date, 'receipt', 'Receipt ' || r.number,
      jsonb_build_array(
        jsonb_build_object('account_id', r.account_id, 'debit', r.amount, 'description', r.number,
                           'party_kind', 'customer', 'party_id', c.id::text),
        jsonb_strip_nulls(jsonb_build_object('account_id', r.receivable_account_id, 'credit', r.amount,
                           'description', r.number, 'payer_id', c.payer_id,
                           'party_kind', 'customer', 'party_id', c.id::text))));
    update public.acc_receipts set journal_id = (v_res ->> 'id')::uuid, posting_status = 'posted' where id = r.id;
    return 'posted';
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    if v_hint = 'before_ledger_start' then
      update public.acc_receipts set posting_status = 'waiting_ledger_start' where id = r.id;
      return 'waiting_ledger_start';
    end if;
    raise;
  end;
end;
$$;
revoke all on function app.acc_receipt_post(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. Sales invoices and credit notes
-- ---------------------------------------------------------------------------
-- Save a draft (new when p_doc_id is null). p_header: { kind, customer_id, entity_id?, original_invoice_id?, invoice_date,
-- supply_date?, due_date?, event_date?, credit_reason?, reference?, notes?, expected_total }. p_lines: [{ description,
-- quantity, unit_price, discount, income_account_id, tax_code_id, branch_code?, department?, cost_centre_id? }].
-- Totals are computed here (per line, 2 decimals) and must equal expected_total (computed by lib/accounting/sales.ts).
-- Editing a draft makes the editor its preparer.
create or replace function public.acc_sales_doc_save(p_org_id uuid, p_user_id uuid, p_doc_id uuid, p_header jsonb, p_lines jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.acc_sales_invoices;
  o public.acc_sales_invoices;
  v_kind text := coalesce(nullif(p_header ->> 'kind', ''), 'invoice');
  v_customer uuid;
  v_entity uuid;
  v_original uuid;
  v_date date;
  v_supply date;
  v_due date;
  v_event date;
  v_expected numeric;
  v_id uuid;
  it jsonb;
  v_no bigint;
  v_qty numeric;
  v_price numeric;
  v_disc numeric;
  v_gross numeric;
  v_net numeric;
  v_rate numeric;
  v_vat numeric;
  v_income uuid;
  v_tax uuid;
  v_cc uuid;
  v_branch text;
  v_dept text;
  v_desc text;
  v_sub numeric := 0;
  v_dsum numeric := 0;
  v_nsum numeric := 0;
  v_vsum numeric := 0;
  v_hint text;
begin
  if not app.user_has_perm(p_org_id, p_user_id, 'accounting.sales.manage') then
    raise exception 'You cannot prepare sales documents.' using errcode = 'check_violation', hint = 'not_permitted';
  end if;
  if v_kind not in ('invoice', 'credit_note') then
    raise exception 'Unknown document kind.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  begin
    v_customer := nullif(p_header ->> 'customer_id', '')::uuid;
    v_entity := nullif(p_header ->> 'entity_id', '')::uuid;
    v_original := nullif(p_header ->> 'original_invoice_id', '')::uuid;
    v_date := nullif(p_header ->> 'invoice_date', '')::date;
    v_supply := nullif(p_header ->> 'supply_date', '')::date;
    v_due := nullif(p_header ->> 'due_date', '')::date;
    v_event := nullif(p_header ->> 'event_date', '')::date;
    v_expected := nullif(p_header ->> 'expected_total', '')::numeric;
  exception when others then
    raise exception 'Check the dates and amounts.' using errcode = 'check_violation', hint = 'invalid';
  end;
  if v_date is null or v_date < date '2000-01-01' or v_date > date '2999-12-01' then
    raise exception 'Enter a valid date.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  if v_due is not null and v_due < v_date then
    raise exception 'The due date is before the invoice date.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  if not exists (select 1 from public.acc_customers c where c.id = v_customer and c.org_id = p_org_id and c.active) then
    raise exception 'Choose an active customer.' using errcode = 'check_violation', hint = 'customer_unknown';
  end if;
  if v_entity is null then
    select e.id into v_entity from public.acc_entities e where e.org_id = p_org_id and e.is_default;
  end if;
  if not exists (select 1 from public.acc_entities e where e.id = v_entity and e.org_id = p_org_id and e.active) then
    raise exception 'Entity not found.' using errcode = 'check_violation', hint = 'entity_unknown';
  end if;
  if v_kind = 'credit_note' then
    select * into o from public.acc_sales_invoices
     where id = v_original and org_id = p_org_id and kind = 'invoice' and status in ('issued', 'part_paid', 'paid')
       and customer_id = v_customer and entity_id = v_entity;
    if not found then
      raise exception 'A credit note refers to an issued invoice of the same customer.' using errcode = 'check_violation', hint = 'original_invoice';
    end if;
    v_due := null;
  else
    v_original := null;
    v_event := null;
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Add at least one line.' using errcode = 'check_violation', hint = 'no_lines';
  end if;
  if jsonb_array_length(p_lines) > 200 then
    raise exception 'A document has at most 200 lines.' using errcode = 'check_violation', hint = 'too_many_lines';
  end if;

  if p_doc_id is null then
    insert into public.acc_sales_invoices (org_id, entity_id, kind, customer_id, original_invoice_id, invoice_date, prepared_by)
    values (p_org_id, v_entity, v_kind, v_customer, v_original, v_date, p_user_id)
    returning id into v_id;
  else
    select * into d from public.acc_sales_invoices where id = p_doc_id and org_id = p_org_id for update;
    if not found then
      raise exception 'Document not found.' using errcode = 'no_data_found', hint = 'not_found';
    end if;
    if d.status <> 'draft' then
      raise exception 'Only a draft can be edited.' using errcode = 'check_violation', hint = 'wrong_status';
    end if;
    v_id := d.id;
    delete from public.acc_sales_invoice_lines where invoice_id = v_id;
  end if;

  for it, v_no in select x.value, x.ordinality from jsonb_array_elements(p_lines) with ordinality as x loop
    begin
      v_desc := btrim(coalesce(it ->> 'description', ''));
      v_qty := (it ->> 'quantity')::numeric;
      v_price := (it ->> 'unit_price')::numeric;
      v_disc := coalesce(nullif(it ->> 'discount', '')::numeric, 0);
      v_income := nullif(it ->> 'income_account_id', '')::uuid;
      v_tax := nullif(it ->> 'tax_code_id', '')::uuid;
      v_cc := nullif(it ->> 'cost_centre_id', '')::uuid;
      v_branch := nullif(btrim(coalesce(it ->> 'branch_code', '')), '');
      v_dept := nullif(btrim(coalesce(it ->> 'department', '')), '');
    exception when others then
      raise exception 'Line %: check the numbers.', v_no using errcode = 'check_violation', hint = 'bad_line';
    end;
    if v_desc = '' or char_length(v_desc) > 200 or v_qty is null or v_qty <= 0 or v_qty <> round(v_qty, 3) or v_qty >= 1e9
       or v_price is null or v_price < 0 or v_price <> round(v_price, 2) or v_disc < 0 or v_disc <> round(v_disc, 2)
       or (v_dept is not null and char_length(v_dept) > 60) then
      raise exception 'Line %: check the description, quantity, price and discount.', v_no using errcode = 'check_violation', hint = 'bad_line';
    end if;
    if not exists (select 1 from public.acc_accounts a
                   where a.id = v_income and a.org_id = p_org_id and not a.is_group and a.is_active
                     and a.nature = 'income' and a.control is null
                     and (a.entity_id is null or a.entity_id = v_entity)) then
      raise exception 'Line %: choose an active income ledger.', v_no using errcode = 'check_violation', hint = 'income_account';
    end if;
    select t.rate into v_rate from public.acc_tax_codes t
     where t.id = v_tax and t.org_id = p_org_id and t.active and t.kind in ('standard', 'zero', 'exempt', 'out_of_scope')
       and (t.kind <> 'standard' or t.output_account_id is not null);
    if not found then
      raise exception 'Line %: choose a sales tax code.', v_no using errcode = 'check_violation', hint = 'sales_tax_code';
    end if;
    if v_branch is not null and not exists (select 1 from public.fin_ref_branches b where b.org_id = p_org_id and b.code = v_branch) then
      raise exception 'Line %: unknown branch.', v_no using errcode = 'check_violation', hint = 'branch_unknown';
    end if;
    if v_cc is not null and not exists (select 1 from public.acc_cost_centres cc where cc.id = v_cc and cc.org_id = p_org_id and cc.active) then
      raise exception 'Line %: unknown cost centre.', v_no using errcode = 'check_violation', hint = 'cost_centre';
    end if;
    v_gross := round(v_qty * v_price, 2);
    if v_disc > v_gross then
      raise exception 'Line %: the discount is more than the amount.', v_no using errcode = 'check_violation', hint = 'bad_line';
    end if;
    v_net := v_gross - v_disc;
    v_vat := round(v_net * v_rate / 100, 2);
    insert into public.acc_sales_invoice_lines (org_id, invoice_id, line_no, description, quantity, unit_price, discount,
                                                gross, net, vat_rate, vat_amount, line_total, income_account_id, tax_code_id,
                                                branch_code, department, cost_centre_id)
    values (p_org_id, v_id, v_no, v_desc, v_qty, v_price, v_disc, v_gross, v_net, v_rate, v_vat, v_net + v_vat, v_income,
            v_tax, v_branch, v_dept, v_cc);
    v_sub := v_sub + v_gross;
    v_dsum := v_dsum + v_disc;
    v_nsum := v_nsum + v_net;
    v_vsum := v_vsum + v_vat;
  end loop;
  if v_nsum + v_vsum >= 1e12 then
    raise exception 'The total is too large.' using errcode = 'check_violation', hint = 'bad_line';
  end if;
  if v_expected is null or v_expected <> v_nsum + v_vsum then
    raise exception 'The totals do not match.' using errcode = 'check_violation', hint = 'totals_mismatch';
  end if;

  update public.acc_sales_invoices set
    entity_id = v_entity, kind = v_kind, customer_id = v_customer, original_invoice_id = v_original, invoice_date = v_date,
    supply_date = v_supply, due_date = v_due, event_date = v_event,
    credit_reason = nullif(left(btrim(coalesce(p_header ->> 'credit_reason', '')), 200), ''),
    reference = nullif(left(btrim(coalesce(p_header ->> 'reference', '')), 60), ''),
    notes = nullif(left(btrim(coalesce(p_header ->> 'notes', '')), 500), ''),
    subtotal = v_sub, discount_total = v_dsum, net_total = v_nsum, vat_total = v_vsum, total = v_nsum + v_vsum,
    prepared_by = p_user_id
  where id = v_id;
  update public.acc_sales_invoices set content_sha256 = app.acc_sales_doc_hash(v_id) where id = v_id
  returning * into d;
  return jsonb_build_object('id', d.id, 'sha256', d.content_sha256, 'total', d.total, 'vat_total', d.vat_total);
end;
$$;
revoke all on function public.acc_sales_doc_save(uuid, uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.acc_sales_doc_save(uuid, uuid, uuid, jsonb, jsonb) to service_role;

create or replace function public.acc_sales_doc_discard(p_org_id uuid, p_doc_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.acc_sales_invoices;
begin
  if not app.user_has_perm(p_org_id, p_user_id, 'accounting.sales.manage') then
    raise exception 'You cannot change sales documents.' using errcode = 'check_violation', hint = 'not_permitted';
  end if;
  select * into d from public.acc_sales_invoices where id = p_doc_id and org_id = p_org_id for update;
  if not found then
    raise exception 'Document not found.' using errcode = 'no_data_found', hint = 'not_found';
  end if;
  if d.status <> 'draft' then
    raise exception 'Only a draft can be deleted.' using errcode = 'check_violation', hint = 'wrong_status';
  end if;
  delete from public.acc_sales_invoices where id = d.id;
  return jsonb_build_object('id', d.id, 'deleted', true);
end;
$$;
revoke all on function public.acc_sales_doc_discard(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.acc_sales_doc_discard(uuid, uuid, uuid) to service_role;

-- Issue a checked draft: credit check for a credit note, the form of tax invoice, the due date, the number and the
-- journal. The caller has decided who may issue it (public.acc_sales_doc_issue, acc_sales_invoice_void).
create or replace function app.acc_sales_issue_internal(p_doc_id uuid, p_user_id uuid, p_approved boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.acc_sales_invoices;
  o public.acc_sales_invoices;
  c public.acc_customers;
  st public.acc_ar_settings;
  v_credited numeric;
  v_number text;
  v_posting text;
  v_hash text;
begin
  select * into d from public.acc_sales_invoices where id = p_doc_id for update;
  st := app.acc_ar_settings_of(d.org_id);
  if d.total <= 0 then
    raise exception 'The total must be above zero.' using errcode = 'check_violation', hint = 'zero_total';
  end if;
  select * into c from public.acc_customers where id = d.customer_id;
  if not c.active then
    raise exception 'Choose an active customer.' using errcode = 'check_violation', hint = 'customer_unknown';
  end if;
  if d.kind = 'credit_note' then
    select * into o from public.acc_sales_invoices where id = d.original_invoice_id for update;
    if o.kind <> 'invoice' or o.status not in ('issued', 'part_paid', 'paid') or o.customer_id <> d.customer_id
       or o.entity_id <> d.entity_id then
      raise exception 'A credit note refers to an issued invoice of the same customer that is not void.' using errcode = 'check_violation', hint = 'original_invoice';
    end if;
    if d.invoice_date < o.invoice_date then
      raise exception 'A credit note cannot be dated before its invoice.' using errcode = 'check_violation', hint = 'reversal_before_original';
    end if;
    select coalesce(sum(cn.total), 0) into v_credited from public.acc_sales_invoices cn
     where cn.original_invoice_id = o.id and cn.kind = 'credit_note' and cn.status <> 'draft' and cn.id <> d.id;
    if v_credited + d.total > o.total then
      raise exception 'The credit note is more than what is left to credit.' using errcode = 'check_violation', hint = 'credit_exceeds';
    end if;
  end if;
  v_number := app.acc_ar_next_number(d.org_id, d.entity_id, d.kind, d.invoice_date);
  v_hash := app.acc_sales_doc_hash(d.id);
  update public.acc_sales_invoices set
    status = 'issued', number = v_number, issued_by = p_user_id, issued_at = now(),
    approval_required = p_approved, approved_by = case when p_approved then p_user_id end,
    invoice_form = case when (c.trn is null or btrim(c.trn) = '') and d.total <= st.simplified_invoice_limit
                        then 'simplified' else 'full' end,
    due_date = case when d.kind = 'invoice' then coalesce(d.due_date, d.invoice_date + c.credit_terms_days) end,
    receivable_account_id = case when d.kind = 'credit_note' then o.receivable_account_id
                                 else app.acc_ar_receivable_account(d.org_id, d.customer_id) end,
    content_sha256 = v_hash
  where id = d.id;
  v_posting := app.acc_sales_doc_post(d.id);
  if d.kind = 'credit_note' then
    perform app.acc_ar_refresh_invoice(o.id);
  end if;
  select * into d from public.acc_sales_invoices where id = p_doc_id;
  return jsonb_build_object('id', d.id, 'number', d.number, 'status', d.status, 'total', d.total,
                            'posting_status', v_posting, 'journal_id', d.journal_id, 'invoice_form', d.invoice_form,
                            'sha256', d.content_sha256);
end;
$$;
revoke all on function app.acc_sales_issue_internal(uuid, uuid, boolean) from public, anon, authenticated;

-- Issue a draft. Up to the approval limit: anyone with accounting.sales.manage. Above it: a DIFFERENT person from the
-- preparer, holding accounting.journals.approve, quoting the content hash they reviewed (p_hash). Below the limit p_hash is
-- optional but checked when given.
create or replace function public.acc_sales_doc_issue(p_org_id uuid, p_doc_id uuid, p_user_id uuid, p_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.acc_sales_invoices;
  st public.acc_ar_settings := app.acc_ar_settings_of(p_org_id);
  v_hash text;
  v_approval boolean;
begin
  select * into d from public.acc_sales_invoices where id = p_doc_id and org_id = p_org_id for update;
  if not found then
    raise exception 'Document not found.' using errcode = 'no_data_found', hint = 'not_found';
  end if;
  if d.status <> 'draft' then
    raise exception 'Only a draft is issued.' using errcode = 'check_violation', hint = 'wrong_status';
  end if;
  v_hash := app.acc_sales_doc_hash(d.id);
  if p_hash is not null and p_hash <> v_hash then
    raise exception 'The document changed since you opened it.' using errcode = 'check_violation', hint = 'hash_mismatch';
  end if;
  v_approval := d.total > st.issue_approval_threshold;
  if v_approval then
    if p_user_id is null or p_user_id is not distinct from d.prepared_by
       or not app.user_has_perm(p_org_id, p_user_id, 'accounting.journals.approve') then
      raise exception 'Above the approval limit someone else with the approval permission issues it.' using errcode = 'check_violation', hint = 'approval_required';
    end if;
    if p_hash is null then
      raise exception 'The approver confirms the content they reviewed.' using errcode = 'check_violation', hint = 'hash_mismatch';
    end if;
  elsif not app.user_has_perm(p_org_id, p_user_id, 'accounting.sales.manage') then
    raise exception 'You cannot issue sales documents.' using errcode = 'check_violation', hint = 'not_permitted';
  end if;
  return app.acc_sales_issue_internal(d.id, p_user_id, v_approval);
end;
$$;
revoke all on function public.acc_sales_doc_issue(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.acc_sales_doc_issue(uuid, uuid, uuid, text) to service_role;

-- Void an issued invoice: a credit note for the full amount is created and issued on p_date (it reverses the income, VAT
-- and receivable), and the invoice becomes void. Refused while receipts are allocated to it or another credit note
-- exists. Above the approval limit only someone with accounting.journals.approve may void.
create or replace function public.acc_sales_invoice_void(p_org_id uuid, p_invoice_id uuid, p_user_id uuid, p_date date, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  i public.acc_sales_invoices;
  st public.acc_ar_settings := app.acc_ar_settings_of(p_org_id);
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_cn uuid;
  v_res jsonb;
begin
  select * into i from public.acc_sales_invoices where id = p_invoice_id and org_id = p_org_id for update;
  if not found or i.kind <> 'invoice' then
    raise exception 'Invoice not found.' using errcode = 'no_data_found', hint = 'not_found';
  end if;
  if i.status not in ('issued', 'part_paid', 'paid') then
    raise exception 'Only an issued invoice is voided.' using errcode = 'check_violation', hint = 'wrong_status';
  end if;
  if i.total > st.issue_approval_threshold then
    if not app.user_has_perm(p_org_id, p_user_id, 'accounting.journals.approve') then
      raise exception 'Above the approval limit someone with the approval permission voids it.' using errcode = 'check_violation', hint = 'approval_required';
    end if;
  elsif not app.user_has_perm(p_org_id, p_user_id, 'accounting.sales.manage') then
    raise exception 'You cannot void sales documents.' using errcode = 'check_violation', hint = 'not_permitted';
  end if;
  if v_reason is null or char_length(v_reason) < 3 then
    raise exception 'Say why the invoice is voided.' using errcode = 'check_violation', hint = 'remarks_required';
  end if;
  if p_date is null or p_date < i.invoice_date then
    raise exception 'The void date is on or after the invoice date.' using errcode = 'check_violation', hint = 'reversal_before_original';
  end if;
  if exists (select 1 from public.acc_allocations a join public.acc_receipts r on r.id = a.receipt_id
             where a.invoice_id = i.id and r.status = 'active') then
    raise exception 'Receipts are allocated to this invoice.' using errcode = 'check_violation', hint = 'has_receipts';
  end if;
  if exists (select 1 from public.acc_sales_invoices cn where cn.original_invoice_id = i.id and cn.status <> 'draft') then
    raise exception 'Credit notes already exist for this invoice.' using errcode = 'check_violation', hint = 'has_credit_notes';
  end if;

  insert into public.acc_sales_invoices (org_id, entity_id, kind, customer_id, original_invoice_id, invoice_date, event_date,
                                         credit_reason, reference, prepared_by, subtotal, discount_total, net_total,
                                         vat_total, total)
  values (i.org_id, i.entity_id, 'credit_note', i.customer_id, i.id, p_date, p_date, left('Void: ' || v_reason, 200),
          i.reference, p_user_id, i.subtotal, i.discount_total, i.net_total, i.vat_total, i.total)
  returning id into v_cn;
  insert into public.acc_sales_invoice_lines (org_id, invoice_id, line_no, description, quantity, unit_price, discount, gross,
                                              net, vat_rate, vat_amount, line_total, income_account_id, tax_code_id,
                                              branch_code, department, cost_centre_id)
  select l.org_id, v_cn, l.line_no, l.description, l.quantity, l.unit_price, l.discount, l.gross, l.net, l.vat_rate,
         l.vat_amount, l.line_total, l.income_account_id, l.tax_code_id, l.branch_code, l.department, l.cost_centre_id
  from public.acc_sales_invoice_lines l where l.invoice_id = i.id;
  v_res := app.acc_sales_issue_internal(v_cn, p_user_id, false);
  update public.acc_sales_invoices set status = 'void', voided_by = p_user_id, voided_at = now(),
    void_reason = left(v_reason, 200), void_credit_note_id = v_cn
  where id = i.id;
  return jsonb_build_object('id', i.id, 'status', 'void', 'credit_note_id', v_cn, 'credit_note_number', v_res ->> 'number',
                            'posting_status', v_res ->> 'posting_status');
end;
$$;
revoke all on function public.acc_sales_invoice_void(uuid, uuid, uuid, date, text) from public, anon, authenticated;
grant execute on function public.acc_sales_invoice_void(uuid, uuid, uuid, date, text) to service_role;

-- ---------------------------------------------------------------------------
-- 9. Receipts and allocations
-- ---------------------------------------------------------------------------
-- Replace a receipt's allocations. p_allocations null = oldest invoice first (by date, then number) up to the receipt;
-- otherwise [{ invoice_id, amount }] exactly as given (an empty array = all on account).
create or replace function app.acc_receipt_allocate_internal(p_receipt_id uuid, p_user_id uuid, p_allocations jsonb)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.acc_receipts;
  v_touched uuid[];
  v_left numeric;
  v_open numeric;
  v_take numeric;
  v_amount numeric;
  v_inv uuid;
  v_total numeric := 0;
  inv record;
  it jsonb;
begin
  select * into r from public.acc_receipts where id = p_receipt_id for update;
  if r.status <> 'active' then
    raise exception 'A void receipt is not allocated.' using errcode = 'check_violation', hint = 'wrong_status';
  end if;
  select coalesce(array_agg(a.invoice_id), '{}') into v_touched from public.acc_allocations a where a.receipt_id = r.id;
  delete from public.acc_allocations where receipt_id = r.id;

  if p_allocations is null then
    v_left := r.amount;
    for inv in
      select i.id from public.acc_sales_invoices i
      where i.org_id = r.org_id and i.customer_id = r.customer_id and i.entity_id = r.entity_id and i.kind = 'invoice'
        and i.status in ('issued', 'part_paid') and i.receivable_account_id = r.receivable_account_id
      order by i.invoice_date, i.number
      for update
    loop
      exit when v_left <= 0;
      v_open := app.acc_ar_invoice_open(inv.id, null);
      v_take := least(v_left, v_open);
      if v_take > 0 then
        insert into public.acc_allocations (org_id, receipt_id, invoice_id, amount, allocated_by)
        values (r.org_id, r.id, inv.id, v_take, p_user_id);
        v_left := v_left - v_take;
        v_total := v_total + v_take;
        v_touched := array_append(v_touched, inv.id);
      end if;
    end loop;
  else
    if jsonb_typeof(p_allocations) <> 'array' or jsonb_array_length(p_allocations) > 500 then
      raise exception 'The allocations are not readable.' using errcode = 'check_violation', hint = 'invalid';
    end if;
    for it in select x.value from jsonb_array_elements(p_allocations) as x loop
      begin
        v_inv := (it ->> 'invoice_id')::uuid;
        v_amount := (it ->> 'amount')::numeric;
      exception when others then
        raise exception 'An allocation is not readable.' using errcode = 'check_violation', hint = 'invalid';
      end;
      if v_amount is null or v_amount <= 0 or v_amount <> round(v_amount, 2) then
        raise exception 'Allocations are positive with at most two decimals.' using errcode = 'check_violation', hint = 'bad_amount';
      end if;
      perform 1 from public.acc_sales_invoices i
       where i.id = v_inv and i.org_id = r.org_id and i.customer_id = r.customer_id and i.entity_id = r.entity_id
         and i.kind = 'invoice' and i.status in ('issued', 'part_paid', 'paid')
         and i.receivable_account_id = r.receivable_account_id
       for update;
      if not found then
        raise exception 'Allocate only to this customer''s issued invoices.' using errcode = 'check_violation', hint = 'allocation_customer';
      end if;
      if exists (select 1 from public.acc_allocations a where a.receipt_id = r.id and a.invoice_id = v_inv) then
        raise exception 'An invoice appears twice.' using errcode = 'check_violation', hint = 'invalid';
      end if;
      v_open := app.acc_ar_invoice_open(v_inv, r.id);
      if v_amount > v_open then
        raise exception 'An allocation is more than the invoice''s open amount.' using errcode = 'check_violation', hint = 'allocation_exceeds';
      end if;
      insert into public.acc_allocations (org_id, receipt_id, invoice_id, amount, allocated_by)
      values (r.org_id, r.id, v_inv, v_amount, p_user_id);
      v_total := v_total + v_amount;
      v_touched := array_append(v_touched, v_inv);
    end loop;
    if v_total > r.amount then
      raise exception 'The allocations add up to more than the receipt.' using errcode = 'check_violation', hint = 'over_allocated';
    end if;
  end if;

  update public.acc_receipts set amount_allocated = v_total where id = r.id;
  for v_inv in select distinct x from unnest(v_touched) as x loop
    perform app.acc_ar_refresh_invoice(v_inv);
  end loop;
  return v_total;
end;
$$;
revoke all on function app.acc_receipt_allocate_internal(uuid, uuid, jsonb) from public, anon, authenticated;

-- Record a receipt and post it (Dr bank / cash / clearing, Cr the customer's receivable), then allocate it.
-- p_receipt: { customer_id, entity_id?, receipt_date, account_id, amount, mode, reference?, notes? }.
create or replace function public.acc_receipt_save(p_org_id uuid, p_user_id uuid, p_receipt jsonb, p_allocations jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer uuid;
  v_entity uuid;
  v_account uuid;
  v_date date;
  v_amount numeric;
  v_mode text := coalesce(p_receipt ->> 'mode', '');
  v_id uuid;
  v_number text;
  v_posting text;
  v_alloc numeric;
begin
  if not app.user_has_perm(p_org_id, p_user_id, 'accounting.receipts.manage') then
    raise exception 'You cannot record receipts.' using errcode = 'check_violation', hint = 'not_permitted';
  end if;
  begin
    v_customer := nullif(p_receipt ->> 'customer_id', '')::uuid;
    v_entity := nullif(p_receipt ->> 'entity_id', '')::uuid;
    v_account := nullif(p_receipt ->> 'account_id', '')::uuid;
    v_date := nullif(p_receipt ->> 'receipt_date', '')::date;
    v_amount := nullif(p_receipt ->> 'amount', '')::numeric;
  exception when others then
    raise exception 'Check the date and amount.' using errcode = 'check_violation', hint = 'invalid';
  end;
  if v_date is null or v_date < date '2000-01-01' or v_date > date '2999-12-01'
     or v_mode not in ('bank_transfer', 'cheque', 'card', 'cash', 'other') then
    raise exception 'Enter a valid date and mode.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  if v_amount is null or v_amount <= 0 or v_amount <> round(v_amount, 2) or v_amount >= 1e12 then
    raise exception 'Amounts are positive with at most two decimals.' using errcode = 'check_violation', hint = 'bad_amount';
  end if;
  if not exists (select 1 from public.acc_customers c where c.id = v_customer and c.org_id = p_org_id and c.active) then
    raise exception 'Choose an active customer.' using errcode = 'check_violation', hint = 'customer_unknown';
  end if;
  if v_entity is null then
    select e.id into v_entity from public.acc_entities e where e.org_id = p_org_id and e.is_default;
  end if;
  if not exists (select 1 from public.acc_entities e where e.id = v_entity and e.org_id = p_org_id and e.active) then
    raise exception 'Entity not found.' using errcode = 'check_violation', hint = 'entity_unknown';
  end if;
  if not exists (select 1 from public.acc_accounts a
                 where a.id = v_account and a.org_id = p_org_id and not a.is_group and a.is_active
                   and a.control in ('bank', 'cash', 'clearing') and (a.entity_id is null or a.entity_id = v_entity)) then
    raise exception 'Choose a bank, cash or clearing ledger.' using errcode = 'check_violation', hint = 'receipt_account';
  end if;
  v_number := app.acc_ar_next_number(p_org_id, v_entity, 'receipt', v_date);
  insert into public.acc_receipts (org_id, entity_id, customer_id, number, receipt_date, account_id, receivable_account_id,
                                   amount, mode, reference, notes, prepared_by)
  values (p_org_id, v_entity, v_customer, v_number, v_date, v_account, app.acc_ar_receivable_account(p_org_id, v_customer),
          v_amount, v_mode, nullif(left(btrim(coalesce(p_receipt ->> 'reference', '')), 60), ''),
          nullif(left(btrim(coalesce(p_receipt ->> 'notes', '')), 300), ''), p_user_id)
  returning id into v_id;
  v_posting := app.acc_receipt_post(v_id);
  v_alloc := app.acc_receipt_allocate_internal(v_id, p_user_id, p_allocations);
  return jsonb_build_object('id', v_id, 'number', v_number, 'posting_status', v_posting, 'allocated', v_alloc,
                            'unallocated', v_amount - v_alloc);
end;
$$;
revoke all on function public.acc_receipt_save(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.acc_receipt_save(uuid, uuid, jsonb, jsonb) to service_role;

create or replace function public.acc_receipt_allocate(p_org_id uuid, p_receipt_id uuid, p_user_id uuid, p_allocations jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.acc_receipts;
  v_alloc numeric;
begin
  if not app.user_has_perm(p_org_id, p_user_id, 'accounting.receipts.manage') then
    raise exception 'You cannot allocate receipts.' using errcode = 'check_violation', hint = 'not_permitted';
  end if;
  select * into r from public.acc_receipts where id = p_receipt_id and org_id = p_org_id;
  if not found then
    raise exception 'Receipt not found.' using errcode = 'no_data_found', hint = 'not_found';
  end if;
  v_alloc := app.acc_receipt_allocate_internal(r.id, p_user_id, p_allocations);
  return jsonb_build_object('id', r.id, 'allocated', v_alloc, 'unallocated', r.amount - v_alloc);
end;
$$;
revoke all on function public.acc_receipt_allocate(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.acc_receipt_allocate(uuid, uuid, uuid, jsonb) to service_role;

-- Void a receipt: its allocations go, its journal is reversed (dated the later of p_date and the receipt date) and the
-- invoices it paid are open again.
create or replace function public.acc_receipt_void(p_org_id uuid, p_receipt_id uuid, p_user_id uuid, p_date date, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.acc_receipts;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_touched uuid[];
  v_inv uuid;
  v_rev jsonb;
begin
  if not app.user_has_perm(p_org_id, p_user_id, 'accounting.receipts.manage') then
    raise exception 'You cannot void receipts.' using errcode = 'check_violation', hint = 'not_permitted';
  end if;
  select * into r from public.acc_receipts where id = p_receipt_id and org_id = p_org_id for update;
  if not found then
    raise exception 'Receipt not found.' using errcode = 'no_data_found', hint = 'not_found';
  end if;
  if r.status <> 'active' then
    raise exception 'This receipt is already void.' using errcode = 'check_violation', hint = 'wrong_status';
  end if;
  if v_reason is null or char_length(v_reason) < 3 then
    raise exception 'Say why the receipt is voided.' using errcode = 'check_violation', hint = 'remarks_required';
  end if;
  select coalesce(array_agg(a.invoice_id), '{}') into v_touched from public.acc_allocations a where a.receipt_id = r.id;
  delete from public.acc_allocations where receipt_id = r.id;
  if r.journal_id is not null then
    v_rev := app.acc_reverse_internal(p_org_id, r.journal_id, p_user_id, greatest(coalesce(p_date, r.receipt_date), r.receipt_date),
                                      'receipt ' || r.number || ' void: ' || v_reason);
  end if;
  update public.acc_receipts set status = 'void', amount_allocated = 0, voided_by = p_user_id, voided_at = now(),
    void_reason = left(v_reason, 200)
  where id = r.id;
  foreach v_inv in array v_touched loop
    perform app.acc_ar_refresh_invoice(v_inv);
  end loop;
  return jsonb_build_object('id', r.id, 'status', 'void', 'reversal_id', v_rev ->> 'id', 'reversal_number', v_rev ->> 'number');
end;
$$;
revoke all on function public.acc_receipt_void(uuid, uuid, uuid, date, text) from public, anon, authenticated;
grant execute on function public.acc_receipt_void(uuid, uuid, uuid, date, text) to service_role;

-- Post the documents still waiting for the ledger start (each on its own: one refusal does not stop the others).
create or replace function public.acc_ar_retry_postings(p_org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  x record;
  v text;
  v_posted integer := 0;
  v_waiting integer := 0;
  v_failed integer := 0;
begin
  for x in
    select 'doc' as k, d.id, d.invoice_date as dt, d.number from public.acc_sales_invoices d
     where d.org_id = p_org_id and d.status <> 'draft' and d.posting_status = 'waiting_ledger_start'
    union all
    select 'receipt', r.id, r.receipt_date, r.number from public.acc_receipts r
     where r.org_id = p_org_id and r.status = 'active' and r.posting_status = 'waiting_ledger_start'
    order by 3, 4
  loop
    begin
      v := case when x.k = 'doc' then app.acc_sales_doc_post(x.id) else app.acc_receipt_post(x.id) end;
      if v = 'posted' then v_posted := v_posted + 1; else v_waiting := v_waiting + 1; end if;
    exception when others then
      v_failed := v_failed + 1;
    end;
  end loop;
  return jsonb_build_object('posted', v_posted, 'waiting', v_waiting, 'failed', v_failed);
end;
$$;
revoke all on function public.acc_ar_retry_postings(uuid) from public, anon, authenticated;
grant execute on function public.acc_ar_retry_postings(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 10. Reports: open items (ageing, balance confirmation) and the customer statement
-- ---------------------------------------------------------------------------
-- As at p_as_of: every issued invoice dated on or before it with what was still open (total - credit notes dated on or
-- before it - allocations from active receipts dated on or before it), and every active receipt's unallocated part.
create or replace function public.acc_ar_open_items(p_org_id uuid, p_customer_id uuid, p_as_of date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with inv as (
    select i.id, i.customer_id, i.number, i.invoice_date, i.due_date, i.total, i.reference,
           i.total
           - coalesce((select sum(cn.total) from public.acc_sales_invoices cn
                       where cn.original_invoice_id = i.id and cn.kind = 'credit_note' and cn.status <> 'draft'
                         and cn.invoice_date <= p_as_of), 0)
           - coalesce((select sum(a.amount) from public.acc_allocations a join public.acc_receipts r on r.id = a.receipt_id
                       where a.invoice_id = i.id and r.status = 'active' and r.receipt_date <= p_as_of), 0) as open
    from public.acc_sales_invoices i
    where i.org_id = p_org_id and i.kind = 'invoice' and i.status <> 'draft' and i.invoice_date <= p_as_of
      and (p_customer_id is null or i.customer_id = p_customer_id)
  ), rec as (
    select r.id, r.customer_id, r.number, r.receipt_date, r.reference,
           r.amount - coalesce((select sum(a.amount) from public.acc_allocations a
                                join public.acc_sales_invoices i on i.id = a.invoice_id
                                where a.receipt_id = r.id and i.invoice_date <= p_as_of), 0) as unallocated
    from public.acc_receipts r
    where r.org_id = p_org_id and r.status = 'active' and r.receipt_date <= p_as_of
      and (p_customer_id is null or r.customer_id = p_customer_id)
  )
  select jsonb_build_object(
    'as_of', p_as_of,
    'invoices', coalesce((select jsonb_agg(jsonb_build_object(
        'id', inv.id, 'customer_id', inv.customer_id, 'number', inv.number, 'invoice_date', inv.invoice_date,
        'due_date', inv.due_date, 'total', inv.total, 'open', inv.open, 'reference', inv.reference)
        order by inv.invoice_date, inv.number) from inv where inv.open <> 0), '[]'::jsonb),
    'on_account', coalesce((select jsonb_agg(jsonb_build_object(
        'id', rec.id, 'customer_id', rec.customer_id, 'number', rec.number, 'receipt_date', rec.receipt_date,
        'unallocated', rec.unallocated, 'reference', rec.reference)
        order by rec.receipt_date, rec.number) from rec where rec.unallocated > 0), '[]'::jsonb));
$$;
revoke all on function public.acc_ar_open_items(uuid, uuid, date) from public, anon, authenticated;
grant execute on function public.acc_ar_open_items(uuid, uuid, date) to service_role;

-- A customer's statement for a date range: the opening balance (everything before p_from) and each invoice (debit),
-- credit note and receipt (credit) in the range. Void documents stay on it with the credit note that voided them; void
-- receipts are left out (their journal and its reversal net to nothing).
create or replace function public.acc_ar_statement(p_org_id uuid, p_customer_id uuid, p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with docs as (
    select d.invoice_date as dt, d.kind, d.number, d.reference,
           case when d.kind = 'invoice' then d.total else 0 end as debit,
           case when d.kind = 'credit_note' then d.total else 0 end as credit
    from public.acc_sales_invoices d
    where d.org_id = p_org_id and d.customer_id = p_customer_id and d.status <> 'draft'
    union all
    select r.receipt_date, 'receipt', r.number, r.reference, 0, r.amount
    from public.acc_receipts r
    where r.org_id = p_org_id and r.customer_id = p_customer_id and r.status = 'active'
  )
  select jsonb_build_object(
    'customer_id', p_customer_id, 'from', p_from, 'to', p_to,
    'opening', coalesce((select sum(debit - credit) from docs where dt < p_from), 0),
    'entries', coalesce((select jsonb_agg(jsonb_build_object('date', dt, 'kind', kind, 'number', number,
                                                             'reference', reference, 'debit', debit, 'credit', credit)
                                          order by dt, number)
                         from docs where dt between p_from and p_to), '[]'::jsonb));
$$;
revoke all on function public.acc_ar_statement(uuid, uuid, date, date) from public, anon, authenticated;
grant execute on function public.acc_ar_statement(uuid, uuid, date, date) to service_role;

-- ---------------------------------------------------------------------------
-- 11. Who changed it (record_history on invoices and receipts) and who opened it (the access log learns receivables)
-- ---------------------------------------------------------------------------
select app.enable_record_history('acc_sales_invoices');
select app.enable_record_history('acc_receipts');

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
    when 'acc_sales_invoices' then app.acc_can_read_receivables(p_org_id)
    when 'acc_receipts' then app.acc_can_read_receivables(p_org_id)
    else exists (
      select 1 from public.portal_objects po
      where po.org_id = p_org_id and po.table_name = p_table and app.has_perm_wild(p_org_id, po.read_perm)
    )
  end;
$$;
grant execute on function app.can_view_record_history(uuid, text) to authenticated, service_role;

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
                                   'appointment', 'portal_record', 'export', 'activity_log', 'finance_document',
                                   'accounting_journal']);
  if not ('accounting_receivable' = any (v_list)) then
    v_list := array_append(v_list, 'accounting_receivable');
  end if;
  execute format('alter table public.record_access_log add constraint record_access_log_entity_check check (entity in (%s))',
    (select string_agg(quote_literal(x), ', ' order by x) from unnest(v_list) as x));
end $$;

-- ---------------------------------------------------------------------------
-- 12. Every existing workspace gets its receivable ledger, rental income ledger and settings now
-- ---------------------------------------------------------------------------
select public.acc_seed_receivables(id) from public.orgs;
