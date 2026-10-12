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
