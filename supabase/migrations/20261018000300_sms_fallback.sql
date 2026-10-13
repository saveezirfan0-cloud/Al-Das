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
