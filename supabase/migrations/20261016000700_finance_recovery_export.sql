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
