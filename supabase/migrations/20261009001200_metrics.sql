-- Phase 10 / 3: metrics layer for dashboards and reports.
--
-- Built only from tables that exist today (conversations, messages, memberships). Reports for
-- enquiries, appointments, campaigns and Unite are added with their phases; the report registry
-- (lib/reports/registry.ts) checks public.report_sources_available() to decide what is "live".
--
-- Metric definitions (documented in docs/audit/reports.md; OQ-44, the data requirements matrix, is
-- still missing, so these are working definitions):
--   first response     first outbound message sent by a *staff member* (sent_by_user_id is set; bots and
--                      flows excluded) at or after the first inbound message of the conversation
--   resolution time    closed_at - opened_at
--   returning contact  the contact had an earlier conversation than this one
--   days               bucketed in the org's timezone (orgs.timezone)
--
-- Materialized views are NOT covered by RLS. They are revoked from anon/authenticated and read only
-- by lib/reports through the service role, after can('reports.view') and always filtered by org_id.

-- ---------------------------------------------------------------------------
-- Materialized views (refreshed concurrently by pg_cron every 15 minutes)
-- ---------------------------------------------------------------------------

create materialized view public.mv_conversation_facts as
with m as (
  select conversation_id,
         min(at) filter (where direction = 'in') as first_inbound_at,
         count(*) filter (where direction = 'in') as inbound_count,
         count(*) filter (where direction = 'out') as outbound_count
  from public.messages
  group by conversation_id
)
select c.id as conversation_id,
       c.org_id,
       c.channel_id,
       c.contact_id,
       c.assignee_user_id,
       c.assignee_team_id,
       c.status,
       c.opened_at,
       c.closed_at,
       c.closed_by,
       (c.opened_at at time zone o.timezone)::date as opened_day,
       m.first_inbound_at,
       fr.first_response_at,
       fr.first_response_by,
       case when fr.first_response_at is not null and m.first_inbound_at is not null
            then extract(epoch from fr.first_response_at - m.first_inbound_at)::integer end as first_response_seconds,
       case when c.closed_at is not null
            then extract(epoch from c.closed_at - c.opened_at)::integer end as resolution_seconds,
       coalesce(m.inbound_count, 0)::integer as inbound_count,
       coalesce(m.outbound_count, 0)::integer as outbound_count,
       exists (
         select 1 from public.conversations p
         where p.contact_id = c.contact_id and p.opened_at < c.opened_at
       ) as is_returning
from public.conversations c
join public.orgs o on o.id = c.org_id
left join m on m.conversation_id = c.id
left join lateral (
  select x.at as first_response_at, x.sent_by_user_id as first_response_by
  from public.messages x
  where x.conversation_id = c.id
    and x.direction = 'out'
    and x.sent_by_user_id is not null
    and x.at >= coalesce(m.first_inbound_at, c.opened_at)
  order by x.at
  limit 1
) fr on true;
create unique index mv_conversation_facts_pk on public.mv_conversation_facts (conversation_id);
create index mv_conversation_facts_org_day_idx on public.mv_conversation_facts (org_id, opened_day);

create materialized view public.mv_daily_conversations as
with opened as (
  select org_id, opened_day as day, channel_id,
         count(*) as opened,
         count(distinct contact_id) as unique_contacts,
         count(distinct contact_id) filter (where is_returning) as returning_contacts
  from public.mv_conversation_facts
  group by org_id, opened_day, channel_id
),
closed as (
  select f.org_id, (f.closed_at at time zone o.timezone)::date as day, f.channel_id, count(*) as closed
  from public.mv_conversation_facts f
  join public.orgs o on o.id = f.org_id
  where f.closed_at is not null
  group by f.org_id, (f.closed_at at time zone o.timezone)::date, f.channel_id
),
msgs as (
  select m.org_id, (m.at at time zone o.timezone)::date as day, c.channel_id,
         count(*) filter (where m.direction = 'in') as inbound_messages,
         count(*) filter (where m.direction = 'out') as outbound_messages
  from public.messages m
  join public.conversations c on c.id = m.conversation_id
  join public.orgs o on o.id = m.org_id
  group by m.org_id, (m.at at time zone o.timezone)::date, c.channel_id
)
select org_id, day, channel_id,
       coalesce(opened.opened, 0)::integer as opened,
       coalesce(closed.closed, 0)::integer as closed,
       coalesce(opened.unique_contacts, 0)::integer as unique_contacts,
       coalesce(opened.returning_contacts, 0)::integer as returning_contacts,
       coalesce(msgs.inbound_messages, 0)::integer as inbound_messages,
       coalesce(msgs.outbound_messages, 0)::integer as outbound_messages
from opened
full join closed using (org_id, day, channel_id)
full join msgs using (org_id, day, channel_id);
create unique index mv_daily_conversations_pk on public.mv_daily_conversations (org_id, day, channel_id);

-- Hour x weekday heatmap source: the report sums over the chosen period and groups by dow/hour.
create materialized view public.mv_hourly_conversations as
select m.org_id,
       (m.at at time zone o.timezone)::date as day,
       extract(hour from m.at at time zone o.timezone)::integer as hour,
       c.channel_id,
       count(*) filter (where m.direction = 'in')::integer as inbound_messages,
       count(*) filter (where m.direction = 'out')::integer as outbound_messages
from public.messages m
join public.conversations c on c.id = m.conversation_id
join public.orgs o on o.id = m.org_id
where m.direction in ('in', 'out')
group by m.org_id, (m.at at time zone o.timezone)::date, extract(hour from m.at at time zone o.timezone)::integer, c.channel_id;
create unique index mv_hourly_conversations_pk on public.mv_hourly_conversations (org_id, day, hour, channel_id);

-- Per staff member per day. Sums + counts (not medians) so any period can be re-aggregated exactly.
create materialized view public.mv_agent_performance as
with sent as (
  select m.org_id, (m.at at time zone o.timezone)::date as day, m.sent_by_user_id as user_id,
         count(*) as messages_sent,
         count(distinct m.conversation_id) as conversations_handled
  from public.messages m
  join public.orgs o on o.id = m.org_id
  where m.direction = 'out' and m.sent_by_user_id is not null
  group by m.org_id, (m.at at time zone o.timezone)::date, m.sent_by_user_id
),
fr as (
  select f.org_id, (f.first_response_at at time zone o.timezone)::date as day, f.first_response_by as user_id,
         count(f.first_response_seconds) as first_response_count,
         coalesce(sum(f.first_response_seconds), 0) as first_response_seconds_sum
  from public.mv_conversation_facts f
  join public.orgs o on o.id = f.org_id
  where f.first_response_by is not null
  group by f.org_id, (f.first_response_at at time zone o.timezone)::date, f.first_response_by
),
cl as (
  select f.org_id, (f.closed_at at time zone o.timezone)::date as day, f.closed_by as user_id,
         count(*) as conversations_closed,
         coalesce(sum(f.resolution_seconds), 0) as resolution_seconds_sum
  from public.mv_conversation_facts f
  join public.orgs o on o.id = f.org_id
  where f.closed_at is not null and f.closed_by is not null
  group by f.org_id, (f.closed_at at time zone o.timezone)::date, f.closed_by
)
select org_id, day, user_id,
       coalesce(sent.messages_sent, 0)::integer as messages_sent,
       coalesce(sent.conversations_handled, 0)::integer as conversations_handled,
       coalesce(fr.first_response_count, 0)::integer as first_response_count,
       coalesce(fr.first_response_seconds_sum, 0)::bigint as first_response_seconds_sum,
       coalesce(cl.conversations_closed, 0)::integer as conversations_closed,
       coalesce(cl.resolution_seconds_sum, 0)::bigint as resolution_seconds_sum
from sent
full join fr using (org_id, day, user_id)
full join cl using (org_id, day, user_id);
create unique index mv_agent_performance_pk on public.mv_agent_performance (org_id, day, user_id);

-- Outbound usage by day / number / template vs free-form / delivery status.
-- Cost is NOT here: it needs Meta pricing_analytics ingestion (a later task).
create materialized view public.mv_message_usage_daily as
select m.org_id,
       (m.at at time zone o.timezone)::date as day,
       c.channel_id,
       case when m.kind = 'template' then 'template' else 'free_form' end as category,
       m.status,
       count(*)::integer as messages
from public.messages m
join public.conversations c on c.id = m.conversation_id
join public.orgs o on o.id = m.org_id
where m.direction = 'out'
group by m.org_id, (m.at at time zone o.timezone)::date, c.channel_id,
         case when m.kind = 'template' then 'template' else 'free_form' end, m.status;
create unique index mv_message_usage_daily_pk on public.mv_message_usage_daily (org_id, day, channel_id, category, status);

-- ---------------------------------------------------------------------------
-- Live views for the team-lead dashboard (security_invoker: the caller's RLS still applies)
-- ---------------------------------------------------------------------------

create view public.v_team_queue_now with (security_invoker = true) as
select org_id,
       assignee_team_id,
       count(*) filter (where status = 'open')::integer as open_count,
       count(*) filter (where status = 'waiting')::integer as waiting_count,
       count(*) filter (where assignee_user_id is null)::integer as unassigned_count,
       count(*) filter (where unread_count > 0)::integer as unread_count
from public.conversations
where status <> 'closed'
group by org_id, assignee_team_id;

create view public.v_agent_workload_now with (security_invoker = true) as
select m.org_id,
       m.user_id,
       m.presence,
       m.presence_at,
       count(c.id) filter (where c.status <> 'closed')::integer as open_conversations,
       count(c.id) filter (where c.status <> 'closed' and c.unread_count > 0)::integer as unread_conversations
from public.memberships m
left join public.conversations c on c.org_id = m.org_id and c.assignee_user_id = m.user_id
where m.status = 'active'
group by m.org_id, m.user_id, m.presence, m.presence_at;

-- Conversations where the patient wrote last and staff have not replied within the SLA.
-- Threshold: orgs.settings->'reports'->>'sla_minutes' (default 15).
create view public.v_sla_breaches_now with (security_invoker = true) as
select c.org_id,
       c.id as conversation_id,
       c.assignee_user_id,
       c.assignee_team_id,
       c.last_inbound_at,
       extract(epoch from now() - c.last_inbound_at)::integer / 60 as waiting_minutes
from public.conversations c
join public.orgs o on o.id = c.org_id
where c.status <> 'closed'
  and c.last_message_direction = 'in'
  and c.last_inbound_at is not null
  and c.last_inbound_at < now() - make_interval(mins => coalesce((o.settings -> 'reports' ->> 'sla_minutes')::integer, 15));

-- ---------------------------------------------------------------------------
-- Access: service role only for the materialized views; views are service role + RLS.
-- ---------------------------------------------------------------------------

revoke all on public.mv_conversation_facts, public.mv_daily_conversations, public.mv_hourly_conversations,
              public.mv_agent_performance, public.mv_message_usage_daily
  from public, anon, authenticated;
grant select on public.mv_conversation_facts, public.mv_daily_conversations, public.mv_hourly_conversations,
                public.mv_agent_performance, public.mv_message_usage_daily
  to service_role;

revoke all on public.v_team_queue_now, public.v_agent_workload_now, public.v_sla_breaches_now from public, anon;
grant select on public.v_team_queue_now, public.v_agent_workload_now, public.v_sla_breaches_now to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Refresh + discovery
-- ---------------------------------------------------------------------------

-- Refresh one view, or all in dependency order. Concurrent, so dashboards keep reading during a refresh.
create or replace function public.refresh_metrics(p_name text default null)
returns text[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_all text[] := array[
    'mv_conversation_facts', 'mv_daily_conversations', 'mv_hourly_conversations',
    'mv_agent_performance', 'mv_message_usage_daily'
  ];
  v_name text;
  v_done text[] := '{}';
begin
  if p_name is not null and not (p_name = any (v_all)) then
    raise exception 'unknown metrics view %', p_name using errcode = 'invalid_parameter_value';
  end if;
  foreach v_name in array v_all loop
    if p_name is null or p_name = v_name then
      execute format('refresh materialized view concurrently public.%I', v_name);
      v_done := v_done || v_name;
    end if;
  end loop;
  return v_done;
end;
$$;
revoke all on function public.refresh_metrics(text) from public, anon, authenticated;
grant execute on function public.refresh_metrics(text) to service_role;

-- Which report data sources exist right now (views / materialized views named v_* or mv_*).
-- The report registry marks a report "awaiting Phase N" until its sources appear here.
create or replace function public.report_sources_available()
returns text[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(c.relname::text order by c.relname), '{}')
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('v', 'm')
    and (c.relname like 'mv\_%' or c.relname like 'v\_%');
$$;
revoke all on function public.report_sources_available() from public, anon, authenticated;
grant execute on function public.report_sources_available() to service_role;

-- The refresh runs through the app's task route so it lands in job_runs.
select cron.schedule('pulse:metrics_refresh', '*/15 * * * *', $$select app.ping_jobs('metrics_refresh')$$);
