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
