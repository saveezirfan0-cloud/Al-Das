-- Phase 20c / G13 reports (docs/24_PHASE_20C_ROUTING_NOTES.md). Source views (lib/reports/registry.ts `requires`) plus
-- report functions. Service role only, called by lib/reports after can('reports.view'). Each returns a bounded,
-- aggregated result (counts, seconds, staff ids): never patient data or message text.
--
-- Definitions:
--   first-assign-to-close   closed_at minus the first time the conversation got an owner (assignment log, at or before close)
--   last-assign-to-close    closed_at minus the last time it got a (new) owner before it was closed
--   owner removed           an assignment event that took the conversation away from a person (unassigned or reassigned)
--   AI assisted             a staff member used an AI draft in the conversation (ai_suggestion_outcomes)
--   bot engaged             a flow sent at least one message in it (messages.flow_run_id)
--   closed without a human  closed with no outbound message sent by a staff member (messages.sent_by_user_id);
--                           "handled by automation" = of those, at least one automated outbound message was sent
--   days                    org-local (orgs.timezone), like the other reports
-- The assignment and presence logs start when 20261025000100 is applied; older conversations have no assignment events.

-- ---------------------------------------------------------------------------
-- Source views (security_invoker; revoked from API roles like the other report views)
-- ---------------------------------------------------------------------------

create view public.v_assignment_events
with (security_invoker = true) as
select e.id,
       e.org_id,
       e.conversation_id,
       e.kind,
       e.from_user_id,
       e.to_user_id,
       e.from_team_id,
       e.to_team_id,
       e.source,
       e.at,
       (e.at at time zone o.timezone)::date as day
from public.conversation_assignment_events e
join public.orgs o on o.id = e.org_id;

create view public.v_presence_events
with (security_invoker = true) as
select e.id, e.org_id, e.user_id, e.presence, e.previous, e.source, e.at
from public.member_presence_events e;

-- One row per conversation with the engagement flags the AI report counts. Only cheap EXISTS probes on indexed
-- conversation_id columns; callers always filter by org and closed_day first.
create view public.v_conversation_engagement
with (security_invoker = true) as
select c.id as conversation_id,
       c.org_id,
       c.channel_id,
       c.assignee_team_id,
       c.assignee_user_id,
       c.status,
       c.closed_at,
       case when c.closed_at is not null then (c.closed_at at time zone o.timezone)::date end as closed_day,
       exists (select 1 from public.ai_suggestion_outcomes s where s.conversation_id = c.id) as ai_assisted,
       exists (select 1 from public.messages m
               where m.conversation_id = c.id and m.direction = 'out' and m.flow_run_id is not null) as bot_engaged,
       exists (select 1 from public.messages m
               where m.conversation_id = c.id and m.direction = 'out' and m.sent_by_user_id is not null) as human_replied,
       exists (select 1 from public.messages m
               where m.conversation_id = c.id and m.direction = 'out' and m.sent_by_user_id is null
                 and m.kind <> 'reaction') as automated_reply
from public.conversations c
join public.orgs o on o.id = c.org_id;

revoke all on public.v_assignment_events, public.v_presence_events, public.v_conversation_engagement
  from public, anon, authenticated;
grant select on public.v_assignment_events, public.v_presence_events, public.v_conversation_engagement to service_role;

-- ---------------------------------------------------------------------------
-- Report functions
-- ---------------------------------------------------------------------------

create or replace function public.report_assignment_close(
  p_org uuid, p_from date, p_to date, p_teams uuid[] default null, p_users uuid[] default null
)
returns table (
  user_id uuid, is_total boolean, closed integer, with_assignment integer,
  first_avg_seconds numeric, first_median_seconds numeric,
  last_avg_seconds numeric, last_median_seconds numeric
)
language sql stable
set search_path = public, pg_temp
as $$
  with c as (
    select v.conversation_id as id, v.closed_at, v.assignee_user_id
    from public.v_conversation_engagement v
    where v.org_id = p_org and v.status = 'closed' and v.closed_day between p_from and p_to
      and (p_teams is null or cardinality(p_teams) = 0 or v.assignee_team_id = any (p_teams))
      and (p_users is null or cardinality(p_users) = 0 or v.assignee_user_id = any (p_users))
  ),
  a as (
    select c.id,
           extract(epoch from c.closed_at - min(e.at))::numeric as first_s,
           extract(epoch from c.closed_at - max(e.at))::numeric as last_s
    from c
    join public.v_assignment_events e on e.conversation_id = c.id
    where e.org_id = p_org and e.to_user_id is not null and e.kind in ('assigned', 'reassigned') and e.at <= c.closed_at
    group by c.id, c.closed_at
  )
  select c.assignee_user_id,
         grouping(c.assignee_user_id) = 1,
         count(*)::integer,
         count(a.id)::integer,
         round(avg(a.first_s), 0),
         round(percentile_cont(0.5) within group (order by a.first_s)::numeric, 0),
         round(avg(a.last_s), 0),
         round(percentile_cont(0.5) within group (order by a.last_s)::numeric, 0)
  from c left join a on a.id = c.id
  group by grouping sets ((c.assignee_user_id), ())
  order by 2 desc, 3 desc
  limit 300;
$$;

create or replace function public.report_owner_removed(
  p_org uuid, p_from date, p_to date, p_teams uuid[] default null, p_users uuid[] default null
)
returns table (
  user_id uuid, is_total boolean, removed integer, unassigned integer, reassigned integer,
  by_staff integer, by_routing_or_system integer
)
language sql stable
set search_path = public, pg_temp
as $$
  select e.from_user_id,
         grouping(e.from_user_id) = 1,
         count(*)::integer,
         count(*) filter (where e.kind = 'unassigned')::integer,
         count(*) filter (where e.kind = 'reassigned')::integer,
         count(*) filter (where e.source = 'user')::integer,
         count(*) filter (where e.source <> 'user')::integer
  from public.v_assignment_events e
  where e.org_id = p_org
    and e.from_user_id is not null
    and e.kind in ('unassigned', 'reassigned')
    and e.day between p_from and p_to
    and (p_teams is null or cardinality(p_teams) = 0 or e.from_team_id = any (p_teams))
    and (p_users is null or cardinality(p_users) = 0 or e.from_user_id = any (p_users))
  group by grouping sets ((e.from_user_id), ())
  order by 2 desc, 3 desc
  limit 300;
$$;

create or replace function public.report_ai_engagement(
  p_org uuid, p_from date, p_to date, p_channels uuid[] default null, p_teams uuid[] default null
)
returns table (
  closed integer, ai_assisted integer, bot_engaged integer, engaged integer,
  closed_without_human integer, handled_by_automation integer, closed_without_reply integer
)
language sql stable
set search_path = public, pg_temp
as $$
  select count(*)::integer,
         count(*) filter (where v.ai_assisted)::integer,
         count(*) filter (where v.bot_engaged)::integer,
         count(*) filter (where v.ai_assisted or v.bot_engaged)::integer,
         count(*) filter (where not v.human_replied)::integer,
         count(*) filter (where not v.human_replied and v.automated_reply)::integer,
         count(*) filter (where not v.human_replied and not v.automated_reply)::integer
  from public.v_conversation_engagement v
  where v.org_id = p_org and v.status = 'closed' and v.closed_day between p_from and p_to
    and (p_channels is null or cardinality(p_channels) = 0 or v.channel_id = any (p_channels))
    and (p_teams is null or cardinality(p_teams) = 0 or v.assignee_team_id = any (p_teams));
$$;

-- Enquiries created in the period, grouped by the org-local month they were created, with where they are now.
create or replace function public.report_enquiry_cohorts(
  p_org uuid, p_from date, p_to date, p_users uuid[] default null
)
returns table (
  month date, created integer, open integer, won integer, lost integer, disqualified integer,
  won_value numeric, median_days_to_close numeric
)
language sql stable
set search_path = public, pg_temp
as $$
  select date_trunc('month', f.created_day)::date,
         count(*)::integer,
         count(*) filter (where f.status = 'open')::integer,
         count(*) filter (where f.status = 'won')::integer,
         count(*) filter (where f.status = 'lost')::integer,
         count(*) filter (where f.status = 'disqualified')::integer,
         coalesce(sum(f.est_value) filter (where f.status = 'won'), 0),
         round((percentile_cont(0.5) within group (order by extract(epoch from f.closed_at - f.created_at) / 86400.0)
                filter (where f.closed_at is not null))::numeric, 1)
  from public.v_enquiry_facts f
  where f.org_id = p_org
    and f.created_day between p_from and p_to
    and (p_users is null or cardinality(p_users) = 0 or f.assignee_id = any (p_users))
  group by 1
  order by 1
  limit 400;
$$;

-- Presence changes for the member status log, as ONE jsonb value (PostgREST caps set results at max-rows; a year of
-- changes for a team can exceed that). seed = each member's state when the window opens (the last change before it,
-- else the state before the first change inside it, else their current state); events = changes inside the window,
-- capped at 50 000 (truncated = true when cut). Durations per day are worked out by lib/reports/presence.ts (pure).
create or replace function public.report_presence_events(
  p_org uuid, p_from timestamptz, p_to timestamptz, p_users uuid[] default null
)
returns jsonb
language sql stable
set search_path = public, pg_temp
as $$
  with people as (
    select m.user_id, m.presence from public.memberships m
    where m.org_id = p_org
      and (p_users is null or cardinality(p_users) = 0 or m.user_id = any (p_users))
    union
    select distinct e.user_id, null::text from public.v_presence_events e
    where e.org_id = p_org and e.at < p_to
      and not exists (select 1 from public.memberships m where m.org_id = p_org and m.user_id = e.user_id)
      and (p_users is null or cardinality(p_users) = 0 or e.user_id = any (p_users))
  ),
  seed as (
    select p.user_id,
           coalesce(
             (select e.presence from public.v_presence_events e
              where e.org_id = p_org and e.user_id = p.user_id and e.at < p_from order by e.at desc, e.id desc limit 1),
             (select e.previous from public.v_presence_events e
              where e.org_id = p_org and e.user_id = p.user_id and e.at >= p_from order by e.at, e.id limit 1),
             p.presence,
             'offline'
           ) as presence
    from people p
  ),
  ev as (
    select e.user_id, e.presence, e.at, e.id
    from public.v_presence_events e
    where e.org_id = p_org and e.at >= p_from and e.at < p_to
      and e.user_id in (select user_id from people)
    order by e.at, e.id
    limit 50001
  )
  select jsonb_build_object(
    'seed', coalesce((select jsonb_agg(jsonb_build_object('user_id', s.user_id, 'presence', s.presence)) from seed s), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('user_id', x.user_id, 'presence', x.presence, 'at', x.at) order by x.at, x.id)
                        from (select * from ev order by at, id limit 50000) x), '[]'::jsonb),
    'truncated', (select count(*) from ev) > 50000
  );
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.report_assignment_close(uuid, date, date, uuid[], uuid[])',
    'public.report_owner_removed(uuid, date, date, uuid[], uuid[])',
    'public.report_ai_engagement(uuid, date, date, uuid[], uuid[])',
    'public.report_enquiry_cohorts(uuid, date, date, uuid[])',
    'public.report_presence_events(uuid, timestamptz, timestamptz, uuid[])'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;
