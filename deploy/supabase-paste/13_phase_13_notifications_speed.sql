-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Phase 13 (mobile, notifications and speed). Needs the earlier files first, including 12_phase_15_security.sql.
-- Check the project name in the Supabase header first: this is for the Pulse project only.
-- After running it: set the VAPID keys (pnpm push:keys) in Vercel, and turn on notifications under Settings > Notifications.

-- ======================================================================
-- 20261013000100_notifications_push.sql
-- ======================================================================
-- Phase 13: notification preferences, Web Push subscriptions, snooze, escalation ladder, digest log.
--
--   notification_preferences  one row per (user, event, channel): is that channel on for that event?
--                             The row with event = '*' is the channel master switch and carries the
--                             user's quiet hours for that channel. Users manage their own rows.
--   push_subscriptions        one row per browser/device. The subscription (endpoint + keys) is
--                             AES-256-GCM encrypted by the app (ENCRYPTION_KEY); only a hash of the
--                             endpoint is stored in clear, for uniqueness. Written by the server only.
--   notification_digest_log   one row per digest sent, so a retried cron tick never sends twice.
--   notifications.snoozed_until   hides a notification from the bell and unread counts until then.
--   conversations.escalation_level  0 = none, 1 = team lead told, 2 = on-call told. Reset on assignment.
--   teams.lead_user_id        who the escalation ladder tells first.
--
-- RLS: every new table is org-scoped. notification_preferences is writable by its own user;
-- the other two are readable by their own user and written by the service role only. Policies use
-- (select auth.uid()) so Postgres evaluates it once per statement instead of once per row.

-- ---------------------------------------------------------------------------
-- notification_preferences
-- ---------------------------------------------------------------------------
create table public.notification_preferences (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  event text not null check (event = '*' or event ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)*$'),
  channel text not null check (channel in ('in_app', 'email', 'push')),
  enabled boolean not null default true,
  -- Quiet hours, local time, only on the '*' row of a channel. The window may cross midnight.
  quiet_start time,
  quiet_end time,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, user_id, event, channel),
  check ((quiet_start is null) = (quiet_end is null)),
  check (event = '*' or quiet_start is null)
);
create index notification_preferences_user_idx on public.notification_preferences (org_id, user_id);
create trigger notification_preferences_set_updated_at
  before update on public.notification_preferences for each row execute function app.set_updated_at();

alter table public.notification_preferences enable row level security;
create policy notification_preferences_select on public.notification_preferences for select to authenticated
  using (user_id = (select auth.uid()) and app.is_org_member(org_id));
create policy notification_preferences_insert on public.notification_preferences for insert to authenticated
  with check (user_id = (select auth.uid()) and app.is_org_member(org_id));
create policy notification_preferences_update on public.notification_preferences for update to authenticated
  using (user_id = (select auth.uid()) and app.is_org_member(org_id))
  with check (user_id = (select auth.uid()) and app.is_org_member(org_id));
create policy notification_preferences_delete on public.notification_preferences for delete to authenticated
  using (user_id = (select auth.uid()) and app.is_org_member(org_id));

-- ---------------------------------------------------------------------------
-- push_subscriptions
-- ---------------------------------------------------------------------------
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  endpoint_hash text not null check (endpoint_hash ~ '^[0-9a-f]{64}$'),   -- sha256 of the endpoint URL
  subscription_enc text not null,                                         -- v1:<iv>:<tag>:<ciphertext> (AES-256-GCM)
  ua_family text,
  failure_count integer not null default 0,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  unique (org_id, user_id, endpoint_hash)
);
create index push_subscriptions_user_idx on public.push_subscriptions (org_id, user_id);

alter table public.push_subscriptions enable row level security;
-- A user can see that they have devices (never anyone else's). Writes: service role only.
create policy push_subscriptions_select on public.push_subscriptions for select to authenticated
  using (user_id = (select auth.uid()) and app.is_org_member(org_id));

-- ---------------------------------------------------------------------------
-- notification_digest_log
-- ---------------------------------------------------------------------------
create table public.notification_digest_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('daily', 'weekly')),
  period_key text not null,                         -- '2026-10-13' (daily) or '2026-W42' (weekly), org-local
  sent_at timestamptz not null default now(),
  unique (org_id, user_id, kind, period_key)
);

alter table public.notification_digest_log enable row level security;
create policy notification_digest_log_select on public.notification_digest_log for select to authenticated
  using (user_id = (select auth.uid()) and app.is_org_member(org_id));

-- ---------------------------------------------------------------------------
-- Snooze
-- ---------------------------------------------------------------------------
alter table public.notifications add column snoozed_until timestamptz;

-- ---------------------------------------------------------------------------
-- Escalation ladder
-- ---------------------------------------------------------------------------
alter table public.teams add column lead_user_id uuid references public.profiles (id) on delete set null;

alter table public.conversations
  add column escalation_level smallint not null default 0 check (escalation_level between 0 and 2);

-- Giving a conversation an owner ends any escalation in progress.
create or replace function app.reset_escalation_on_assign()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.assignee_user_id is not null and new.assignee_user_id is distinct from old.assignee_user_id then
    new.escalation_level := 0;
  end if;
  return new;
end;
$$;
create trigger conversations_reset_escalation
  before update of assignee_user_id on public.conversations
  for each row execute function app.reset_escalation_on_assign();

-- ---------------------------------------------------------------------------
-- Cron: the digest task checks every org's local hour, so it runs hourly.
-- ---------------------------------------------------------------------------
select cron.schedule('pulse:notification_digests', '5 * * * *', $$select app.ping_jobs('notification_digests')$$);

-- ======================================================================
-- 20261013000200_dashboard_overview.sql
-- ======================================================================
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

-- ======================================================================
-- 20261013000300_performance_indexes.sql
-- ======================================================================
-- Phase 13 (speed): indexes found by reading the code's queries against the existing indexes.
-- (The Supabase performance advisor was not available in the build sandbox. A catalogue query for foreign keys
-- without a leading index returned about 150 candidates; almost all are covered by an (org_id, ...) composite
-- that every query uses, or are never filtered on. The ones below are the ones a real query needs.)
--
-- Every index is partial or narrow, so the write cost is small. All are IF NOT EXISTS so a re-run is harmless.

-- 1. clinical_followups: evaluateVisit() looks up the OPEN follow-ups of one visit
--    (where org_id = $1 and visit_id = $2 and source = 'engine' and closed_at is null) for each visit it
--    evaluates, up to 500 per run, every 10 minutes. The existing indexes lead with dedupe_key or call_status,
--    so each lookup scanned every open follow-up of the organisation.
create index if not exists clinical_followups_visit_open_idx
  on public.clinical_followups (org_id, visit_id)
  where closed_at is null;

-- 2. tasks: the Tasks page's "Done" view (done = true, sorted by due date, with an exact count) could not use
--    tasks_open_due_idx, which is partial on "not done". Done tasks only ever accumulate (every failed reminder
--    leaves a call task), so this view got slower every month.
create index if not exists tasks_org_done_due_idx
  on public.tasks (org_id, due_at desc)
  where done;

-- 3. audit_log: the Activity log filtered by person (where org_id = $1 and user_id = $2 order by at desc) walked
--    audit_log_org_at_idx backwards until it found enough rows by that person, which for a quiet person is the
--    whole history. Rows with no user (system, API keys) are not worth indexing.
create index if not exists audit_log_org_user_at_idx
  on public.audit_log (org_id, user_id, at desc)
  where user_id is not null;

-- 4. contacts: "my patients" views filter on the owner or assignee, both exposed in the filter builder
--    (lib/filters/field-registry.ts). Most contacts have neither set, so the partial indexes stay small.
create index if not exists contacts_org_owner_idx
  on public.contacts (org_id, owner_id)
  where owner_id is not null and deleted_at is null;
create index if not exists contacts_org_assignee_idx
  on public.contacts (org_id, assignee_id)
  where assignee_id is not null and deleted_at is null;

