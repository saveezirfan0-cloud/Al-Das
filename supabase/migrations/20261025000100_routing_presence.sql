-- Phase 20c (routing half, docs/24_PHASE_20C_ROUTING_NOTES.md): team auto-reply and fallback team, a per-member open
-- conversation limit honoured by round-robin, presence auto-away from browser heartbeats, a per-member restricted
-- enquiry view enforced in RLS, and two logs the G13 reports read (assignment events, presence changes).
--
--   teams.auto_reply_text         sent once per conversation when a new chat lands in the team outside its office hours or
--                                 while nobody in it is online (lib/inbox/routing.ts decides, queueOutbound sends)
--   teams.office_hours            the Office Hours node's schedule shape (lib/flow-engine/office-hours.ts); null = always open
--   teams.fallback_team_id        used when nobody in the team is online or everyone is at their limit (one hop, never chained)
--   memberships.max_open_conversations   null = no limit; checked inside the SQL picker under a per-member advisory lock
--   memberships.enquiry_scope     'all' (default, no change) | 'team' | 'own'; app.enquiry_visible_to() is the one rule
--   memberships.last_seen_at      last browser heartbeat (public.presence_heartbeat)
--   memberships.presence_auto     true while the sweep (not the person) has set them away; their next heartbeat brings them back
--   conversations.auto_reply_sent_at     claimed atomically before the auto-reply is queued (at most once)
--   orgs.settings.inbox.auto_away_minutes  null = off. Online members with no heartbeat for that long count as away
--                                 at once in routing, and the every-minute sweep marks them away.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

alter table public.teams
  add column auto_reply_text text check (auto_reply_text is null or char_length(btrim(auto_reply_text)) between 1 and 1024),
  add column office_hours jsonb check (office_hours is null or jsonb_typeof(office_hours) = 'object'),
  add column fallback_team_id uuid references public.teams (id) on delete set null,
  add constraint teams_fallback_not_self check (fallback_team_id is null or fallback_team_id <> id);

create trigger teams_fallback_org_check before insert or update of fallback_team_id on public.teams
  for each row execute function app.check_parent_org('teams', 'fallback_team_id');

alter table public.memberships
  add column max_open_conversations integer check (max_open_conversations is null or max_open_conversations between 1 and 500),
  add column enquiry_scope text not null default 'all' check (enquiry_scope in ('all', 'team', 'own')),
  add column last_seen_at timestamptz,
  add column presence_auto boolean not null default false;

alter table public.conversations add column auto_reply_sent_at timestamptz;

-- ---------------------------------------------------------------------------
-- Logs
-- ---------------------------------------------------------------------------

-- One row per change of a conversation's owner or team. User and team ids are plain uuids on purpose: a foreign key would
-- make deleting a profile or team fail (the FK's own SET NULL on conversations fires this log for the row being deleted).
create table public.conversation_assignment_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  kind text not null check (kind in ('assigned', 'reassigned', 'unassigned', 'team_changed')),
  from_user_id uuid,
  to_user_id uuid,
  from_team_id uuid,
  to_team_id uuid,
  actor_id uuid,                                      -- the signed-in person, when there was one
  source text not null check (source in ('user', 'routing', 'system')),
  at timestamptz not null default now()
);
create index conversation_assignment_events_org_at_idx on public.conversation_assignment_events (org_id, at desc);
create index conversation_assignment_events_conv_idx on public.conversation_assignment_events (conversation_id, at);

-- One row per presence change of a member.
create table public.member_presence_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null,                              -- plain uuid: removing a member keeps their history for the report
  presence text not null check (presence in ('online', 'away', 'offline')),
  previous text check (previous is null or previous in ('online', 'away', 'offline')),
  source text not null check (source in ('manual', 'auto_away', 'auto_back', 'admin')),
  at timestamptz not null default now()
);
create index member_presence_events_org_at_idx on public.member_presence_events (org_id, at);
create index member_presence_events_user_idx on public.member_presence_events (org_id, user_id, at);

alter table public.conversation_assignment_events enable row level security;
alter table public.member_presence_events enable row level security;

-- Read-only for people who see reports (the trigger functions below write them). A member also sees their own status log.
create policy conversation_assignment_events_select on public.conversation_assignment_events for select to authenticated
  using (app.has_perm(org_id, 'reports.view'));
create policy member_presence_events_select on public.member_presence_events for select to authenticated
  using (app.has_perm(org_id, 'reports.view') or (app.is_org_member(org_id) and user_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- Who did it: the signed-in user, or the x-pulse-actor header on a service-role request (the same rule as record_history).
-- ---------------------------------------------------------------------------

create or replace function app.request_actor()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_role text;
begin
  v_actor := auth.uid();
  if v_actor is null then
    v_role := coalesce(
      nullif(current_setting('request.jwt.claim.role', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
    );
    if v_role = 'service_role' then
      begin
        v_actor := nullif(nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-pulse-actor', '')::uuid;
      exception when others then
        v_actor := null;                                  -- a malformed header must never break the write
      end;
    end if;
  end if;
  return v_actor;
end;
$$;
revoke all on function app.request_actor() from public, anon, authenticated;

create or replace function app.log_conversation_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_actor uuid;
  v_source text;
  v_old_user uuid;
  v_old_team uuid;
begin
  if TG_OP = 'INSERT' then
    if new.assignee_user_id is null and new.assignee_team_id is null then
      return null;
    end if;
  elsif new.assignee_user_id is not distinct from old.assignee_user_id
    and new.assignee_team_id is not distinct from old.assignee_team_id then
    return null;
  end if;
  if TG_OP = 'UPDATE' then
    v_old_user := old.assignee_user_id;
    v_old_team := old.assignee_team_id;
  end if;
  if new.assignee_user_id is not distinct from v_old_user then
    v_kind := 'team_changed';
  elsif v_old_user is null then
    v_kind := 'assigned';
  elsif new.assignee_user_id is null then
    v_kind := 'unassigned';
  else
    v_kind := 'reassigned';
  end if;
  v_actor := app.request_actor();
  v_source := nullif(current_setting('pulse.assign_source', true), '');
  if v_source is null or v_source not in ('user', 'routing', 'system') then
    v_source := case when v_actor is null then 'system' else 'user' end;
  end if;
  insert into public.conversation_assignment_events
    (org_id, conversation_id, kind, from_user_id, to_user_id, from_team_id, to_team_id, actor_id, source)
  values
    (new.org_id, new.id, v_kind, v_old_user, new.assignee_user_id, v_old_team, new.assignee_team_id, v_actor, v_source);
  return null;
end;
$$;
revoke all on function app.log_conversation_assignment() from public, anon, authenticated;

create trigger conversations_assignment_log
  after insert or update of assignee_user_id, assignee_team_id on public.conversations
  for each row execute function app.log_conversation_assignment();

create or replace function app.log_member_presence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source text;
begin
  if new.presence is not distinct from old.presence then
    return null;
  end if;
  v_source := nullif(current_setting('pulse.presence_source', true), '');
  if v_source is null or v_source not in ('manual', 'auto_away', 'auto_back', 'admin') then
    v_source := case when auth.uid() = new.user_id then 'manual' else 'admin' end;
  end if;
  insert into public.member_presence_events (org_id, user_id, presence, previous, source)
  values (new.org_id, new.user_id, new.presence, old.presence, v_source);
  return null;
end;
$$;
revoke all on function app.log_member_presence() from public, anon, authenticated;

create trigger memberships_presence_log
  after update of presence on public.memberships
  for each row execute function app.log_member_presence();

-- ---------------------------------------------------------------------------
-- Presence: idle rule, heartbeat, manual changes, auto-away sweep
-- ---------------------------------------------------------------------------

-- orgs.settings.inbox.auto_away_minutes as an integer, or null when off or not a number (the app validates 5..480).
create or replace function app.auto_away_minutes(p_settings jsonb)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(p_settings -> 'inbox' -> 'auto_away_minutes') = 'number'
      then greatest(1, least(1440, (p_settings -> 'inbox' ->> 'auto_away_minutes')::numeric::integer))
  end;
$$;

-- Online for routing: presence says online and, with auto-away on, the last heartbeat is recent enough. The pure mirror
-- of this rule is isPresenceOnline() in lib/presence/idle.ts.
create or replace function app.presence_is_online(p_presence text, p_seen_at timestamptz, p_idle_minutes integer)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_presence = 'online'
    and (p_idle_minutes is null or (p_seen_at is not null and p_seen_at >= now() - make_interval(mins => p_idle_minutes)));
$$;

-- Manual status change from the user menu (same signature as before). Going online counts as being seen, and any
-- automatic away is over.
create or replace function public.set_presence(p_org_id uuid, p_presence text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_presence not in ('online', 'away', 'offline') then
    raise exception 'invalid presence %', p_presence using errcode = 'check_violation';
  end if;
  perform set_config('pulse.presence_source', 'manual', true);
  update public.memberships
  set presence = p_presence,
      presence_at = now(),
      presence_auto = false,
      last_seen_at = case when p_presence = 'online' then now() else last_seen_at end
  where org_id = p_org_id and user_id = auth.uid() and status = 'active';
end;
$$;

-- Browser heartbeat (components/shell/shell-data.tsx sends one a minute while the person is active). Throttled to one
-- write per 30 seconds. Brings back someone the sweep set away; never overrides a status the person picked.
-- Returns the resulting presence so the user menu can repaint its dot.
create or replace function public.presence_heartbeat(p_org_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_presence text;
begin
  perform set_config('pulse.presence_source', 'auto_back', true);
  update public.memberships
  set last_seen_at = now(),
      presence = case when presence = 'away' and presence_auto then 'online' else presence end,
      presence_at = case when presence = 'away' and presence_auto then now() else presence_at end,
      presence_auto = false
  where org_id = p_org_id and user_id = auth.uid() and status = 'active'
    and (last_seen_at is null or last_seen_at < now() - interval '30 seconds' or presence_auto)
  returning presence into v_presence;
  if v_presence is null then
    select presence into v_presence from public.memberships
    where org_id = p_org_id and user_id = auth.uid() and status = 'active';
  end if;
  return v_presence;
end;
$$;
revoke all on function public.presence_heartbeat(uuid) from public, anon;
grant execute on function public.presence_heartbeat(uuid) to authenticated, service_role;

-- Every minute (pg_cron, plain SQL, no HTTP job): online members whose last heartbeat is older than their org's
-- auto_away_minutes become away (presence_auto = true). Returns how many changed.
create or replace function public.presence_auto_away_sweep()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  perform set_config('pulse.presence_source', 'auto_away', true);
  update public.memberships m
  set presence = 'away', presence_at = now(), presence_auto = true
  from public.orgs o
  where o.id = m.org_id
    and m.presence = 'online'
    and m.status = 'active'
    and app.auto_away_minutes(o.settings) is not null
    and not app.presence_is_online(m.presence, coalesce(m.last_seen_at, m.presence_at), app.auto_away_minutes(o.settings));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.presence_auto_away_sweep() from public, anon, authenticated;
grant execute on function public.presence_auto_away_sweep() to service_role;

select cron.schedule('pulse:presence_auto_away', '* * * * *', $$select public.presence_auto_away_sweep()$$);

-- ---------------------------------------------------------------------------
-- Routing
-- ---------------------------------------------------------------------------

create or replace function app.team_has_online_member(p_org_id uuid, p_team_id uuid, p_idle_minutes integer)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.team_members tm
    join public.memberships m on m.org_id = tm.org_id and m.user_id = tm.user_id
    where tm.team_id = p_team_id and tm.org_id = p_org_id and m.status = 'active'
      and app.presence_is_online(m.presence, coalesce(m.last_seen_at, m.presence_at), p_idle_minutes)
  );
$$;
revoke all on function app.team_has_online_member(uuid, uuid, integer) from public, anon, authenticated;

-- The one round-robin picker. Online (idle-aware) active members with weight > 0, least recently assigned first. With
-- p_check_capacity, a member at max_open_conversations is skipped; the count runs under a per-member advisory lock that
-- is held until the caller's transaction ends, so two routings in flight can never both take the last place. A lock
-- someone else holds means that member is being checked right now: skip them (no waiting, no deadlock).
create or replace function app.pick_team_assignee(p_org_id uuid, p_team_id uuid, p_check_capacity boolean)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_idle integer;
  v_open integer;
  r record;
begin
  select app.auto_away_minutes(o.settings) into v_idle from public.orgs o where o.id = p_org_id;
  for r in
    select tm.user_id, m.max_open_conversations as cap
    from public.team_members tm
    join public.memberships m on m.org_id = tm.org_id and m.user_id = tm.user_id
    where tm.team_id = p_team_id
      and tm.org_id = p_org_id
      and tm.rr_weight > 0
      and m.status = 'active'
      and app.presence_is_online(m.presence, coalesce(m.last_seen_at, m.presence_at), v_idle)
    order by tm.last_assigned_at asc nulls first, tm.rr_weight desc, tm.user_id
  loop
    if p_check_capacity and r.cap is not null then
      if not pg_try_advisory_xact_lock(hashtextextended('pulse:capacity:' || p_org_id::text || ':' || r.user_id::text, 0)) then
        continue;
      end if;
      select count(*) into v_open
      from public.conversations c
      where c.org_id = p_org_id and c.assignee_user_id = r.user_id and c.status <> 'closed' and not c.campaign_only;
      if v_open >= r.cap then
        continue;
      end if;
    end if;
    perform 1 from public.team_members tm
    where tm.team_id = p_team_id and tm.user_id = r.user_id
    for update skip locked;
    if not found then
      continue;
    end if;
    update public.team_members set last_assigned_at = now() where team_id = p_team_id and user_id = r.user_id;
    return r.user_id;
  end loop;
  return null;
end;
$$;
revoke all on function app.pick_team_assignee(uuid, uuid, boolean) from public, anon, authenticated;

-- Unchanged signature (enquiry assignment rules use it); now idle-aware. No capacity check: the limit is about
-- open conversations, not enquiries.
create or replace function public.pick_round_robin_assignee(p_org_id uuid, p_team_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  return app.pick_team_assignee(p_org_id, p_team_id, false);
end;
$$;

-- Capacity-aware pick for the inbox "Auto-assign" button (the assignment itself follows in a separate request).
create or replace function public.pick_round_robin_assignee_capped(p_org_id uuid, p_team_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  return app.pick_team_assignee(p_org_id, p_team_id, true);
end;
$$;
revoke all on function public.pick_round_robin_assignee_capped(uuid, uuid) from public, anon, authenticated;
grant execute on function public.pick_round_robin_assignee_capped(uuid, uuid) to service_role;

-- Routes an unowned conversation into p_team_id in ONE transaction: pick (capacity-aware) and write the owner together,
-- so the limit holds under concurrent inbound webhooks. Falls back to the team's fallback team (one hop) when nobody in
-- the team is online, or when round-robin found nobody (everyone away or at their limit). Without anyone online there
-- either, the conversation stays in the first team. A conversation that already has an owner is left alone.
-- Returns {team_id, user_id, fallback, team_online, auto_reply_text, office_hours} for the team it landed in.
create or replace function public.route_conversation(p_org_id uuid, p_conversation_id uuid, p_team_id uuid, p_round_robin boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conv record;
  v_team record;
  v_fb record;
  v_idle integer;
  v_user uuid;
  v_final uuid;
  v_fallback boolean := false;
  v_tried_rr boolean := false;
  v_out record;
begin
  select c.id, c.assignee_user_id, c.assignee_team_id into v_conv
  from public.conversations c
  where c.id = p_conversation_id and c.org_id = p_org_id
  for update;
  if not found then
    return null;
  end if;
  if v_conv.assignee_user_id is not null then
    return jsonb_build_object('team_id', v_conv.assignee_team_id, 'user_id', v_conv.assignee_user_id,
                              'fallback', false, 'team_online', true, 'auto_reply_text', null, 'office_hours', null);
  end if;
  select t.id, t.round_robin, t.fallback_team_id into v_team
  from public.teams t where t.id = p_team_id and t.org_id = p_org_id;
  if not found then
    return jsonb_build_object('team_id', v_conv.assignee_team_id, 'user_id', null,
                              'fallback', false, 'team_online', false, 'auto_reply_text', null, 'office_hours', null);
  end if;

  perform set_config('pulse.assign_source', 'routing', true);
  select app.auto_away_minutes(o.settings) into v_idle from public.orgs o where o.id = p_org_id;

  v_final := v_team.id;
  if p_round_robin and v_team.round_robin then
    v_tried_rr := true;
    v_user := app.pick_team_assignee(p_org_id, v_team.id, true);
  end if;
  if v_user is null and v_team.fallback_team_id is not null
     and (v_tried_rr or not app.team_has_online_member(p_org_id, v_team.id, v_idle)) then
    select t.id, t.round_robin into v_fb
    from public.teams t where t.id = v_team.fallback_team_id and t.org_id = p_org_id;
    if found then
      if p_round_robin and v_fb.round_robin then
        v_user := app.pick_team_assignee(p_org_id, v_fb.id, true);
      end if;
      if v_user is not null or app.team_has_online_member(p_org_id, v_fb.id, v_idle) then
        v_final := v_fb.id;
        v_fallback := true;
      end if;
    end if;
  end if;

  update public.conversations
  set assignee_team_id = v_final, assignee_user_id = v_user
  where id = p_conversation_id;

  select t.auto_reply_text, t.office_hours into v_out from public.teams t where t.id = v_final;
  return jsonb_build_object(
    'team_id', v_final,
    'user_id', v_user,
    'fallback', v_fallback,
    'team_online', v_user is not null or app.team_has_online_member(p_org_id, v_final, v_idle),
    'auto_reply_text', v_out.auto_reply_text,
    'office_hours', v_out.office_hours
  );
end;
$$;
revoke all on function public.route_conversation(uuid, uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.route_conversation(uuid, uuid, uuid, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- Restricted enquiry view
-- ---------------------------------------------------------------------------

-- The one rule (RLS below and the service-role list queries in lib/enquiries/query.ts both call it):
--   all   every enquiry (default)
--   own   assigned to me, or unassigned and created by me
--   team  assigned to me or to someone who shares a team with me, or unassigned (so the team can pick new ones up)
-- A person who is not an active member sees nothing.
create or replace function app.enquiry_visible_to(p_org_id uuid, p_user_id uuid, p_assignee_id uuid, p_created_by uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_scope text;
begin
  if p_user_id is null then
    return false;
  end if;
  select m.enquiry_scope into v_scope
  from public.memberships m
  where m.org_id = p_org_id and m.user_id = p_user_id and m.status = 'active';
  if v_scope is null then
    return false;
  end if;
  if v_scope = 'all' or p_assignee_id = p_user_id then
    return true;
  end if;
  if v_scope = 'own' then
    return p_assignee_id is null and p_created_by = p_user_id;
  end if;
  if p_assignee_id is null then
    return true;
  end if;
  return exists (
    select 1
    from public.team_members a
    join public.team_members b on b.team_id = a.team_id and b.org_id = a.org_id
    where a.org_id = p_org_id and a.user_id = p_user_id and b.user_id = p_assignee_id
  );
end;
$$;
revoke all on function app.enquiry_visible_to(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function app.enquiry_visible_to(uuid, uuid, uuid, uuid) to authenticated, service_role;

drop policy enquiries_select on public.enquiries;
create policy enquiries_select on public.enquiries for select to authenticated
  using (app.has_perm(org_id, 'enquiries.view') and app.enquiry_visible_to(org_id, auth.uid(), assignee_id, created_by));
drop policy enquiries_update on public.enquiries;
create policy enquiries_update on public.enquiries for update to authenticated
  using (app.has_perm(org_id, 'enquiries.manage') and app.enquiry_visible_to(org_id, auth.uid(), assignee_id, created_by))
  with check (app.has_perm(org_id, 'enquiries.manage'));
drop policy enquiries_delete on public.enquiries;
create policy enquiries_delete on public.enquiries for delete to authenticated
  using (app.has_perm(org_id, 'enquiries.delete') and app.enquiry_visible_to(org_id, auth.uid(), assignee_id, created_by));

-- Server code (service role, after can()) filters a list of ids down to the ones a member may see.
create or replace function public.enquiry_ids_visible_to(p_org_id uuid, p_user_id uuid, p_ids uuid[])
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.id
  from public.enquiries e
  where e.org_id = p_org_id
    and e.id = any (p_ids)
    and app.enquiry_visible_to(e.org_id, p_user_id, e.assignee_id, e.created_by);
$$;
revoke all on function public.enquiry_ids_visible_to(uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.enquiry_ids_visible_to(uuid, uuid, uuid[]) to service_role;
