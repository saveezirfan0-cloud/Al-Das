-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. Safe to stop between files.

-- ======================================================================
-- 20261009000100_finance_raw.sql
-- ======================================================================
-- Finance F1 / 1: raw capture tables, capture settings and the single-consumer lease.
--
-- The Unite Finance API is sync-once: every call permanently dequeues records
-- (CLAUDE.md rule 7). Raw payloads are therefore stored BEFORE any parsing and
-- are the only copy of the data until processing succeeds. These tables are
-- infrastructure tables like job_runs: RLS is enabled with NO policies, so only
-- the service role (server code after can() checks) can read or write them.
-- The payload holds full patient PII; it is never selected by the app UI.

create table public.fin_raw_unite_batches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  requested_at timestamptz not null default now(),
  from_date date not null,
  to_date date not null,
  count_requested integer not null check (count_requested > 0),
  http_status integer,
  message_status text,
  detail_message text,
  balance_in_range integer,                           -- DataBalancetoSync
  balance_overall integer,                            -- OverallDataBalancetoSync
  record_count integer,                               -- number of elements in payload.Data
  payload jsonb,                                      -- full response, PII included; stripped later
  payload_sha256 text,
  payload_stripped_at timestamptz,                    -- set when PII keys were removed (replay still works)
  process_status text not null default 'received'
    check (process_status in ('received', 'processed', 'failed')),
  processed_at timestamptz,
  process_counts jsonb not null default '{}'::jsonb,  -- per-table counts written by fin_process_batch
  error text,
  created_at timestamptz not null default now(),
  check (to_date >= from_date)
);
create index fin_raw_unite_batches_org_requested_idx on public.fin_raw_unite_batches (org_id, requested_at desc);
create index fin_raw_unite_batches_pending_idx on public.fin_raw_unite_batches (org_id, process_status)
  where process_status <> 'processed';

create table public.fin_raw_diligence_files (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  storage_path text not null,                         -- private Storage bucket
  file_name text,
  file_sha256 text not null,                          -- blocks duplicate uploads
  uploaded_by uuid references public.profiles (id) on delete set null,
  uploaded_at timestamptz not null default now(),
  row_count integer,
  sum_net numeric(16, 2),
  sum_remitted numeric(16, 2),
  sum_rejected numeric(16, 2),
  header_check jsonb not null default '{}'::jsonb,    -- missing / extra headers
  status text not null default 'validated'
    check (status in ('validated', 'committed', 'rejected')),
  errors jsonb not null default '[]'::jsonb,
  committed_at timestamptz,
  unique (org_id, file_sha256)
);
create index fin_raw_diligence_files_org_uploaded_idx on public.fin_raw_diligence_files (org_id, uploaded_at desc);

-- Per-org capture configuration. `enabled` defaults to FALSE: nothing may call
-- the Unite Finance API until an admin switches it on after the Phase F0 checks.
create table public.fin_capture_settings (
  org_id uuid primary key references public.orgs (id) on delete cascade,
  enabled boolean not null default false,
  batch_size integer not null default 50 check (batch_size between 1 and 500),
  window_from date not null default date '2026-01-01',   -- every pull uses window_from -> today
  max_batches_per_run integer not null default 10 check (max_batches_per_run between 1 and 100),
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger fin_capture_settings_set_updated_at before update on public.fin_capture_settings
  for each row execute function app.set_updated_at();

-- One consumer only: the capture job claims this lease before calling Unite.
-- (Session-level advisory locks do not survive pooled connections.)
create table public.fin_capture_lease (
  org_id uuid primary key references public.orgs (id) on delete cascade,
  holder text not null,
  leased_until timestamptz not null
);

alter table public.fin_raw_unite_batches enable row level security;
alter table public.fin_raw_diligence_files enable row level security;
alter table public.fin_capture_settings enable row level security;
alter table public.fin_capture_lease enable row level security;
-- No policies on purpose: service role only.

-- Atomically claim the lease. Returns true when this holder now owns it.
create or replace function public.fin_capture_try_lease(p_org_id uuid, p_holder text, p_ttl_seconds integer default 300)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_holder text;
begin
  insert into public.fin_capture_lease (org_id, holder, leased_until)
  values (p_org_id, p_holder, now() + make_interval(secs => greatest(p_ttl_seconds, 1)))
  on conflict (org_id) do update
    set holder = excluded.holder, leased_until = excluded.leased_until
    where public.fin_capture_lease.leased_until < now()
       or public.fin_capture_lease.holder = excluded.holder
  returning holder into v_holder;
  return v_holder is not null;
end;
$$;

create or replace function public.fin_capture_release_lease(p_org_id uuid, p_holder text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.fin_capture_lease set leased_until = now() - interval '1 second'
  where org_id = p_org_id and holder = p_holder;
$$;

revoke all on function public.fin_capture_try_lease(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.fin_capture_release_lease(uuid, text) from public, anon, authenticated;
grant execute on function public.fin_capture_try_lease(uuid, text, integer) to service_role;
grant execute on function public.fin_capture_release_lease(uuid, text) to service_role;

-- ======================================================================
-- 20261009000200_finance_ref.sql
-- ======================================================================
-- Finance F1 / 2: reference data maintained by admins in the portal, plus the
-- permission helper used by every finance policy.

-- Which permission lets a member see an exception, by the role that owns it.
create or replace function app.fin_owner_perm(p_owner_role text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_owner_role
    when 'insurance' then 'finance.claims.view'
    when 'billing'   then 'finance.invoices.view'
    when 'finance'   then 'finance.view'
    else 'finance.capture.manage'                    -- 'admin' and anything unknown fail towards admins
  end;
$$;

create table public.fin_ref_branches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9]{1,4}$'),
  name text not null,
  unite_clinic_long_name text,                        -- confirm exact names from the first full pull
  unite_clinic_short_name text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, code)
);
create unique index fin_ref_branches_clinic_uidx on public.fin_ref_branches (org_id, unite_clinic_long_name)
  where unite_clinic_long_name is not null;

create table public.fin_ref_doctors (
  org_id uuid not null references public.orgs (id) on delete cascade,
  dha_id text not null,
  name text,
  department text,
  specialty text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, dha_id)
);

create table public.fin_ref_services (
  org_id uuid not null references public.orgs (id) on delete cascade,
  item_code text not null,                            -- Unite ItemCode (internal codes such as T-100007 are not CPT)
  cpt_code text,
  description text,
  item_type text,
  service_category text not null default 'Unmapped',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, item_code)
);
create index fin_ref_services_unmapped_idx on public.fin_ref_services (org_id) where service_category = 'Unmapped';

create table public.fin_ref_payers (
  org_id uuid not null references public.orgs (id) on delete cascade,
  payer_id text not null,
  payer_name text,
  receiver_id text,
  receiver_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, payer_id)
);

create table public.fin_ref_exception_rules (
  org_id uuid not null references public.orgs (id) on delete cascade,
  rule_code text not null check (rule_code ~ '^E[0-9]{2}$'),
  description text not null,
  owner_role text not null check (owner_role in ('insurance', 'billing', 'finance', 'admin')),
  threshold_days integer check (threshold_days is null or threshold_days >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, rule_code)
);

create trigger fin_ref_branches_set_updated_at before update on public.fin_ref_branches for each row execute function app.set_updated_at();
create trigger fin_ref_doctors_set_updated_at before update on public.fin_ref_doctors for each row execute function app.set_updated_at();
create trigger fin_ref_services_set_updated_at before update on public.fin_ref_services for each row execute function app.set_updated_at();
create trigger fin_ref_payers_set_updated_at before update on public.fin_ref_payers for each row execute function app.set_updated_at();
create trigger fin_ref_exception_rules_set_updated_at before update on public.fin_ref_exception_rules for each row execute function app.set_updated_at();

-- RLS: org members with a finance permission read; finance.reference.manage writes.
alter table public.fin_ref_branches enable row level security;
alter table public.fin_ref_doctors enable row level security;
alter table public.fin_ref_services enable row level security;
alter table public.fin_ref_payers enable row level security;
alter table public.fin_ref_exception_rules enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['fin_ref_branches', 'fin_ref_doctors', 'fin_ref_services', 'fin_ref_payers', 'fin_ref_exception_rules'] loop
    execute format($f$create policy %1$s_select on public.%1$s for select to authenticated
      using (app.has_perm(org_id, 'finance.view') or app.has_perm(org_id, 'finance.invoices.view')
          or app.has_perm(org_id, 'finance.claims.view') or app.has_perm(org_id, 'finance.reference.manage')
          or app.has_perm(org_id, 'finance.capture.manage'))$f$, t);
    execute format($f$create policy %1$s_insert on public.%1$s for insert to authenticated
      with check (app.has_perm(org_id, 'finance.reference.manage'))$f$, t);
    execute format($f$create policy %1$s_update on public.%1$s for update to authenticated
      using (app.has_perm(org_id, 'finance.reference.manage'))
      with check (app.has_perm(org_id, 'finance.reference.manage'))$f$, t);
    execute format($f$create policy %1$s_delete on public.%1$s for delete to authenticated
      using (app.has_perm(org_id, 'finance.reference.manage'))$f$, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Per-org seed: branches, exception rules, capture settings (disabled).
-- Idempotent; never overwrites admin edits. Runs for every new org via trigger
-- and is back-filled for existing orgs below.
-- ---------------------------------------------------------------------------

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
    (p_org_id, 'E10', 'Diligence file failed validation',                                              'insurance', null)
  on conflict (org_id, rule_code) do nothing;

  insert into public.fin_capture_settings (org_id) values (p_org_id)
  on conflict (org_id) do nothing;
end;
$$;
revoke all on function public.seed_finance_reference(uuid) from public, anon, authenticated;
grant execute on function public.seed_finance_reference(uuid) to service_role;

create or replace function app.seed_finance_on_org_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.seed_finance_reference(new.id);
  return new;
end;
$$;
create trigger orgs_seed_finance after insert on public.orgs
  for each row execute function app.seed_finance_on_org_insert();

select public.seed_finance_reference(id) from public.orgs;

-- ---------------------------------------------------------------------------
-- Adds finance role presets to an existing org (new orgs get them from the
-- app's SYSTEM_ROLES). p_roles: [{name, description, permissions[]}].
-- Existing roles with the same name are left untouched.
-- ---------------------------------------------------------------------------
create or replace function public.seed_finance_roles(p_org_id uuid, p_roles jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r jsonb;
  v_added integer := 0;
begin
  if jsonb_typeof(p_roles) <> 'array' then
    raise exception 'p_roles must be an array' using errcode = 'check_violation';
  end if;
  for r in select * from jsonb_array_elements(p_roles) loop
    insert into public.roles (org_id, name, description, permissions, is_system)
    values (p_org_id, r ->> 'name', r ->> 'description', coalesce(r -> 'permissions', '[]'::jsonb), true)
    on conflict (org_id, name) do nothing;
    if found then v_added := v_added + 1; end if;
  end loop;
  return v_added;
end;
$$;
revoke all on function public.seed_finance_roles(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.seed_finance_roles(uuid, jsonb) to service_role;

-- ======================================================================
-- 20261009000300_finance_core.sql
-- ======================================================================
-- Finance F1 / 3: invoices, lines, payments, insurance claim activities, exceptions.
--
-- Only the Unite patient PIN is stored here. Names, DOB, contacts and Emirates
-- ID stay in the raw payload (service role only). All tables are written by the
-- capture / import jobs (service role); staff only read, except exceptions.

-- ---------------------------------------------------------------------------
-- Invoices (current state) + one row per delivery
-- ---------------------------------------------------------------------------

create table public.fin_invoices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  inv_display_number text not null,
  inv_key text generated always as (upper(regexp_replace(inv_display_number, '\s+', '', 'g'))) stored,
  ref_type text,
  transaction_date date,
  patient_pin text,                                   -- Unite PIN; joins to contacts.external_id
  appointment_id text,                                -- empty for direct invoices (valid)
  branch_code text,                                   -- derived from fin_ref_branches; null = unknown clinic (E07)
  unite_clinic_long_name text,
  unite_bu_short_name text,
  doctor_dha_id text,
  doctor_name text,
  department text,
  specialty text,
  inv_type text,                                      -- SELF PAID / INSURANCE / ...
  is_package boolean not null default false,
  is_deleted boolean not null default false,
  gross numeric(14, 2),
  discount numeric(14, 2),
  net numeric(14, 2),
  vat_applicable boolean,
  vat numeric(14, 2),
  total numeric(14, 2),
  write_off numeric(14, 2),
  credit_note numeric(14, 2),
  referral_doctor text,
  referral_doctor_id text,
  referral_clinic text,
  referral_clinic_id text,
  created_by text,
  modified_by text,
  version integer not null default 1,
  record_hash text not null,                          -- hash of the delivered record; version bumps only on change
  first_received_at timestamptz not null default now(),
  last_received_at timestamptz not null default now(),
  last_batch_id uuid references public.fin_raw_unite_batches (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, inv_display_number)
);
create index fin_invoices_org_date_idx on public.fin_invoices (org_id, transaction_date desc);
create index fin_invoices_org_key_idx on public.fin_invoices (org_id, inv_key);
create index fin_invoices_org_pin_idx on public.fin_invoices (org_id, patient_pin) where patient_pin is not null;
create index fin_invoices_org_appt_idx on public.fin_invoices (org_id, appointment_id) where appointment_id is not null;
create index fin_invoices_org_branch_idx on public.fin_invoices (org_id, branch_code, transaction_date);

create table public.fin_invoice_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  invoice_id uuid not null references public.fin_invoices (id) on delete cascade,
  version integer not null,
  batch_id uuid references public.fin_raw_unite_batches (id) on delete set null,
  received_at timestamptz not null default now(),
  record jsonb not null,                              -- PII stripped before insert
  unique (invoice_id, batch_id)
);
create index fin_invoice_versions_invoice_idx on public.fin_invoice_versions (invoice_id, version desc);

-- line_key = inv_display_number|item_code|occurrence (Unite has no line id).
-- Lines are never deleted: claim matches reference them. Lines missing from a
-- re-delivery are flagged is_current = false.
create table public.fin_invoice_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  invoice_id uuid not null references public.fin_invoices (id) on delete cascade,
  line_key text not null,
  position integer not null,
  item_code text,
  cpt_code text,
  item_short_desc text,
  item_type text,
  qty numeric(12, 3),
  line_price numeric(14, 2),
  line_gross numeric(14, 2),
  line_discount numeric(14, 2),
  line_net numeric(14, 2),
  vat_applicable boolean,
  vat numeric(14, 2),
  total numeric(14, 2),
  line_remarks text,                                  -- e.g. 'COPAY AMOUNT'
  is_package_item boolean not null default false,
  actual_cost_price numeric(14, 2),                   -- 0 today; costs come from Finance later
  is_current boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, line_key)
);
create index fin_invoice_lines_invoice_idx on public.fin_invoice_lines (invoice_id) where is_current;
create index fin_invoice_lines_item_idx on public.fin_invoice_lines (org_id, item_code);

create table public.fin_payments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  invoice_id uuid not null references public.fin_invoices (id) on delete cascade,
  payment_key text not null,                          -- inv_display_number|instalment|receipt_number
  instalment text,
  payment_mode text,
  collected numeric(14, 2),
  paid numeric(14, 2),
  paid_date date,
  returned numeric(14, 2),
  receipt_number text,
  advance_added numeric(14, 2),
  refund numeric(14, 2),
  refund_date date,
  txn_ref_no text,
  txn_ref_name text,
  card_type text,
  surcharge numeric(14, 2),
  remarks text,
  is_current boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, payment_key)
);
create index fin_payments_invoice_idx on public.fin_payments (invoice_id) where is_current;
create index fin_payments_org_paid_idx on public.fin_payments (org_id, paid_date);

-- ---------------------------------------------------------------------------
-- Insurance claim activities (Diligence), current state + history
-- Not imported: EmiratesIDNumber, MemberID, ResubmissionComment, RemittanceComment.
-- ---------------------------------------------------------------------------

create table public.ins_claim_activities (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  claim_activity_number text not null,
  invoice_no text,
  matched_invoice_id uuid references public.fin_invoices (id) on delete set null,
  matched_line_id uuid references public.fin_invoice_lines (id) on delete set null,
  match_status text not null default 'unmatched' check (match_status in ('matched', 'ambiguous', 'unmatched')),
  transaction_date date,
  activity_start_date date,
  encounter_type text,
  cpt_code text,
  cpt_category text,
  cpt_type text,
  quantity numeric(12, 3),
  ordering_clinician_id text,
  clinician_id text,
  receiver_id text,
  payer_id text,
  prior_auth_id text,
  payment_reference text,
  initial_net numeric(14, 2),
  net numeric(14, 2),
  remitted numeric(14, 2),
  last_remitted numeric(14, 2),
  initial_rejected numeric(14, 2),
  rejected numeric(14, 2),
  unprocessed numeric(14, 2),
  write_off numeric(14, 2),
  write_off_status text,
  settled boolean,
  principal_diagnosis text,
  diagnosis_text text,
  last_denial_code text,
  denial_category text,
  denial_type text,
  denial_comment text,
  initial_denial_code text,
  initial_denial_type text,
  resubmission_count integer,
  remittance_count integer,
  first_remittance_date date,
  last_remittance_date date,
  last_resubmission_date date,
  claim_status text,
  payment_status text,
  receipt_status text,
  claim_year integer,
  claim_month integer check (claim_month is null or claim_month between 1 and 12),
  first_seen_file_id uuid references public.fin_raw_diligence_files (id) on delete set null,
  last_seen_file_id uuid references public.fin_raw_diligence_files (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, claim_activity_number)
);
create index ins_claim_activities_org_invoice_idx on public.ins_claim_activities (org_id, upper(regexp_replace(coalesce(invoice_no, ''), '\s+', '', 'g')));
create index ins_claim_activities_org_match_idx on public.ins_claim_activities (org_id, match_status);
create index ins_claim_activities_org_payer_idx on public.ins_claim_activities (org_id, payer_id, claim_year, claim_month);
create index ins_claim_activities_matched_invoice_idx on public.ins_claim_activities (matched_invoice_id) where matched_invoice_id is not null;

create table public.ins_claim_activity_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  claim_activity_id uuid not null references public.ins_claim_activities (id) on delete cascade,
  file_id uuid references public.fin_raw_diligence_files (id) on delete set null,
  observed_at timestamptz not null default now(),
  changed_fields jsonb not null,                      -- { field: { old, new } }
  check (jsonb_typeof(changed_fields) = 'object')
);
create index ins_claim_activity_events_claim_idx on public.ins_claim_activity_events (claim_activity_id, observed_at);

-- ---------------------------------------------------------------------------
-- Exceptions
-- ---------------------------------------------------------------------------

create table public.ops_exceptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  rule_code text not null,
  entity_type text not null check (entity_type in ('invoice', 'claim', 'batch', 'file')),
  entity_key text not null,
  branch_code text,
  owner_role text not null check (owner_role in ('insurance', 'billing', 'finance', 'admin')),
  assignee_user_id uuid references public.profiles (id) on delete set null,
  due_date date,
  status text not null default 'open' check (status in ('open', 'in_progress', 'closed', 'auto_closed')),
  detail jsonb not null default '{}'::jsonb,          -- identifiers and amounts only, no patient data
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by uuid references public.profiles (id) on delete set null,
  closure_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (org_id, rule_code) references public.fin_ref_exception_rules (org_id, rule_code),
  check (jsonb_typeof(detail) = 'object'),
  -- a manual close needs a note; any closed state needs a timestamp
  check (status <> 'closed' or (closure_note is not null and btrim(closure_note) <> '')),
  check (status in ('open', 'in_progress') or closed_at is not null)
);
-- one open exception per (rule, entity)
create unique index ops_exceptions_open_uidx on public.ops_exceptions (org_id, rule_code, entity_key)
  where status in ('open', 'in_progress');
create index ops_exceptions_queue_idx on public.ops_exceptions (org_id, owner_role, status, due_date);
create index ops_exceptions_assignee_idx on public.ops_exceptions (org_id, assignee_user_id) where status in ('open', 'in_progress');

create table public.ops_exception_comments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  exception_id uuid not null references public.ops_exceptions (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete set null,
  comment text not null check (btrim(comment) <> ''),
  created_at timestamptz not null default now()
);
create index ops_exception_comments_exception_idx on public.ops_exception_comments (exception_id, created_at);

-- ---------------------------------------------------------------------------
-- updated_at + same-org guards (app.check_parent_org is defined in the CRM migration)
-- ---------------------------------------------------------------------------

create trigger fin_invoices_set_updated_at before update on public.fin_invoices for each row execute function app.set_updated_at();
create trigger fin_invoice_lines_set_updated_at before update on public.fin_invoice_lines for each row execute function app.set_updated_at();
create trigger fin_payments_set_updated_at before update on public.fin_payments for each row execute function app.set_updated_at();
create trigger ins_claim_activities_set_updated_at before update on public.ins_claim_activities for each row execute function app.set_updated_at();
create trigger ops_exceptions_set_updated_at before update on public.ops_exceptions for each row execute function app.set_updated_at();

create trigger fin_invoices_batch_org_check before insert or update of last_batch_id, org_id on public.fin_invoices
  for each row execute function app.check_parent_org('fin_raw_unite_batches', 'last_batch_id');
create trigger fin_invoice_versions_invoice_org_check before insert or update of invoice_id, org_id on public.fin_invoice_versions
  for each row execute function app.check_parent_org('fin_invoices', 'invoice_id');
create trigger fin_invoice_versions_batch_org_check before insert or update of batch_id, org_id on public.fin_invoice_versions
  for each row execute function app.check_parent_org('fin_raw_unite_batches', 'batch_id');
create trigger fin_invoice_lines_invoice_org_check before insert or update of invoice_id, org_id on public.fin_invoice_lines
  for each row execute function app.check_parent_org('fin_invoices', 'invoice_id');
create trigger fin_payments_invoice_org_check before insert or update of invoice_id, org_id on public.fin_payments
  for each row execute function app.check_parent_org('fin_invoices', 'invoice_id');
create trigger ins_claims_invoice_org_check before insert or update of matched_invoice_id, org_id on public.ins_claim_activities
  for each row execute function app.check_parent_org('fin_invoices', 'matched_invoice_id');
create trigger ins_claims_line_org_check before insert or update of matched_line_id, org_id on public.ins_claim_activities
  for each row execute function app.check_parent_org('fin_invoice_lines', 'matched_line_id');
create trigger ins_claims_first_file_org_check before insert or update of first_seen_file_id, org_id on public.ins_claim_activities
  for each row execute function app.check_parent_org('fin_raw_diligence_files', 'first_seen_file_id');
create trigger ins_claims_last_file_org_check before insert or update of last_seen_file_id, org_id on public.ins_claim_activities
  for each row execute function app.check_parent_org('fin_raw_diligence_files', 'last_seen_file_id');
create trigger ins_events_claim_org_check before insert or update of claim_activity_id, org_id on public.ins_claim_activity_events
  for each row execute function app.check_parent_org('ins_claim_activities', 'claim_activity_id');
create trigger ins_events_file_org_check before insert or update of file_id, org_id on public.ins_claim_activity_events
  for each row execute function app.check_parent_org('fin_raw_diligence_files', 'file_id');
create trigger ops_exception_comments_exception_org_check before insert or update of exception_id, org_id on public.ops_exception_comments
  for each row execute function app.check_parent_org('ops_exceptions', 'exception_id');

-- ---------------------------------------------------------------------------
-- RLS
--   Billing   (finance.invoices.view): invoices, versions, lines, payments
--   Insurance (finance.claims.view):   claims + events (invoice fields via v_ins_invoice_match)
--   Writes to these tables come from the capture / import jobs (service role).
--   Exceptions: visible to the owning role; managed with finance.exceptions.manage.
-- ---------------------------------------------------------------------------

alter table public.fin_invoices enable row level security;
alter table public.fin_invoice_versions enable row level security;
alter table public.fin_invoice_lines enable row level security;
alter table public.fin_payments enable row level security;
alter table public.ins_claim_activities enable row level security;
alter table public.ins_claim_activity_events enable row level security;
alter table public.ops_exceptions enable row level security;
alter table public.ops_exception_comments enable row level security;

create policy fin_invoices_select on public.fin_invoices for select to authenticated
  using (app.has_perm(org_id, 'finance.invoices.view'));
create policy fin_invoice_versions_select on public.fin_invoice_versions for select to authenticated
  using (app.has_perm(org_id, 'finance.invoices.view'));
create policy fin_invoice_lines_select on public.fin_invoice_lines for select to authenticated
  using (app.has_perm(org_id, 'finance.invoices.view'));
create policy fin_payments_select on public.fin_payments for select to authenticated
  using (app.has_perm(org_id, 'finance.invoices.view'));

create policy ins_claim_activities_select on public.ins_claim_activities for select to authenticated
  using (app.has_perm(org_id, 'finance.claims.view'));
create policy ins_claim_activity_events_select on public.ins_claim_activity_events for select to authenticated
  using (app.has_perm(org_id, 'finance.claims.view'));

create policy ops_exceptions_select on public.ops_exceptions for select to authenticated
  using (app.has_perm(org_id, app.fin_owner_perm(owner_role)));
create policy ops_exceptions_update on public.ops_exceptions for update to authenticated
  using (app.has_perm(org_id, 'finance.exceptions.manage') and app.has_perm(org_id, app.fin_owner_perm(owner_role)))
  with check (app.has_perm(org_id, 'finance.exceptions.manage') and app.has_perm(org_id, app.fin_owner_perm(owner_role)));

create policy ops_exception_comments_select on public.ops_exception_comments for select to authenticated
  using (exists (
    select 1 from public.ops_exceptions e
    where e.id = exception_id and app.has_perm(e.org_id, app.fin_owner_perm(e.owner_role))
  ));
create policy ops_exception_comments_insert on public.ops_exception_comments for insert to authenticated
  with check (
    user_id = auth.uid()
    and app.has_perm(org_id, 'finance.exceptions.manage')
    and exists (
      select 1 from public.ops_exceptions e
      where e.id = exception_id and e.org_id = ops_exception_comments.org_id
        and app.has_perm(e.org_id, app.fin_owner_perm(e.owner_role))
    )
  );

-- ======================================================================
-- 20261009000400_finance_views.sql
-- ======================================================================
-- Finance F1 / 4: reporting views. These are the single agreed definition of
-- every number the portal shows.
--
-- The views run with the owner's rights (security_invoker = false) and filter
-- on the caller's permission, so Finance / CEO can read aggregates without
-- being able to read individual invoices, and Insurance can read the invoice
-- fields needed for matching without payments. Every view is filtered by
-- app.has_perm(org_id, ...), so a member never sees another org's rows.
-- Only current, non-deleted invoices and current lines / payments count.

-- Invoice fields Insurance needs for matching claims (no payments, no referral data).
create view public.v_ins_invoice_match with (security_invoker = false) as
select i.org_id, i.id as invoice_id, i.inv_display_number, i.inv_key, i.transaction_date,
       i.branch_code, i.inv_type, i.doctor_dha_id, i.net, i.total, i.is_deleted
from public.fin_invoices i
where app.has_perm(i.org_id, 'finance.claims.view');

create view public.v_ins_invoice_line_match with (security_invoker = false) as
select l.org_id, l.id as line_id, l.invoice_id, l.line_key, l.position, l.item_code, l.cpt_code,
       l.qty, l.line_net
from public.fin_invoice_lines l
where l.is_current and app.has_perm(l.org_id, 'finance.claims.view');

-- Revenue at line grain, so service category is exact. Invoice-level
-- write-offs and credit notes are in v_fin_adjustments_daily (different grain).
create view public.v_fin_revenue_daily with (security_invoker = false) as
select i.org_id,
       i.transaction_date as date,
       i.branch_code,
       i.department,
       i.doctor_dha_id,
       i.doctor_name,
       coalesce(s.service_category, 'Unmapped') as service_category,
       i.inv_type,
       sum(l.line_gross)    as gross,
       sum(l.line_discount) as discount,
       sum(l.line_net)      as net,
       sum(l.vat)           as vat
from public.fin_invoices i
join public.fin_invoice_lines l on l.invoice_id = i.id and l.is_current
left join public.fin_ref_services s on s.org_id = i.org_id and s.item_code = l.item_code
where not i.is_deleted and app.has_perm(i.org_id, 'finance.view')
group by i.org_id, i.transaction_date, i.branch_code, i.department, i.doctor_dha_id, i.doctor_name,
         coalesce(s.service_category, 'Unmapped'), i.inv_type;

create view public.v_fin_adjustments_daily with (security_invoker = false) as
select i.org_id, i.transaction_date as date, i.branch_code, i.inv_type,
       sum(i.write_off) as write_off, sum(i.credit_note) as credit_note
from public.fin_invoices i
where not i.is_deleted and app.has_perm(i.org_id, 'finance.view')
group by i.org_id, i.transaction_date, i.branch_code, i.inv_type;

create view public.v_fin_collections_daily with (security_invoker = false) as
select p.org_id, p.paid_date as date, i.branch_code, p.payment_mode,
       sum(p.paid) as paid, sum(p.refund) as refunds
from public.fin_payments p
join public.fin_invoices i on i.id = p.invoice_id
where p.is_current and not i.is_deleted and app.has_perm(p.org_id, 'finance.view')
group by p.org_id, p.paid_date, i.branch_code, p.payment_mode;

-- Claims by month / payer / branch. Branch comes from the matched invoice
-- (null while a claim is unmatched).
create view public.v_fin_claims_status with (security_invoker = false) as
select c.org_id, c.claim_year, c.claim_month, c.payer_id, i.branch_code,
       count(*)                                                         as submitted,
       count(*) filter (where coalesce(c.remitted, 0) > 0)              as accepted,
       count(*) filter (where coalesce(c.rejected, 0) > 0)              as rejected,
       count(*) filter (where coalesce(c.remitted, 0) = 0 and coalesce(c.rejected, 0) = 0) as pending,
       count(*) filter (where coalesce(c.resubmission_count, 0) > 0)    as resubmitted,
       sum(c.net)      as net,
       sum(c.remitted) as remitted,
       sum(c.rejected) as rejected_amount
from public.ins_claim_activities c
left join public.fin_invoices i on i.id = c.matched_invoice_id
where app.has_perm(c.org_id, 'finance.view')
group by c.org_id, c.claim_year, c.claim_month, c.payer_id, i.branch_code;

-- Outstanding = net - remitted - approved write-offs, bucketed by age of the
-- claim's transaction date. 'approved' is the assumed write_off_status value
-- (confirm against the first unfiltered Diligence export).
create view public.v_fin_receivables_ageing with (security_invoker = false) as
with outstanding as (
  select c.org_id, c.payer_id, i.branch_code,
         greatest(coalesce(c.net, 0) - coalesce(c.remitted, 0)
                  - case when lower(coalesce(c.write_off_status, '')) = 'approved' then coalesce(c.write_off, 0) else 0 end, 0) as amount,
         (current_date - c.transaction_date) as age_days
  from public.ins_claim_activities c
  left join public.fin_invoices i on i.id = c.matched_invoice_id
  where c.transaction_date is not null and app.has_perm(c.org_id, 'finance.view')
)
select org_id, payer_id, branch_code,
       case when age_days <= 30 then '0-30'
            when age_days <= 60 then '31-60'
            when age_days <= 90 then '61-90'
            else '90+' end as bucket,
       count(*) as claim_activities,
       sum(amount) as outstanding
from outstanding
where amount > 0
group by org_id, payer_id, branch_code,
         case when age_days <= 30 then '0-30'
              when age_days <= 60 then '31-60'
              when age_days <= 90 then '61-90'
              else '90+' end;

create view public.v_fin_denials with (security_invoker = false) as
select c.org_id, c.denial_type, c.last_denial_code, c.clinician_id as doctor_dha_id,
       c.cpt_category as service_category, c.payer_id,
       count(*) as claim_activities, sum(c.rejected) as rejected_amount
from public.ins_claim_activities c
where coalesce(c.rejected, 0) > 0 and app.has_perm(c.org_id, 'finance.view')
group by c.org_id, c.denial_type, c.last_denial_code, c.clinician_id, c.cpt_category, c.payer_id;

-- generated . claimed . remitted . rejected . outstanding . self-pay collected, by month and branch.
create view public.v_fin_monthly_summary with (security_invoker = false) as
with generated as (
  select i.org_id, date_trunc('month', i.transaction_date)::date as month, i.branch_code, sum(i.net) as generated
  from public.fin_invoices i
  where not i.is_deleted and i.transaction_date is not null
  group by 1, 2, 3
), claimed as (
  select c.org_id, date_trunc('month', c.transaction_date)::date as month, i.branch_code,
         sum(c.net) as claimed, sum(c.remitted) as remitted, sum(c.rejected) as rejected,
         sum(greatest(coalesce(c.net, 0) - coalesce(c.remitted, 0)
             - case when lower(coalesce(c.write_off_status, '')) = 'approved' then coalesce(c.write_off, 0) else 0 end, 0)) as outstanding
  from public.ins_claim_activities c
  left join public.fin_invoices i on i.id = c.matched_invoice_id
  where c.transaction_date is not null
  group by 1, 2, 3
), selfpay as (
  select p.org_id, date_trunc('month', p.paid_date)::date as month, i.branch_code, sum(p.paid) as self_pay_collected
  from public.fin_payments p
  join public.fin_invoices i on i.id = p.invoice_id
  where p.is_current and not i.is_deleted and p.paid_date is not null and upper(coalesce(i.inv_type, '')) like 'SELF%'
  group by 1, 2, 3
), keys as (
  select org_id, month, branch_code from generated
  union select org_id, month, branch_code from claimed
  union select org_id, month, branch_code from selfpay
)
select k.org_id, k.month, k.branch_code,
       g.generated, c.claimed, c.remitted, c.rejected, c.outstanding, s.self_pay_collected
from keys k
left join generated g on g.org_id = k.org_id and g.month = k.month and g.branch_code is not distinct from k.branch_code
left join claimed   c on c.org_id = k.org_id and c.month = k.month and c.branch_code is not distinct from k.branch_code
left join selfpay   s on s.org_id = k.org_id and s.month = k.month and s.branch_code is not distinct from k.branch_code
where app.has_perm(k.org_id, 'finance.view');

-- Views are never exposed to anon.
revoke all on public.v_ins_invoice_match, public.v_ins_invoice_line_match, public.v_fin_revenue_daily,
  public.v_fin_adjustments_daily, public.v_fin_collections_daily, public.v_fin_claims_status,
  public.v_fin_receivables_ageing, public.v_fin_denials, public.v_fin_monthly_summary from anon;
grant select on public.v_ins_invoice_match, public.v_ins_invoice_line_match, public.v_fin_revenue_daily,
  public.v_fin_adjustments_daily, public.v_fin_collections_daily, public.v_fin_claims_status,
  public.v_fin_receivables_ageing, public.v_fin_denials, public.v_fin_monthly_summary to authenticated, service_role;

-- ======================================================================
-- 20261009000500_finance_queue.sql
-- ======================================================================
-- Finance F1 / 5: the finance_capture queue and its hourly cron entry.
--
-- No handler is registered for this queue in F1, so /api/jobs/finance_capture
-- answers `skipped` and NOTHING calls the Unite Finance API (CLAUDE.md rule 7:
-- the API is sync-once). The F2 handler additionally requires
-- fin_capture_settings.enabled = true for the org.

select pgmq.create('finance_capture');

do $$
declare
  j record;
begin
  for j in select jobname from cron.job where jobname = 'pulse:finance_capture' loop
    perform cron.unschedule(j.jobname);
  end loop;
end $$;

select cron.schedule('pulse:finance_capture', '5 * * * *', $$select app.ping_jobs('finance_capture')$$);

-- ======================================================================
-- 20261009000600_finance_capture.sql
-- ======================================================================
-- Finance F2: capture pipeline support.
--   * integration_accounts (encrypted credentials + token cache) and unite_api_calls (call log)
--   * fin_apply_invoices: atomic, idempotent upsert of one batch of already-normalised invoices
--   * exception helpers (reused by the F5 rules), branch re-derivation, invoice-number gap report
--   * hourly tick enqueuer + 30 s pings for the finance_capture queue
--
-- The Unite Finance API is deliver-once. Mapping Unite's JSON to the normalised
-- shape happens in TypeScript (lib/finance/unite-mapping.ts); this file only
-- writes rows, in ONE transaction per batch, so a failed batch changes nothing
-- and can be replayed from fin_raw_unite_batches.

-- ---------------------------------------------------------------------------
-- Infrastructure tables (service role only: RLS on, no policies)
-- ---------------------------------------------------------------------------

create table public.integration_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  kind text not null,                                 -- 'unite', 'google_calendar', ...
  config_enc text not null,                           -- AES-256-GCM (lib/crypto.ts); never selected by the UI
  status text not null default 'active' check (status in ('active', 'disabled', 'error')),
  token_expires_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, kind)
);
create trigger integration_accounts_set_updated_at before update on public.integration_accounts
  for each row execute function app.set_updated_at();

create table public.unite_api_calls (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs (id) on delete cascade,
  endpoint text not null,                             -- 'authorize' | 'refreshtoken' | 'GetFinanceDetails' | ...
  http_status integer,
  unite_status text,                                  -- body Status / Message (never record data)
  duration_ms integer,
  batch_id uuid references public.fin_raw_unite_batches (id) on delete set null,
  at timestamptz not null default now()
);
create index unite_api_calls_org_at_idx on public.unite_api_calls (org_id, at desc);

alter table public.integration_accounts enable row level security;
alter table public.unite_api_calls enable row level security;

-- ---------------------------------------------------------------------------
-- Exception helpers
-- ---------------------------------------------------------------------------

-- Opens an exception unless one is already open for the same (rule, entity).
-- Inactive or unknown rules open nothing. `detail` must not contain patient data.
create or replace function public.fin_open_exception(
  p_org_id uuid,
  p_rule_code text,
  p_entity_type text,
  p_entity_key text,
  p_branch_code text default null,
  p_detail jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner text;
  v_id uuid;
begin
  select owner_role into v_owner
  from public.fin_ref_exception_rules
  where org_id = p_org_id and rule_code = p_rule_code and active;
  if v_owner is null then
    return null;
  end if;

  insert into public.ops_exceptions (org_id, rule_code, entity_type, entity_key, branch_code, owner_role, detail)
  values (p_org_id, p_rule_code, p_entity_type, p_entity_key, p_branch_code, v_owner, coalesce(p_detail, '{}'::jsonb))
  on conflict (org_id, rule_code, entity_key) where status in ('open', 'in_progress') do nothing
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.fin_auto_close_exceptions(
  p_org_id uuid,
  p_rule_code text,
  p_entity_key text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  update public.ops_exceptions
  set status = 'auto_closed', closed_at = now(), closure_note = 'condition cleared'
  where org_id = p_org_id and rule_code = p_rule_code and entity_key = p_entity_key
    and status in ('open', 'in_progress');
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- A failed batch keeps its raw payload; the exception tells an admin to fix the
-- mapping and replay (or ask Unite to re-queue when the raw insert itself failed).
create or replace function public.fin_batch_mark_failed(p_batch_id uuid, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  update public.fin_raw_unite_batches
  set process_status = 'failed', error = left(coalesce(p_error, 'unknown error'), 1000)
  where id = p_batch_id
  returning org_id into v_org;
  if v_org is not null then
    perform public.fin_open_exception(
      v_org, 'E09', 'batch', p_batch_id::text, null,
      jsonb_build_object('reason', 'batch_failed', 'error', left(coalesce(p_error, ''), 300))
    );
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- fin_apply_invoices
--   p_invoices: [{ inv_display_number, ..., record_hash, record, lines: [...], payments: [...] }]
--   Idempotent: applying the same batch twice changes nothing. A replay of an
--   OLDER batch never overwrites newer current state (it only records history).
-- ---------------------------------------------------------------------------

create or replace function public.fin_apply_invoices(p_org_id uuid, p_batch_id uuid, p_invoices jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch public.fin_raw_unite_batches;
  x record;
  e public.fin_invoices;
  v_id uuid;
  v_branch text;
  v_version integer;
  v_stale boolean;
  v_expected integer;
  c_invoices integer := 0;
  c_created integer := 0;
  c_updated integer := 0;
  c_unchanged integer := 0;
  c_stale integer := 0;
  c_lines integer := 0;
  c_payments integer := 0;
  c_versions integer := 0;
  v_rows integer;
begin
  select * into v_batch from public.fin_raw_unite_batches where id = p_batch_id and org_id = p_org_id for update;
  if not found then
    raise exception 'batch % not found in org %', p_batch_id, p_org_id using errcode = 'no_data_found';
  end if;
  if jsonb_typeof(p_invoices) <> 'array' then
    raise exception 'p_invoices must be a json array' using errcode = 'check_violation';
  end if;
  v_expected := coalesce(v_batch.record_count, jsonb_array_length(p_invoices));
  if jsonb_array_length(p_invoices) <> v_expected then
    raise exception 'count mismatch: batch has % records, % were mapped', v_expected, jsonb_array_length(p_invoices)
      using errcode = 'check_violation';
  end if;

  for x in
    select * from jsonb_to_recordset(p_invoices) as t(
      inv_display_number text, ref_type text, transaction_date date, patient_pin text, appointment_id text,
      unite_clinic_long_name text, unite_bu_short_name text, doctor_dha_id text, doctor_name text,
      department text, specialty text, inv_type text, is_package boolean, is_deleted boolean,
      gross numeric, discount numeric, net numeric, vat_applicable boolean, vat numeric, total numeric,
      write_off numeric, credit_note numeric, referral_doctor text, referral_doctor_id text,
      referral_clinic text, referral_clinic_id text, created_by text, modified_by text,
      record_hash text, record jsonb, lines jsonb, payments jsonb
    )
  loop
    c_invoices := c_invoices + 1;

    select b.code into v_branch
    from public.fin_ref_branches b
    where b.org_id = p_org_id and b.active and b.unite_clinic_long_name = x.unite_clinic_long_name
    limit 1;

    select * into e from public.fin_invoices
    where org_id = p_org_id and inv_display_number = x.inv_display_number for update;

    v_stale := false;
    if not found then
      insert into public.fin_invoices (
        org_id, inv_display_number, ref_type, transaction_date, patient_pin, appointment_id, branch_code,
        unite_clinic_long_name, unite_bu_short_name, doctor_dha_id, doctor_name, department, specialty,
        inv_type, is_package, is_deleted, gross, discount, net, vat_applicable, vat, total, write_off,
        credit_note, referral_doctor, referral_doctor_id, referral_clinic, referral_clinic_id,
        created_by, modified_by, version, record_hash, first_received_at, last_received_at, last_batch_id
      ) values (
        p_org_id, x.inv_display_number, x.ref_type, x.transaction_date, x.patient_pin, x.appointment_id, v_branch,
        x.unite_clinic_long_name, x.unite_bu_short_name, x.doctor_dha_id, x.doctor_name, x.department, x.specialty,
        x.inv_type, coalesce(x.is_package, false), coalesce(x.is_deleted, false), x.gross, x.discount, x.net,
        x.vat_applicable, x.vat, x.total, x.write_off, x.credit_note, x.referral_doctor, x.referral_doctor_id,
        x.referral_clinic, x.referral_clinic_id, x.created_by, x.modified_by, 1, x.record_hash,
        v_batch.requested_at, v_batch.requested_at, p_batch_id
      ) returning id into v_id;
      v_version := 1;
      c_created := c_created + 1;
    else
      v_id := e.id;
      v_stale := e.last_received_at > v_batch.requested_at;
      v_version := e.version;
      if v_stale then
        c_stale := c_stale + 1;
      else
        if e.record_hash is distinct from x.record_hash then
          v_version := e.version + 1;
          c_updated := c_updated + 1;
          update public.fin_invoices set
            ref_type = x.ref_type, transaction_date = x.transaction_date, patient_pin = x.patient_pin,
            appointment_id = x.appointment_id, branch_code = v_branch,
            unite_clinic_long_name = x.unite_clinic_long_name, unite_bu_short_name = x.unite_bu_short_name,
            doctor_dha_id = x.doctor_dha_id, doctor_name = x.doctor_name, department = x.department,
            specialty = x.specialty, inv_type = x.inv_type, is_package = coalesce(x.is_package, false),
            is_deleted = coalesce(x.is_deleted, false), gross = x.gross, discount = x.discount, net = x.net,
            vat_applicable = x.vat_applicable, vat = x.vat, total = x.total, write_off = x.write_off,
            credit_note = x.credit_note, referral_doctor = x.referral_doctor, referral_doctor_id = x.referral_doctor_id,
            referral_clinic = x.referral_clinic, referral_clinic_id = x.referral_clinic_id,
            created_by = x.created_by, modified_by = x.modified_by, version = v_version,
            record_hash = x.record_hash, last_received_at = v_batch.requested_at, last_batch_id = p_batch_id
          where id = v_id;
        else
          c_unchanged := c_unchanged + 1;
          -- same content: touch only bookkeeping, and only when it actually differs (replays change nothing)
          update public.fin_invoices
          set branch_code = v_branch, last_received_at = v_batch.requested_at, last_batch_id = p_batch_id
          where id = v_id
            and (branch_code, last_received_at, last_batch_id) is distinct from (v_branch, v_batch.requested_at, p_batch_id);
        end if;
      end if;
    end if;

    -- one history row per delivery (idempotent on replay)
    insert into public.fin_invoice_versions (org_id, invoice_id, version, batch_id, received_at, record)
    values (p_org_id, v_id, v_version, p_batch_id, v_batch.requested_at, coalesce(x.record, '{}'::jsonb))
    on conflict (invoice_id, batch_id) do nothing;
    get diagnostics v_rows = row_count;
    c_versions := c_versions + v_rows;

    if not v_stale then
      -- lines: upsert by key; keys absent from this delivery become not current (never deleted)
      insert into public.fin_invoice_lines (
        org_id, invoice_id, line_key, position, item_code, cpt_code, item_short_desc, item_type, qty,
        line_price, line_gross, line_discount, line_net, vat_applicable, vat, total, line_remarks,
        is_package_item, actual_cost_price, is_current
      )
      select p_org_id, v_id, l.line_key, l.position, l.item_code, l.cpt_code, l.item_short_desc, l.item_type,
             l.qty, l.line_price, l.line_gross, l.line_discount, l.line_net, l.vat_applicable, l.vat, l.total,
             l.line_remarks, coalesce(l.is_package_item, false), l.actual_cost_price, true
      from jsonb_to_recordset(coalesce(x.lines, '[]'::jsonb)) as l(
        line_key text, position integer, item_code text, cpt_code text, item_short_desc text, item_type text,
        qty numeric, line_price numeric, line_gross numeric, line_discount numeric, line_net numeric,
        vat_applicable boolean, vat numeric, total numeric, line_remarks text, is_package_item boolean,
        actual_cost_price numeric
      )
      on conflict (org_id, line_key) do update set
        invoice_id = excluded.invoice_id, position = excluded.position, item_code = excluded.item_code,
        cpt_code = excluded.cpt_code, item_short_desc = excluded.item_short_desc, item_type = excluded.item_type,
        qty = excluded.qty, line_price = excluded.line_price, line_gross = excluded.line_gross,
        line_discount = excluded.line_discount, line_net = excluded.line_net,
        vat_applicable = excluded.vat_applicable, vat = excluded.vat, total = excluded.total,
        line_remarks = excluded.line_remarks, is_package_item = excluded.is_package_item,
        actual_cost_price = excluded.actual_cost_price, is_current = true;
      get diagnostics v_rows = row_count;
      c_lines := c_lines + v_rows;

      update public.fin_invoice_lines
      set is_current = false
      where invoice_id = v_id and is_current
        and line_key <> all (coalesce(
          (select array_agg(l.line_key) from jsonb_to_recordset(coalesce(x.lines, '[]'::jsonb)) as l(line_key text)),
          '{}'::text[]));

      insert into public.fin_payments (
        org_id, invoice_id, payment_key, instalment, payment_mode, collected, paid, paid_date, returned,
        receipt_number, advance_added, refund, refund_date, txn_ref_no, txn_ref_name, card_type, surcharge,
        remarks, is_current
      )
      select p_org_id, v_id, p.payment_key, p.instalment, p.payment_mode, p.collected, p.paid, p.paid_date,
             p.returned, p.receipt_number, p.advance_added, p.refund, p.refund_date, p.txn_ref_no,
             p.txn_ref_name, p.card_type, p.surcharge, p.remarks, true
      from jsonb_to_recordset(coalesce(x.payments, '[]'::jsonb)) as p(
        payment_key text, instalment text, payment_mode text, collected numeric, paid numeric, paid_date date,
        returned numeric, receipt_number text, advance_added numeric, refund numeric, refund_date date,
        txn_ref_no text, txn_ref_name text, card_type text, surcharge numeric, remarks text
      )
      on conflict (org_id, payment_key) do update set
        invoice_id = excluded.invoice_id, instalment = excluded.instalment, payment_mode = excluded.payment_mode,
        collected = excluded.collected, paid = excluded.paid, paid_date = excluded.paid_date,
        returned = excluded.returned, receipt_number = excluded.receipt_number,
        advance_added = excluded.advance_added, refund = excluded.refund, refund_date = excluded.refund_date,
        txn_ref_no = excluded.txn_ref_no, txn_ref_name = excluded.txn_ref_name, card_type = excluded.card_type,
        surcharge = excluded.surcharge, remarks = excluded.remarks, is_current = true;
      get diagnostics v_rows = row_count;
      c_payments := c_payments + v_rows;

      update public.fin_payments
      set is_current = false
      where invoice_id = v_id and is_current
        and payment_key <> all (coalesce(
          (select array_agg(p.payment_key) from jsonb_to_recordset(coalesce(x.payments, '[]'::jsonb)) as p(payment_key text)),
          '{}'::text[]));

      -- reference data: fill blanks only; admins own the rest
      if x.doctor_dha_id is not null and btrim(x.doctor_dha_id) <> '' then
        insert into public.fin_ref_doctors (org_id, dha_id, name, department, specialty)
        values (p_org_id, x.doctor_dha_id, x.doctor_name, x.department, x.specialty)
        on conflict (org_id, dha_id) do update set
          name = coalesce(public.fin_ref_doctors.name, excluded.name),
          department = coalesce(public.fin_ref_doctors.department, excluded.department),
          specialty = coalesce(public.fin_ref_doctors.specialty, excluded.specialty);
      end if;
      insert into public.fin_ref_services (org_id, item_code, cpt_code, description, item_type)
      select distinct on (l.item_code) p_org_id, l.item_code, l.cpt_code, l.item_short_desc, l.item_type
      from jsonb_to_recordset(coalesce(x.lines, '[]'::jsonb)) as l(item_code text, cpt_code text, item_short_desc text, item_type text)
      where l.item_code is not null and btrim(l.item_code) <> ''
      on conflict (org_id, item_code) do update set
        cpt_code = coalesce(public.fin_ref_services.cpt_code, excluded.cpt_code),
        description = coalesce(public.fin_ref_services.description, excluded.description),
        item_type = coalesce(public.fin_ref_services.item_type, excluded.item_type);

      -- E07: unknown clinic. Opens while unmapped, auto-closes once mapped.
      if v_branch is null then
        perform public.fin_open_exception(
          p_org_id, 'E07', 'invoice', x.inv_display_number, null,
          jsonb_build_object('unite_clinic_long_name', x.unite_clinic_long_name));
      else
        perform public.fin_auto_close_exceptions(p_org_id, 'E07', x.inv_display_number);
      end if;
    end if;
  end loop;

  update public.fin_raw_unite_batches
  set process_status = 'processed', processed_at = now(), error = null,
      process_counts = jsonb_build_object(
        'invoices', c_invoices, 'created', c_created, 'updated', c_updated, 'unchanged', c_unchanged,
        'stale', c_stale, 'lines', c_lines, 'payments', c_payments, 'versions', c_versions)
  where id = p_batch_id;

  perform public.fin_auto_close_exceptions(p_org_id, 'E09', p_batch_id::text);

  return jsonb_build_object(
    'invoices', c_invoices, 'created', c_created, 'updated', c_updated, 'unchanged', c_unchanged,
    'stale', c_stale, 'lines', c_lines, 'payments', c_payments, 'versions', c_versions);
end;
$$;

-- After an admin maps a clinic name, re-derive branches for invoices that had none
-- (and close their E07 exceptions) without waiting for a replay.
create or replace function public.fin_rederive_branches(p_org_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_n integer := 0;
begin
  for r in
    update public.fin_invoices i
    set branch_code = b.code
    from public.fin_ref_branches b
    where i.org_id = p_org_id and i.branch_code is null and b.org_id = i.org_id and b.active
      and b.unite_clinic_long_name = i.unite_clinic_long_name
    returning i.inv_display_number
  loop
    perform public.fin_auto_close_exceptions(p_org_id, 'E07', r.inv_display_number);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- Missing numbers inside each invoice-number series (e.g. 'ADMC/C/'), for the
-- data-health gap report. Gaps mean records Unite has not delivered yet.
create or replace function public.fin_invoice_number_gaps(p_org_id uuid, p_from date default date '2026-01-01')
returns table (series text, missing_from bigint, missing_to bigint, missing_count bigint)
language sql
stable
security definer
set search_path = ''
as $$
  with parsed as (
    select (m)[1] as series, (m)[2]::bigint as n
    from (
      select regexp_match(inv_display_number, '^(.*?)([0-9]{1,15})$') as m
      from public.fin_invoices
      where org_id = p_org_id and transaction_date >= p_from
    ) s
    where m is not null
  ), uniq as (
    select distinct series, n from parsed
  ), stepped as (
    select series, n, lag(n) over (partition by series order by n) as prev from uniq
  )
  select series, prev + 1, n - 1, n - prev - 1
  from stepped
  where prev is not null and n - prev > 1
  order by series, prev;
$$;

-- ---------------------------------------------------------------------------
-- Scheduling: one tick per enabled org per hour; the queue is pinged every 30 s.
-- ---------------------------------------------------------------------------

create or replace function public.fin_capture_enqueue_ticks()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  s record;
  v_n integer := 0;
begin
  for s in select org_id from public.fin_capture_settings where enabled loop
    if not exists (
      select 1 from pgmq.q_finance_capture
      where message ->> 'kind' = 'tick' and message ->> 'org_id' = s.org_id::text
    ) then
      perform pgmq.send('finance_capture', jsonb_build_object('kind', 'tick', 'org_id', s.org_id));
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

do $$
declare
  j record;
begin
  for j in select jobname from cron.job where jobname in ('pulse:finance_capture', 'pulse:finance_capture_tick') loop
    perform cron.unschedule(j.jobname);
  end loop;
end $$;

select cron.schedule('pulse:finance_capture_tick', '5 * * * *', $$select public.fin_capture_enqueue_ticks()$$);
select cron.schedule('pulse:finance_capture', '30 seconds', $$select app.ping_jobs('finance_capture')$$);

-- ---------------------------------------------------------------------------
-- Privileges: service role only
-- ---------------------------------------------------------------------------

revoke all on function public.fin_open_exception(uuid, text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.fin_auto_close_exceptions(uuid, text, text) from public, anon, authenticated;
revoke all on function public.fin_batch_mark_failed(uuid, text) from public, anon, authenticated;
revoke all on function public.fin_apply_invoices(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.fin_rederive_branches(uuid) from public, anon, authenticated;
revoke all on function public.fin_invoice_number_gaps(uuid, date) from public, anon, authenticated;
revoke all on function public.fin_capture_enqueue_ticks() from public, anon, authenticated;
grant execute on function public.fin_open_exception(uuid, text, text, text, text, jsonb) to service_role;
grant execute on function public.fin_auto_close_exceptions(uuid, text, text) to service_role;
grant execute on function public.fin_batch_mark_failed(uuid, text) to service_role;
grant execute on function public.fin_apply_invoices(uuid, uuid, jsonb) to service_role;
grant execute on function public.fin_rederive_branches(uuid) to service_role;
grant execute on function public.fin_invoice_number_gaps(uuid, date) to service_role;
grant execute on function public.fin_capture_enqueue_ticks() to service_role;

