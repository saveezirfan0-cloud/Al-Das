-- Phase 19a (4/4): payment links sent over WhatsApp.
--
-- fin_payment_requests records what Pulse asked a payment gateway for and what the gateway told Pulse afterwards. It NEVER marks an
-- invoice as paid anywhere and nothing here is written to Unite: the status is the gateway's word, for finance to reconcile by
-- hand. It carries the Unite PIN and invoice number only (no names, DOB, Emirates ID, card data or link).
--
--   one live request per invoice (pending / created / sent) so a second click cannot ask the patient to pay twice
--   amounts are integers in minor units; a webhook whose amount or currency differs is never applied (needs_review)
--   writes: server code only (service role after can('finance.payment_links')); browsers can only read

create table public.fin_payment_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  invoice_id uuid not null references public.fin_invoices (id) on delete cascade,
  invoice_number text not null,
  patient_pin text,
  contact_id uuid references public.contacts (id) on delete set null,       -- the person the link was sent to
  provider text not null check (provider in ('stripe', 'paytabs')),
  provider_ref text check (provider_ref is null or char_length(provider_ref) <= 120),
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'pending'
    check (status in ('pending', 'created', 'sent', 'paid', 'failed', 'expired', 'cancelled')),
  needs_review boolean not null default false,
  review_reason text check (review_reason is null or char_length(review_reason) <= 60),
  failure_code text check (failure_code is null or char_length(failure_code) <= 60),
  expires_at timestamptz,
  amount_paid_minor bigint check (amount_paid_minor is null or amount_paid_minor >= 0),
  paid_at timestamptz,
  last_event_at timestamptz,
  message_id uuid references public.messages (id) on delete set null,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index fin_payment_requests_provider_ref_uidx on public.fin_payment_requests (org_id, provider, provider_ref)
  where provider_ref is not null;
create unique index fin_payment_requests_one_live_uidx on public.fin_payment_requests (org_id, invoice_id)
  where status in ('pending', 'created', 'sent');
create index fin_payment_requests_org_created_idx on public.fin_payment_requests (org_id, created_at desc);
create index fin_payment_requests_expiry_idx on public.fin_payment_requests (expires_at) where status in ('created', 'sent');

create trigger fin_payment_requests_set_updated_at before update on public.fin_payment_requests
  for each row execute function app.set_updated_at();
create trigger fin_payment_requests_invoice_org_check before insert or update of invoice_id, org_id on public.fin_payment_requests
  for each row execute function app.check_parent_org('fin_invoices', 'invoice_id');
create trigger fin_payment_requests_contact_org_check before insert or update of contact_id, org_id on public.fin_payment_requests
  for each row execute function app.check_parent_org('contacts', 'contact_id');

alter table public.fin_payment_requests enable row level security;
create policy fin_payment_requests_select on public.fin_payment_requests for select to authenticated
  using (app.has_perm(org_id, 'finance.payment_links'));

-- A link nobody paid before it expired is closed here; a late payment webhook is still recorded (and flagged) by the app.
select cron.schedule('pulse:fin_payment_expiry', '*/15 * * * *', $$
  update public.fin_payment_requests set status = 'expired'
   where status in ('created', 'sent') and expires_at is not null and expires_at < now();
$$);
