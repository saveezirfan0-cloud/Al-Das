-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Phase 19b (Google review requests, Meta ad attribution and Conversions API, video visits, e-signature for consent forms). Needs the
-- earlier files first, including 19a_phase_19a_integrations.sql (integration_accounts flag and health columns, calls log, webhook keys,
-- usage counters), 16_phase_16_media_documents.sql (patient_documents, media_assets, erase_contact) and 14_phase_14_front_desk.sql.
-- Check the project name in the Supabase header first: this is for the Pulse project only.
-- Adds the ads.view permission (granted to the existing Manager and Marketing roles; Admin already holds everything), locations.review_url,
-- contacts.no_review_requests_at, services.default_visit_mode, appointments.visit_mode, the review_requests, ad_attributions, capi_events,
-- telehealth_rooms and esign_requests tables, the capi_events queue, claim_review_request(), review_request_stats() and
-- ad_attribution_report(), a replacement erase_contact() that also removes the new records, and these schedules: pulse:review_requests_sweep
-- (every 15 minutes), pulse:capi_events (every 10 seconds), pulse:capi_sweep (every 10 minutes) and pulse:housekeeping_19b (daily 03:55 UTC).
-- Every integration is OFF until an administrator switches it on in Settings, Integrations. Nothing here calls Unite, WhatsApp, Meta,
-- a video service or an e-signature provider (see docs/19_PHASE_19B_NOTES.md and OQ-86 to OQ-89).

-- ======================================================================
-- 20261019000100_review_requests.sql
-- ======================================================================
-- Phase 19b (1/5): Google review requests.
--
-- No Google service is called: the "integration" is a feature flag (integration_accounts, kind 'google_reviews'), one review link per
-- location and an approved WhatsApp template that carries it. After a completed visit ONE message may be queued for the patient (or
-- the guardian of a dependant), only with explicit marketing opt-in, and never more often than the cap per person.
--
--   locations.review_url             the clinic's Google review link for that place (https, google hosts only; checked in lib too)
--   contacts.no_review_requests_at   staff "do not ask" switch (deceased, placeholder, or asked not to be asked)
--   review_requests                  one row per visit: scheduled -> queued | skipped | cap_blocked | failed. Ids only: no name, phone,
--                                    link or message text.
--   claim_review_request()           the cap, enforced atomically in the database (advisory lock per patient and per person asked)
--   review_request_stats()           counts for the settings page (no names)
--   pulse:review_requests_sweep      finds completed visits whose hook was missed (Unite sync, another process); never looks back more
--                                    than a day and never before the switch was turned on

alter table public.locations
  add column if not exists review_url text check (review_url is null or char_length(review_url) <= 500);
comment on column public.locations.review_url is
  'Google review link used by review requests (https; google.com, g.page or maps.app.goo.gl). Validated in lib/integrations/reviews/url.ts.';

alter table public.contacts add column if not exists no_review_requests_at timestamptz;
comment on column public.contacts.no_review_requests_at is
  'Staff switch: never ask this person for a review (deceased, placeholder record, or asked not to be asked). The only filter on review requests besides marketing consent and training mode: nobody is filtered by how their visit went.';

create table public.review_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  appointment_id uuid not null references public.appointments (id) on delete cascade,
  contact_id uuid references public.contacts (id) on delete set null,
  recipient_contact_id uuid references public.contacts (id) on delete set null,
  location_id uuid references public.locations (id) on delete set null,
  status text not null default 'scheduled' check (status in ('scheduled', 'queued', 'skipped', 'cap_blocked', 'failed')),
  reason text check (reason is null or char_length(reason) <= 40),
  run_at timestamptz not null,
  visit_ended_at timestamptz,
  claimed_at timestamptz,
  message_id uuid references public.messages (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, appointment_id)
);
create index review_requests_org_created_idx on public.review_requests (org_id, created_at desc);
create index review_requests_cap_patient_idx on public.review_requests (org_id, contact_id, claimed_at) where status = 'queued';
create index review_requests_cap_recipient_idx on public.review_requests (org_id, recipient_contact_id, claimed_at) where status = 'queued';

create trigger review_requests_set_updated_at before update on public.review_requests
  for each row execute function app.set_updated_at();
create trigger review_requests_appointment_org_check before insert or update of appointment_id, org_id on public.review_requests
  for each row execute function app.check_parent_org('appointments', 'appointment_id');
create trigger review_requests_contact_org_check before insert or update of contact_id, org_id on public.review_requests
  for each row execute function app.check_parent_org('contacts', 'contact_id');
create trigger review_requests_recipient_org_check before insert or update of recipient_contact_id, org_id on public.review_requests
  for each row execute function app.check_parent_org('contacts', 'recipient_contact_id');

alter table public.review_requests enable row level security;
create policy review_requests_select on public.review_requests for select to authenticated
  using (app.has_perm(org_id, 'integrations.manage'));
-- writes: the review job and the sweep (service role)

-- The cap, atomically. One request per patient AND per person asked inside the window (a guardian of three children is asked once).
-- Returns 'claimed' (status is now 'queued'), 'cap_blocked' (status is now 'cap_blocked'), 'not_scheduled' (someone else decided) or 'missing'.
create or replace function public.claim_review_request(p_org uuid, p_request uuid, p_cap_days integer)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.review_requests;
  k1 text;
  k2 text;
  n integer;
begin
  select * into r from public.review_requests where id = p_request and org_id = p_org for update;
  if not found then
    return 'missing';
  end if;
  if r.status <> 'scheduled' then
    return 'not_scheduled';
  end if;
  if p_cap_days < 1 then
    p_cap_days := 1;
  end if;

  -- Lock both people in a fixed order so two requests for the same family cannot deadlock or both slip through.
  k1 := coalesce(r.contact_id::text, r.id::text);
  k2 := coalesce(r.recipient_contact_id::text, r.id::text);
  if k1 > k2 then
    perform pg_advisory_xact_lock(hashtextextended(p_org::text || ':' || k2, 19));
    perform pg_advisory_xact_lock(hashtextextended(p_org::text || ':' || k1, 19));
  else
    perform pg_advisory_xact_lock(hashtextextended(p_org::text || ':' || k1, 19));
    if k2 <> k1 then
      perform pg_advisory_xact_lock(hashtextextended(p_org::text || ':' || k2, 19));
    end if;
  end if;

  select count(*) into n
    from public.review_requests x
   where x.org_id = p_org
     and x.id <> r.id
     and x.status = 'queued'
     and x.claimed_at > now() - make_interval(days => p_cap_days)
     and (
       (r.contact_id is not null and (x.contact_id = r.contact_id or x.recipient_contact_id = r.contact_id))
       or (r.recipient_contact_id is not null and (x.recipient_contact_id = r.recipient_contact_id or x.contact_id = r.recipient_contact_id))
     );
  if n > 0 then
    update public.review_requests set status = 'cap_blocked', reason = 'cap', decided_at = now() where id = r.id;
    return 'cap_blocked';
  end if;
  update public.review_requests set status = 'queued', claimed_at = now(), decided_at = now() where id = r.id;
  return 'claimed';
end;
$$;
revoke all on function public.claim_review_request(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_review_request(uuid, uuid, integer) to service_role;

-- Counts for the settings page: by status, by skip reason, by place, and how many queued messages WhatsApp then failed to deliver.
-- No names, numbers or links.
create or replace function public.review_request_stats(p_org uuid, p_since timestamptz)
returns jsonb
language sql
security definer
set search_path = ''
stable
as $$
  select jsonb_build_object(
    'by_status', coalesce((
      select jsonb_object_agg(status, n) from (
        select r.status, count(*) as n from public.review_requests r
         where r.org_id = p_org and r.created_at >= p_since group by r.status
      ) s
    ), '{}'::jsonb),
    'skipped_by_reason', coalesce((
      select jsonb_object_agg(reason, n) from (
        select r.reason, count(*) as n from public.review_requests r
         where r.org_id = p_org and r.created_at >= p_since and r.status in ('skipped', 'failed') and r.reason is not null
         group by r.reason
      ) s
    ), '{}'::jsonb),
    'by_location', coalesce((
      select jsonb_agg(jsonb_build_object('location', name, 'queued', queued, 'cap_blocked', capped, 'skipped', skipped) order by name)
      from (
        select coalesce(l.name, 'No location') as name,
               count(*) filter (where r.status = 'queued') as queued,
               count(*) filter (where r.status = 'cap_blocked') as capped,
               count(*) filter (where r.status in ('skipped', 'failed')) as skipped
          from public.review_requests r
          left join public.locations l on l.id = r.location_id
         where r.org_id = p_org and r.created_at >= p_since
         group by coalesce(l.name, 'No location')
      ) s
    ), '[]'::jsonb),
    'not_delivered', (
      select count(*) from public.review_requests r
        join public.messages m on m.id = r.message_id
       where r.org_id = p_org and r.created_at >= p_since and m.status = 'failed'
    )
  );
$$;
revoke all on function public.review_request_stats(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.review_request_stats(uuid, timestamptz) to service_role;

-- Safety net for the hooks (a visit completed by the Unite sync or in another process). The job itself (lib/integrations/reviews)
-- only looks at the last day and at visits after the integration was switched on.
select cron.schedule('pulse:review_requests_sweep', '*/15 * * * *', $$select app.ping_jobs('review_requests_sweep')$$);

-- ======================================================================
-- 20261019000200_ad_attribution.sql
-- ======================================================================
-- Phase 19b (2/5): Meta ad attribution and the Conversions API for business messaging.
--
--   ads.view                permission to see the ad attribution report (granted to the Manager and Marketing roles below)
--   ad_attributions         one row per ad click that started or continued a WhatsApp conversation: the click id (ctwa_clid) and the
--                           ad's id, type and headline from the referral object. No ad body, link, image or message text.
--   capi_events             one row per server-side event for Meta (Contact, Lead or Schedule): a deterministic event id, a status and
--                           a short reason. It never holds a name, number, e-mail, service, doctor or value.
--   capi_events queue       its own pgmq queue so retries and back-off never touch the WhatsApp lanes
--   ad_attribution_report() aggregates per ad (counts only)
--   pulse:capi_events / pulse:capi_sweep   queue drain every 10 s; sweep (Lead and Schedule from enquiries and bookings) every 10 min
--
-- Nothing is captured or sent until an administrator switches the integration (kind 'meta_capi') on; sending needs a second choice
-- ("send events", default "report only") and credentials.

-- ---------------------------------------------------------------------------
-- Permission for the existing system roles (idempotent; new orgs get it from lib/auth/permissions.ts)
-- ---------------------------------------------------------------------------
do $$
declare
  g record;
begin
  for g in
    select * from (values
      ('Manager', 'ads.view'),
      ('Marketing', 'ads.view')
    ) as t (role_name, perm)
  loop
    update public.roles r
       set permissions = r.permissions || to_jsonb(g.perm)
     where r.is_system and r.name = g.role_name and not (r.permissions ? g.perm);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- ad_attributions
-- ---------------------------------------------------------------------------
create table public.ad_attributions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  contact_id uuid references public.contacts (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete set null,
  channel_id uuid references public.channels (id) on delete set null,
  waba_id text check (waba_id is null or char_length(waba_id) <= 40),
  ctwa_clid text not null check (char_length(ctwa_clid) between 1 and 500),
  source_id text check (source_id is null or char_length(source_id) <= 100),
  source_type text check (source_type is null or char_length(source_type) <= 20),
  headline text check (headline is null or char_length(headline) <= 200),
  clicked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (org_id, ctwa_clid)
);
create index ad_attributions_org_clicked_idx on public.ad_attributions (org_id, clicked_at desc);
create index ad_attributions_contact_idx on public.ad_attributions (contact_id) where contact_id is not null;

create trigger ad_attributions_contact_org_check before insert or update of contact_id, org_id on public.ad_attributions
  for each row execute function app.check_parent_org('contacts', 'contact_id');
create trigger ad_attributions_conversation_org_check before insert or update of conversation_id, org_id on public.ad_attributions
  for each row execute function app.check_parent_org('conversations', 'conversation_id');

alter table public.ad_attributions enable row level security;
create policy ad_attributions_select on public.ad_attributions for select to authenticated
  using (app.has_perm(org_id, 'ads.view'));
-- writes: the inbound job (service role)

-- ---------------------------------------------------------------------------
-- capi_events
-- ---------------------------------------------------------------------------
create table public.capi_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  attribution_id uuid not null references public.ad_attributions (id) on delete cascade,
  event_name text not null check (event_name in ('Lead', 'Contact', 'Schedule')),
  event_id text not null check (char_length(event_id) between 8 and 100),
  subject_id uuid,
  event_time timestamptz not null,
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'skipped')),
  reason text check (reason is null or char_length(reason) <= 40),
  is_test boolean not null default false,
  attempts smallint not null default 0,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (org_id, event_id)
);
create index capi_events_org_created_idx on public.capi_events (org_id, created_at desc);
create index capi_events_attribution_idx on public.capi_events (attribution_id);

create trigger capi_events_set_updated_at before update on public.capi_events
  for each row execute function app.set_updated_at();
create trigger capi_events_attribution_org_check before insert or update of attribution_id, org_id on public.capi_events
  for each row execute function app.check_parent_org('ad_attributions', 'attribution_id');

alter table public.capi_events enable row level security;
create policy capi_events_select on public.capi_events for select to authenticated
  using (app.has_perm(org_id, 'ads.view'));
-- writes: the inbound job, the sweep and the capi_events queue handler (service role)

-- ---------------------------------------------------------------------------
-- The report: counts per ad, nothing about a person. A booking or enquiry counts for an ad when it was created after the click, for
-- the same contact, inside the attribution window; a cancelled booking does not count.
-- ---------------------------------------------------------------------------
create or replace function public.ad_attribution_report(p_org uuid, p_since timestamptz, p_window_days integer default 7)
returns jsonb
language sql
security definer
set search_path = ''
stable
as $$
  with a as (
    select x.id, x.contact_id, x.clicked_at, x.source_id, x.source_type, x.headline
      from public.ad_attributions x
     where x.org_id = p_org and x.clicked_at >= p_since
  ), appts as (
    select a.id as attribution_id, count(distinct ap.id) as n
      from a
      join public.appointments ap on ap.org_id = p_org and ap.contact_id = a.contact_id
       and ap.created_at >= a.clicked_at
       and ap.created_at < a.clicked_at + make_interval(days => greatest(p_window_days, 1))
       and ap.status <> 'cancelled'
     group by a.id
  ), enq as (
    select a.id as attribution_id, count(distinct e.id) as n
      from a
      join public.enquiries e on e.org_id = p_org and e.contact_id = a.contact_id
       and e.created_at >= a.clicked_at
       and e.created_at < a.clicked_at + make_interval(days => greatest(p_window_days, 1))
     group by a.id
  )
  select coalesce(jsonb_agg(to_jsonb(t) order by t.conversations desc, t.source_id), '[]'::jsonb)
    from (
      select coalesce(a.source_id, 'unknown') as source_id,
             coalesce(a.source_type, 'unknown') as source_type,
             max(a.headline) as headline,
             count(*) as conversations,
             count(distinct a.contact_id) as patients,
             coalesce(sum(enq.n), 0) as enquiries,
             coalesce(sum(appts.n), 0) as appointments
        from a
        left join appts on appts.attribution_id = a.id
        left join enq on enq.attribution_id = a.id
       group by coalesce(a.source_id, 'unknown'), coalesce(a.source_type, 'unknown')
    ) t;
$$;
revoke all on function public.ad_attribution_report(uuid, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.ad_attribution_report(uuid, timestamptz, integer) to service_role;

-- ---------------------------------------------------------------------------
-- Queue and schedules (queue names must stay in sync with lib/jobs/queues.ts)
-- ---------------------------------------------------------------------------
select pgmq.create('capi_events');
select cron.schedule('pulse:capi_events', '10 seconds', $$select app.ping_jobs('capi_events')$$);
select cron.schedule('pulse:capi_sweep', '*/10 * * * *', $$select app.ping_jobs('capi_sweep')$$);

-- ======================================================================
-- 20261019000300_telehealth.sql
-- ======================================================================
-- Phase 19b (3/5): telehealth links on video appointments.
--
--   services.default_visit_mode      'in_person' (default) or 'video': what a booking of that service is, unless overridden
--   appointments.visit_mode          null = follow the service; 'in_person' or 'video' overrides it for this booking. Pulse-only: the
--                                    Unite sync never writes it
--   telehealth_rooms                 one video room per appointment: an unguessable 256-bit token (only its SHA-256 and an AES-256-GCM
--                                    copy are stored, so staff can be shown the link and reminders can carry it), the provider's room
--                                    name, and the window it is valid for. No patient name, number or id ever goes into a room name.
--                                    Service role only: staff get the link through a server action that checks the permission.
--
-- A room is created when it is first needed (a member of staff presses Join, or a reminder that carries the link is rendered), is
-- replaced when the appointment moves, and is revoked when the appointment is cancelled, a no-show or completed.

alter table public.services
  add column if not exists default_visit_mode text not null default 'in_person'
    check (default_visit_mode in ('in_person', 'video'));
comment on column public.services.default_visit_mode is
  'in_person or video. A booking of this service is a video visit unless appointments.visit_mode overrides it.';

alter table public.appointments
  add column if not exists visit_mode text check (visit_mode is null or visit_mode in ('in_person', 'video'));
comment on column public.appointments.visit_mode is
  'Null follows services.default_visit_mode. Pulse-only; the Unite sync never writes it.';

create table public.telehealth_rooms (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  appointment_id uuid not null references public.appointments (id) on delete cascade,
  provider text not null check (provider in ('static', 'daily')),
  room_ref text check (room_ref is null or char_length(room_ref) <= 200),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  token_enc text not null,
  status text not null default 'creating' check (status in ('creating', 'active', 'revoked')),
  revoked_reason text check (revoked_reason is null or char_length(revoked_reason) <= 40),
  for_starts_at timestamptz not null,
  for_ends_at timestamptz not null,
  expires_at timestamptz not null,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  provider_deleted_at timestamptz
);
-- one live room per appointment
create unique index telehealth_rooms_live_uidx on public.telehealth_rooms (appointment_id) where status in ('creating', 'active');
create index telehealth_rooms_org_idx on public.telehealth_rooms (org_id, created_at desc);

create trigger telehealth_rooms_appointment_org_check before insert or update of appointment_id, org_id on public.telehealth_rooms
  for each row execute function app.check_parent_org('appointments', 'appointment_id');

alter table public.telehealth_rooms enable row level security;
-- no policies: holds the encrypted room token. Only server code (service role, after can()) reads or writes it.

-- ======================================================================
-- 20261019000400_esign.sql
-- ======================================================================
-- Phase 19b (4/5): e-signature for consent forms.
--
--   esign_requests   one row per request sent to the e-signature provider: which patient, which source document (a patient document or a
--                    library file), the provider's request id, a forward-only status and, once signed, the stored copy (a normal
--                    patient document of category 'consent'). The signer's e-mail is NOT stored, only a masked hint ("s***@x.com"); the
--                    request carries no clinical information. Documents must be switched on (Settings, Patient documents) to use it.
--
-- Status moves forward only (enforced here and in lib/integrations/esign/state.ts):
--   creating -> pending | failed;  pending -> signed | declined | expired | cancelled;  everything else is final.

create table public.esign_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  requested_by uuid references public.profiles (id) on delete set null,
  provider text not null default 'dropbox_sign' check (provider in ('dropbox_sign')),
  provider_request_id text check (provider_request_id is null or char_length(provider_request_id) <= 120),
  source_kind text not null check (source_kind in ('patient_document', 'library_asset')),
  source_document_id uuid references public.patient_documents (id) on delete set null,
  source_asset_id uuid references public.media_assets (id) on delete set null,
  status text not null default 'creating' check (status in ('creating', 'pending', 'signed', 'declined', 'expired', 'cancelled', 'failed')),
  error_code text check (error_code is null or char_length(error_code) <= 40),
  signer_hint text check (signer_hint is null or char_length(signer_hint) <= 80),
  signed_document_id uuid references public.patient_documents (id) on delete set null,
  test_mode boolean not null default true,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  check (
    (source_kind = 'patient_document' and source_asset_id is null)
    or (source_kind = 'library_asset' and source_document_id is null)
  )
);
create unique index esign_requests_provider_ref_uidx on public.esign_requests (provider, provider_request_id)
  where provider_request_id is not null;
create index esign_requests_contact_idx on public.esign_requests (org_id, contact_id, created_at desc);
create index esign_requests_open_idx on public.esign_requests (org_id, expires_at) where status in ('creating', 'pending');

create trigger esign_requests_set_updated_at before update on public.esign_requests
  for each row execute function app.set_updated_at();
create trigger esign_requests_contact_org_check before insert or update of contact_id, org_id on public.esign_requests
  for each row execute function app.check_parent_org('contacts', 'contact_id');
create trigger esign_requests_source_doc_org_check before insert or update of source_document_id, org_id on public.esign_requests
  for each row execute function app.check_parent_org('patient_documents', 'source_document_id');
create trigger esign_requests_source_asset_org_check before insert or update of source_asset_id, org_id on public.esign_requests
  for each row execute function app.check_parent_org('media_assets', 'source_asset_id');
create trigger esign_requests_signed_doc_org_check before insert or update of signed_document_id, org_id on public.esign_requests
  for each row execute function app.check_parent_org('patient_documents', 'signed_document_id');

create or replace function app.esign_status_forward_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = old.status then
    return new;
  end if;
  if not (
    (old.status = 'creating' and new.status in ('pending', 'failed'))
    or (old.status = 'pending' and new.status in ('signed', 'declined', 'expired', 'cancelled'))
  ) then
    raise exception 'esign request cannot move from % to %', old.status, new.status using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger esign_requests_forward_only before update of status on public.esign_requests
  for each row execute function app.esign_status_forward_only();

alter table public.esign_requests enable row level security;
create policy esign_requests_select on public.esign_requests for select to authenticated
  using (app.has_perm(org_id, 'documents.view'));
-- writes: server actions (service role after can('documents.manage')) and the signed-request webhook

-- ======================================================================
-- 20261019000500_phase19b_erasure_housekeeping.sql
-- ======================================================================
-- Phase 19b (5/5): erasure and housekeeping for the 19b tables.
--
-- public.erase_contact() is replaced with the Phase 16 body plus Phase 19b steps, so erasing a patient also removes
--   * their Google review requests (review_requests, as patient and as the person who was messaged)
--   * their ad clicks (ad_attributions; the Conversions API event rows go with them)
--   * their e-signature requests (esign_requests; the signed copies are patient documents, which are already deleted above)
--   * their video rooms: the link is revoked and its encrypted token wiped; a durable job deletes the room at the provider
-- Files are removed by the server action BEFORE this function runs (unchanged). The e-signature provider keeps its own copy of anything
-- it was sent, under its own terms: the privacy action withdraws requests that are still waiting, and the clinic's agreement with the
-- provider has to cover the rest (docs/19_PHASE_19B_NOTES.md).
--
-- pulse:housekeeping_19b (daily 03:55 UTC) keeps the tables small: review requests and ad clicks 400 days, Conversions API event rows
-- 90 days, ended video rooms 30 days, and waiting e-signature requests a day past their expiry are closed as expired.

create or replace function public.erase_contact(p_org uuid, p_contact uuid, p_actor uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact public.contacts;
  v_conv uuid[];
  v_enq uuid[];
  v_appt uuid[];
  v_task uuid[];
  n integer;
  r jsonb := '{}'::jsonb;
begin
  select * into v_contact from public.contacts where id = p_contact and org_id = p_org for update;
  if not found then
    raise exception 'contact not found in this organisation' using errcode = 'no_data_found';
  end if;
  if v_contact.erased_at is not null then
    raise exception 'contact is already erased' using errcode = 'check_violation';
  end if;

  select coalesce(array_agg(id), '{}') into v_conv from public.conversations where org_id = p_org and contact_id = p_contact;
  select coalesce(array_agg(id), '{}') into v_enq from public.enquiries where org_id = p_org and contact_id = p_contact;
  select coalesce(array_agg(id), '{}') into v_appt from public.appointments where org_id = p_org and contact_id = p_contact;
  select coalesce(array_agg(id), '{}') into v_task from public.tasks where org_id = p_org and contact_id = p_contact;

  -- Messages: keep the row (counts, delivery stats) but drop everything a person wrote or sent.
  update public.messages
     set body = null, payload = '{}'::jsonb, media_path = null, media_mime = null, media_filename = null,
         media_meta_id = null, error_message = null
   where org_id = p_org and conversation_id = any (v_conv);
  get diagnostics n = row_count; r := r || jsonb_build_object('messages_scrubbed', n);

  update public.conversations
     set summary = null, last_message_preview = null, ad_referral = null, ai_tags = '{}'
   where org_id = p_org and id = any (v_conv);

  delete from public.mentions where org_id = p_org and (contact_id = p_contact or conversation_id = any (v_conv));
  delete from public.timeline_events
   where org_id = p_org and (contact_id = p_contact or enquiry_id = any (v_enq));
  get diagnostics n = row_count; r := r || jsonb_build_object('timeline_events_deleted', n);

  delete from public.contact_phones where org_id = p_org and contact_id = p_contact;
  get diagnostics n = row_count; r := r || jsonb_build_object('phones_deleted', n);
  delete from public.contact_tags where contact_id = p_contact;
  delete from public.segment_members where contact_id = p_contact;

  -- Phase 16: the patient's uploaded documents (referrals, lab reports, insurance cards, consent forms).
  delete from public.patient_documents where org_id = p_org and contact_id = p_contact;
  get diagnostics n = row_count; r := r || jsonb_build_object('documents_deleted', n);

  -- Phase 19b: review requests, ad clicks, e-signature requests and video rooms.
  delete from public.review_requests
   where org_id = p_org and (contact_id = p_contact or recipient_contact_id = p_contact or appointment_id = any (v_appt));
  get diagnostics n = row_count; r := r || jsonb_build_object('review_requests_deleted', n);
  delete from public.ad_attributions where org_id = p_org and contact_id = p_contact;
  get diagnostics n = row_count; r := r || jsonb_build_object('ad_clicks_deleted', n);
  delete from public.esign_requests where org_id = p_org and contact_id = p_contact;
  get diagnostics n = row_count; r := r || jsonb_build_object('esign_requests_deleted', n);
  insert into public.scheduled_jobs (kind, org_id, run_at, payload, dedupe_key)
  select 'telehealth.cleanup', t.org_id, now(), jsonb_build_object('room_id', t.id), 'telehealth-cleanup:' || t.id::text
    from public.telehealth_rooms t
   where t.org_id = p_org and t.appointment_id = any (v_appt) and t.provider <> 'static' and t.room_ref is not null and t.provider_deleted_at is null
  on conflict do nothing;
  update public.telehealth_rooms
     set status = 'revoked', revoked_reason = coalesce(revoked_reason, 'erased'), revoked_at = coalesce(revoked_at, now()), token_enc = ''
   where org_id = p_org and appointment_id = any (v_appt);
  get diagnostics n = row_count; r := r || jsonb_build_object('video_rooms_revoked', n);

  update public.appointments set notes = null, custom = '{}'::jsonb where org_id = p_org and id = any (v_appt);
  update public.enquiries
     set title = 'Erased enquiry', custom = '{}'::jsonb, lost_reason = null
   where org_id = p_org and id = any (v_enq);
  update public.tasks set subject = 'Erased task', notes = null where org_id = p_org and id = any (v_task);
  update public.flow_runs set context = '{}'::jsonb, waiting_for = null, error = null
   where org_id = p_org and contact_id = p_contact;
  update public.campaign_recipients set vars = '{}'::jsonb, csv_data = '{}'::jsonb, error_message = null
   where org_id = p_org and contact_id = p_contact;
  update public.recall_sends set notes = null, sent_to_phone_e164 = null where org_id = p_org and contact_id = p_contact;
  -- Unite patients that were matched to this contact carry the patient's details in the review item.
  update public.sync_reviews set incoming = '{}'::jsonb, candidates = '[]'::jsonb
   where org_id = p_org and resolved_contact_id = p_contact;

  -- The field-level history of the patient's appointments, enquiries and tasks repeats those values.
  perform set_config('app.history_purge', 'on', true);
  delete from public.record_history
   where org_id = p_org and (
     (table_name = 'appointments' and record_id = any (v_appt)) or
     (table_name = 'enquiries' and record_id = any (v_enq)) or
     (table_name = 'tasks' and record_id = any (v_task))
   );
  get diagnostics n = row_count; r := r || jsonb_build_object('history_rows_deleted', n);

  update public.contacts
     set first_name = 'Erased', last_name = 'patient', phone_e164 = null, wa_bsuid = null, email = null,
         gender = null, nationality = null, country = null, language = null, dob = null, label = null,
         owner_id = null, assignee_id = null, external_id = null, custom = '{}'::jsonb,
         wa_profile_name = null, promotions_opt_in = false, promotions_consent = null,
         stop_marketing = true,                                    -- an erased person is never messaged again
         clinical_messaging_consent = false,
         merged_into_id = null, deleted_at = coalesce(deleted_at, now()), erased_at = now()
   where id = p_contact;

  -- Counts of what is deliberately left (clinical records), so the reviewer sees it in the result.
  r := r || jsonb_build_object(
    'retained_visits', (select count(*) from public.visits where org_id = p_org and contact_id = p_contact),
    'retained_prescriptions', (select count(*) from public.prescriptions where org_id = p_org and contact_id = p_contact),
    'retained_followups', (select count(*) from public.clinical_followups where org_id = p_org and contact_id = p_contact),
    'retained_feedback', (select count(*) from public.clinical_feedback where org_id = p_org and contact_id = p_contact),
    'conversations', coalesce(array_length(v_conv, 1), 0),
    'appointments', coalesce(array_length(v_appt, 1), 0),
    'enquiries', coalesce(array_length(v_enq, 1), 0),
    'tasks', coalesce(array_length(v_task, 1), 0)
  );

  insert into public.audit_log (org_id, user_id, action, entity, entity_id, diff)
  values (p_org, p_actor, 'contact.erased', 'contact', p_contact::text, r);
  return r;
end;
$$;
revoke all on function public.erase_contact(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.erase_contact(uuid, uuid, uuid) to service_role;

select cron.schedule('pulse:housekeeping_19b', '55 3 * * *', $$
  delete from public.review_requests where created_at < now() - interval '400 days';
  delete from public.capi_events where created_at < now() - interval '90 days';
  delete from public.ad_attributions where clicked_at < now() - interval '400 days';
  delete from public.telehealth_rooms
   where (status = 'revoked' and revoked_at < now() - interval '30 days'
          and (provider = 'static' or room_ref is null or provider_deleted_at is not null))
      or (status = 'active' and expires_at < now() - interval '30 days');
  update public.esign_requests set status = 'expired', completed_at = now()
   where status = 'pending' and expires_at < now() - interval '1 day';
$$);
