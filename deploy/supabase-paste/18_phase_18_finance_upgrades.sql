-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Phase 18 (Finance and insurance upgrades). Needs the earlier files first, including
-- 16_phase_16_media_documents.sql and the Finance phase migrations.
-- Check the project name in the Supabase header first: this is for the Pulse project only.
-- Adds pre-authorisations, eligibility checks, denial cases, remittance (payment advice) staging and matching, payer
-- price lists, analytics functions, the month-end close with its lock, the end-of-day cash-up, self-pay reminder
-- settings and the accounting export mapping. It grants the new finance.* permissions to the existing Finance, Billing,
-- Insurance, CEO and Medical Director roles and schedules pulse:finance_workflows (daily).
-- It never calls Unite. Self-pay reminders stay OFF until finance approves the wording and an administrator switches them
-- on (see docs/16_PHASE_18_NOTES.md).

-- ======================================================================
-- 20261016000100_finance_upgrades_foundation.sql
-- ======================================================================
-- Phase 18 (1/7): Finance & Insurance upgrades, foundation.
--
--   * new finance.* permissions are granted to the existing system roles (idempotent; new orgs get them from
--     lib/auth/permissions.ts, existing orgs from here)
--   * reference tables every Phase 18 rule reads its thresholds from (CLAUDE.md: no hard-coded thresholds):
--       fin_ref_finance_settings   one row per org: thresholds for pre-auth, denials, short-pay, scorecards,
--                                  forecast, cash-up and self-pay recovery
--       fin_ref_denial_codes       the denial reason-code taxonomy (exact codes and code families)
--       fin_ref_payer_prices       the payer's agreed price list (used to flag short payments)
--       fin_ref_account_map        general-ledger accounts for the one-way accounting export
--   * fin_ref_services.requires_preauth  (which services need a pre-authorisation before billing)
--   * ai_usage.feature accepts 'appeal_draft' (the AI-drafted appeal letter)
--
-- Like every other fin_ref_* table: staff with a finance permission read, finance.reference.manage writes.
-- Only the Unite patient PIN is ever stored on finance rows: no names, dates of birth, Emirates IDs or member IDs.

-- ---------------------------------------------------------------------------
-- Permissions for existing system roles
-- ---------------------------------------------------------------------------
do $$
declare
  g record;
begin
  for g in
    select * from (values
      ('Finance', 'finance.preauth.manage'), -- Finance sees the tracker; Insurance works it
      ('Finance', 'finance.denials.manage'),
      ('Finance', 'finance.remittance.manage'),
      ('Finance', 'finance.scorecards.view'),
      ('Finance', 'finance.forecast.view'),
      ('Finance', 'finance.recovery.manage'),
      ('Finance', 'finance.recovery.approve'),
      ('Finance', 'finance.close.view'),
      ('Finance', 'finance.close.manage'),
      ('Finance', 'finance.close.signoff.finance'),
      ('Finance', 'finance.cashup.manage'),
      ('Finance', 'finance.revenue.view'),
      ('Finance', 'finance.export.run'),
      ('Billing', 'finance.eligibility.manage'),
      ('Billing', 'finance.cashup.manage'),
      ('Billing', 'finance.recovery.manage'),
      ('Insurance', 'finance.preauth.manage'),
      ('Insurance', 'finance.eligibility.manage'),
      ('Insurance', 'finance.denials.manage'),
      ('Insurance', 'finance.remittance.manage'),
      ('Insurance', 'finance.scorecards.view'),
      ('CEO', 'finance.scorecards.view'),
      ('CEO', 'finance.forecast.view'),
      ('CEO', 'finance.revenue.view'),
      ('CEO', 'finance.close.view'),
      ('CEO', 'finance.close.signoff.ceo'),
      ('Medical Director', 'finance.scorecards.view'),
      ('Medical Director', 'finance.revenue.view')
    ) as t (role_name, perm)
  loop
    update public.roles r
       set permissions = r.permissions || to_jsonb(g.perm)
     where r.is_system and r.name = g.role_name and not (r.permissions ? g.perm);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- fin_ref_finance_settings: one row per org
-- ---------------------------------------------------------------------------
create table public.fin_ref_finance_settings (
  org_id uuid primary key references public.orgs (id) on delete cascade,

  -- pre-authorisations
  preauth_expiry_lead_days integer not null default 7 check (preauth_expiry_lead_days between 0 and 180),
  preauth_task_enabled boolean not null default true,

  -- eligibility / "ready to bill"
  ready_grace_days integer not null default 1 check (ready_grace_days between 0 and 60),
  -- insurance invoices dated before this are never flagged "not ready to bill"; null = the check is switched off
  ready_start_date date,

  -- denial management
  denial_default_resubmit_days integer not null default 30 check (denial_default_resubmit_days between 1 and 365),
  denial_warn_days integer not null default 7 check (denial_warn_days between 0 and 90),
  denial_task_enabled boolean not null default true,
  -- denials before this date never become cases; null = denial management is switched off
  denial_cases_start_date date,

  -- remittance reconciliation: a payment is short when it falls below the expectation by more than BOTH tolerances
  short_pay_tolerance_amount numeric(12, 2) not null default 1.00 check (short_pay_tolerance_amount >= 0),
  short_pay_tolerance_pct numeric(6, 4) not null default 0.0100 check (short_pay_tolerance_pct between 0 and 1),

  -- payer scorecards: sample size before a rate is judged, and the traffic-light thresholds
  scorecard_min_claims integer not null default 20 check (scorecard_min_claims between 1 and 100000),
  scorecard_denial_rate_warn numeric(5, 4) not null default 0.1000 check (scorecard_denial_rate_warn between 0 and 1),
  scorecard_denial_rate_alert numeric(5, 4) not null default 0.2000 check (scorecard_denial_rate_alert between 0 and 1),
  scorecard_days_to_pay_warn integer not null default 60 check (scorecard_days_to_pay_warn between 1 and 730),
  scorecard_days_to_pay_alert integer not null default 90 check (scorecard_days_to_pay_alert between 1 and 730),

  -- collections forecast
  forecast_horizon_weeks integer not null default 13 check (forecast_horizon_weeks between 1 and 52),
  forecast_default_lag_days integer not null default 60 check (forecast_default_lag_days between 1 and 730),
  forecast_default_collection_rate numeric(5, 4) not null default 0.9000 check (forecast_default_collection_rate between 0 and 1),
  forecast_min_history integer not null default 30 check (forecast_min_history between 1 and 100000),
  forecast_tail_weeks integer not null default 4 check (forecast_tail_weeks between 1 and 52),

  -- end-of-day cash-up: a counted amount this far from the expected one needs a reason
  cashup_variance_tolerance numeric(12, 2) not null default 5.00 check (cashup_variance_tolerance >= 0),

  -- self-pay recovery reminders (WhatsApp). OFF until finance has approved the tone of a mapped template.
  recovery_enabled boolean not null default false,
  recovery_template_id uuid references public.wa_templates (id) on delete set null,
  recovery_variable_map jsonb not null default '{}'::jsonb check (jsonb_typeof(recovery_variable_map) = 'object'),
  recovery_tone_approved_by uuid references public.profiles (id) on delete set null,
  recovery_tone_approved_at timestamptz,
  recovery_tone_approved_hash text,            -- hash of the template wording that was approved; a change resets it
  recovery_min_balance numeric(12, 2) not null default 50.00 check (recovery_min_balance >= 0),
  recovery_min_days_overdue integer not null default 14 check (recovery_min_days_overdue between 0 and 365),
  recovery_gap_days integer not null default 14 check (recovery_gap_days between 1 and 365),
  recovery_max_reminders integer not null default 3 check (recovery_max_reminders between 1 and 10),
  recovery_batch_size integer not null default 50 check (recovery_batch_size between 1 and 500),

  updated_at timestamptz not null default now(),
  check (scorecard_denial_rate_alert >= scorecard_denial_rate_warn),
  check (scorecard_days_to_pay_alert >= scorecard_days_to_pay_warn)
);
create trigger fin_ref_finance_settings_set_updated_at before update on public.fin_ref_finance_settings
  for each row execute function app.set_updated_at();
create trigger fin_ref_finance_settings_template_org_check before insert or update of recovery_template_id, org_id on public.fin_ref_finance_settings
  for each row execute function app.check_parent_org('wa_templates', 'recovery_template_id');

-- ---------------------------------------------------------------------------
-- fin_ref_denial_codes: the reason-code taxonomy. A code that is not listed exactly falls back to its family
-- (the letters before the first "-" or digit), then to the 'other' category. The starter rows are PLACEHOLDERS
-- (is_placeholder) until finance loads the payers' real code lists.
-- ---------------------------------------------------------------------------
create table public.fin_ref_denial_codes (
  org_id uuid not null references public.orgs (id) on delete cascade,
  code text not null check (code ~ '^[A-Za-z0-9._-]{1,40}$'),
  is_family boolean not null default false,
  description text not null check (char_length(description) between 1 and 200),
  category text not null default 'other'
    check (category in ('authorization', 'eligibility', 'medical_necessity', 'coding', 'documentation', 'duplicate', 'timely_filing', 'pricing', 'other')),
  default_owner_role text not null default 'insurance' check (default_owner_role in ('insurance', 'billing', 'finance', 'admin')),
  resubmit_days integer check (resubmit_days is null or resubmit_days between 1 and 365),
  appealable boolean not null default true,
  active boolean not null default true,
  is_placeholder boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, code)
);
create trigger fin_ref_denial_codes_set_updated_at before update on public.fin_ref_denial_codes
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- fin_ref_payer_prices: the agreed price per payer and CPT code
-- ---------------------------------------------------------------------------
create table public.fin_ref_payer_prices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  payer_id text not null check (char_length(payer_id) between 1 and 60),
  cpt_code text not null check (char_length(cpt_code) between 1 and 40),
  agreed_price numeric(14, 2) not null check (agreed_price >= 0),
  effective_from date not null default date '2000-01-01',
  effective_to date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from),
  unique (org_id, payer_id, cpt_code, effective_from)
);
create index fin_ref_payer_prices_lookup_idx on public.fin_ref_payer_prices (org_id, payer_id, cpt_code);
create trigger fin_ref_payer_prices_set_updated_at before update on public.fin_ref_payer_prices
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- fin_ref_account_map: general-ledger accounts for the accounting export
--   kind: revenue (key = service category) | payment_mode (key = mode) | receivable (insurance | self_pay)
--         | vat_output | writeoff | credit_note | rounding | refund   (key '*' for the single-account kinds)
-- ---------------------------------------------------------------------------
create table public.fin_ref_account_map (
  org_id uuid not null references public.orgs (id) on delete cascade,
  kind text not null check (kind in ('revenue', 'payment_mode', 'receivable', 'vat_output', 'writeoff', 'credit_note', 'rounding', 'refund')),
  key text not null check (char_length(key) between 1 and 80),
  account_code text not null check (char_length(account_code) between 1 and 40),
  account_name text check (account_name is null or char_length(account_name) <= 120),
  updated_at timestamptz not null default now(),
  primary key (org_id, kind, key)
);
create trigger fin_ref_account_map_set_updated_at before update on public.fin_ref_account_map
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- Services that need a pre-authorisation before they can be billed to an insurer
-- ---------------------------------------------------------------------------
alter table public.fin_ref_services add column requires_preauth boolean not null default false;

-- ---------------------------------------------------------------------------
-- RLS: staff with a finance permission read; finance.reference.manage writes (same model as the F1 reference tables)
-- ---------------------------------------------------------------------------
alter table public.fin_ref_finance_settings enable row level security;
alter table public.fin_ref_denial_codes enable row level security;
alter table public.fin_ref_payer_prices enable row level security;
alter table public.fin_ref_account_map enable row level security;

create policy fin_ref_finance_settings_select on public.fin_ref_finance_settings for select to authenticated
  using (app.has_perm(org_id, 'finance.reference.manage') or app.has_perm(org_id, 'finance.view')
      or app.has_perm(org_id, 'finance.preauth.manage') or app.has_perm(org_id, 'finance.eligibility.manage')
      or app.has_perm(org_id, 'finance.denials.manage') or app.has_perm(org_id, 'finance.remittance.manage')
      or app.has_perm(org_id, 'finance.scorecards.view') or app.has_perm(org_id, 'finance.forecast.view')
      or app.has_perm(org_id, 'finance.recovery.manage') or app.has_perm(org_id, 'finance.cashup.manage')
      or app.has_perm(org_id, 'finance.close.view'));
create policy fin_ref_finance_settings_insert on public.fin_ref_finance_settings for insert to authenticated
  with check (app.has_perm(org_id, 'finance.reference.manage'));
create policy fin_ref_finance_settings_update on public.fin_ref_finance_settings for update to authenticated
  using (app.has_perm(org_id, 'finance.reference.manage'))
  with check (app.has_perm(org_id, 'finance.reference.manage'));

create policy fin_ref_denial_codes_select on public.fin_ref_denial_codes for select to authenticated
  using (app.has_perm(org_id, 'finance.reference.manage') or app.has_perm(org_id, 'finance.denials.manage')
      or app.has_perm(org_id, 'finance.scorecards.view') or app.has_perm(org_id, 'finance.remittance.manage'));
create policy fin_ref_denial_codes_insert on public.fin_ref_denial_codes for insert to authenticated
  with check (app.has_perm(org_id, 'finance.reference.manage'));
create policy fin_ref_denial_codes_update on public.fin_ref_denial_codes for update to authenticated
  using (app.has_perm(org_id, 'finance.reference.manage'))
  with check (app.has_perm(org_id, 'finance.reference.manage'));
create policy fin_ref_denial_codes_delete on public.fin_ref_denial_codes for delete to authenticated
  using (app.has_perm(org_id, 'finance.reference.manage'));

-- the agreed price list is commercially sensitive: only the people who reconcile payments and maintain reference data
create policy fin_ref_payer_prices_select on public.fin_ref_payer_prices for select to authenticated
  using (app.has_perm(org_id, 'finance.reference.manage') or app.has_perm(org_id, 'finance.remittance.manage'));
create policy fin_ref_payer_prices_insert on public.fin_ref_payer_prices for insert to authenticated
  with check (app.has_perm(org_id, 'finance.reference.manage'));
create policy fin_ref_payer_prices_update on public.fin_ref_payer_prices for update to authenticated
  using (app.has_perm(org_id, 'finance.reference.manage'))
  with check (app.has_perm(org_id, 'finance.reference.manage'));
create policy fin_ref_payer_prices_delete on public.fin_ref_payer_prices for delete to authenticated
  using (app.has_perm(org_id, 'finance.reference.manage'));

create policy fin_ref_account_map_select on public.fin_ref_account_map for select to authenticated
  using (app.has_perm(org_id, 'finance.reference.manage') or app.has_perm(org_id, 'finance.export.run'));
create policy fin_ref_account_map_insert on public.fin_ref_account_map for insert to authenticated
  with check (app.has_perm(org_id, 'finance.reference.manage'));
create policy fin_ref_account_map_update on public.fin_ref_account_map for update to authenticated
  using (app.has_perm(org_id, 'finance.reference.manage'))
  with check (app.has_perm(org_id, 'finance.reference.manage'));
create policy fin_ref_account_map_delete on public.fin_ref_account_map for delete to authenticated
  using (app.has_perm(org_id, 'finance.reference.manage'));

-- ---------------------------------------------------------------------------
-- Per-org seed (replaces the F1 function; still idempotent and never overwrites admin edits)
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
end;
$$;
revoke all on function public.seed_finance_reference(uuid) from public, anon, authenticated;
grant execute on function public.seed_finance_reference(uuid) to service_role;

select public.seed_finance_reference(id) from public.orgs;

-- ---------------------------------------------------------------------------
-- ai_usage.feature: add 'appeal_draft' without losing any value another migration may have added
-- ---------------------------------------------------------------------------
do $$
declare
  c record;
  v_list text[];
begin
  for c in
    select con.conname, pg_get_constraintdef(con.oid) as def
    from pg_constraint con
    where con.conrelid = 'public.ai_usage'::regclass and con.contype = 'c' and pg_get_constraintdef(con.oid) like '%feature%'
  loop
    select array_agg(distinct m[1]) into v_list from regexp_matches(c.def, '''([a-z_]+)''', 'g') as m;
    execute format('alter table public.ai_usage drop constraint %I', c.conname);
  end loop;
  v_list := coalesce(v_list, array['summarize', 'ask', 'suggest_reply', 'rewrite']);
  if not ('appeal_draft' = any (v_list)) then
    v_list := array_append(v_list, 'appeal_draft');
  end if;
  execute format('alter table public.ai_usage add constraint ai_usage_feature_check check (feature in (%s))',
    (select string_agg(quote_literal(x), ', ' order by x) from unnest(v_list) as x));
end $$;

-- ======================================================================
-- 20261016000200_finance_preauth_eligibility.sql
-- ======================================================================
-- Phase 18 (2/7): pre-authorisation tracker and eligibility checks ("ready to bill").
--
--   fin_pre_authorisations   request -> decision -> expiry, linked to an appointment and (when billed) a claim
--   fin_eligibility_checks   the cover check for a patient: payer, validity, and the insurance-card document
--                            (a Phase 16 patient_documents row, referenced by id only)
--   v_fin_billing_readiness  insurance invoices that are not yet ready to bill, with the reasons
--
-- Only the Unite PIN (and the platform contact id) identify a patient: no names, dates of birth, Emirates IDs or
-- member IDs. Writes are server-only (service role after can()); staff read through RLS. record_history is attached
-- so the History tab says who changed what.

-- ---------------------------------------------------------------------------
-- fin_pre_authorisations
-- ---------------------------------------------------------------------------
create table public.fin_pre_authorisations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  patient_pin text check (patient_pin is null or char_length(patient_pin) between 1 and 60),
  contact_id uuid references public.contacts (id) on delete set null,
  payer_id text not null check (char_length(payer_id) between 1 and 60),
  auth_number text check (auth_number is null or char_length(auth_number) between 1 and 80),   -- the payer's reference
  cpt_codes text[] not null default '{}',
  appointment_id uuid references public.appointments (id) on delete set null,
  claim_activity_id uuid references public.ins_claim_activities (id) on delete set null,
  status text not null default 'requested'
    check (status in ('draft', 'requested', 'approved', 'partially_approved', 'denied', 'expired', 'cancelled', 'used')),
  requested_on date,
  requested_by uuid references public.profiles (id) on delete set null,
  decision_on date,
  valid_from date,
  expires_on date,
  approved_amount numeric(14, 2) check (approved_amount is null or approved_amount >= 0),
  approved_units integer check (approved_units is null or approved_units >= 0),
  reference_note text check (reference_note is null or char_length(reference_note) <= 200),   -- never clinical detail
  expiry_task_id uuid references public.tasks (id) on delete set null,
  expiry_notified_at timestamptz,                    -- atomic claim: the expiry reminder is raised once
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (patient_pin is not null or contact_id is not null),
  check (valid_from is null or expires_on is null or expires_on >= valid_from),
  -- an approval is worthless without the payer's reference and an expiry date: fail closed
  check (status not in ('approved', 'partially_approved') or (auth_number is not null and expires_on is not null))
);
create unique index fin_pre_authorisations_auth_uidx on public.fin_pre_authorisations (org_id, payer_id, auth_number)
  where auth_number is not null;
create index fin_pre_authorisations_status_idx on public.fin_pre_authorisations (org_id, status, expires_on);
create index fin_pre_authorisations_pin_idx on public.fin_pre_authorisations (org_id, patient_pin) where patient_pin is not null;
create index fin_pre_authorisations_appt_idx on public.fin_pre_authorisations (appointment_id) where appointment_id is not null;
create index fin_pre_authorisations_claim_idx on public.fin_pre_authorisations (claim_activity_id) where claim_activity_id is not null;
create index fin_pre_authorisations_expiry_idx on public.fin_pre_authorisations (org_id, expires_on)
  where status in ('approved', 'partially_approved') and expiry_notified_at is null;

create trigger fin_pre_authorisations_set_updated_at before update on public.fin_pre_authorisations
  for each row execute function app.set_updated_at();
create trigger fin_pre_auth_contact_org_check before insert or update of contact_id, org_id on public.fin_pre_authorisations
  for each row execute function app.check_parent_org('contacts', 'contact_id');
create trigger fin_pre_auth_appointment_org_check before insert or update of appointment_id, org_id on public.fin_pre_authorisations
  for each row execute function app.check_parent_org('appointments', 'appointment_id');
create trigger fin_pre_auth_claim_org_check before insert or update of claim_activity_id, org_id on public.fin_pre_authorisations
  for each row execute function app.check_parent_org('ins_claim_activities', 'claim_activity_id');
create trigger fin_pre_auth_task_org_check before insert or update of expiry_task_id, org_id on public.fin_pre_authorisations
  for each row execute function app.check_parent_org('tasks', 'expiry_task_id');

-- ---------------------------------------------------------------------------
-- fin_eligibility_checks
-- ---------------------------------------------------------------------------
create table public.fin_eligibility_checks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  patient_pin text check (patient_pin is null or char_length(patient_pin) between 1 and 60),
  contact_id uuid references public.contacts (id) on delete set null,
  appointment_id uuid references public.appointments (id) on delete set null,
  payer_id text not null check (char_length(payer_id) between 1 and 60),
  document_id uuid references public.patient_documents (id) on delete set null,     -- the card: by id only
  status text not null default 'pending' check (status in ('pending', 'verified', 'failed', 'expired')),
  method text not null default 'portal' check (method in ('portal', 'phone', 'card_only', 'other')),
  valid_from date,
  valid_to date,
  checked_on date,
  checked_by uuid references public.profiles (id) on delete set null,
  result_note text check (result_note is null or char_length(result_note) <= 200),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (patient_pin is not null or contact_id is not null),
  check (valid_from is null or valid_to is null or valid_to >= valid_from),
  -- a verified check needs the date it stops covering the patient and the date it was checked
  check (status <> 'verified' or (valid_to is not null and checked_on is not null))
);
create index fin_eligibility_checks_pin_idx on public.fin_eligibility_checks (org_id, patient_pin, checked_on desc) where patient_pin is not null;
create index fin_eligibility_checks_contact_idx on public.fin_eligibility_checks (org_id, contact_id) where contact_id is not null;
create index fin_eligibility_checks_status_idx on public.fin_eligibility_checks (org_id, status, valid_to);
create index fin_eligibility_checks_appt_idx on public.fin_eligibility_checks (appointment_id) where appointment_id is not null;

create trigger fin_eligibility_checks_set_updated_at before update on public.fin_eligibility_checks
  for each row execute function app.set_updated_at();
create trigger fin_elig_contact_org_check before insert or update of contact_id, org_id on public.fin_eligibility_checks
  for each row execute function app.check_parent_org('contacts', 'contact_id');
create trigger fin_elig_appointment_org_check before insert or update of appointment_id, org_id on public.fin_eligibility_checks
  for each row execute function app.check_parent_org('appointments', 'appointment_id');
create trigger fin_elig_document_org_check before insert or update of document_id, org_id on public.fin_eligibility_checks
  for each row execute function app.check_parent_org('patient_documents', 'document_id');

-- ---------------------------------------------------------------------------
-- RLS: select-only for the browser (writes are server actions using the service role after can())
-- ---------------------------------------------------------------------------
alter table public.fin_pre_authorisations enable row level security;
alter table public.fin_eligibility_checks enable row level security;

create policy fin_pre_authorisations_select on public.fin_pre_authorisations for select to authenticated
  using (app.has_perm(org_id, 'finance.preauth.manage'));
create policy fin_eligibility_checks_select on public.fin_eligibility_checks for select to authenticated
  using (app.has_perm(org_id, 'finance.eligibility.manage'));

-- ---------------------------------------------------------------------------
-- Link approved pre-authorisations to the claims that quote their number (idempotent; never overwrites a manual link)
-- ---------------------------------------------------------------------------
create or replace function public.fin_link_preauth_claims(p_org_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  with pick as (
    select distinct on (p.id) p.id as preauth_id, c.id as claim_id
    from public.fin_pre_authorisations p
    join public.ins_claim_activities c
      on c.org_id = p.org_id and c.prior_auth_id = p.auth_number and (c.payer_id is null or c.payer_id = p.payer_id)
    where p.org_id = p_org_id and p.auth_number is not null and p.claim_activity_id is null
      and p.status in ('approved', 'partially_approved', 'used')
    order by p.id, c.transaction_date nulls last, c.id
  )
  update public.fin_pre_authorisations p
     set claim_activity_id = pick.claim_id
    from pick
   where p.id = pick.preauth_id and p.claim_activity_id is null;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.fin_link_preauth_claims(uuid) from public, anon, authenticated;
grant execute on function public.fin_link_preauth_claims(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- v_fin_billing_readiness: insurance invoices that have not been claimed yet and are not ready to bill.
-- One definition of the rules in SQL (mirrored by lib/finance/bill-readiness.ts, which the tests keep in step).
--   no_patient_pin       the invoice carries no PIN, so cover cannot be checked
--   no_eligibility       no eligibility check at all for the patient
--   eligibility_pending  the latest check has not been completed
--   eligibility_failed   the latest check failed
--   eligibility_expired  the latest verified check stopped covering the patient before the service date
--   no_card_on_file      the covering check has no insurance-card document
--   preauth_missing      a line needs a pre-authorisation and none covers the service date
-- Nothing is flagged until fin_ref_finance_settings.ready_start_date is set, nor inside ready_grace_days.
-- ---------------------------------------------------------------------------
create or replace view public.v_fin_billing_readiness with (security_invoker = false) as
with base as (
  select i.org_id, i.id as invoice_id, i.inv_display_number, i.transaction_date, i.branch_code, i.patient_pin,
         i.net, i.total, i.doctor_dha_id
  from public.fin_invoices i
  join public.fin_ref_finance_settings s on s.org_id = i.org_id
  where not i.is_deleted
    and public.fin_is_insurance_type(i.inv_type)
    and i.transaction_date is not null
    and s.ready_start_date is not null
    and i.transaction_date >= s.ready_start_date
    and i.transaction_date <= current_date - s.ready_grace_days
    and app.has_perm(i.org_id, 'finance.eligibility.manage')
    -- not yet claimed: no Diligence claim activity matched to this invoice or quoting its number
    and not exists (select 1 from public.ins_claim_activities c where c.org_id = i.org_id and c.matched_invoice_id = i.id)
    and not exists (
      select 1 from public.ins_claim_activities c
      where c.org_id = i.org_id and upper(regexp_replace(coalesce(c.invoice_no, ''), '\s+', '', 'g')) = i.inv_key
    )
), facts as (
  select b.*,
    exists (
      select 1 from public.fin_eligibility_checks e
      where e.org_id = b.org_id and e.patient_pin = b.patient_pin and e.status = 'verified'
        and (e.valid_from is null or e.valid_from <= b.transaction_date) and e.valid_to >= b.transaction_date
    ) as covered,
    (select e.document_id is null from public.fin_eligibility_checks e
      where e.org_id = b.org_id and e.patient_pin = b.patient_pin and e.status = 'verified'
        and (e.valid_from is null or e.valid_from <= b.transaction_date) and e.valid_to >= b.transaction_date
      order by e.checked_on desc, e.created_at desc limit 1) as card_missing,
    (select e.status from public.fin_eligibility_checks e
      where e.org_id = b.org_id and e.patient_pin = b.patient_pin
      order by e.checked_on desc nulls last, e.created_at desc limit 1) as latest_status,
    exists (
      select 1 from public.fin_invoice_lines l
      join public.fin_ref_services sv on sv.org_id = l.org_id and sv.item_code = l.item_code and sv.requires_preauth
      where l.invoice_id = b.invoice_id and l.is_current
    ) as needs_preauth,
    exists (
      select 1 from public.fin_pre_authorisations p
      where p.org_id = b.org_id and p.patient_pin = b.patient_pin and p.status in ('approved', 'partially_approved', 'used')
        and (p.valid_from is null or p.valid_from <= b.transaction_date) and p.expires_on >= b.transaction_date
    ) as has_preauth
  from base b
), judged as (
  select f.*,
    array_remove(array[
      case when f.patient_pin is null then 'no_patient_pin' end,
      case when f.patient_pin is not null and not f.covered then
        case coalesce(f.latest_status, 'none')
          when 'none' then 'no_eligibility'
          when 'pending' then 'eligibility_pending'
          when 'failed' then 'eligibility_failed'
          else 'eligibility_expired'
        end
      end,
      case when f.covered and coalesce(f.card_missing, false) then 'no_card_on_file' end,
      case when f.needs_preauth and not f.has_preauth then 'preauth_missing' end
    ], null) as reasons
  from facts f
)
select org_id, invoice_id, inv_display_number, transaction_date, branch_code, patient_pin, net, total, doctor_dha_id, reasons
from judged
where cardinality(reasons) > 0;

-- A view's caller needs EXECUTE on every function the view calls. fin_is_insurance_type() is the one pure, side-effect-free
-- definition of "insurance invoice" (F5 revoked it from signed-in users only because nothing needed it then).
grant execute on function public.fin_is_insurance_type(text) to authenticated;

revoke all on public.v_fin_billing_readiness from anon;
grant select on public.v_fin_billing_readiness to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- History tab: who changed what. Replaces app.can_view_record_history with the Phase 18 tables added.
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
    else exists (
      select 1 from public.portal_objects po
      where po.org_id = p_org_id and po.table_name = p_table and app.has_perm_wild(p_org_id, po.read_perm)
    )
  end;
$$;
grant execute on function app.can_view_record_history(uuid, text) to authenticated, service_role;

select app.enable_record_history('fin_pre_authorisations', 'expiry_notified_at');
select app.enable_record_history('fin_eligibility_checks');

-- ======================================================================
-- 20261016000300_finance_denials.sql
-- ======================================================================
-- Phase 18 (3/7): denial management.
--
--   ins_denial_cases    one case per denied claim activity: reason code (taxonomy in fin_ref_denial_codes), owner,
--                       resubmission deadline, status
--   ins_denial_notes    working notes on a case (append-only in practice; no update or delete policy)
--   ins_appeal_drafts   appeal letters: always a DRAFT, never sent from Pulse. Built from claim ids, reason codes and
--                       amounts only (no names), either by the AI (kind 'ai') or from a fixed template (kind 'template')
--   fin_sync_denial_cases()  opens / refreshes / closes cases from the Diligence claims; idempotent
--
-- The case row copies the identifiers a screen needs (claim number, invoice number, CPT, clinician id, payer id, net)
-- so the queue does not depend on the claims permission. Nothing here holds a patient name.


create table public.ins_denial_cases (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  claim_activity_id uuid not null references public.ins_claim_activities (id) on delete cascade,
  claim_number text not null,
  invoice_no text,
  cpt_code text,
  clinician_id text,
  payer_id text,
  claim_net numeric(14, 2),
  rejected_amount numeric(14, 2) not null default 0,
  reason_code text,
  category text not null default 'other'
    check (category in ('authorization', 'eligibility', 'medical_necessity', 'coding', 'documentation', 'duplicate', 'timely_filing', 'pricing', 'other')),
  appealable boolean not null default true,
  owner_role text not null default 'insurance' check (owner_role in ('insurance', 'billing', 'finance', 'admin')),
  owner_user_id uuid references public.profiles (id) on delete set null,
  status text not null default 'open'
    check (status in ('open', 'in_progress', 'appealed', 'resubmitted', 'won', 'lost', 'written_off', 'recovered', 'cancelled')),
  denied_on date not null,
  deadline_on date not null,
  deadline_notified_at timestamptz,                  -- atomic claim: the "deadline approaching" reminder is raised once
  task_id uuid references public.tasks (id) on delete set null,
  resolution text check (resolution is null or char_length(resolution) <= 200),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles (id) on delete set null,
  opened_by uuid references public.profiles (id) on delete set null,   -- null = opened by the nightly sync
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, claim_activity_id, denied_on),
  check (status in ('open', 'in_progress', 'appealed', 'resubmitted') or resolved_at is not null),
  check (deadline_on >= denied_on)
);
-- at most one live case per claim activity
create unique index ins_denial_cases_active_uidx on public.ins_denial_cases (org_id, claim_activity_id)
  where status in ('open', 'in_progress', 'appealed', 'resubmitted');
create index ins_denial_cases_queue_idx on public.ins_denial_cases (org_id, status, deadline_on);
create index ins_denial_cases_owner_idx on public.ins_denial_cases (org_id, owner_user_id)
  where status in ('open', 'in_progress', 'appealed', 'resubmitted');
create index ins_denial_cases_payer_idx on public.ins_denial_cases (org_id, payer_id, reason_code);

create table public.ins_denial_notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  case_id uuid not null references public.ins_denial_cases (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete set null,
  note text not null check (btrim(note) <> '' and char_length(note) <= 2000),
  created_at timestamptz not null default now()
);
create index ins_denial_notes_case_idx on public.ins_denial_notes (case_id, created_at);

create table public.ins_appeal_drafts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  case_id uuid not null references public.ins_denial_cases (id) on delete cascade,
  kind text not null check (kind in ('ai', 'template')),
  language text not null default 'en' check (language in ('en', 'ar')),
  body text not null check (btrim(body) <> '' and char_length(body) <= 12000),
  model text,                                        -- the model that wrote an 'ai' draft
  flags text[] not null default '{}',                -- why a human must read it carefully
  status text not null default 'draft' check (status in ('draft', 'discarded', 'marked_sent')),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  marked_sent_by uuid references public.profiles (id) on delete set null,
  marked_sent_at timestamptz,
  check (status <> 'marked_sent' or marked_sent_at is not null)
);
create index ins_appeal_drafts_case_idx on public.ins_appeal_drafts (case_id, created_at desc);

create trigger ins_denial_cases_set_updated_at before update on public.ins_denial_cases
  for each row execute function app.set_updated_at();
create trigger ins_denial_cases_claim_org_check before insert or update of claim_activity_id, org_id on public.ins_denial_cases
  for each row execute function app.check_parent_org('ins_claim_activities', 'claim_activity_id');
create trigger ins_denial_cases_task_org_check before insert or update of task_id, org_id on public.ins_denial_cases
  for each row execute function app.check_parent_org('tasks', 'task_id');
create trigger ins_denial_notes_case_org_check before insert or update of case_id, org_id on public.ins_denial_notes
  for each row execute function app.check_parent_org('ins_denial_cases', 'case_id');
create trigger ins_appeal_drafts_case_org_check before insert or update of case_id, org_id on public.ins_appeal_drafts
  for each row execute function app.check_parent_org('ins_denial_cases', 'case_id');

alter table public.ins_denial_cases enable row level security;
alter table public.ins_denial_notes enable row level security;
alter table public.ins_appeal_drafts enable row level security;

create policy ins_denial_cases_select on public.ins_denial_cases for select to authenticated
  using (app.has_perm(org_id, 'finance.denials.manage'));
create policy ins_denial_notes_select on public.ins_denial_notes for select to authenticated
  using (app.has_perm(org_id, 'finance.denials.manage'));
create policy ins_appeal_drafts_select on public.ins_appeal_drafts for select to authenticated
  using (app.has_perm(org_id, 'finance.denials.manage'));

-- ---------------------------------------------------------------------------
-- fin_sync_denial_cases(org): service role only. Idempotent. Reads every threshold from reference tables.
--   1. active cases whose claim no longer shows a rejected amount become 'recovered'
--   2. active cases take the claim's current rejected / net amounts
--   3. claims with a rejected amount and no live case open one (denied_on = last remittance date, else first,
--      else the claim's transaction date); the deadline is denied_on + the code's resubmit_days (exact code, then
--      its family, then the org default). Nothing opens before denial_cases_start_date.
-- ---------------------------------------------------------------------------
create or replace function public.fin_sync_denial_cases(p_org_id uuid, p_limit integer default 1000)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_start date;
  v_default integer;
  v_opened integer := 0;
  v_recovered integer := 0;
  v_refreshed integer := 0;
begin
  select s.denial_cases_start_date, s.denial_default_resubmit_days
    into v_start, v_default
    from public.fin_ref_finance_settings s where s.org_id = p_org_id;
  if v_start is null then
    return jsonb_build_object('skipped', 'not_enabled', 'opened', 0, 'recovered', 0, 'refreshed', 0);
  end if;

  update public.ins_denial_cases d
     set status = 'recovered', resolved_at = now(), resolution = 'The claim no longer shows a rejected amount'
    from public.ins_claim_activities c
   where d.org_id = p_org_id and c.id = d.claim_activity_id
     and d.status in ('open', 'in_progress', 'appealed', 'resubmitted')
     and coalesce(c.rejected, 0) = 0;
  get diagnostics v_recovered = row_count;

  update public.ins_denial_cases d
     set rejected_amount = c.rejected, claim_net = c.net
    from public.ins_claim_activities c
   where d.org_id = p_org_id and c.id = d.claim_activity_id
     and d.status in ('open', 'in_progress', 'appealed', 'resubmitted')
     and (d.rejected_amount is distinct from c.rejected or d.claim_net is distinct from c.net);
  get diagnostics v_refreshed = row_count;

  with cand as (
    select c.id as claim_id, c.claim_activity_number, c.invoice_no, c.cpt_code, c.clinician_id, c.payer_id, c.net, c.rejected,
           c.last_denial_code,
           coalesce(c.last_remittance_date, c.first_remittance_date, c.transaction_date) as denied_on
    from public.ins_claim_activities c
    where c.org_id = p_org_id and coalesce(c.rejected, 0) > 0
      and coalesce(c.last_remittance_date, c.first_remittance_date, c.transaction_date) >= v_start
      and not exists (
        select 1 from public.ins_denial_cases d
        where d.org_id = c.org_id and d.claim_activity_id = c.id
          and (d.status in ('open', 'in_progress', 'appealed', 'resubmitted')
               or d.denied_on = coalesce(c.last_remittance_date, c.first_remittance_date, c.transaction_date))
      )
    order by coalesce(c.last_remittance_date, c.first_remittance_date, c.transaction_date), c.id
    limit greatest(p_limit, 1)
  ), tax as (
    select cand.*, t.category, t.default_owner_role, t.appealable, t.resubmit_days
    from cand
    left join lateral (
      select t.* from public.fin_ref_denial_codes t
      where t.org_id = p_org_id and t.active and cand.last_denial_code is not null
        and ((not t.is_family and upper(t.code) = upper(cand.last_denial_code))
          or (t.is_family and upper(t.code) = upper(substring(cand.last_denial_code from '^[A-Za-z]+'))))
      order by t.is_family
      limit 1
    ) t on true
  )
  insert into public.ins_denial_cases (org_id, claim_activity_id, claim_number, invoice_no, cpt_code, clinician_id, payer_id,
                                       claim_net, rejected_amount, reason_code, category, appealable, owner_role, denied_on, deadline_on)
  select p_org_id, claim_id, claim_activity_number, invoice_no, cpt_code, clinician_id, payer_id,
         net, rejected, last_denial_code, coalesce(category, 'other'), coalesce(appealable, true),
         coalesce(default_owner_role, 'insurance'), denied_on, denied_on + coalesce(resubmit_days, v_default)
  from tax
  on conflict do nothing;
  get diagnostics v_opened = row_count;

  return jsonb_build_object('opened', v_opened, 'recovered', v_recovered, 'refreshed', v_refreshed);
end;
$$;
revoke all on function public.fin_sync_denial_cases(uuid, integer) from public, anon, authenticated;
grant execute on function public.fin_sync_denial_cases(uuid, integer) to service_role;

select app.enable_record_history('ins_denial_cases', 'deadline_notified_at');

-- ======================================================================
-- 20261016000400_finance_remittance.sql
-- ======================================================================
-- Phase 18 (4/7): remittance reconciliation.
--
-- A payer's payment advice (.xlsx or .csv) is parsed on the server. The advice can hold patient names and member IDs,
-- so, exactly like the Diligence flow, only SANITISED rows are staged for the preview and the uploaded file is deleted
-- at once; only its sha256 is kept (to block a second upload of the same bytes).
--
--   fin_raw_remittance_files       upload log + sha256 + validation result       (service role only: RLS, no policy)
--   fin_staged_remittance_lines    sanitised rows waiting for confirmation       (service role only: RLS, no policy)
--   ins_remittance_batches         one reconciled advice                          (finance.remittance.manage)
--   ins_remittance_lines           every line with its claim match, the expected amount and the flags
--   ins_commit_remittance()        atomic commit of a validated file
--
-- Matching and the short-payment rule are pure TypeScript (lib/finance/match-remittance.ts); this function only stores
-- what the server computed. Claims themselves are never changed here: Diligence stays the source of truth.

create table public.fin_raw_remittance_files (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  file_name text check (file_name is null or char_length(file_name) <= 200),
  file_sha256 text not null,                         -- blocks duplicate uploads
  uploaded_by uuid references public.profiles (id) on delete set null,
  uploaded_at timestamptz not null default now(),
  row_count integer,
  sum_paid numeric(16, 2),
  header_check jsonb not null default '{}'::jsonb,
  errors jsonb not null default '[]'::jsonb,
  status text not null default 'validated' check (status in ('validated', 'committed', 'rejected')),
  committed_at timestamptz,
  committed_by uuid references public.profiles (id) on delete set null,
  unique (org_id, file_sha256)
);
create index fin_raw_remittance_files_org_idx on public.fin_raw_remittance_files (org_id, uploaded_at desc);
alter table public.fin_raw_remittance_files enable row level security;      -- service role only

create table public.fin_staged_remittance_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  file_id uuid not null references public.fin_raw_remittance_files (id) on delete cascade,
  row_no integer not null,
  data jsonb not null,                               -- sanitised line
  created_at timestamptz not null default now(),
  unique (file_id, row_no)
);
create index fin_staged_remittance_lines_file_idx on public.fin_staged_remittance_lines (file_id, row_no);
alter table public.fin_staged_remittance_lines enable row level security;  -- service role only
create trigger fin_staged_remittance_file_org_check before insert or update of file_id, org_id on public.fin_staged_remittance_lines
  for each row execute function app.check_parent_org('fin_raw_remittance_files', 'file_id');

create table public.ins_remittance_batches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  file_id uuid references public.fin_raw_remittance_files (id) on delete set null,
  remittance_ref text check (remittance_ref is null or char_length(remittance_ref) <= 80),
  payer_id text,
  paid_on date,
  line_count integer not null default 0,
  matched_count integer not null default 0,
  unmatched_count integer not null default 0,
  short_count integer not null default 0,
  sum_paid numeric(16, 2) not null default 0,
  sum_expected numeric(16, 2) not null default 0,
  sum_short numeric(16, 2) not null default 0,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index ins_remittance_batches_org_idx on public.ins_remittance_batches (org_id, created_at desc);

create table public.ins_remittance_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  batch_id uuid not null references public.ins_remittance_batches (id) on delete cascade,
  row_no integer not null,
  line_key text not null,                            -- idempotence: the same advice line is never stored twice
  remittance_ref text,
  claim_activity_number text,
  invoice_no text,
  cpt_code text,
  payer_id text,
  quantity numeric(12, 3),
  claimed_amount numeric(14, 2),
  paid_amount numeric(14, 2) not null default 0,
  denied_amount numeric(14, 2) not null default 0,
  denial_code text,
  paid_on date,
  claim_activity_id uuid references public.ins_claim_activities (id) on delete set null,
  match_status text not null check (match_status in ('matched', 'unmatched', 'ambiguous')),
  match_reason text,
  expected_amount numeric(14, 2),
  expected_basis text not null default 'none' check (expected_basis in ('price_list', 'claim_net', 'file', 'none')),
  short_amount numeric(14, 2) not null default 0,
  flags text[] not null default '{}',
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,
  review_note text check (review_note is null or char_length(review_note) <= 500),
  created_at timestamptz not null default now(),
  unique (org_id, line_key)
);
create index ins_remittance_lines_batch_idx on public.ins_remittance_lines (batch_id, row_no);
create index ins_remittance_lines_flags_idx on public.ins_remittance_lines (org_id, reviewed_at) where cardinality(flags) > 0;
create index ins_remittance_lines_claim_idx on public.ins_remittance_lines (claim_activity_id) where claim_activity_id is not null;

create trigger ins_remittance_batches_file_org_check before insert or update of file_id, org_id on public.ins_remittance_batches
  for each row execute function app.check_parent_org('fin_raw_remittance_files', 'file_id');
create trigger ins_remittance_lines_batch_org_check before insert or update of batch_id, org_id on public.ins_remittance_lines
  for each row execute function app.check_parent_org('ins_remittance_batches', 'batch_id');
create trigger ins_remittance_lines_claim_org_check before insert or update of claim_activity_id, org_id on public.ins_remittance_lines
  for each row execute function app.check_parent_org('ins_claim_activities', 'claim_activity_id');

alter table public.ins_remittance_batches enable row level security;
alter table public.ins_remittance_lines enable row level security;
create policy ins_remittance_batches_select on public.ins_remittance_batches for select to authenticated
  using (app.has_perm(org_id, 'finance.remittance.manage'));
create policy ins_remittance_lines_select on public.ins_remittance_lines for select to authenticated
  using (app.has_perm(org_id, 'finance.remittance.manage'));

-- ---------------------------------------------------------------------------
-- ins_commit_remittance: store one reconciled advice atomically.
--   p_batch : {remittance_ref, payer_id, paid_on}
--   p_lines : [{row_no, line_key, remittance_ref, claim_activity_number, invoice_no, cpt_code, payer_id, quantity,
--               claimed_amount, paid_amount, denied_amount, denial_code, paid_on, claim_activity_id, match_status,
--               match_reason, expected_amount, expected_basis, short_amount, flags}]
-- Lines whose line_key already exists (a re-keyed upload of the same advice) are skipped and counted.
-- ---------------------------------------------------------------------------
create or replace function public.ins_commit_remittance(
  p_org_id uuid,
  p_file_id uuid,
  p_user_id uuid,
  p_batch jsonb,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_file public.fin_raw_remittance_files;
  v_batch uuid;
  v_inserted integer;
  v_total integer;
begin
  perform pg_advisory_xact_lock(hashtext('ins_remit:' || p_org_id::text));

  select * into v_file from public.fin_raw_remittance_files where id = p_file_id and org_id = p_org_id for update;
  if not found then
    raise exception 'file % not found in org %', p_file_id, p_org_id using errcode = 'no_data_found';
  end if;
  if v_file.status <> 'validated' then
    raise exception 'file is % and cannot be committed', v_file.status using errcode = 'check_violation';
  end if;

  insert into public.ins_remittance_batches (org_id, file_id, remittance_ref, payer_id, paid_on, created_by)
  values (p_org_id, p_file_id, nullif(p_batch ->> 'remittance_ref', ''), nullif(p_batch ->> 'payer_id', ''),
          nullif(p_batch ->> 'paid_on', '')::date, p_user_id)
  returning id into v_batch;

  select count(*) into v_total from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb));

  insert into public.ins_remittance_lines (org_id, batch_id, row_no, line_key, remittance_ref, claim_activity_number, invoice_no,
    cpt_code, payer_id, quantity, claimed_amount, paid_amount, denied_amount, denial_code, paid_on, claim_activity_id,
    match_status, match_reason, expected_amount, expected_basis, short_amount, flags)
  select p_org_id, v_batch, r.row_no, r.line_key, r.remittance_ref, r.claim_activity_number, r.invoice_no,
         r.cpt_code, r.payer_id, r.quantity, r.claimed_amount, coalesce(r.paid_amount, 0), coalesce(r.denied_amount, 0),
         r.denial_code, r.paid_on, r.claim_activity_id, r.match_status, r.match_reason, r.expected_amount,
         coalesce(r.expected_basis, 'none'), coalesce(r.short_amount, 0), coalesce(r.flags, '{}')
  from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb)) as r(
    row_no integer, line_key text, remittance_ref text, claim_activity_number text, invoice_no text, cpt_code text,
    payer_id text, quantity numeric, claimed_amount numeric, paid_amount numeric, denied_amount numeric, denial_code text,
    paid_on date, claim_activity_id uuid, match_status text, match_reason text, expected_amount numeric,
    expected_basis text, short_amount numeric, flags text[]
  )
  on conflict (org_id, line_key) do nothing;
  get diagnostics v_inserted = row_count;

  update public.ins_remittance_batches b
     set line_count = s.n, matched_count = s.matched, unmatched_count = s.unmatched, short_count = s.short,
         sum_paid = s.paid, sum_expected = s.expected, sum_short = s.short_amount
    from (
      select count(*) as n,
             count(*) filter (where match_status = 'matched') as matched,
             count(*) filter (where match_status <> 'matched') as unmatched,
             count(*) filter (where 'short_paid' = any (flags)) as short,
             coalesce(sum(paid_amount), 0) as paid,
             coalesce(sum(expected_amount), 0) as expected,
             coalesce(sum(short_amount), 0) as short_amount
      from public.ins_remittance_lines where batch_id = v_batch
    ) s
   where b.id = v_batch;

  update public.fin_raw_remittance_files
     set status = 'committed', committed_at = now(), committed_by = p_user_id
   where id = p_file_id;
  delete from public.fin_staged_remittance_lines where file_id = p_file_id;

  return jsonb_build_object('batch_id', v_batch, 'lines', v_inserted, 'duplicates_skipped', v_total - v_inserted);
end;
$$;
revoke all on function public.ins_commit_remittance(uuid, uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.ins_commit_remittance(uuid, uuid, uuid, jsonb, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- ins_claims_for_remittance: the candidate claims for a batch of advice lines, found by claim number or by normalised
-- invoice number (the same normalisation as fin_invoices.inv_key). Identifiers and amounts only.
-- ---------------------------------------------------------------------------
create or replace function public.ins_claims_for_remittance(p_org_id uuid, p_numbers text[], p_invoice_keys text[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'claim_activity_number', c.claim_activity_number, 'invoice_no', c.invoice_no, 'cpt_code', c.cpt_code,
    'payer_id', c.payer_id, 'quantity', c.quantity, 'net', c.net, 'transaction_date', c.transaction_date,
    'activity_start_date', c.activity_start_date)), '[]'::jsonb)
  from public.ins_claim_activities c
  where c.org_id = p_org_id
    and (upper(btrim(c.claim_activity_number)) = any (select upper(btrim(x)) from unnest(coalesce(p_numbers, '{}')) as x)
         or upper(regexp_replace(coalesce(c.invoice_no, ''), '\s+', '', 'g')) = any (coalesce(p_invoice_keys, '{}')));
$$;
revoke all on function public.ins_claims_for_remittance(uuid, text[], text[]) from public, anon, authenticated;
grant execute on function public.ins_claims_for_remittance(uuid, text[], text[]) to service_role;

-- ======================================================================
-- 20261016000500_finance_analytics.sql
-- ======================================================================
-- Phase 18 (5/7): analytics for payer scorecards, the collections forecast, revenue views, self-pay recovery,
-- the accounting export and the cash-up.
--
-- Every function here is SECURITY DEFINER, takes the organisation explicitly and is executable by the SERVICE ROLE ONLY:
-- the server runs can('finance.<feature>') first, then calls the function with member.orgId (CLAUDE.md rule 2). They
-- return jsonb (one value, so PostgREST's row cap never truncates a report). Identifiers and amounts only: the finance
-- tables hold no patient names, and none of these functions reads the raw payload tables.
--
-- Definitions are single-sourced here (CLAUDE.md "single definition of every number"):
--   outstanding (insurance)  = greatest(net - remitted - approved write-off, 0)         (same as v_fin_receivables_ageing)
--   denied claim             = initial_rejected > 0 or rejected > 0
--   days to pay              = first_remittance_date - transaction_date, claims with a remitted amount, never negative
--   self-pay balance         = total - paid + refund - write_off - credit_note, floored at 0
--   self-pay invoice         = upper(inv_type) like 'SELF%'                              (same as v_fin_monthly_summary)

-- ---------------------------------------------------------------------------
-- Payer scorecards: grouped by payer | doctor | department | branch for claims dated in [p_from, p_to]
-- ---------------------------------------------------------------------------
create or replace function public.fin_payer_scorecard(
  p_org_id uuid, p_from date, p_to date, p_group text, p_payer text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if p_group not in ('payer', 'doctor', 'department', 'branch') then
    raise exception 'unknown scorecard grouping %', p_group using errcode = 'invalid_parameter_value';
  end if;
  with base as (
    select c.id,
           case p_group
             when 'payer' then coalesce(c.payer_id, '(no payer)')
             when 'doctor' then coalesce(c.clinician_id, '(no doctor)')
             when 'department' then coalesce(d.department, i.department, '(no department)')
             else coalesce(i.branch_code, '(no branch)')
           end as group_key,
           case p_group when 'doctor' then d.name when 'payer' then pr.payer_name else null end as group_label,
           (coalesce(c.initial_rejected, 0) > 0 or coalesce(c.rejected, 0) > 0) as denied,
           coalesce(c.net, 0) as net, coalesce(c.remitted, 0) as remitted, coalesce(c.rejected, 0) as rejected,
           case when coalesce(c.remitted, 0) > 0 and c.first_remittance_date is not null and c.transaction_date is not null
                then greatest(c.first_remittance_date - c.transaction_date, 0) end as days_to_pay
    from public.ins_claim_activities c
    left join public.fin_invoices i on i.id = c.matched_invoice_id
    left join public.fin_ref_doctors d on d.org_id = c.org_id and d.dha_id = c.clinician_id
    left join public.fin_ref_payers pr on pr.org_id = c.org_id and pr.payer_id = c.payer_id
    where c.org_id = p_org_id and c.transaction_date between p_from and p_to
      and (p_payer is null or c.payer_id = p_payer)
  )
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.claims desc, t.group_key), '[]'::jsonb) into v_result
  from (
    select group_key, max(group_label) as group_label,
           count(*) as claims,
           count(*) filter (where denied) as denied_claims,
           round(sum(net), 2) as net, round(sum(remitted), 2) as remitted, round(sum(rejected), 2) as rejected,
           count(days_to_pay) as paid_claims,
           round(avg(days_to_pay)::numeric, 1) as avg_days_to_pay,
           round((percentile_cont(0.9) within group (order by days_to_pay))::numeric, 1) as p90_days_to_pay
    from base group by group_key
  ) t;
  return v_result;
end;
$$;
revoke all on function public.fin_payer_scorecard(uuid, date, date, text, text) from public, anon, authenticated;
grant execute on function public.fin_payer_scorecard(uuid, date, date, text, text) to service_role;

-- Top denial reasons in the period (code, taxonomy description, claim count, amount)
create or replace function public.fin_denial_reasons(
  p_org_id uuid, p_from date, p_to date, p_payer text default null, p_limit integer default 10
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.claims desc, t.reason_code), '[]'::jsonb)
  from (
    select coalesce(c.last_denial_code, '(no code)') as reason_code,
           max(tax.description) as description,
           max(tax.category) as category,
           count(*) as claims,
           round(sum(coalesce(c.rejected, 0)), 2) as amount
    from public.ins_claim_activities c
    left join lateral (
      select t.description, t.category from public.fin_ref_denial_codes t
      where t.org_id = c.org_id and t.active and c.last_denial_code is not null
        and ((not t.is_family and upper(t.code) = upper(c.last_denial_code))
          or (t.is_family and upper(t.code) = upper(substring(c.last_denial_code from '^[A-Za-z]+'))))
      order by t.is_family limit 1
    ) tax on true
    where c.org_id = p_org_id and c.transaction_date between p_from and p_to
      and (coalesce(c.rejected, 0) > 0 or coalesce(c.initial_rejected, 0) > 0)
      and (p_payer is null or c.payer_id = p_payer)
    group by coalesce(c.last_denial_code, '(no code)')
    order by count(*) desc, 1
    limit greatest(p_limit, 1)
  ) t;
$$;
revoke all on function public.fin_denial_reasons(uuid, date, date, text, integer) from public, anon, authenticated;
grant execute on function public.fin_denial_reasons(uuid, date, date, text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- Collections forecast inputs
--   fin_forecast_outstanding: what is still owed, by payer and week of the claim date
--   fin_forecast_history:     how each payer has paid so far (days-to-pay percentiles and collection rate)
-- ---------------------------------------------------------------------------
create or replace function public.fin_forecast_outstanding(p_org_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.payer_id, t.week_start), '[]'::jsonb)
  from (
    select coalesce(c.payer_id, '(no payer)') as payer_id,
           date_trunc('week', c.transaction_date)::date as week_start,
           count(*) as claims,
           round(sum(greatest(coalesce(c.net, 0) - coalesce(c.remitted, 0)
                 - case when lower(coalesce(c.write_off_status, '')) = 'approved' then coalesce(c.write_off, 0) else 0 end, 0)), 2) as outstanding
    from public.ins_claim_activities c
    where c.org_id = p_org_id and c.transaction_date is not null
      and greatest(coalesce(c.net, 0) - coalesce(c.remitted, 0)
            - case when lower(coalesce(c.write_off_status, '')) = 'approved' then coalesce(c.write_off, 0) else 0 end, 0) > 0
    group by 1, 2
  ) t;
$$;
revoke all on function public.fin_forecast_outstanding(uuid) from public, anon, authenticated;
grant execute on function public.fin_forecast_outstanding(uuid) to service_role;

create or replace function public.fin_forecast_history(p_org_id uuid, p_mature_days integer default 120)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.payer_id), '[]'::jsonb)
  from (
    select coalesce(c.payer_id, '(no payer)') as payer_id,
           count(*) filter (where days.d is not null) as paid_claims,
           round((percentile_cont(0.25) within group (order by days.d))::numeric, 1) as p25,
           round((percentile_cont(0.50) within group (order by days.d))::numeric, 1) as p50,
           round((percentile_cont(0.75) within group (order by days.d))::numeric, 1) as p75,
           round((percentile_cont(0.90) within group (order by days.d))::numeric, 1) as p90,
           -- collection rate over claims old enough that they should have been paid by now
           count(*) filter (where c.transaction_date <= current_date - p_mature_days) as mature_claims,
           round(coalesce(
             sum(least(coalesce(c.remitted, 0), coalesce(c.net, 0))) filter (where c.transaction_date <= current_date - p_mature_days)
             / nullif(sum(coalesce(c.net, 0)) filter (where c.transaction_date <= current_date - p_mature_days), 0), 0), 4) as collection_rate
    from public.ins_claim_activities c
    cross join lateral (
      select case when coalesce(c.remitted, 0) > 0 and c.first_remittance_date is not null and c.transaction_date is not null
                  then greatest(c.first_remittance_date - c.transaction_date, 0) end as d
    ) days
    where c.org_id = p_org_id and c.transaction_date is not null
    group by 1
  ) t;
$$;
revoke all on function public.fin_forecast_history(uuid, integer) from public, anon, authenticated;
grant execute on function public.fin_forecast_history(uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- Revenue breakdown: net revenue by doctor | department | branch | service | category | month for invoices dated in range
-- ---------------------------------------------------------------------------
create or replace function public.fin_revenue_breakdown(
  p_org_id uuid, p_from date, p_to date, p_dimension text, p_branch text default null, p_limit integer default 300
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if p_dimension not in ('doctor', 'department', 'branch', 'service', 'category', 'month') then
    raise exception 'unknown revenue dimension %', p_dimension using errcode = 'invalid_parameter_value';
  end if;
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.net desc nulls last, t.key), '[]'::jsonb) into v_result
  from (
    select x.key, max(x.label) as label,
           round(sum(x.net), 2) as net, round(sum(x.gross), 2) as gross, round(sum(x.discount), 2) as discount,
           round(sum(x.vat), 2) as vat, count(*) as lines, count(distinct x.invoice_id) as invoices
    from (
      select i.id as invoice_id,
             case p_dimension
               when 'doctor' then coalesce(i.doctor_dha_id, '(no doctor)')
               when 'department' then coalesce(i.department, d.department, '(no department)')
               when 'branch' then coalesce(i.branch_code, '(no branch)')
               when 'service' then coalesce(l.item_code, '(no item)')
               when 'category' then coalesce(s.service_category, 'Unmapped')
               else to_char(date_trunc('month', i.transaction_date), 'YYYY-MM')
             end as key,
             case p_dimension
               when 'doctor' then coalesce(d.name, i.doctor_name)
               when 'service' then s.description
               when 'branch' then b.name
               else null
             end as label,
             coalesce(l.line_net, 0) as net, coalesce(l.line_gross, 0) as gross,
             coalesce(l.line_discount, 0) as discount, coalesce(l.vat, 0) as vat
      from public.fin_invoices i
      join public.fin_invoice_lines l on l.invoice_id = i.id and l.is_current
      left join public.fin_ref_services s on s.org_id = i.org_id and s.item_code = l.item_code
      left join public.fin_ref_doctors d on d.org_id = i.org_id and d.dha_id = i.doctor_dha_id
      left join public.fin_ref_branches b on b.org_id = i.org_id and b.code = i.branch_code
      where i.org_id = p_org_id and not i.is_deleted and i.transaction_date between p_from and p_to
        and (p_branch is null or i.branch_code = p_branch)
    ) x
    group by x.key
    order by sum(x.net) desc nulls last, x.key
    limit greatest(p_limit, 1)
  ) t;
  return v_result;
end;
$$;
revoke all on function public.fin_revenue_breakdown(uuid, date, date, text, text, integer) from public, anon, authenticated;
grant execute on function public.fin_revenue_breakdown(uuid, date, date, text, text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- Self-pay balances (candidates for a WhatsApp reminder). PIN only: the server resolves the patient.
-- ---------------------------------------------------------------------------
create or replace function public.fin_selfpay_balances(
  p_org_id uuid, p_min_balance numeric default 0, p_min_days integer default 0, p_limit integer default 500
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.transaction_date, t.inv_display_number), '[]'::jsonb)
  from (
    select i.id as invoice_id, i.inv_display_number, i.patient_pin, i.transaction_date, i.branch_code,
           round(coalesce(i.total, 0), 2) as total,
           round(coalesce(p.paid, 0) - coalesce(p.refund, 0), 2) as settled,
           round(greatest(coalesce(i.total, 0) - coalesce(p.paid, 0) + coalesce(p.refund, 0)
                 - coalesce(i.write_off, 0) - coalesce(i.credit_note, 0), 0), 2) as balance,
           (current_date - i.transaction_date) as days_old
    from public.fin_invoices i
    left join lateral (
      select sum(pay.paid) as paid, sum(pay.refund) as refund
      from public.fin_payments pay where pay.invoice_id = i.id and pay.is_current
    ) p on true
    where i.org_id = p_org_id and not i.is_deleted and upper(coalesce(i.inv_type, '')) like 'SELF%'
      and i.transaction_date is not null and i.patient_pin is not null
      and (current_date - i.transaction_date) >= p_min_days
      and greatest(coalesce(i.total, 0) - coalesce(p.paid, 0) + coalesce(p.refund, 0)
            - coalesce(i.write_off, 0) - coalesce(i.credit_note, 0), 0) >= greatest(p_min_balance, 0.01)
    order by i.transaction_date, i.inv_display_number
    limit greatest(p_limit, 1)
  ) t;
$$;
revoke all on function public.fin_selfpay_balances(uuid, numeric, integer, integer) from public, anon, authenticated;
grant execute on function public.fin_selfpay_balances(uuid, numeric, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- Accounting export source: daily aggregates by branch and invoice type. Pure inputs for lib/finance/accounting-export.ts
-- (which turns them into balanced journal lines with the account map).
--   type: insurance | self_pay | other
-- ---------------------------------------------------------------------------
create or replace function public.fin_journal_source(p_org_id uuid, p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with inv as (
    select i.id, i.transaction_date as date, coalesce(i.branch_code, '(none)') as branch,
           case when public.fin_is_insurance_type(i.inv_type) then 'insurance'
                when upper(coalesce(i.inv_type, '')) like 'SELF%' then 'self_pay'
                else 'other' end as type,
           coalesce(i.total, 0) as total, coalesce(i.write_off, 0) as write_off, coalesce(i.credit_note, 0) as credit_note
    from public.fin_invoices i
    where i.org_id = p_org_id and not i.is_deleted and i.transaction_date between p_from and p_to
  ), sales as (
    select inv.date, inv.branch, inv.type, coalesce(s.service_category, 'Unmapped') as category,
           round(sum(coalesce(l.line_net, 0)), 2) as net, round(sum(coalesce(l.vat, 0)), 2) as vat
    from inv
    join public.fin_invoice_lines l on l.invoice_id = inv.id and l.is_current
    left join public.fin_ref_services s on s.org_id = p_org_id and s.item_code = l.item_code
    group by 1, 2, 3, 4
  ), totals as (
    select date, branch, type, round(sum(total), 2) as total, round(sum(write_off), 2) as write_off, round(sum(credit_note), 2) as credit_note
    from inv group by 1, 2, 3
  ), receipts as (
    select p.paid_date as date, coalesce(i.branch_code, '(none)') as branch,
           case when public.fin_is_insurance_type(i.inv_type) then 'insurance'
                when upper(coalesce(i.inv_type, '')) like 'SELF%' then 'self_pay'
                else 'other' end as type,
           coalesce(nullif(btrim(p.payment_mode), ''), '(unknown)') as mode,
           round(sum(coalesce(p.paid, 0)), 2) as paid
    from public.fin_payments p
    join public.fin_invoices i on i.id = p.invoice_id
    where p.org_id = p_org_id and p.is_current and not i.is_deleted and p.paid_date between p_from and p_to
    group by 1, 2, 3, 4
  ), refunds as (
    select coalesce(p.refund_date, p.paid_date) as date, coalesce(i.branch_code, '(none)') as branch,
           case when public.fin_is_insurance_type(i.inv_type) then 'insurance'
                when upper(coalesce(i.inv_type, '')) like 'SELF%' then 'self_pay'
                else 'other' end as type,
           coalesce(nullif(btrim(p.payment_mode), ''), '(unknown)') as mode,
           round(sum(coalesce(p.refund, 0)), 2) as refund
    from public.fin_payments p
    join public.fin_invoices i on i.id = p.invoice_id
    where p.org_id = p_org_id and p.is_current and not i.is_deleted and coalesce(p.refund, 0) <> 0
      and coalesce(p.refund_date, p.paid_date) between p_from and p_to
    group by 1, 2, 3, 4
  )
  select jsonb_build_object(
    'sales',    coalesce((select jsonb_agg(row_to_json(s)::jsonb order by s.date, s.branch, s.type, s.category) from sales s), '[]'::jsonb),
    'totals',   coalesce((select jsonb_agg(row_to_json(t)::jsonb order by t.date, t.branch, t.type) from totals t), '[]'::jsonb),
    'receipts', coalesce((select jsonb_agg(row_to_json(r)::jsonb order by r.date, r.branch, r.type, r.mode) from receipts r), '[]'::jsonb),
    'refunds',  coalesce((select jsonb_agg(row_to_json(f)::jsonb order by f.date, f.branch, f.type, f.mode) from refunds f), '[]'::jsonb)
  );
$$;
revoke all on function public.fin_journal_source(uuid, date, date) from public, anon, authenticated;
grant execute on function public.fin_journal_source(uuid, date, date) to service_role;

-- ---------------------------------------------------------------------------
-- Cash-up: what the system says was paid at a branch on a day, by payment mode (paid minus refunds that day)
-- ---------------------------------------------------------------------------
create or replace function public.fin_cashup_expected(p_org_id uuid, p_branch text, p_date date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with paid as (
    select coalesce(nullif(btrim(p.payment_mode), ''), '(unknown)') as mode, sum(coalesce(p.paid, 0)) as amount, count(*) as payments
    from public.fin_payments p
    join public.fin_invoices i on i.id = p.invoice_id
    where p.org_id = p_org_id and p.is_current and not i.is_deleted and p.paid_date = p_date
      and coalesce(i.branch_code, '(none)') = p_branch
    group by 1
  ), refunded as (
    select coalesce(nullif(btrim(p.payment_mode), ''), '(unknown)') as mode, sum(coalesce(p.refund, 0)) as amount
    from public.fin_payments p
    join public.fin_invoices i on i.id = p.invoice_id
    where p.org_id = p_org_id and p.is_current and not i.is_deleted and coalesce(p.refund_date, p.paid_date) = p_date
      and coalesce(p.refund, 0) <> 0 and coalesce(i.branch_code, '(none)') = p_branch
    group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'mode', m.mode,
           'expected', round(coalesce(pd.amount, 0) - coalesce(rf.amount, 0), 2),
           'payments', coalesce(pd.payments, 0)) order by m.mode), '[]'::jsonb)
  from (select mode from paid union select mode from refunded) m
  left join paid pd on pd.mode = m.mode
  left join refunded rf on rf.mode = m.mode;
$$;
revoke all on function public.fin_cashup_expected(uuid, text, date) from public, anon, authenticated;
grant execute on function public.fin_cashup_expected(uuid, text, date) to service_role;

-- ======================================================================
-- 20261016000600_finance_close_cashup.sql
-- ======================================================================
-- Phase 18 (6/7): month-end close with a LOCK, and the end-of-day cash-up.
--
--   fin_period_closes   one row per month: the frozen snapshot of the month's figures (and its sha256), the finance
--                       sign-off and the CEO sign-off. The CEO sign-off locks the month.
--   fin_cashups / fin_cashup_lines   the cash-up per branch and day, by payment mode
--
-- WHAT "LOCKED" MEANS (enforced here, not in the application):
--   * the close row, its snapshot and its sign-offs can never change or be deleted again (trigger, no bypass: not even
--     the service role; only removing the whole organisation cascades it away);
--   * the snapshot's hash is re-checked at lock time, so a locked month is exactly what both signers approved;
--   * cash-ups dated inside a locked month cannot be inserted, changed or deleted.
--   What is NOT blocked: the Unite and Diligence mirrors. Unite delivers each record once and may re-send an amended
--   invoice; refusing it would lose data. A late change to a locked month is therefore stored (raw first) but never
--   alters the frozen pack; lib/finance/close-drift.ts shows the difference between the live figures and the snapshot.
--
-- Sign-offs are bound to the hash the signer was looking at, and the CEO cannot be the person who signed for finance.

create table public.fin_period_closes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  month date not null check (month = date_trunc('month', month)::date),
  status text not null default 'open' check (status in ('open', 'built', 'finance_signed', 'locked')),
  snapshot jsonb check (snapshot is null or jsonb_typeof(snapshot) = 'object'),
  snapshot_hash text,
  built_at timestamptz,
  built_by uuid references public.profiles (id) on delete set null,
  finance_signed_by uuid references public.profiles (id) on delete set null,
  finance_signed_at timestamptz,
  finance_note text check (finance_note is null or char_length(finance_note) <= 500),
  ceo_signed_by uuid references public.profiles (id) on delete set null,
  ceo_signed_at timestamptz,
  ceo_note text check (ceo_note is null or char_length(ceo_note) <= 500),
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, month),
  check (status = 'open' or (snapshot is not null and snapshot_hash is not null and built_at is not null)),
  check (status not in ('finance_signed', 'locked') or (finance_signed_at is not null)),
  check (status <> 'locked' or (ceo_signed_at is not null and locked_at is not null)),
  check ((status = 'locked') = (locked_at is not null)),
  check (finance_signed_by is null or ceo_signed_by is null or finance_signed_by <> ceo_signed_by)
);
create index fin_period_closes_org_idx on public.fin_period_closes (org_id, month desc);
create trigger fin_period_closes_set_updated_at before update on public.fin_period_closes
  for each row execute function app.set_updated_at();

-- The immutability rule. Runs for every role, including the service role.
create or replace function app.fin_period_close_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    -- cascading from a deleted organisation is the only way out
    if old.locked_at is not null and exists (select 1 from public.orgs o where o.id = old.org_id) then
      raise exception 'a locked month cannot be deleted' using errcode = '42501';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if old.locked_at is not null then
      -- the FK action that nulls a deleted user's id is the one permitted change
      if (to_jsonb(new) - 'built_by' - 'finance_signed_by' - 'ceo_signed_by' - 'updated_at')
         is not distinct from (to_jsonb(old) - 'built_by' - 'finance_signed_by' - 'ceo_signed_by' - 'updated_at')
         and (new.built_by is null or new.built_by = old.built_by)
         and (new.finance_signed_by is null or new.finance_signed_by = old.finance_signed_by)
         and (new.ceo_signed_by is null or new.ceo_signed_by = old.ceo_signed_by) then
        return new;
      end if;
      raise exception 'a locked month is immutable' using errcode = '42501';
    end if;
    if new.org_id <> old.org_id or new.month <> old.month then
      raise exception 'the month of a close cannot change' using errcode = 'check_violation';
    end if;
    if not (
         (old.status = new.status and old.status in ('open', 'built'))
      or (old.status = 'open' and new.status = 'built')
      or (old.status = 'built' and new.status = 'finance_signed')
      or (old.status = 'finance_signed' and new.status = 'built')                       -- sign-off withdrawn
      or (old.status = 'finance_signed' and new.status = 'locked')                      -- CEO sign-off
      or (old.status = 'finance_signed' and new.status = 'finance_signed'               -- noise columns / a deleted user's id only
          and (new.finance_signed_by is null or new.finance_signed_by = old.finance_signed_by))
    ) then
      raise exception 'invalid close transition % -> %', old.status, new.status using errcode = 'check_violation';
    end if;
    -- the snapshot can change only while the pack is being built; signing, withdrawing and locking never touch it
    if not (old.status in ('open', 'built') and new.status = 'built')
       and (new.snapshot is distinct from old.snapshot or new.snapshot_hash is distinct from old.snapshot_hash) then
      raise exception 'the snapshot cannot change once the pack is signed' using errcode = 'check_violation';
    end if;
    if new.status = 'locked' then
      if new.snapshot_hash is distinct from encode(sha256(convert_to(new.snapshot::text, 'UTF8')), 'hex') then
        raise exception 'the snapshot does not match its hash' using errcode = 'check_violation';
      end if;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.fin_period_close_guard() from public, anon, authenticated;
create trigger fin_period_closes_guard before update or delete on public.fin_period_closes
  for each row execute function app.fin_period_close_guard();

alter table public.fin_period_closes enable row level security;
create policy fin_period_closes_select on public.fin_period_closes for select to authenticated
  using (app.has_perm(org_id, 'finance.close.view') or app.has_perm(org_id, 'finance.close.manage')
      or app.has_perm(org_id, 'finance.close.signoff.finance') or app.has_perm(org_id, 'finance.close.signoff.ceo'));

-- Is a month locked? (cash-ups consult this)
create or replace function app.fin_month_is_locked(p_org_id uuid, p_date date)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.fin_period_closes c
    where c.org_id = p_org_id and c.month = date_trunc('month', p_date)::date and c.locked_at is not null
  );
$$;
revoke all on function app.fin_month_is_locked(uuid, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Cash-up
-- ---------------------------------------------------------------------------
create table public.fin_cashups (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  branch_code text not null check (char_length(branch_code) between 1 and 20),
  business_date date not null,
  status text not null default 'draft' check (status in ('draft', 'submitted')),
  note text check (note is null or char_length(note) <= 500),
  prepared_by uuid references public.profiles (id) on delete set null,
  submitted_by uuid references public.profiles (id) on delete set null,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, branch_code, business_date),
  check ((status = 'submitted') = (submitted_at is not null))
);
create index fin_cashups_org_date_idx on public.fin_cashups (org_id, business_date desc);

create table public.fin_cashup_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  cashup_id uuid not null references public.fin_cashups (id) on delete cascade,
  payment_mode text not null check (char_length(payment_mode) between 1 and 60),
  expected_amount numeric(14, 2) not null default 0,   -- what the system recorded, refreshed while the cash-up is a draft
  counted_amount numeric(14, 2) check (counted_amount is null or counted_amount >= 0),
  variance numeric(14, 2) generated always as (counted_amount - expected_amount) stored,
  reason text check (reason is null or char_length(reason) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (cashup_id, payment_mode)
);
create index fin_cashup_lines_cashup_idx on public.fin_cashup_lines (cashup_id);

create trigger fin_cashups_set_updated_at before update on public.fin_cashups for each row execute function app.set_updated_at();
create trigger fin_cashup_lines_set_updated_at before update on public.fin_cashup_lines for each row execute function app.set_updated_at();
create trigger fin_cashup_lines_cashup_org_check before insert or update of cashup_id, org_id on public.fin_cashup_lines
  for each row execute function app.check_parent_org('fin_cashups', 'cashup_id');

-- Locked month => no change. A submitted cash-up's lines are frozen until it is reopened (status back to draft).
-- A row with no date or no parent (the cross-org probe in the security tests) passes through untouched so RLS answers.
create or replace function app.fin_cashup_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_date date;
  v_org uuid;
  v_status text;
  v_cashup_id uuid;
begin
  if tg_op = 'DELETE' then
    v_org := old.org_id;
  else
    v_org := new.org_id;
  end if;

  if tg_table_name = 'fin_cashups' then
    if tg_op = 'DELETE' then
      v_date := old.business_date;
    else
      v_date := new.business_date;
    end if;
    if tg_op <> 'INSERT' then
      v_status := old.status;
    end if;
  else
    if tg_op = 'DELETE' then
      v_cashup_id := old.cashup_id;
    else
      v_cashup_id := new.cashup_id;
    end if;
    select c.business_date, c.status into v_date, v_status from public.fin_cashups c where c.id = v_cashup_id;
  end if;

  if v_org is not null and v_date is not null then
    if app.fin_month_is_locked(v_org, v_date) and exists (select 1 from public.orgs o where o.id = v_org) then
      raise exception 'the month of this cash-up is locked' using errcode = '42501';
    end if;
    if tg_table_name = 'fin_cashup_lines' and v_status = 'submitted' then
      raise exception 'a submitted cash-up is frozen; reopen it first' using errcode = 'check_violation';
    end if;
    if tg_table_name = 'fin_cashups' then
      if tg_op = 'UPDATE' then
        if old.status = 'submitted' and new.status = 'submitted'
           and (new.branch_code, new.business_date, new.note) is distinct from (old.branch_code, old.business_date, old.note) then
          raise exception 'a submitted cash-up is frozen; reopen it first' using errcode = 'check_violation';
        end if;
      end if;
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
revoke all on function app.fin_cashup_guard() from public, anon, authenticated;
create trigger fin_cashups_guard before insert or update or delete on public.fin_cashups
  for each row execute function app.fin_cashup_guard();
create trigger fin_cashup_lines_guard before insert or update or delete on public.fin_cashup_lines
  for each row execute function app.fin_cashup_guard();

alter table public.fin_cashups enable row level security;
alter table public.fin_cashup_lines enable row level security;
create policy fin_cashups_select on public.fin_cashups for select to authenticated
  using (app.has_perm(org_id, 'finance.cashup.manage'));
create policy fin_cashup_lines_select on public.fin_cashup_lines for select to authenticated
  using (app.has_perm(org_id, 'finance.cashup.manage'));

-- ---------------------------------------------------------------------------
-- Month figures for the close pack (SQL so the definitions match the live reports); lib/finance/close-pack.ts adds the
-- revenue breakdowns, scorecard rows and denial reasons and freezes the lot.
-- ---------------------------------------------------------------------------
create or replace function public.fin_close_month_figures(p_org_id uuid, p_month date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with m as (select date_trunc('month', p_month)::date as s, (date_trunc('month', p_month) + interval '1 month')::date as e),
  generated as (
    select coalesce(i.branch_code, '(none)') as branch, sum(i.net) as generated, count(*) as invoices
    from public.fin_invoices i cross join m
    where i.org_id = p_org_id and not i.is_deleted and i.transaction_date >= m.s and i.transaction_date < m.e group by 1
  ), claimed as (
    select coalesce(i.branch_code, '(none)') as branch, sum(c.net) as claimed, sum(c.remitted) as remitted, sum(c.rejected) as rejected,
           sum(greatest(coalesce(c.net, 0) - coalesce(c.remitted, 0)
               - case when lower(coalesce(c.write_off_status, '')) = 'approved' then coalesce(c.write_off, 0) else 0 end, 0)) as outstanding,
           count(*) as claims
    from public.ins_claim_activities c cross join m
    left join public.fin_invoices i on i.id = c.matched_invoice_id
    where c.org_id = p_org_id and c.transaction_date >= m.s and c.transaction_date < m.e group by 1
  ), selfpay as (
    select coalesce(i.branch_code, '(none)') as branch, sum(p.paid) as self_pay_collected
    from public.fin_payments p join public.fin_invoices i on i.id = p.invoice_id cross join m
    where p.org_id = p_org_id and p.is_current and not i.is_deleted and p.paid_date >= m.s and p.paid_date < m.e
      and upper(coalesce(i.inv_type, '')) like 'SELF%' group by 1
  ), branches as (
    select branch from generated union select branch from claimed union select branch from selfpay
  ), by_branch as (
    select b.branch, round(coalesce(g.generated, 0), 2) as generated, coalesce(g.invoices, 0) as invoices,
           round(coalesce(c.claimed, 0), 2) as claimed, round(coalesce(c.remitted, 0), 2) as remitted,
           round(coalesce(c.rejected, 0), 2) as rejected, round(coalesce(c.outstanding, 0), 2) as outstanding,
           coalesce(c.claims, 0) as claims, round(coalesce(s.self_pay_collected, 0), 2) as self_pay_collected
    from branches b
    left join generated g on g.branch = b.branch left join claimed c on c.branch = b.branch left join selfpay s on s.branch = b.branch
  ), collections as (
    select coalesce(nullif(btrim(p.payment_mode), ''), '(unknown)') as mode,
           round(sum(coalesce(p.paid, 0)), 2) as paid, round(sum(coalesce(p.refund, 0)), 2) as refunds
    from public.fin_payments p join public.fin_invoices i on i.id = p.invoice_id cross join m
    where p.org_id = p_org_id and p.is_current and not i.is_deleted and p.paid_date >= m.s and p.paid_date < m.e group by 1
  ), adjustments as (
    select round(coalesce(sum(i.write_off), 0), 2) as write_off, round(coalesce(sum(i.credit_note), 0), 2) as credit_note
    from public.fin_invoices i cross join m
    where i.org_id = p_org_id and not i.is_deleted and i.transaction_date >= m.s and i.transaction_date < m.e
  ), ageing as (
    select bucket, count(*) as claims, round(sum(amount), 2) as outstanding from (
      select greatest(coalesce(c.net, 0) - coalesce(c.remitted, 0)
               - case when lower(coalesce(c.write_off_status, '')) = 'approved' then coalesce(c.write_off, 0) else 0 end, 0) as amount,
             case when (current_date - c.transaction_date) <= 30 then '0-30' when (current_date - c.transaction_date) <= 60 then '31-60'
                  when (current_date - c.transaction_date) <= 90 then '61-90' else '90+' end as bucket
      from public.ins_claim_activities c where c.org_id = p_org_id and c.transaction_date is not null
    ) a where amount > 0 group by bucket
  ), denials as (
    select count(*) filter (where d.denied_on >= m.s and d.denied_on < m.e) as opened_in_month,
           count(*) filter (where d.status in ('open', 'in_progress', 'appealed', 'resubmitted')) as active_now,
           round(coalesce(sum(d.rejected_amount) filter (where d.status in ('open', 'in_progress', 'appealed', 'resubmitted')), 0), 2) as active_amount,
           count(*) filter (where d.status in ('open', 'in_progress') and d.deadline_on < current_date) as past_deadline
    from public.ins_denial_cases d cross join m where d.org_id = p_org_id
  ), remit as (
    select count(distinct b.id) as batches, count(l.id) as lines, count(l.id) filter (where 'short_paid' = any (l.flags)) as short_lines,
           round(coalesce(sum(l.short_amount), 0), 2) as short_amount, round(coalesce(sum(l.paid_amount), 0), 2) as paid
    from public.ins_remittance_batches b cross join m
    left join public.ins_remittance_lines l on l.batch_id = b.id
    where b.org_id = p_org_id and b.created_at >= m.s and b.created_at < m.e
  ), cash as (
    select coalesce(c.branch_code, '(none)') as branch, count(distinct c.id) as days,
           round(coalesce(sum(l.expected_amount), 0), 2) as expected, round(coalesce(sum(l.counted_amount), 0), 2) as counted,
           round(coalesce(sum(l.variance), 0), 2) as variance
    from public.fin_cashups c cross join m
    left join public.fin_cashup_lines l on l.cashup_id = c.id
    where c.org_id = p_org_id and c.status = 'submitted' and c.business_date >= m.s and c.business_date < m.e group by 1
  )
  select jsonb_build_object(
    'by_branch', coalesce((select jsonb_agg(row_to_json(x)::jsonb order by x.branch) from by_branch x), '[]'::jsonb),
    'collections', coalesce((select jsonb_agg(row_to_json(x)::jsonb order by x.mode) from collections x), '[]'::jsonb),
    'adjustments', (select row_to_json(x)::jsonb from adjustments x),
    'ageing', coalesce((select jsonb_agg(row_to_json(x)::jsonb order by x.bucket) from ageing x), '[]'::jsonb),
    'denials', (select row_to_json(x)::jsonb from denials x),
    'remittance', (select row_to_json(x)::jsonb from remit x),
    'cashups', coalesce((select jsonb_agg(row_to_json(x)::jsonb order by x.branch) from cash x), '[]'::jsonb),
    'open_exceptions', (select count(*) from public.ops_exceptions e where e.org_id = p_org_id and e.status in ('open', 'in_progress')),
    'freshness', jsonb_build_object(
      'last_capture_at', (select max(b.processed_at) from public.fin_raw_unite_batches b where b.org_id = p_org_id and b.process_status = 'processed'),
      'last_import_at', (select max(f.committed_at) from public.fin_raw_diligence_files f where f.org_id = p_org_id and f.status = 'committed'))
  );
$$;
revoke all on function public.fin_close_month_figures(uuid, date) from public, anon, authenticated;
grant execute on function public.fin_close_month_figures(uuid, date) to service_role;

-- ---------------------------------------------------------------------------
-- Build / store the snapshot, sign for finance, sign for the CEO (locks), withdraw. Service role only; the server has
-- run can('finance.close.*') first. The database enforces the order, the hash binding and "not the same person".
-- ---------------------------------------------------------------------------
create or replace function public.fin_close_store_snapshot(p_org_id uuid, p_month date, p_user_id uuid, p_snapshot jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_close public.fin_period_closes;
begin
  if v_month >= date_trunc('month', current_date)::date then
    raise exception 'a month can only be closed after it has ended' using errcode = 'check_violation';
  end if;
  insert into public.fin_period_closes (org_id, month) values (p_org_id, v_month) on conflict (org_id, month) do nothing;
  select * into v_close from public.fin_period_closes where org_id = p_org_id and month = v_month for update;
  if v_close.status in ('finance_signed', 'locked') then
    raise exception 'this month is % and cannot be rebuilt', v_close.status using errcode = 'check_violation';
  end if;
  update public.fin_period_closes
     set status = 'built', snapshot = p_snapshot,
         snapshot_hash = encode(sha256(convert_to(p_snapshot::text, 'UTF8')), 'hex'),
         built_at = now(), built_by = p_user_id
   where id = v_close.id;
  return v_close.id;
end;
$$;
revoke all on function public.fin_close_store_snapshot(uuid, date, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.fin_close_store_snapshot(uuid, date, uuid, jsonb) to service_role;

create or replace function public.fin_close_sign_finance(p_org_id uuid, p_close_id uuid, p_user_id uuid, p_hash text, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_close public.fin_period_closes;
begin
  select * into v_close from public.fin_period_closes where id = p_close_id and org_id = p_org_id for update;
  if not found then raise exception 'close not found' using errcode = 'no_data_found'; end if;
  if v_close.status <> 'built' then
    raise exception 'the month is % and cannot be signed for finance', v_close.status using errcode = 'check_violation';
  end if;
  if p_hash is distinct from v_close.snapshot_hash then
    raise exception 'the pack changed since you opened it; reload and review it again' using errcode = 'check_violation';
  end if;
  update public.fin_period_closes
     set status = 'finance_signed', finance_signed_by = p_user_id, finance_signed_at = now(),
         finance_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = v_close.id;
end;
$$;
revoke all on function public.fin_close_sign_finance(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.fin_close_sign_finance(uuid, uuid, uuid, text, text) to service_role;

create or replace function public.fin_close_sign_ceo(p_org_id uuid, p_close_id uuid, p_user_id uuid, p_hash text, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_close public.fin_period_closes;
begin
  select * into v_close from public.fin_period_closes where id = p_close_id and org_id = p_org_id for update;
  if not found then raise exception 'close not found' using errcode = 'no_data_found'; end if;
  if v_close.status <> 'finance_signed' then
    raise exception 'the month is % and cannot be signed for the CEO', v_close.status using errcode = 'check_violation';
  end if;
  if v_close.finance_signed_by = p_user_id then
    raise exception 'the finance and CEO sign-offs must be two different people' using errcode = 'check_violation';
  end if;
  if p_hash is distinct from v_close.snapshot_hash then
    raise exception 'the pack changed since you opened it; reload and review it again' using errcode = 'check_violation';
  end if;
  update public.fin_period_closes
     set status = 'locked', ceo_signed_by = p_user_id, ceo_signed_at = now(), locked_at = now(),
         ceo_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = v_close.id;
end;
$$;
revoke all on function public.fin_close_sign_ceo(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.fin_close_sign_ceo(uuid, uuid, uuid, text, text) to service_role;

create or replace function public.fin_close_withdraw(p_org_id uuid, p_close_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_close public.fin_period_closes;
begin
  select * into v_close from public.fin_period_closes where id = p_close_id and org_id = p_org_id for update;
  if not found then raise exception 'close not found' using errcode = 'no_data_found'; end if;
  if v_close.status <> 'finance_signed' then
    raise exception 'only a month waiting for the CEO can have its finance sign-off withdrawn' using errcode = 'check_violation';
  end if;
  update public.fin_period_closes
     set status = 'built', finance_signed_by = null, finance_signed_at = null, finance_note = null
   where id = v_close.id;
end;
$$;
revoke all on function public.fin_close_withdraw(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fin_close_withdraw(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Cash-up: refresh the expected amounts of a draft, and submit (freeze) it
-- ---------------------------------------------------------------------------
create or replace function public.fin_cashup_refresh(p_org_id uuid, p_cashup_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cashup public.fin_cashups;
  v_row jsonb;
begin
  select * into v_cashup from public.fin_cashups where id = p_cashup_id and org_id = p_org_id for update;
  if not found then raise exception 'cash-up not found' using errcode = 'no_data_found'; end if;
  if v_cashup.status <> 'draft' then
    raise exception 'a submitted cash-up is frozen' using errcode = 'check_violation';
  end if;
  -- modes the system knows about get a line (expected updated); lines the cashier added for another mode keep expected 0
  for v_row in select * from jsonb_array_elements(public.fin_cashup_expected(p_org_id, v_cashup.branch_code, v_cashup.business_date)) loop
    insert into public.fin_cashup_lines (org_id, cashup_id, payment_mode, expected_amount)
    values (p_org_id, p_cashup_id, v_row ->> 'mode', (v_row ->> 'expected')::numeric)
    on conflict (cashup_id, payment_mode) do update set expected_amount = excluded.expected_amount;
  end loop;
  update public.fin_cashup_lines l set expected_amount = 0
   where l.cashup_id = p_cashup_id
     and not exists (select 1 from jsonb_array_elements(public.fin_cashup_expected(p_org_id, v_cashup.branch_code, v_cashup.business_date)) e
                     where e ->> 'mode' = l.payment_mode)
     and l.expected_amount <> 0;
end;
$$;
revoke all on function public.fin_cashup_refresh(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fin_cashup_refresh(uuid, uuid) to service_role;

create or replace function public.fin_cashup_submit(p_org_id uuid, p_cashup_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cashup public.fin_cashups;
  v_tolerance numeric;
  v_bad integer;
begin
  perform public.fin_cashup_refresh(p_org_id, p_cashup_id);
  select * into v_cashup from public.fin_cashups where id = p_cashup_id and org_id = p_org_id for update;
  select s.cashup_variance_tolerance into v_tolerance from public.fin_ref_finance_settings s where s.org_id = p_org_id;
  if exists (select 1 from public.fin_cashup_lines l where l.cashup_id = p_cashup_id and l.counted_amount is null) then
    raise exception 'count every payment mode before submitting (enter 0 where nothing was taken)' using errcode = 'check_violation';
  end if;
  select count(*) into v_bad from public.fin_cashup_lines l
   where l.cashup_id = p_cashup_id and abs(l.variance) > coalesce(v_tolerance, 0) and btrim(coalesce(l.reason, '')) = '';
  if v_bad > 0 then
    raise exception 'give a reason for every difference above the tolerance' using errcode = 'check_violation';
  end if;
  update public.fin_cashups set status = 'submitted', submitted_by = p_user_id, submitted_at = now() where id = v_cashup.id;
end;
$$;
revoke all on function public.fin_cashup_submit(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.fin_cashup_submit(uuid, uuid, uuid) to service_role;

select app.enable_record_history('fin_period_closes', 'snapshot,snapshot_hash');

-- ======================================================================
-- 20261016000700_finance_recovery_export.sql
-- ======================================================================
-- Phase 18 (7/7): self-pay recovery reminders, the accounting export log, the daily workflow task.
--
--   fin_recovery_reminders   one row per reminder decision (queued / skipped / failed), idempotent per invoice and sequence
--   fin_accounting_exports   a log of CSV exports (who, which period, how many rows, a checksum); the file itself is not kept
--
-- Reminders go out only through the outbound queue, as an APPROVED TEMPLATE, to patients who opted in and have not
-- stopped marketing, and only after finance has approved the tone of the mapped template (fin_ref_finance_settings).
-- The whole feature is OFF by default.

create table public.fin_recovery_reminders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  invoice_id uuid not null references public.fin_invoices (id) on delete cascade,
  patient_pin text,
  contact_id uuid references public.contacts (id) on delete set null,       -- the person the reminder went to
  sequence_no integer not null check (sequence_no between 1 and 10),
  status text not null check (status in ('queued', 'skipped', 'failed')),
  skip_reason text check (skip_reason is null or char_length(skip_reason) <= 60),
  balance numeric(14, 2),
  template_id uuid references public.wa_templates (id) on delete set null,
  message_id uuid references public.messages (id) on delete set null,
  created_by uuid references public.profiles (id) on delete set null,       -- null = the daily job
  created_at timestamptz not null default now(),
  unique (org_id, invoice_id, sequence_no)
);
create index fin_recovery_reminders_invoice_idx on public.fin_recovery_reminders (invoice_id, sequence_no desc);
create index fin_recovery_reminders_org_idx on public.fin_recovery_reminders (org_id, created_at desc);

create trigger fin_recovery_invoice_org_check before insert or update of invoice_id, org_id on public.fin_recovery_reminders
  for each row execute function app.check_parent_org('fin_invoices', 'invoice_id');
create trigger fin_recovery_contact_org_check before insert or update of contact_id, org_id on public.fin_recovery_reminders
  for each row execute function app.check_parent_org('contacts', 'contact_id');

alter table public.fin_recovery_reminders enable row level security;
create policy fin_recovery_reminders_select on public.fin_recovery_reminders for select to authenticated
  using (app.has_perm(org_id, 'finance.recovery.manage'));

create table public.fin_accounting_exports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  period_from date not null,
  period_to date not null,
  status text not null check (status in ('provisional', 'final')),   -- final = every month in the period is locked
  row_count integer not null check (row_count >= 0),
  debit_total numeric(16, 2) not null,
  credit_total numeric(16, 2) not null,
  checksum text not null,
  exported_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  check (period_to >= period_from)
);
create index fin_accounting_exports_org_idx on public.fin_accounting_exports (org_id, created_at desc);

alter table public.fin_accounting_exports enable row level security;
create policy fin_accounting_exports_select on public.fin_accounting_exports for select to authenticated
  using (app.has_perm(org_id, 'finance.export.run'));

-- Daily upkeep for the Phase 18 workflows (pre-authorisation expiry, denial cases and deadlines, self-pay reminders).
-- Runs in the application (it creates tasks, sends notifications and queues WhatsApp messages). Never calls Unite.
select cron.schedule('pulse:finance_workflows', '50 3 * * *', $$select app.ping_jobs('finance_workflows')$$);
