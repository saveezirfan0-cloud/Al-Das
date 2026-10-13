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
