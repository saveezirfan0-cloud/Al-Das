-- Phase 20e (G7): Google Calendar two-way busy sync per specialist. OFF by default (integration_accounts kind
-- 'google_calendar', typed confirmation because appointment times are shared with Google).
--
-- IN:  the specialist's Google busy times become time_blocks rows with source = 'google' (a read-only mirror:
--      only gcal_apply_busy_blocks / gcal_clear_busy_blocks may write them). They carry the fixed reason
--      'Busy (Google Calendar)', never the event's title, description, attendees or location. Availability and
--      book_appointment already honour time_blocks, so nothing else changes.
-- OUT: Pulse appointments are written to Google as events titled "Busy" with no patient detail (lib/integrations/gcal).
--      gcal_event_links remembers which Google event belongs to which appointment so a move updates it and a
--      cancellation deletes it.
--
-- gcal_connections and gcal_oauth_states hold ciphertext / login state: service role only (no policies).
-- gcal_event_links holds ids and a hash only: org-scoped select for appointments.view.

-- ---------------------------------------------------------------------------
-- time_blocks: source + mirror key
-- ---------------------------------------------------------------------------
alter table public.time_blocks
  add column source text not null default 'manual' check (source in ('manual', 'google')),
  add column external_key text check (external_key is null or external_key ~ '^[0-9a-f]{64}$');
alter table public.time_blocks add constraint time_blocks_google_key_check
  check ((source = 'google') = (external_key is not null));
create unique index time_blocks_specialist_external_uidx on public.time_blocks (specialist_id, external_key)
  where external_key is not null;

-- Google rows are a mirror: people (and any code path other than the sync functions) cannot create, change or delete
-- them. Cascades from deleting the specialist or the organisation still work.
create or replace function app.time_blocks_mirror_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_setting('app.gcal_mirror', true) = 'on' then
    return coalesce(new, old);
  end if;
  if tg_op = 'INSERT' and new.source = 'google' then
    raise exception 'busy times from Google Calendar are written by the sync only' using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and (old.source = 'google' or new.source = 'google') then
    raise exception 'busy times from Google Calendar are written by the sync only' using errcode = 'check_violation';
  end if;
  if tg_op = 'DELETE' and old.source = 'google'
     and exists (select 1 from public.specialists where id = old.specialist_id)
     and exists (select 1 from public.orgs where id = old.org_id) then
    raise exception 'busy times from Google Calendar are removed by the sync only' using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger time_blocks_mirror_guard before insert or update or delete on public.time_blocks
  for each row execute function app.time_blocks_mirror_guard();

-- ---------------------------------------------------------------------------
-- Connections (service role only)
-- ---------------------------------------------------------------------------
create table public.gcal_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  specialist_id uuid not null references public.specialists (id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'error', 'revoked')),
  calendar_id text not null default 'primary' check (length(calendar_id) between 1 and 200),
  refresh_enc text,                          -- AES-256-GCM (lib/crypto.ts); null once revoked
  access_enc text,                           -- short-lived; refreshed on demand
  access_expires_at timestamptz,
  connected_by uuid references public.profiles (id) on delete set null,
  connected_at timestamptz not null default now(),
  last_pull_at timestamptz,
  last_push_at timestamptz,
  last_error text,                                 -- short redacted reason, never a token or event text
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  next_sync_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status = 'revoked' or refresh_enc is not null)
);
create unique index gcal_connections_specialist_uidx on public.gcal_connections (specialist_id) where status <> 'revoked';
create index gcal_connections_due_idx on public.gcal_connections (next_sync_at) where status <> 'revoked';
create trigger gcal_connections_set_updated_at before update on public.gcal_connections
  for each row execute function app.set_updated_at();
create trigger gcal_connections_specialist_org_check before insert or update on public.gcal_connections
  for each row execute function app.check_parent_org('specialists', 'specialist_id');
alter table public.gcal_connections enable row level security;
-- no API policies: service role only

-- One-time OAuth "state" values (10 minutes), bound to the person and the specialist. Only the SHA-256 is stored.
create table public.gcal_oauth_states (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  org_id uuid not null references public.orgs (id) on delete cascade,
  specialist_id uuid not null references public.specialists (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index gcal_oauth_states_org_idx on public.gcal_oauth_states (org_id, created_at);
create trigger gcal_oauth_states_specialist_org_check before insert or update on public.gcal_oauth_states
  for each row execute function app.check_parent_org('specialists', 'specialist_id');
alter table public.gcal_oauth_states enable row level security;
-- no API policies: service role only

-- ---------------------------------------------------------------------------
-- Pushed events (ids and a hash only)
-- ---------------------------------------------------------------------------
create table public.gcal_event_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  connection_id uuid not null references public.gcal_connections (id) on delete cascade,
  appointment_id uuid references public.appointments (id) on delete set null,
  event_id text not null check (event_id ~ '^[a-v0-9]+$' and length(event_id) between 5 and 1024),
  synced_hash text not null check (synced_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'live' check (status in ('live', 'deleted')),
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (connection_id, event_id)
);
create unique index gcal_event_links_appointment_uidx on public.gcal_event_links (connection_id, appointment_id)
  where appointment_id is not null;
create index gcal_event_links_org_idx on public.gcal_event_links (org_id, last_synced_at);
create trigger gcal_event_links_connection_org_check before insert or update on public.gcal_event_links
  for each row execute function app.check_parent_org('gcal_connections', 'connection_id');
create trigger gcal_event_links_appointment_org_check before insert or update on public.gcal_event_links
  for each row execute function app.check_parent_org('appointments', 'appointment_id');
alter table public.gcal_event_links enable row level security;
create policy gcal_event_links_select on public.gcal_event_links for select to authenticated
  using (app.has_perm(org_id, 'appointments.view'));
-- Writes: the sync job only (service role).

-- ---------------------------------------------------------------------------
-- Mirror writers
-- ---------------------------------------------------------------------------

-- Replaces the Google busy blocks of one specialist inside [p_from, p_to) with p_blocks
-- ([{"key": <sha256 hex>, "starts_at": ..., "ends_at": ...}]). Idempotent: the same input leaves the same rows.
create or replace function public.gcal_apply_busy_blocks(
  p_org uuid, p_specialist uuid, p_from timestamptz, p_to timestamptz, p_blocks jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inserted integer := 0;
  v_updated integer := 0;
  v_deleted integer := 0;
begin
  if not exists (select 1 from public.specialists where id = p_specialist and org_id = p_org) then
    raise exception 'specialist not found in this organisation' using errcode = 'no_data_found';
  end if;
  if jsonb_typeof(p_blocks) <> 'array' or jsonb_array_length(p_blocks) > 2000 or p_to <= p_from then
    raise exception 'invalid busy blocks' using errcode = 'check_violation';
  end if;
  perform set_config('app.gcal_mirror', 'on', true);
  perform pg_advisory_xact_lock(hashtext('gcal-mirror:' || p_specialist::text));

  create temporary table if not exists pg_temp.gcal_incoming (key text primary key, starts_at timestamptz, ends_at timestamptz) on commit drop;
  truncate pg_temp.gcal_incoming;
  insert into pg_temp.gcal_incoming (key, starts_at, ends_at)
  select distinct on (b ->> 'key') b ->> 'key', (b ->> 'starts_at')::timestamptz, (b ->> 'ends_at')::timestamptz
    from jsonb_array_elements(p_blocks) b
   where (b ->> 'key') ~ '^[0-9a-f]{64}$' and (b ->> 'ends_at')::timestamptz > (b ->> 'starts_at')::timestamptz;

  with u as (
    update public.time_blocks t
       set starts_at = i.starts_at, ends_at = i.ends_at
      from pg_temp.gcal_incoming i
     where t.specialist_id = p_specialist and t.external_key = i.key
       and (t.starts_at <> i.starts_at or t.ends_at <> i.ends_at)
    returning 1
  ) select count(*) into v_updated from u;

  with ins as (
    insert into public.time_blocks (org_id, specialist_id, location_id, starts_at, ends_at, reason, source, external_key)
    select p_org, p_specialist, null, i.starts_at, i.ends_at, 'Busy (Google Calendar)', 'google', i.key
      from pg_temp.gcal_incoming i
     where not exists (select 1 from public.time_blocks t where t.specialist_id = p_specialist and t.external_key = i.key)
    returning 1
  ) select count(*) into v_inserted from ins;

  with d as (
    delete from public.time_blocks t
     where t.org_id = p_org and t.specialist_id = p_specialist and t.source = 'google'
       and t.starts_at < p_to and t.ends_at > p_from
       and not exists (select 1 from pg_temp.gcal_incoming i where i.key = t.external_key)
    returning 1
  ) select count(*) into v_deleted from d;

  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'deleted', v_deleted);
end;
$$;
revoke all on function public.gcal_apply_busy_blocks(uuid, uuid, timestamptz, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.gcal_apply_busy_blocks(uuid, uuid, timestamptz, timestamptz, jsonb) to service_role;

-- Removes every Google busy block of one specialist (disconnect, or pulling switched off).
create or replace function public.gcal_clear_busy_blocks(p_org uuid, p_specialist uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  perform set_config('app.gcal_mirror', 'on', true);
  delete from public.time_blocks where org_id = p_org and specialist_id = p_specialist and source = 'google';
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.gcal_clear_busy_blocks(uuid, uuid) from public, anon, authenticated;
grant execute on function public.gcal_clear_busy_blocks(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Schedules
-- ---------------------------------------------------------------------------
select cron.schedule('pulse:gcal_sync', '*/5 * * * *', $$select app.ping_jobs('gcal_sync')$$);
select cron.schedule('pulse:housekeeping_20e_gcal', '40 3 * * *', $$
  delete from public.gcal_oauth_states where expires_at < now() - interval '1 day';
  delete from public.gcal_event_links where status = 'deleted' and last_synced_at < now() - interval '30 days';
$$);
