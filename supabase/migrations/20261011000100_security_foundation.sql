-- Phase 15 (1/3): security, audit and access — foundation tables.
--
--   roles.require_mfa     per-role "require two-step verification" switch (enforced in middleware)
--   auth_events           sign-in / failure / sign-out / password / MFA events (IP hash + UA family;
--                         the raw IP is nulled after 30 days by security_maintenance())
--   user_sessions         one row per signed-in device, for the session list in Settings → Account
--   record_access_log     who opened a patient, conversation, claim or document, or ran an export
--   security_alerts       anomaly alerts (bulk export, off-hours access, failed logins, role changes);
--                         unique (org_id, dedupe_key) makes alerting idempotent
--   api_read_log          aggregate (per key, resource, hour) log of public-API reads
--   access_reviews        quarterly attest-and-sign access review snapshots
--   contacts.promotions_consent / erased_at   consent evidence and the erasure marker
--
-- All tables are RLS-protected and org-scoped. Writes happen only through the service role (server code
-- after can()), so no insert/update/delete policy exists for `authenticated`.

-- ---------------------------------------------------------------------------
-- Per-role MFA requirement
-- ---------------------------------------------------------------------------
alter table public.roles add column require_mfa boolean not null default false;

-- ---------------------------------------------------------------------------
-- Contacts: consent evidence for promotions_opt_in and the erasure marker
-- ---------------------------------------------------------------------------
alter table public.contacts
  add column promotions_consent jsonb,
  add column erased_at timestamptz,
  add constraint contacts_promotions_consent_check
    check (promotions_consent is null or jsonb_typeof(promotions_consent) = 'object');

-- ---------------------------------------------------------------------------
-- auth_events
-- ---------------------------------------------------------------------------
create table public.auth_events (
  id bigint generated always as identity primary key,
  org_id uuid references public.orgs (id) on delete cascade,      -- null for failures that match no member
  user_id uuid references auth.users (id) on delete set null,
  event_type text not null check (event_type in (
    'sign_in', 'sign_in_failed', 'sign_out', 'sign_out_everywhere', 'password_changed',
    'mfa_enrolled', 'mfa_removed', 'mfa_verified', 'session_revoked'
  )),
  method text check (method is null or method in ('password', 'magic_link', 'mfa')),
  at timestamptz not null default now(),
  ip_hash text,                                                    -- HMAC of the IP; kept for the life of the row
  ip_address text,                                                 -- raw IP; nulled after 30 days
  ua_family text,                                                  -- 'Chrome on Windows', never the full UA string
  email_hash text,                                                 -- HMAC of the e-mail on failed attempts
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object')
);
create index auth_events_org_at_idx on public.auth_events (org_id, at desc);
create index auth_events_user_at_idx on public.auth_events (user_id, at desc);
create index auth_events_failed_idx on public.auth_events (email_hash, at desc) where event_type = 'sign_in_failed';
create index auth_events_ip_idx on public.auth_events (at) where ip_address is not null;

alter table public.auth_events enable row level security;
-- You see your own events; admins see their organisation's.
create policy auth_events_select on public.auth_events for select to authenticated
  using (user_id = auth.uid() or (org_id is not null and app.has_perm(org_id, 'settings.manage')));

-- ---------------------------------------------------------------------------
-- user_sessions
-- ---------------------------------------------------------------------------
create table public.user_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  session_id text not null,                                        -- GoTrue session id (the JWT "session_id" claim)
  ip_hash text,
  ua_family text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_reason text check (revoked_reason is null or revoked_reason in ('signed_out', 'signed_out_others', 'signed_out_everywhere', 'offboarded')),
  unique (user_id, session_id)
);
create index user_sessions_org_user_idx on public.user_sessions (org_id, user_id, last_seen_at desc);

alter table public.user_sessions enable row level security;
create policy user_sessions_select on public.user_sessions for select to authenticated
  using (user_id = auth.uid() and app.is_org_member(org_id));

-- ---------------------------------------------------------------------------
-- record_access_log
-- ---------------------------------------------------------------------------
create table public.record_access_log (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  entity text not null check (entity in (
    'contact', 'conversation', 'finance_claim', 'finance_invoice', 'document',
    'enquiry', 'appointment', 'portal_record', 'export', 'activity_log'
  )),
  entity_id text,
  action text not null check (action in ('view', 'list', 'search', 'download', 'export')),
  sampled boolean not null default false,                          -- true for list views, which are only sampled
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object'),  -- counts, format; never values
  at timestamptz not null default now()
);
create index record_access_log_org_at_idx on public.record_access_log (org_id, at desc);
create index record_access_log_user_idx on public.record_access_log (org_id, user_id, at desc);
create index record_access_log_entity_idx on public.record_access_log (org_id, entity, entity_id);

alter table public.record_access_log enable row level security;
create policy record_access_log_select on public.record_access_log for select to authenticated
  using (app.has_perm(org_id, 'settings.manage'));

-- Append-only, like audit_log. Rows leave only through the org cascade or the retention purge below.
create or replace function app.access_log_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.user_id is null
       and (new.id, new.org_id, new.entity, new.entity_id, new.action, new.sampled, new.detail, new.at)
           is not distinct from (old.id, old.org_id, old.entity, old.entity_id, old.action, old.sampled, old.detail, old.at) then
      return new;                                                  -- the FK action that nulls user_id
    end if;
    raise exception 'record_access_log is append-only' using errcode = '42501';
  elsif tg_op = 'DELETE' then
    if exists (select 1 from public.orgs o where o.id = old.org_id)
       and coalesce(current_setting('app.access_log_purge', true), '') <> 'on' then
      raise exception 'record_access_log is append-only' using errcode = '42501';
    end if;
    return old;
  end if;
  return null;
end;
$$;
create trigger record_access_log_append_only
  before update or delete on public.record_access_log
  for each row execute function app.access_log_guard();

-- auth_events is tamper-resistant too: the only edits are the user_id null-out and the 30-day IP scrub.
create or replace function app.auth_events_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if (new.id, new.org_id, new.event_type, new.method, new.at, new.ip_hash, new.ua_family, new.email_hash, new.detail)
         is not distinct from (old.id, old.org_id, old.event_type, old.method, old.at, old.ip_hash, old.ua_family, old.email_hash, old.detail)
       and (new.user_id is not distinct from old.user_id or new.user_id is null)
       and (new.ip_address is not distinct from old.ip_address or new.ip_address is null) then
      return new;
    end if;
    raise exception 'auth_events is append-only' using errcode = '42501';
  elsif tg_op = 'DELETE' then
    if exists (select 1 from public.orgs o where o.id = old.org_id)
       and coalesce(current_setting('app.access_log_purge', true), '') <> 'on' then
      raise exception 'auth_events is append-only' using errcode = '42501';
    end if;
    return old;
  end if;
  return null;
end;
$$;
create trigger auth_events_append_only
  before update or delete on public.auth_events
  for each row execute function app.auth_events_guard();

-- ---------------------------------------------------------------------------
-- security_alerts
-- ---------------------------------------------------------------------------
create table public.security_alerts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  kind text not null check (kind in ('bulk_export', 'off_hours_access', 'failed_logins', 'role_change', 'bulk_api_read')),
  user_id uuid references auth.users (id) on delete set null,      -- the person the alert is about
  dedupe_key text not null check (char_length(dedupe_key) between 1 and 200),
  summary text not null check (char_length(summary) between 1 and 300),
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object'),
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid references auth.users (id) on delete set null,
  unique (org_id, dedupe_key)
);
create index security_alerts_org_idx on public.security_alerts (org_id, created_at desc);

alter table public.security_alerts enable row level security;
create policy security_alerts_select on public.security_alerts for select to authenticated
  using (app.has_perm(org_id, 'settings.manage'));

-- ---------------------------------------------------------------------------
-- api_read_log: reads through the public API, aggregated per key, resource and hour
-- ---------------------------------------------------------------------------
create table public.api_read_log (
  org_id uuid not null references public.orgs (id) on delete cascade,
  api_key_id uuid not null references public.api_keys (id) on delete cascade,
  resource text not null check (resource ~ '^[a-z_]{1,40}$'),
  bucket timestamptz not null,                                     -- start of the hour
  request_count integer not null default 0,
  row_count integer not null default 0,
  primary key (api_key_id, resource, bucket)
);
create index api_read_log_org_idx on public.api_read_log (org_id, bucket desc);

alter table public.api_read_log enable row level security;
create policy api_read_log_select on public.api_read_log for select to authenticated
  using (app.has_perm(org_id, 'settings.manage'));

-- Called by the public API after a successful read. Service role only. Returns the rows read through this
-- key in the current hour so the caller can compare against the alert threshold without a second query.
create or replace function public.api_read_log_hit(p_org uuid, p_key uuid, p_resource text, p_rows integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total integer;
begin
  if not exists (select 1 from public.api_keys k where k.id = p_key and k.org_id = p_org) then
    return 0;
  end if;
  insert into public.api_read_log (org_id, api_key_id, resource, bucket, request_count, row_count)
  values (p_org, p_key, p_resource, date_trunc('hour', now()), 1, greatest(coalesce(p_rows, 0), 0))
  on conflict (api_key_id, resource, bucket) do update
    set request_count = public.api_read_log.request_count + 1,
        row_count = public.api_read_log.row_count + excluded.row_count;
  select coalesce(sum(row_count), 0)::integer into v_total
  from public.api_read_log where api_key_id = p_key and bucket = date_trunc('hour', now());
  return v_total;
end;
$$;
revoke all on function public.api_read_log_hit(uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.api_read_log_hit(uuid, uuid, text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- access_reviews
-- ---------------------------------------------------------------------------
create table public.access_reviews (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  period text not null check (period ~ '^[0-9]{4}-Q[1-4]$'),
  status text not null default 'open' check (status in ('open', 'attested')),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'array'),  -- one entry per user, with the reviewer's decision
  opened_by uuid references auth.users (id) on delete set null,
  opened_at timestamptz not null default now(),
  attested_by uuid references auth.users (id) on delete set null,
  attested_at timestamptz,
  attestation_name text,                                           -- the name the reviewer typed to sign
  attestation_note text,
  signature text,                                                  -- SHA-256 over snapshot, signer and time
  unique (org_id, period),
  check ((status = 'attested') = (attested_at is not null))
);

alter table public.access_reviews enable row level security;
create policy access_reviews_select on public.access_reviews for select to authenticated
  using (app.has_perm(org_id, 'security.manage'));

-- An attested review is a signed record: it cannot be edited or removed (except by the org cascade).
create or replace function app.access_review_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if old.status = 'attested' then
      raise exception 'an attested access review cannot be changed' using errcode = '42501';
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    if old.status = 'attested' and exists (select 1 from public.orgs o where o.id = old.org_id) then
      raise exception 'an attested access review cannot be deleted' using errcode = '42501';
    end if;
    return old;
  end if;
  return null;
end;
$$;
create trigger access_reviews_guard
  before update or delete on public.access_reviews
  for each row execute function app.access_review_guard();

-- ---------------------------------------------------------------------------
-- Retention. security_maintenance() is called daily by the app's task route (service role only).
--   - raw IPs on auth_events are nulled after 30 days (the hash stays)
--   - auth_events older than 400 days go
--   - record_access_log keeps the per-org retention (orgs.settings.security.access_log_retention_days,
--     default 365, never below 30)
--   - stale sessions (not seen for 90 days) and old API read aggregates go
-- ---------------------------------------------------------------------------
create or replace function public.security_maintenance(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ips integer;
  v_events integer;
  v_access integer := 0;
  v_sessions integer;
  v_api integer;
  o record;
  v_days integer;
  v_n integer;
begin
  perform set_config('app.access_log_purge', 'on', true);

  update public.auth_events set ip_address = null
  where ip_address is not null and at < p_now - interval '30 days';
  get diagnostics v_ips = row_count;

  delete from public.auth_events where at < p_now - interval '400 days';
  get diagnostics v_events = row_count;

  for o in select id, settings from public.orgs loop
    v_days := greatest(30, least(1825, coalesce(
      case when jsonb_typeof(o.settings #> '{security,access_log_retention_days}') = 'number'
           then (o.settings #>> '{security,access_log_retention_days}')::numeric::integer end,
      365)));
    delete from public.record_access_log
    where org_id = o.id and at < p_now - make_interval(days => v_days);
    get diagnostics v_n = row_count;
    v_access := v_access + v_n;
  end loop;

  delete from public.user_sessions where last_seen_at < p_now - interval '90 days';
  get diagnostics v_sessions = row_count;

  delete from public.api_read_log where bucket < p_now - interval '90 days';
  get diagnostics v_api = row_count;

  return jsonb_build_object(
    'raw_ips_scrubbed', v_ips, 'auth_events_deleted', v_events, 'access_log_deleted', v_access,
    'sessions_deleted', v_sessions, 'api_read_rows_deleted', v_api
  );
end;
$$;
revoke all on function public.security_maintenance(timestamptz) from public, anon, authenticated;
grant execute on function public.security_maintenance(timestamptz) to service_role;

select cron.schedule('pulse:security_maintenance', '20 3 * * *', $$select app.ping_jobs('security_maintenance')$$);
