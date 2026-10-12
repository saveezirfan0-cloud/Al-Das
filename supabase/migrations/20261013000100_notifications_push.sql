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
