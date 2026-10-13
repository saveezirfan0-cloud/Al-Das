-- Phase 20d (docs/26_PHASE_20D_NOTES.md): template delivery settings, retry-on-fail, template performance.
-- Service role writes everything here; no new table, so no new policy (wa_templates / messages keep theirs).
--
--   wa_templates.retry_on_fail   (existing since Phase 3, unused until now) one bounded WhatsApp retry chain for a
--                                non-campaign template message that failed with a retryable code
--   wa_templates.sms_fallback    may an appointment reminder sent with this template fall back to SMS (Phase 19a path)?
--                                Default true keeps the Phase 19 behaviour; it never applies to MARKETING templates
--                                (lib/templates/delivery.ts smsFallbackAllowed)
--   wa_templates.ttl_seconds     a message of this template that could not be sent within this many seconds of being
--                                queued is not sent at all (outbound job guard); null = no limit
--   messages.retry_of_message_id the failed message a retry copies; unique, so a failure is retried at most once
--   v_template_message_facts     template sends (ids, statuses, times only) for the template performance report
--   report_template_performance  sent / delivered / read / replied / quick-reply clicks / failed per template and range
--   (media_asset_usage() learns carousel card headers in 20261108000600, next to recurring campaigns)

alter table public.wa_templates
  add column if not exists sms_fallback boolean not null default true,
  add column if not exists ttl_seconds integer
    check (ttl_seconds is null or ttl_seconds between 60 and 2592000);

comment on column public.wa_templates.retry_on_fail is
  'Phase 20d: a non-campaign message of this template that fails with a retryable code is sent again (bounded, lib/templates/delivery.ts).';
comment on column public.wa_templates.sms_fallback is
  'Phase 20d: an appointment reminder sent with this template may fall back to SMS (Phase 19a). Never for MARKETING templates.';
comment on column public.wa_templates.ttl_seconds is
  'Phase 20d: not sent when the message is older than this when the outbound job reaches it (null = no limit). Pulse-side guard; Meta''s own template TTL is not set from here.';

alter table public.messages
  add column if not exists retry_of_message_id uuid references public.messages (id) on delete set null;
create unique index if not exists messages_retry_of_uidx on public.messages (retry_of_message_id)
  where retry_of_message_id is not null;
comment on column public.messages.retry_of_message_id is
  'Phase 20d: the failed template message this one retries (retry_on_fail). Unique: one retry per failed message.';

-- Template performance reads outbound template messages by org and time, and quick-reply taps by the message they answer.
create index if not exists messages_org_template_out_idx on public.messages (org_id, at)
  where direction = 'out' and kind = 'template';
create index if not exists messages_in_reply_to_idx on public.messages (reply_to_wa_message_id)
  where direction = 'in' and reply_to_wa_message_id is not null;

-- ---------------------------------------------------------------------------
-- Template message facts (ids, statuses and times only; no body, no payload values).
-- ---------------------------------------------------------------------------
create or replace view public.v_template_message_facts
with (security_invoker = true) as
select m.id,
       m.org_id,
       m.conversation_id,
       cv.channel_id,
       (m.payload -> 'send' ->> 'template_id') as template_key,
       m.status,
       m.error_code,
       m.wa_message_id,
       m.at,
       m.campaign_recipient_id is not null as from_campaign,
       m.retry_of_message_id is not null as is_retry,
       (m.at at time zone o.timezone)::date as day
from public.messages m
join public.conversations cv on cv.id = m.conversation_id
join public.orgs o on o.id = m.org_id
where m.direction = 'out' and m.kind = 'template';

revoke all on public.v_template_message_facts from public, anon, authenticated;
grant select on public.v_template_message_facts to service_role;

-- sent/delivered/read are cumulative like the campaign funnel. replied = the patient wrote in the same conversation
-- within 24 hours of the template message; clicked = a quick-reply button tap that answers it (Meta reports no URL
-- button clicks). A retry is its own message row and is counted as such (`retries`).
create or replace function public.report_template_performance(
  p_org uuid, p_from date, p_to date, p_channels uuid[] default null, p_template uuid default null
)
returns table (
  template_id uuid, name text, language text, category text,
  messages integer, sent integer, delivered integer, read_count integer, replied integer, clicked integer,
  failed integer, pending integer, retries integer, from_campaigns integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with bounds as (
    select (p_from::timestamp at time zone o.timezone) as t0,
           ((p_to + 1)::timestamp at time zone o.timezone) as t1
    from public.orgs o
    where o.id = p_org
  ),
  m as (
    select f.*
    from public.v_template_message_facts f, bounds b
    where f.org_id = p_org
      and f.at >= b.t0 and f.at < b.t1
      and (p_template is null or f.template_key = p_template::text)
      and (p_channels is null or cardinality(p_channels) = 0 or f.channel_id = any (p_channels))
  ),
  scored as (
    select m.*,
           exists (
             select 1 from public.messages r
             where r.conversation_id = m.conversation_id and r.direction = 'in' and r.kind <> 'reaction'
               and r.at > m.at and r.at <= m.at + interval '24 hours'
           ) as was_replied,
           (m.wa_message_id is not null and exists (
             select 1 from public.messages r
             where r.reply_to_wa_message_id = m.wa_message_id and r.direction = 'in' and r.kind = 'button'
               and r.org_id = m.org_id
           )) as was_clicked
    from m
  )
  select t.id, t.name, t.language, t.category,
         count(*)::integer,
         count(*) filter (where s.status in ('sent', 'delivered', 'read'))::integer,
         count(*) filter (where s.status in ('delivered', 'read'))::integer,
         count(*) filter (where s.status = 'read')::integer,
         count(*) filter (where s.was_replied)::integer,
         count(*) filter (where s.was_clicked)::integer,
         count(*) filter (where s.status = 'failed')::integer,
         count(*) filter (where s.status in ('queued', 'sending'))::integer,
         count(*) filter (where s.is_retry)::integer,
         count(*) filter (where s.from_campaign)::integer
  from scored s
  join public.wa_templates t on t.id::text = s.template_key and t.org_id = p_org
  group by t.id, t.name, t.language, t.category
  order by count(*) desc, t.name
  limit 200;
$$;
revoke all on function public.report_template_performance(uuid, date, date, uuid[], uuid) from public, anon, authenticated;
grant execute on function public.report_template_performance(uuid, date, date, uuid[], uuid) to service_role;

