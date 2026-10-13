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
