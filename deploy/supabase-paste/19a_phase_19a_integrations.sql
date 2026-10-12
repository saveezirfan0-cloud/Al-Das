-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Phase 19a (integrations foundation, doctor calendar feeds, SMS fallback, payment links). Needs the earlier files first, including
-- 18_phase_18_finance_upgrades.sql (fin_invoices) and 17_phase_17_ai_copilots.sql.
-- Check the project name in the Supabase header first: this is for the Pulse project only.
-- Adds the integrations.manage, integrations.calendar and finance.payment_links permissions (integrations.calendar goes to the existing
-- Manager role, finance.payment_links to Finance and Billing; Admin already holds everything), the on/off flag and health columns on
-- integration_accounts, the call log, webhook idempotency keys and daily counters, the calendar_feeds, sms_messages and
-- fin_payment_requests tables, contacts.sms_opt_out_at, the sms_outbound queue and these schedules: pulse:sms_outbound (every 10 seconds),
-- pulse:sms_stalled (every 10 minutes), pulse:fin_payment_expiry (every 15 minutes) and pulse:housekeeping_integrations (daily 03:45 UTC).
-- Every integration is OFF until an administrator switches it on in Settings, Integrations. Nothing here calls Unite, WhatsApp, an SMS
-- provider or a payment gateway (see docs/18_PHASE_19A_NOTES.md and OQ-83 to OQ-85).

-- ======================================================================
-- 20261018000100_integrations_foundation.sql
-- ======================================================================
-- Phase 19a (1/4): integrations foundation, shared by every integration (19a and 19b).
--
--   integration_accounts      (exists since Finance F2) gains the on/off flag and health columns. Credentials stay in config_enc
--                             (AES-256-GCM, lib/crypto.ts) and the table keeps NO policies: only server code (service role, after
--                             can('integrations.manage')) reads or writes it, and the browser never receives the ciphertext.
--   integration_calls         one row per call to an external provider: provider, operation, outcome, status code, latency.
--                             Never a URL, header, request or response body, phone number, name or amount.
--   integration_webhook_events idempotency keys for inbound provider webhooks (service role only).
--   integration_usage_daily   daily counters per provider and metric (messages sent, segments, calendar fetches, ...).
--   integration_call_stats()  the 24-hour summary the System health page shows.
--   permissions               integrations.manage (Admin has '*'); integrations.calendar and finance.payment_links are granted to
--                             the existing roles below.
--
-- Every integration is OFF until an administrator switches it on (integration_accounts.enabled = false by default).

-- ---------------------------------------------------------------------------
-- integration_accounts: flag + health
-- ---------------------------------------------------------------------------
alter table public.integration_accounts
  add column if not exists enabled boolean not null default false,
  add column if not exists enabled_at timestamptz,
  add column if not exists enabled_by uuid references public.profiles (id) on delete set null,
  add column if not exists credentials_set_at timestamptz,
  add column if not exists last_ok_at timestamptz,
  add column if not exists last_error_at timestamptz;

comment on column public.integration_accounts.enabled is
  'Feature flag. OFF by default. Nothing is sent to, or fetched from, the provider while false. Unite keeps its own flags in config.';
comment on column public.integration_accounts.last_error is
  'Redacted (lib/redact.ts) one-line reason of the last failure; never a body, token or phone number.';

-- ---------------------------------------------------------------------------
-- integration_calls
-- ---------------------------------------------------------------------------
create table public.integration_calls (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs (id) on delete cascade,
  provider text not null check (char_length(provider) between 1 and 40),
  operation text not null check (char_length(operation) between 1 and 60),
  outcome text not null check (outcome in (
    'ok', 'client_error', 'auth_error', 'rate_limited', 'server_error', 'network_error', 'timeout', 'breaker_open', 'blocked'
  )),
  http_status integer,
  duration_ms integer,
  attempt smallint not null default 1,
  at timestamptz not null default now()
);
create index integration_calls_org_provider_at_idx on public.integration_calls (org_id, provider, at desc);

alter table public.integration_calls enable row level security;
create policy integration_calls_select on public.integration_calls for select to authenticated
  using (app.has_perm(org_id, 'integrations.manage'));

-- ---------------------------------------------------------------------------
-- integration_webhook_events: idempotency for inbound webhooks (service role only, no policies)
-- ---------------------------------------------------------------------------
create table public.integration_webhook_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs (id) on delete cascade,
  provider text not null check (char_length(provider) between 1 and 40),
  event_key text not null check (char_length(event_key) between 1 and 200),
  outcome text check (outcome is null or char_length(outcome) <= 60),
  received_at timestamptz not null default now(),
  unique (org_id, provider, event_key)
);
create index integration_webhook_events_received_idx on public.integration_webhook_events (received_at);
alter table public.integration_webhook_events enable row level security;
-- no API policies: service role only (the webhook route claims a key before it acts)

-- ---------------------------------------------------------------------------
-- integration_usage_daily
-- ---------------------------------------------------------------------------
create table public.integration_usage_daily (
  org_id uuid not null references public.orgs (id) on delete cascade,
  provider text not null check (char_length(provider) between 1 and 40),
  day date not null,
  metric text not null check (char_length(metric) between 1 and 60),
  value bigint not null default 0,
  primary key (org_id, provider, day, metric)
);
alter table public.integration_usage_daily enable row level security;
create policy integration_usage_daily_select on public.integration_usage_daily for select to authenticated
  using (app.has_perm(org_id, 'integrations.manage'));

create or replace function public.integration_usage_bump(p_org uuid, p_provider text, p_metric text, p_n bigint default 1)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.integration_usage_daily as u (org_id, provider, day, metric, value)
  values (p_org, p_provider, (now() at time zone 'utc')::date, p_metric, p_n)
  on conflict (org_id, provider, day, metric) do update set value = u.value + excluded.value;
$$;
revoke all on function public.integration_usage_bump(uuid, text, text, bigint) from public, anon, authenticated;
grant execute on function public.integration_usage_bump(uuid, text, text, bigint) to service_role;

-- Calls per provider and outcome since a moment (System health). Service role only.
create or replace function public.integration_call_stats(p_org uuid, p_since timestamptz)
returns table (provider text, outcome text, calls bigint, avg_ms integer, last_at timestamptz)
language sql
security definer
set search_path = ''
as $$
  select c.provider, c.outcome, count(*)::bigint, coalesce(round(avg(c.duration_ms)), 0)::integer, max(c.at)
  from public.integration_calls c
  where c.org_id = p_org and c.at >= p_since
  group by c.provider, c.outcome
$$;
revoke all on function public.integration_call_stats(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.integration_call_stats(uuid, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- Permissions for the existing system roles (idempotent; new orgs get them from lib/auth/permissions.ts).
-- integrations.manage: Admin only (Admin holds '*').
-- ---------------------------------------------------------------------------
do $$
declare
  g record;
begin
  for g in
    select * from (values
      ('Manager', 'integrations.calendar'),
      ('Finance', 'finance.payment_links'),
      ('Billing', 'finance.payment_links')
    ) as t (role_name, perm)
  loop
    update public.roles r
       set permissions = r.permissions || to_jsonb(g.perm)
     where r.is_system and r.name = g.role_name and not (r.permissions ? g.perm);
  end loop;
end $$;

-- Housekeeping: call log 30 days, webhook idempotency keys 14 days, usage counters 400 days.
select cron.schedule('pulse:housekeeping_integrations', '45 3 * * *', $$
  delete from public.integration_calls where at < now() - interval '30 days';
  delete from public.integration_webhook_events where received_at < now() - interval '14 days';
  delete from public.integration_usage_daily where day < (now() - interval '400 days')::date;
$$);

-- ======================================================================
-- 20261018000200_calendar_feeds.sql
-- ======================================================================
-- Phase 19a (2/4): doctor calendar feeds (ICS, read-only).
--
-- A feed is a secret URL a doctor adds to Outlook, Google or Apple Calendar. Only the SHA-256 of the token is stored; the URL is
-- shown once when it is created or rotated. A feed belongs to ONE specialist, or to one user ("my appointments": every specialist
-- profile linked to that user). The feed carries start, end, a generic title and the location name, never a patient detail.
-- Access is counted (access_count / last_access_at and integration_usage_daily), not logged per request.

create table public.calendar_feeds (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  kind text not null check (kind in ('specialist', 'user')),
  specialist_id uuid references public.specialists (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete cascade,
  label text not null check (char_length(label) between 1 and 80),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  revoked_at timestamptz,
  last_access_at timestamptz,
  access_count bigint not null default 0,
  check (
    (kind = 'specialist' and specialist_id is not null and user_id is null)
    or (kind = 'user' and user_id is not null and specialist_id is null)
  )
);
create index calendar_feeds_org_idx on public.calendar_feeds (org_id, created_at desc);
create index calendar_feeds_specialist_idx on public.calendar_feeds (specialist_id) where specialist_id is not null;

create trigger calendar_feeds_specialist_org_check before insert or update of specialist_id, org_id on public.calendar_feeds
  for each row execute function app.check_parent_org('specialists', 'specialist_id');

-- A "my appointments" feed can only belong to an active member of the same org.
create or replace function app.calendar_feed_user_check()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.user_id is not null and not exists (
    select 1 from public.memberships m where m.org_id = new.org_id and m.user_id = new.user_id and m.status = 'active'
  ) then
    raise exception 'user % is not an active member of org %', new.user_id, new.org_id using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger calendar_feeds_user_check before insert or update of user_id, org_id on public.calendar_feeds
  for each row execute function app.calendar_feed_user_check();

alter table public.calendar_feeds enable row level security;
create policy calendar_feeds_select on public.calendar_feeds for select to authenticated
  using (app.has_perm(org_id, 'integrations.calendar'));
-- writes: server actions only (service role after can('integrations.calendar'))

-- Aggregate access counter (one atomic bump per fetch; no per-request row).
create or replace function public.calendar_feed_touch(p_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.calendar_feeds set access_count = access_count + 1, last_access_at = now() where id = p_id;
$$;
revoke all on function public.calendar_feed_touch(uuid) from public, anon, authenticated;
grant execute on function public.calendar_feed_touch(uuid) to service_role;

-- ======================================================================
-- 20261018000300_sms_fallback.sql
-- ======================================================================
-- Phase 19a (3/4): SMS fallback for appointment reminders that WhatsApp could not deliver.
--
--   sms_messages            one row per SMS: who it went to (a contact id), which appointment, which WhatsApp message failed, the
--                           provider's id and a forward-only status. It never stores a phone number, a name or the text: the text
--                           is rebuilt from the appointment when the SMS is sent.
--   contacts.sms_opt_out_at a person who asked not to get SMS (set by staff, or by the provider reporting an unsubscribe)
--   sms_outbound queue      its own queue with its own per-sender rate limit; nothing is sent inline.

alter table public.contacts add column if not exists sms_opt_out_at timestamptz;
comment on column public.contacts.sms_opt_out_at is
  'Set when the person asked not to receive SMS (staff, or the provider reporting an unsubscribe). Blocks the SMS fallback.';

create table public.sms_messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  contact_id uuid references public.contacts (id) on delete set null,
  appointment_id uuid references public.appointments (id) on delete set null,
  source_message_id uuid references public.messages (id) on delete set null,
  kind text not null default 'reminder_fallback' check (kind in ('reminder_fallback')),
  provider text not null check (char_length(provider) between 1 and 40),
  provider_message_id text check (provider_message_id is null or char_length(provider_message_id) <= 80),
  dedupe_key text not null check (char_length(dedupe_key) between 1 and 120),
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'delivered', 'undelivered', 'failed')),
  error_code text check (error_code is null or char_length(error_code) <= 40),
  segments smallint check (segments is null or segments between 1 and 20),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (org_id, dedupe_key)
);
create unique index sms_messages_provider_ref_uidx on public.sms_messages (provider, provider_message_id)
  where provider_message_id is not null;
create index sms_messages_org_created_idx on public.sms_messages (org_id, created_at desc);
create index sms_messages_contact_idx on public.sms_messages (contact_id) where contact_id is not null;

create trigger sms_messages_set_updated_at before update on public.sms_messages
  for each row execute function app.set_updated_at();
create trigger sms_messages_contact_org_check before insert or update of contact_id, org_id on public.sms_messages
  for each row execute function app.check_parent_org('contacts', 'contact_id');
create trigger sms_messages_appointment_org_check before insert or update of appointment_id, org_id on public.sms_messages
  for each row execute function app.check_parent_org('appointments', 'appointment_id');

alter table public.sms_messages enable row level security;
create policy sms_messages_select on public.sms_messages for select to authenticated
  using (app.has_perm(org_id, 'integrations.manage'));
-- writes: the SMS queue handler and the delivery-receipt route (service role)

-- Queue and schedule. Queue names must stay in sync with lib/jobs/queues.ts.
select pgmq.create('sms_outbound');
select cron.schedule('pulse:sms_outbound', '10 seconds', $$select app.ping_jobs('sms_outbound')$$);

-- A message claimed by a worker that then died is closed after 30 minutes. It is NOT re-sent: the provider may already have it.
select cron.schedule('pulse:sms_stalled', '*/10 * * * *', $$
  update public.sms_messages set status = 'failed', error_code = 'stalled'
   where status = 'sending' and updated_at < now() - interval '30 minutes';
$$);

-- ======================================================================
-- 20261018000400_payment_links.sql
-- ======================================================================
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
