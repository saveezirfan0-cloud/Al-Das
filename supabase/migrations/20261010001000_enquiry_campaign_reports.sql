-- Phase 10 follow-up: enquiry and campaign reports, now that Phases 5 and 7 exist.
--
-- Same shape as the appointment reports (20261009001400): one security_invoker view revoked from API
-- roles as the contract, and report_* functions that aggregate in SQL, service role only.
--
-- Definitions (docs/audit/reports.md §5.1b):
--   created        enquiries whose created_at falls on the day (org timezone)
--   closed         won / lost / disqualified, by the day closed_at falls on (not the creation day)
--   conversion     won / (won + lost + disqualified), among enquiries closed in the period
--   stage history  there is no stage-history table: the timeline events written by lib/enquiries/service.ts
--                  are the history (enquiry.created -> stage_id, enquiry.stage_changed / pipeline_changed
--                  -> to_stage_id). Enquiries created before Phase 5 or imported without timeline events
--                  have no history and drop out of the funnel entries and time-in-stage.
--   time in stage  entry -> next entry; the last stay of a closed enquiry ends at closed_at; the stay an
--                  open enquiry is in right now is not counted. Bucketed by the day the stay ended.
--   team / user    the enquiry's CURRENT assignee (assignment history is not kept)
--   campaign       by the day it started (scheduled / created if it never started); drafts excluded;
--                  counts are read live from campaign_recipients

create view public.v_enquiry_facts
with (security_invoker = true) as
select e.id,
       e.org_id,
       (e.created_at at time zone o.timezone)::date as created_day,
       case when e.closed_at is not null then (e.closed_at at time zone o.timezone)::date end as closed_day,
       e.pipeline_id,
       p.name as pipeline_name,
       p.sort as pipeline_sort,
       e.stage_id,
       s.name as stage_name,
       s.sort as stage_sort,
       e.status,
       e.assignee_id,
       e.est_value,
       e.created_at,
       e.closed_at
from public.enquiries e
join public.orgs o on o.id = e.org_id
join public.pipelines p on p.id = e.pipeline_id
join public.stages s on s.id = e.stage_id
where e.deleted_at is null;

revoke all on public.v_enquiry_facts from public, anon, authenticated;
grant select on public.v_enquiry_facts to service_role;

-- Every time an enquiry entered a stage, from the timeline.
create view public.v_enquiry_stage_entries
with (security_invoker = true) as
select t.org_id,
       t.enquiry_id,
       nullif(case t.type
                when 'enquiry.created' then t.payload ->> 'stage_id'
                else t.payload ->> 'to_stage_id'
              end, '')::uuid as stage_id,
       t.at
from public.timeline_events t
where t.enquiry_id is not null
  and t.type in ('enquiry.created', 'enquiry.stage_changed', 'enquiry.pipeline_changed');

revoke all on public.v_enquiry_stage_entries from public, anon, authenticated;
grant select on public.v_enquiry_stage_entries to service_role;

create view public.v_campaign_facts
with (security_invoker = true) as
select c.id,
       c.org_id,
       c.name,
       c.status,
       c.channel_id,
       ch.name as channel_name,
       c.started_at,
       c.created_at,
       (coalesce(c.started_at, c.scheduled_at, c.created_at) at time zone o.timezone)::date as day,
       coalesce(c.started_at, c.scheduled_at, c.created_at) as placed_at
from public.campaigns c
join public.channels ch on ch.id = c.channel_id
join public.orgs o on o.id = c.org_id;

revoke all on public.v_campaign_facts from public, anon, authenticated;
grant select on public.v_campaign_facts to service_role;

create or replace function public.report_enquiries_summary(
  p_org uuid, p_from date, p_to date, p_users uuid[] default null, p_teams uuid[] default null
)
returns table (created integer, open_now integer, won integer, lost integer, disqualified integer, won_value numeric)
language sql stable
set search_path = public, pg_temp
as $$
  select count(*) filter (where created_day between p_from and p_to)::integer,
         count(*) filter (where status = 'open')::integer,
         count(*) filter (where status = 'won' and closed_day between p_from and p_to)::integer,
         count(*) filter (where status = 'lost' and closed_day between p_from and p_to)::integer,
         count(*) filter (where status = 'disqualified' and closed_day between p_from and p_to)::integer,
         coalesce(sum(est_value) filter (where status = 'won' and closed_day between p_from and p_to), 0)
  from public.v_enquiry_facts
  where org_id = p_org
    and (p_users is null or cardinality(p_users) = 0 or assignee_id = any (p_users))
    and (p_teams is null or cardinality(p_teams) = 0 or assignee_id in (
      select tm.user_id from public.team_members tm where tm.org_id = p_org and tm.team_id = any (p_teams)));
$$;

create or replace function public.report_enquiries_by_day(
  p_org uuid, p_from date, p_to date, p_users uuid[] default null, p_teams uuid[] default null
)
returns table (day date, created integer, won integer, lost integer, disqualified integer)
language sql stable
set search_path = public, pg_temp
as $$
  with days as (select d::date as day from generate_series(p_from, p_to, interval '1 day') d),
  f as (
    select * from public.v_enquiry_facts
    where org_id = p_org
      and (p_users is null or cardinality(p_users) = 0 or assignee_id = any (p_users))
      and (p_teams is null or cardinality(p_teams) = 0 or assignee_id in (
        select tm.user_id from public.team_members tm where tm.org_id = p_org and tm.team_id = any (p_teams)))
  ),
  made as (select created_day as day, count(*)::integer as n from f where created_day between p_from and p_to group by 1),
  closed as (
    select closed_day as day,
           count(*) filter (where status = 'won')::integer as won,
           count(*) filter (where status = 'lost')::integer as lost,
           count(*) filter (where status = 'disqualified')::integer as disqualified
    from f where closed_day between p_from and p_to group by 1
  )
  select days.day, coalesce(made.n, 0), coalesce(closed.won, 0), coalesce(closed.lost, 0), coalesce(closed.disqualified, 0)
  from days
  left join made on made.day = days.day
  left join closed on closed.day = days.day
  order by days.day;
$$;

-- One row per stage: how many enquiries entered it in the period, how many sit in it now, how many ended here.
create or replace function public.report_enquiry_funnel(
  p_org uuid, p_from date, p_to date, p_users uuid[] default null, p_teams uuid[] default null
)
returns table (
  pipeline_id uuid, pipeline_name text, stage_id uuid, stage_name text,
  entered integer, open_now integer, won_here integer, lost_here integer, disqualified_here integer
)
language sql stable
set search_path = public, pg_temp
as $$
  with f as (
    select * from public.v_enquiry_facts
    where org_id = p_org
      and (p_users is null or cardinality(p_users) = 0 or assignee_id = any (p_users))
      and (p_teams is null or cardinality(p_teams) = 0 or assignee_id in (
        select tm.user_id from public.team_members tm where tm.org_id = p_org and tm.team_id = any (p_teams)))
  ),
  entries as (
    select en.stage_id, count(distinct en.enquiry_id)::integer as n
    from public.v_enquiry_stage_entries en
    join f on f.id = en.enquiry_id
    join public.orgs o on o.id = en.org_id
    where en.org_id = p_org and en.stage_id is not null
      and (en.at at time zone o.timezone)::date between p_from and p_to
    group by en.stage_id
  ),
  here as (
    select stage_id,
           count(*) filter (where status = 'open')::integer as open_now,
           count(*) filter (where status = 'won' and closed_day between p_from and p_to)::integer as won_here,
           count(*) filter (where status = 'lost' and closed_day between p_from and p_to)::integer as lost_here,
           count(*) filter (where status = 'disqualified' and closed_day between p_from and p_to)::integer as disq_here
    from f group by stage_id
  )
  select p.id, p.name, s.id, s.name,
         coalesce(entries.n, 0), coalesce(here.open_now, 0), coalesce(here.won_here, 0),
         coalesce(here.lost_here, 0), coalesce(here.disq_here, 0)
  from public.stages s
  join public.pipelines p on p.id = s.pipeline_id
  left join entries on entries.stage_id = s.id
  left join here on here.stage_id = s.id
  where s.org_id = p_org and p.archived_at is null
  order by p.sort, p.name, s.sort, s.name
  limit 300;
$$;

create or replace function public.report_enquiry_stage_times(
  p_org uuid, p_from date, p_to date, p_users uuid[] default null, p_teams uuid[] default null
)
returns table (
  pipeline_id uuid, pipeline_name text, stage_id uuid, stage_name text,
  stays integer, avg_seconds numeric, median_seconds numeric
)
language sql stable
set search_path = public, pg_temp
as $$
  with f as (
    select * from public.v_enquiry_facts
    where org_id = p_org
      and (p_users is null or cardinality(p_users) = 0 or assignee_id = any (p_users))
      and (p_teams is null or cardinality(p_teams) = 0 or assignee_id in (
        select tm.user_id from public.team_members tm where tm.org_id = p_org and tm.team_id = any (p_teams)))
  ),
  ordered as (
    select en.enquiry_id, en.stage_id, en.at as entered_at,
           lead(en.at) over (partition by en.enquiry_id order by en.at, en.stage_id) as next_at
    from public.v_enquiry_stage_entries en
    where en.org_id = p_org and en.stage_id is not null
  ),
  stays as (
    select f.pipeline_id, ordered.stage_id, ordered.entered_at,
           coalesce(ordered.next_at, f.closed_at) as left_at,
           o.timezone
    from ordered
    join f on f.id = ordered.enquiry_id
    join public.orgs o on o.id = p_org
  )
  select p.id, p.name, s.id, s.name,
         count(*)::integer,
         avg(extract(epoch from (st.left_at - st.entered_at))),
         percentile_cont(0.5) within group (order by extract(epoch from (st.left_at - st.entered_at)))
  from stays st
  join public.stages s on s.id = st.stage_id
  join public.pipelines p on p.id = s.pipeline_id
  where st.left_at is not null
    and st.left_at >= st.entered_at
    and (st.left_at at time zone st.timezone)::date between p_from and p_to
  group by p.id, p.name, p.sort, s.id, s.name, s.sort
  order by p.sort, p.name, s.sort, s.name
  limit 300;
$$;

create or replace function public.report_campaigns(
  p_org uuid, p_from date, p_to date, p_channels uuid[] default null
)
returns table (
  campaign_id uuid, name text, status text, channel_name text, started_at timestamptz,
  total integer, eligible integer, sent integer, delivered integer, read_count integer,
  replied integer, failed integer, skipped integer
)
language sql stable
set search_path = public, pg_temp
as $$
  select c.id, c.name, c.status, c.channel_name, c.started_at,
         r.total, r.eligible, r.sent, r.delivered, r.read_count, r.replied, r.failed, r.skipped
  from public.v_campaign_facts c
  cross join lateral (
    select count(*)::integer as total,
           count(*) filter (where cr.status <> 'skipped')::integer as eligible,
           count(*) filter (where cr.status in ('sent', 'delivered', 'read'))::integer as sent,
           count(*) filter (where cr.status in ('delivered', 'read'))::integer as delivered,
           count(*) filter (where cr.status = 'read')::integer as read_count,
           count(*) filter (where cr.replied_at is not null)::integer as replied,
           count(*) filter (where cr.status = 'failed')::integer as failed,
           count(*) filter (where cr.status = 'skipped')::integer as skipped
    from public.campaign_recipients cr
    where cr.campaign_id = c.id
  ) r
  where c.org_id = p_org
    and c.status <> 'preparing'
    and c.day between p_from and p_to
    and (p_channels is null or cardinality(p_channels) = 0 or c.channel_id = any (p_channels))
  order by c.placed_at desc, c.id
  limit 100;
$$;

do $$
declare sig text;
begin
  foreach sig in array array[
    'report_enquiries_summary(uuid, date, date, uuid[], uuid[])',
    'report_enquiries_by_day(uuid, date, date, uuid[], uuid[])',
    'report_enquiry_funnel(uuid, date, date, uuid[], uuid[])',
    'report_enquiry_stage_times(uuid, date, date, uuid[], uuid[])',
    'report_campaigns(uuid, date, date, uuid[])'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', sig);
    execute format('grant execute on function public.%s to service_role', sig);
  end loop;
end $$;
