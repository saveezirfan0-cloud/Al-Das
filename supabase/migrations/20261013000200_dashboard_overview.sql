-- Phase 13 (speed): the Overview dashboard used to run ten separate count queries, one round trip each.
-- This is the same arithmetic in one statement and one round trip.
--
-- SECURITY INVOKER on purpose: the caller's own row-level security decides which conversations, tasks
-- and enquiries they can count, exactly as the ten separate queries did through the user's client.
-- Sections the caller may not use are skipped by the app via the two flags (and RLS would hide them anyway).

create or replace function public.dashboard_overview(
  p_org uuid,
  p_user uuid,
  p_today_start timestamptz,
  p_include_tasks boolean default true,
  p_include_enquiries boolean default true
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'conversations', (
      select jsonb_build_object(
        'mine',       count(*) filter (where c.assignee_user_id = p_user),
        'unassigned', count(*) filter (where c.assignee_user_id is null),
        'waiting',    count(*) filter (where c.status = 'waiting'),
        'unread_mine', count(*) filter (where c.assignee_user_id = p_user and c.unread_count > 0)
      )
      from public.conversations c
      where c.org_id = p_org and c.status <> 'closed'
    ),
    'team', (
      select jsonb_build_object(
        'members', count(*),
        'online',  count(*) filter (where m.presence = 'online')
      )
      from public.memberships m
      where m.org_id = p_org and m.status = 'active'
    ),
    'tasks', case when p_include_tasks then (
      select jsonb_build_object(
        'open',    count(*),
        'overdue', count(*) filter (where t.due_at < now())
      )
      from public.tasks t
      where t.org_id = p_org and not t.done and t.assignee_id = p_user
    ) else null end,
    'enquiries', case when p_include_enquiries then (
      select jsonb_build_object(
        'open',      count(*) filter (where e.status = 'open'),
        'new_today', count(*) filter (where e.created_at >= p_today_start)
      )
      from public.enquiries e
      where e.org_id = p_org and e.deleted_at is null
    ) else null end
  );
$$;

revoke all on function public.dashboard_overview(uuid, uuid, timestamptz, boolean, boolean) from public, anon;
grant execute on function public.dashboard_overview(uuid, uuid, timestamptz, boolean, boolean) to authenticated, service_role;
