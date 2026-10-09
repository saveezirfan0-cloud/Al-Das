-- Phase 10 / 4: report query functions over the metrics views.
--
-- Each function aggregates in SQL and returns a bounded result (<= a few hundred rows), because
-- PostgREST caps every response at max-rows (1000 on Supabase) and the hourly view alone can exceed
-- that over a year. Service role only: lib/reports calls them after can('reports.view') with the
-- caller's org. Filters are optional arrays; null or empty means "no filter".
--
-- Filter applicability (documented in docs/audit/reports.md):
--   channels  conversation, message and usage numbers
--   teams     conversation-level numbers (assignee_team_id) and the agent report (team members)
--   users     the agent report
-- Message volume per day comes from mv_daily_conversations, which has no team dimension.

-- Conversation-level headline numbers for the period (by the day the conversation opened).
create or replace function public.report_conversations_summary(
  p_org uuid, p_from date, p_to date, p_channels uuid[] default null, p_teams uuid[] default null
)
returns table (
  conversations integer, closed integer, still_open integer,
  unique_contacts integer, returning_contacts integer,
  inbound_messages integer, outbound_messages integer
)
language sql stable
set search_path = public, pg_temp
as $$
  select count(*)::integer,
         count(*) filter (where status = 'closed')::integer,
         count(*) filter (where status <> 'closed')::integer,
         count(distinct contact_id)::integer,
         count(distinct contact_id) filter (where is_returning)::integer,
         coalesce(sum(inbound_count), 0)::integer,
         coalesce(sum(outbound_count), 0)::integer
  from public.mv_conversation_facts
  where org_id = p_org
    and opened_day between p_from and p_to
    and (p_channels is null or cardinality(p_channels) = 0 or channel_id = any (p_channels))
    and (p_teams is null or cardinality(p_teams) = 0 or assignee_team_id = any (p_teams));
$$;

-- One row per day: conversations opened/closed (team-filterable) and message volume (channel-filterable only).
create or replace function public.report_conversations_by_day(
  p_org uuid, p_from date, p_to date, p_channels uuid[] default null, p_teams uuid[] default null
)
returns table (day date, opened integer, closed integer, inbound_messages integer, outbound_messages integer)
language sql stable
set search_path = public, pg_temp
as $$
  with days as (
    select d::date as day from generate_series(p_from, p_to, interval '1 day') d
  ),
  opened as (
    select opened_day as day, count(*)::integer as n
    from public.mv_conversation_facts
    where org_id = p_org and opened_day between p_from and p_to
      and (p_channels is null or cardinality(p_channels) = 0 or channel_id = any (p_channels))
      and (p_teams is null or cardinality(p_teams) = 0 or assignee_team_id = any (p_teams))
    group by opened_day
  ),
  closed as (
    select (f.closed_at at time zone o.timezone)::date as day, count(*)::integer as n
    from public.mv_conversation_facts f
    join public.orgs o on o.id = f.org_id
    where f.org_id = p_org and f.closed_at is not null
      and (f.closed_at at time zone o.timezone)::date between p_from and p_to
      and (p_channels is null or cardinality(p_channels) = 0 or f.channel_id = any (p_channels))
      and (p_teams is null or cardinality(p_teams) = 0 or f.assignee_team_id = any (p_teams))
    group by 1
  ),
  msgs as (
    select day, sum(inbound_messages)::integer as i, sum(outbound_messages)::integer as o
    from public.mv_daily_conversations
    where org_id = p_org and day between p_from and p_to
      and (p_channels is null or cardinality(p_channels) = 0 or channel_id = any (p_channels))
    group by day
  )
  select days.day, coalesce(opened.n, 0), coalesce(closed.n, 0), coalesce(msgs.i, 0), coalesce(msgs.o, 0)
  from days
  left join opened on opened.day = days.day
  left join closed on closed.day = days.day
  left join msgs on msgs.day = days.day
  order by days.day;
$$;

create or replace function public.report_conversations_by_channel(
  p_org uuid, p_from date, p_to date, p_channels uuid[] default null, p_teams uuid[] default null
)
returns table (channel_id uuid, channel_name text, conversations integer)
language sql stable
set search_path = public, pg_temp
as $$
  select f.channel_id, ch.name, count(*)::integer
  from public.mv_conversation_facts f
  join public.channels ch on ch.id = f.channel_id
  where f.org_id = p_org and f.opened_day between p_from and p_to
    and (p_channels is null or cardinality(p_channels) = 0 or f.channel_id = any (p_channels))
    and (p_teams is null or cardinality(p_teams) = 0 or f.assignee_team_id = any (p_teams))
  group by f.channel_id, ch.name
  order by count(*) desc, ch.name
  limit 50;
$$;

-- Inbound messages by weekday (0 = Sunday) and hour, in the org's timezone. At most 168 rows.
create or replace function public.report_heatmap(
  p_org uuid, p_from date, p_to date, p_channels uuid[] default null
)
returns table (dow integer, hour integer, inbound_messages integer)
language sql stable
set search_path = public, pg_temp
as $$
  select extract(dow from day)::integer, hour, sum(inbound_messages)::integer
  from public.mv_hourly_conversations
  where org_id = p_org and day between p_from and p_to
    and (p_channels is null or cardinality(p_channels) = 0 or channel_id = any (p_channels))
  group by 1, 2
  having sum(inbound_messages) > 0
  order by 1, 2;
$$;

-- First-response and resolution times for conversations opened in the period.
create or replace function public.report_response_summary(
  p_org uuid, p_from date, p_to date, p_channels uuid[] default null, p_teams uuid[] default null
)
returns table (
  conversations integer, answered integer, unanswered integer,
  fr_avg_seconds numeric, fr_median_seconds numeric, fr_p90_seconds numeric,
  within_5m integer, within_15m integer, within_1h integer, within_4h integer, over_4h integer,
  resolved integer, res_avg_seconds numeric, res_median_seconds numeric
)
language sql stable
set search_path = public, pg_temp
as $$
  with f as (
    select * from public.mv_conversation_facts
    where org_id = p_org and opened_day between p_from and p_to
      and (p_channels is null or cardinality(p_channels) = 0 or channel_id = any (p_channels))
      and (p_teams is null or cardinality(p_teams) = 0 or assignee_team_id = any (p_teams))
  )
  select count(*)::integer,
         count(first_response_seconds)::integer,
         count(*) filter (where first_inbound_at is not null and first_response_at is null)::integer,
         round(avg(first_response_seconds)),
         round((percentile_cont(0.5) within group (order by first_response_seconds))::numeric),
         round((percentile_cont(0.9) within group (order by first_response_seconds))::numeric),
         count(*) filter (where first_response_seconds < 300)::integer,
         count(*) filter (where first_response_seconds >= 300 and first_response_seconds < 900)::integer,
         count(*) filter (where first_response_seconds >= 900 and first_response_seconds < 3600)::integer,
         count(*) filter (where first_response_seconds >= 3600 and first_response_seconds < 14400)::integer,
         count(*) filter (where first_response_seconds >= 14400)::integer,
         count(resolution_seconds)::integer,
         round(avg(resolution_seconds)),
         round((percentile_cont(0.5) within group (order by resolution_seconds))::numeric)
  from f;
$$;

-- Per staff member over the period. Sums and counts are re-aggregated from daily rows, so averages are exact.
create or replace function public.report_agents(
  p_org uuid, p_from date, p_to date, p_users uuid[] default null, p_teams uuid[] default null
)
returns table (
  user_id uuid, name text, messages_sent integer, first_responses integer,
  avg_first_response_seconds numeric, conversations_closed integer, avg_resolution_seconds numeric
)
language sql stable
set search_path = public, pg_temp
as $$
  select a.user_id,
         nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''),
         sum(a.messages_sent)::integer,
         sum(a.first_response_count)::integer,
         case when sum(a.first_response_count) > 0
              then round(sum(a.first_response_seconds_sum)::numeric / sum(a.first_response_count)) end,
         sum(a.conversations_closed)::integer,
         case when sum(a.conversations_closed) > 0
              then round(sum(a.resolution_seconds_sum)::numeric / sum(a.conversations_closed)) end
  from public.mv_agent_performance a
  left join public.profiles p on p.id = a.user_id
  where a.org_id = p_org
    and a.day between p_from and p_to
    and (p_users is null or cardinality(p_users) = 0 or a.user_id = any (p_users))
    and (p_teams is null or cardinality(p_teams) = 0 or a.user_id in (
      select tm.user_id from public.team_members tm where tm.org_id = p_org and tm.team_id = any (p_teams)
    ))
  group by a.user_id, p.first_name, p.last_name
  order by sum(a.messages_sent) desc, 2
  limit 200;
$$;

-- Outbound messages per day: template vs free-form, and how many failed.
create or replace function public.report_usage_by_day(
  p_org uuid, p_from date, p_to date, p_channels uuid[] default null
)
returns table (day date, template integer, free_form integer, failed integer)
language sql stable
set search_path = public, pg_temp
as $$
  with days as (select d::date as day from generate_series(p_from, p_to, interval '1 day') d),
  u as (
    select day,
           sum(messages) filter (where category = 'template')::integer as template,
           sum(messages) filter (where category = 'free_form')::integer as free_form,
           sum(messages) filter (where status = 'failed')::integer as failed
    from public.mv_message_usage_daily
    where org_id = p_org and day between p_from and p_to
      and (p_channels is null or cardinality(p_channels) = 0 or channel_id = any (p_channels))
    group by day
  )
  select days.day, coalesce(u.template, 0), coalesce(u.free_form, 0), coalesce(u.failed, 0)
  from days left join u on u.day = days.day
  order by days.day;
$$;

-- Outbound messages by delivery status and category for the period (<= 14 rows).
create or replace function public.report_usage_totals(
  p_org uuid, p_from date, p_to date, p_channels uuid[] default null
)
returns table (category text, status text, messages integer)
language sql stable
set search_path = public, pg_temp
as $$
  select category, status, sum(messages)::integer
  from public.mv_message_usage_daily
  where org_id = p_org and day between p_from and p_to
    and (p_channels is null or cardinality(p_channels) = 0 or channel_id = any (p_channels))
  group by category, status
  order by category, status;
$$;

do $$
declare
  f text;
begin
  for f in
    select p.oid::regprocedure::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'report\_%' and p.proname <> 'report_sources_available'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
