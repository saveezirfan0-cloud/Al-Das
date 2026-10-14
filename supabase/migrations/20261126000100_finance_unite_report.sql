-- Phase 23A foundation: the Unite "Daily Collection Multi-Clinic Report" upload (docs/39_UNITE_REPORTS_PLAN.md,
-- docs/40_MANAGEMENT_PLATFORM_PLAN.md M1).
--
--   * Bridge while the Unite finance capture stays OFF (OQ-94), and the way to load history month by month.
--   * Kept apart from fin_invoices on purpose: the report has no DHA doctor id and one row per visit (self-pay and
--     insurance invoice numbers on one row), so mixing it into the capture tables would give every doctor a second
--     identity and could post revenue twice. It feeds the management measures (doctor performance) only (OQ-142).
--   * fin_report_uploads: one row per uploaded file (sha256 only, never the file), with the report's own totals and
--     the reconciliation result. A file that does not reconcile is never committed.
--   * fin_report_visits: one sanitised row per report row. NEVER stored: patient name, insurance card number,
--     insurer text, remarks, referral or staff names. Amounts in AED to three decimals, as Unite keeps them.
--   * Committing an upload makes its rows current and supersedes the current rows of earlier uploads whose report
--     date falls in its range (nothing is deleted).
--   * Both tables have RLS and no policies: service role only, read through SECURITY DEFINER functions after can().
--   * finance.revenue.import (Finance, Finance Manager) uploads and commits.

-- ---------------------------------------------------------------------------
-- 1. Permission
-- ---------------------------------------------------------------------------
do $$
declare g record;
begin
  for g in
    select * from (values
      ('Finance', 'finance.revenue.import'),
      ('Finance Manager', 'finance.revenue.import')
    ) as t (role_name, perm)
  loop
    update public.roles r
       set permissions = r.permissions || to_jsonb(g.perm)
     where r.is_system and r.name = g.role_name and not (r.permissions ? g.perm);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Uploads
-- ---------------------------------------------------------------------------
create table public.fin_report_uploads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  kind text not null default 'unite_daily_collection' check (kind in ('unite_daily_collection')),
  from_date date not null,
  to_date date not null,
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'staged' check (status in ('staged', 'committed', 'discarded')),
  row_count integer not null default 0 check (row_count >= 0),
  report_totals jsonb not null default '{}'::jsonb,   -- the report's own "Invoice Total" row (amounts only)
  row_totals jsonb not null default '{}'::jsonb,      -- the same columns summed over the staged rows
  reconciled boolean not null default false,
  problems jsonb not null default '[]'::jsonb,        -- fixed messages and counts only, never row content
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  committed_by uuid references auth.users (id) on delete set null,
  committed_at timestamptz,
  check (to_date >= from_date),
  check (status <> 'committed' or (reconciled and committed_at is not null)),
  unique (org_id, file_sha256)
);
create index fin_report_uploads_org_created_idx on public.fin_report_uploads (org_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 3. Visit rows
-- ---------------------------------------------------------------------------
create table public.fin_report_visits (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  upload_id uuid not null references public.fin_report_uploads (id) on delete cascade,
  row_no integer not null check (row_no > 0),          -- position in the file, for problem reports
  visit_at timestamptz,
  invoice_date date,
  report_date date not null,                           -- invoice date, else visit date (Asia/Dubai)
  department text,
  doctor_name text not null,
  doctor_key text not null,                            -- normalised name (lib/finance/unite-report-mapping.ts)
  clinic_name text,
  branch_code text,                                    -- fin_ref_branches.code by Unite clinic name; null = unknown
  patient_pin text,
  patient_ref text,                                    -- keyed hash, set by trigger (analytics never use the PIN)
  visit_status text check (visit_status in ('new', 'revisit', 'followup')),
  invoice_type text,
  selfpay_invoice_no text,
  insurance_invoice_no text,
  categories jsonb not null default '{}'::jsonb,       -- Unite service category -> amount
  gross numeric(14, 3) not null default 0,
  discount numeric(14, 3) not null default 0,
  vat numeric(14, 3) not null default 0,
  net numeric(14, 3) not null default 0,               -- Unite "Net Billing" (after discount, before VAT)
  total numeric(14, 3) not null default 0,
  cash numeric(14, 3) not null default 0,
  card numeric(14, 3) not null default 0,
  bank_transfer numeric(14, 3) not null default 0,
  payment_gateway numeric(14, 3) not null default 0,
  other_payment numeric(14, 3) not null default 0,
  patient_share numeric(14, 3) not null default 0,
  insurance_claim numeric(14, 3) not null default 0,
  advance_consumed numeric(14, 3) not null default 0,
  credit_note_consumed numeric(14, 3) not null default 0,
  outstanding_credit numeric(14, 3) not null default 0,
  write_off numeric(14, 3) not null default 0,
  refund numeric(14, 3) not null default 0,
  is_cancelled boolean not null default false,         -- Unite status "Cancel"; still in Unite's totals
  is_current boolean not null default false,
  created_at timestamptz not null default now(),
  unique (upload_id, row_no)
);
create index fin_report_visits_current_idx on public.fin_report_visits (org_id, report_date) where is_current;
create index fin_report_visits_upload_idx on public.fin_report_visits (upload_id);

create or replace function app.fin_report_visit_set_patient_ref()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.patient_ref := app.fin_patient_ref(new.patient_pin);
  return new;
end;
$$;
revoke all on function app.fin_report_visit_set_patient_ref() from public, anon, authenticated;

create trigger fin_report_visits_patient_ref before insert or update of patient_pin on public.fin_report_visits
  for each row execute function app.fin_report_visit_set_patient_ref();

-- ---------------------------------------------------------------------------
-- 4. RLS: service role only (no policies)
-- ---------------------------------------------------------------------------
alter table public.fin_report_uploads enable row level security;
alter table public.fin_report_visits enable row level security;
revoke all on public.fin_report_uploads from anon, authenticated;
revoke all on public.fin_report_visits from anon, authenticated;
