-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Phase 15 (security, audit and access). Needs the earlier files first, including 10_main_flows_recall_reports.sql.
-- Check the project name in the Supabase header first: this is for the Pulse project only.

-- ======================================================================
-- 20261011000100_security_foundation.sql
-- ======================================================================
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

-- ======================================================================
-- 20261011000200_record_history.sql
-- ======================================================================
-- Phase 15 (2/3): one shared, trigger-based field-level history table.
--
-- app.record_history_capture() runs AFTER insert/update/delete on a tracked table and writes one
-- record_history row with {"field": {"from": …, "to": …}} for every column that changed. The History
-- tab in the appointment, enquiry, task, template, flow and portal-record drawers reads it.
--
-- Who made the change: auth.uid() when the write came through a signed-in user's client, otherwise
-- the "x-pulse-actor" request header that the server's service-role client sends (lib/supabase/admin.ts).
-- The header is trusted only when the JWT role is service_role, which only server code holds. Writes
-- with neither (jobs, imports, the public API) are stored with a null actor and shown as "System".
--
-- Long values are cut (text to 500 characters) and large JSON values are reduced to {"changed": true}
-- so the history never becomes a second copy of a flow graph or a template body.

create table public.record_history (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs (id) on delete cascade,
  table_name text not null check (table_name ~ '^[a-z][a-z0-9_]{0,62}$'),
  record_id uuid not null,
  op text not null check (op in ('insert', 'update', 'delete')),
  actor_id uuid references auth.users (id) on delete set null,
  changes jsonb not null default '{}'::jsonb check (jsonb_typeof(changes) = 'object'),
  at timestamptz not null default now()
);
create index record_history_record_idx on public.record_history (org_id, table_name, record_id, at desc, id desc);

-- Who may read the history of a table: whoever may read the record itself.
create or replace function app.can_view_record_history(p_org_id uuid, p_table text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_table
    when 'appointments' then app.has_perm(p_org_id, 'appointments.view')
    when 'enquiries' then app.has_perm(p_org_id, 'enquiries.view')
    when 'tasks' then app.has_perm(p_org_id, 'tasks.view')
    when 'wa_templates' then app.has_perm(p_org_id, 'templates.manage')
    when 'flows' then app.has_perm(p_org_id, 'flows.manage')
    else exists (
      select 1 from public.portal_objects po
      where po.org_id = p_org_id and po.table_name = p_table and app.has_perm_wild(p_org_id, po.read_perm)
    )
  end;
$$;
grant execute on function app.can_view_record_history(uuid, text) to authenticated, service_role;

alter table public.record_history enable row level security;
create policy record_history_select on public.record_history for select to authenticated
  using (app.can_view_record_history(org_id, table_name));

-- History is append-only; it leaves only with the org cascade or a record erasure (erase_contact).
create or replace function app.record_history_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.actor_id is null
       and (new.id, new.org_id, new.table_name, new.record_id, new.op, new.changes, new.at)
           is not distinct from (old.id, old.org_id, old.table_name, old.record_id, old.op, old.changes, old.at) then
      return new;                                                  -- the FK action that nulls actor_id
    end if;
    raise exception 'record_history is append-only' using errcode = '42501';
  elsif tg_op = 'DELETE' then
    if exists (select 1 from public.orgs o where o.id = old.org_id)
       and coalesce(current_setting('app.history_purge', true), '') <> 'on' then
      raise exception 'record_history is append-only' using errcode = '42501';
    end if;
    return old;
  end if;
  return null;
end;
$$;
create trigger record_history_append_only
  before update or delete on public.record_history
  for each row execute function app.record_history_guard();

-- Shortens a value for storage in the history.
create or replace function app.history_value(p_value jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case jsonb_typeof(p_value)
    when 'string' then
      case when char_length(p_value #>> '{}') > 500
           then to_jsonb(left(p_value #>> '{}', 500) || '…')
           else p_value end
    when 'object' then case when length(p_value::text) > 300 then '{"changed": true}'::jsonb else p_value end
    when 'array' then case when length(p_value::text) > 300 then '{"changed": true}'::jsonb else p_value end
    else p_value
  end;
$$;

create or replace function app.record_history_capture()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_changes jsonb := '{}'::jsonb;
  v_skip text[] := array['updated_at', 'created_at', 'search', 'embedding'];
  v_key text;
  v_actor uuid;
  v_headers jsonb;
  v_role text;
  v_row jsonb;
begin
  if TG_NARGS > 0 and TG_ARGV[0] <> '' then
    v_skip := v_skip || string_to_array(TG_ARGV[0], ',');
  end if;

  v_actor := auth.uid();
  if v_actor is null then
    v_role := coalesce(
      nullif(current_setting('request.jwt.claim.role', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
    );
    if v_role = 'service_role' then
      begin
        v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
        v_actor := nullif(v_headers ->> 'x-pulse-actor', '')::uuid;
      exception when others then
        v_actor := null;                                           -- a malformed header must never break the write
      end;
    end if;
  end if;
  -- The actor must be a real user; a stale or forged id would otherwise fail the foreign key.
  if v_actor is not null and not exists (select 1 from auth.users u where u.id = v_actor) then
    v_actor := null;
  end if;

  if TG_OP = 'UPDATE' then
    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);
    for v_key in select jsonb_object_keys(v_new) loop
      continue when v_key = any (v_skip);
      if v_new -> v_key is distinct from v_old -> v_key then
        v_changes := v_changes || jsonb_build_object(
          v_key, jsonb_build_object('from', app.history_value(v_old -> v_key), 'to', app.history_value(v_new -> v_key))
        );
      end if;
    end loop;
    if v_changes = '{}'::jsonb then
      return null;                                                 -- only noise columns changed
    end if;
  end if;

  v_row := to_jsonb(case when TG_OP = 'DELETE' then OLD else NEW end);
  insert into public.record_history (org_id, table_name, record_id, op, actor_id, changes)
  values ((v_row ->> 'org_id')::uuid, TG_TABLE_NAME, (v_row ->> 'id')::uuid, lower(TG_OP), v_actor, v_changes);
  return null;
end;
$$;
revoke all on function app.record_history_capture() from public, anon, authenticated;

-- Attach the trigger to a table (idempotent). Portal tables added by later phases call this too.
create or replace function app.enable_record_history(p_table text, p_skip text default '')
returns void
language plpgsql
set search_path = ''
as $$
begin
  execute format('drop trigger if exists %I on public.%I', p_table || '_record_history', p_table);
  execute format(
    'create trigger %I after insert or update or delete on public.%I for each row execute function app.record_history_capture(%L)',
    p_table || '_record_history', p_table, p_skip
  );
end;
$$;
revoke all on function app.enable_record_history(text, text) from public, anon, authenticated;

select app.enable_record_history('appointments');
select app.enable_record_history('enquiries', 'sla_due_at,sla_breached_at,first_touch_at,stage_entered_at');
select app.enable_record_history('tasks', 'due_notified_for');
select app.enable_record_history('wa_templates');
select app.enable_record_history('flows', 'last_triggered_at');
select app.enable_record_history('ref_diagnoses');
select app.enable_record_history('ref_condition_groups');
select app.enable_record_history('ref_medications');
select app.enable_record_history('ref_items');
select app.enable_record_history('ref_medication_classes');
select app.enable_record_history('website_entry_points');

-- ======================================================================
-- 20261011000300_privacy_offboarding.sql
-- ======================================================================
-- Phase 15 (3/3): patient data export / erasure requests and the off-boarding action.
--
--   privacy_requests   one row per export or erasure request. Two-person rule: the person who approves a
--                      request cannot be the person who raised it (enforced by a CHECK, not only in code).
--   erase_contact()    anonymises one patient inside a single transaction (service role only)
--   offboard_member()  suspends a member, revokes their API keys and sessions, hands over their open
--                      conversations and tasks, and writes the audit row, all in one transaction
--
-- Erasure is anonymisation, not row deletion: the contact row, appointments and enquiries stay so counts,
-- finance links and audit trails keep working, but every identifier and every free-text field that can name
-- the patient is cleared. Clinical records mirrored from Unite (visits, prescriptions, follow-ups, feedback,
-- chronic conditions) are NOT altered: they are medical records with their own legal retention, and the
-- clinic's data-protection decision on them is recorded as an open question (docs/12_PHASE_15_NOTES.md).

-- ---------------------------------------------------------------------------
-- privacy_requests
-- ---------------------------------------------------------------------------
create table public.privacy_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  kind text not null check (kind in ('export', 'erasure')),
  contact_id uuid not null references public.contacts (id) on delete restrict,
  status text not null default 'pending' check (status in ('pending', 'approved', 'completed', 'rejected', 'cancelled')),
  reason text not null check (char_length(reason) between 5 and 1000),
  requested_by uuid references auth.users (id) on delete set null,
  requested_at timestamptz not null default now(),
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  decision_note text check (decision_note is null or char_length(decision_note) <= 1000),
  completed_at timestamptz,
  result jsonb not null default '{}'::jsonb check (jsonb_typeof(result) = 'object'),   -- counts only, never data
  -- Two-person confirmation: whoever decides cannot be whoever asked.
  constraint privacy_requests_two_person check (decided_by is null or requested_by is null or decided_by <> requested_by)
);
create index privacy_requests_org_idx on public.privacy_requests (org_id, requested_at desc);
create index privacy_requests_contact_idx on public.privacy_requests (contact_id);
create trigger privacy_requests_contact_org_check before insert or update of contact_id on public.privacy_requests
  for each row execute function app.check_parent_org('contacts', 'contact_id');

alter table public.privacy_requests enable row level security;
create policy privacy_requests_select on public.privacy_requests for select to authenticated
  using (app.has_perm(org_id, 'privacy.manage'));

-- ---------------------------------------------------------------------------
-- erase_contact
-- ---------------------------------------------------------------------------
create or replace function public.erase_contact(p_org uuid, p_contact uuid, p_actor uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact public.contacts;
  v_conv uuid[];
  v_enq uuid[];
  v_appt uuid[];
  v_task uuid[];
  n integer;
  r jsonb := '{}'::jsonb;
begin
  select * into v_contact from public.contacts where id = p_contact and org_id = p_org for update;
  if not found then
    raise exception 'contact not found in this organisation' using errcode = 'no_data_found';
  end if;
  if v_contact.erased_at is not null then
    raise exception 'contact is already erased' using errcode = 'check_violation';
  end if;

  select coalesce(array_agg(id), '{}') into v_conv from public.conversations where org_id = p_org and contact_id = p_contact;
  select coalesce(array_agg(id), '{}') into v_enq from public.enquiries where org_id = p_org and contact_id = p_contact;
  select coalesce(array_agg(id), '{}') into v_appt from public.appointments where org_id = p_org and contact_id = p_contact;
  select coalesce(array_agg(id), '{}') into v_task from public.tasks where org_id = p_org and contact_id = p_contact;

  -- Messages: keep the row (counts, delivery stats) but drop everything a person wrote or sent.
  update public.messages
     set body = null, payload = '{}'::jsonb, media_path = null, media_mime = null, media_filename = null,
         media_meta_id = null, error_message = null
   where org_id = p_org and conversation_id = any (v_conv);
  get diagnostics n = row_count; r := r || jsonb_build_object('messages_scrubbed', n);

  update public.conversations
     set summary = null, last_message_preview = null, ad_referral = null, ai_tags = '{}'
   where org_id = p_org and id = any (v_conv);

  delete from public.mentions where org_id = p_org and (contact_id = p_contact or conversation_id = any (v_conv));
  delete from public.timeline_events
   where org_id = p_org and (contact_id = p_contact or enquiry_id = any (v_enq));
  get diagnostics n = row_count; r := r || jsonb_build_object('timeline_events_deleted', n);

  delete from public.contact_phones where org_id = p_org and contact_id = p_contact;
  get diagnostics n = row_count; r := r || jsonb_build_object('phones_deleted', n);
  delete from public.contact_tags where contact_id = p_contact;
  delete from public.segment_members where contact_id = p_contact;

  update public.appointments set notes = null, custom = '{}'::jsonb where org_id = p_org and id = any (v_appt);
  update public.enquiries
     set title = 'Erased enquiry', custom = '{}'::jsonb, lost_reason = null
   where org_id = p_org and id = any (v_enq);
  update public.tasks set subject = 'Erased task', notes = null where org_id = p_org and id = any (v_task);
  update public.flow_runs set context = '{}'::jsonb, waiting_for = null, error = null
   where org_id = p_org and contact_id = p_contact;
  update public.campaign_recipients set vars = '{}'::jsonb, csv_data = '{}'::jsonb, error_message = null
   where org_id = p_org and contact_id = p_contact;
  update public.recall_sends set notes = null, sent_to_phone_e164 = null where org_id = p_org and contact_id = p_contact;
  -- Unite patients that were matched to this contact carry the patient's details in the review item.
  update public.sync_reviews set incoming = '{}'::jsonb, candidates = '[]'::jsonb
   where org_id = p_org and resolved_contact_id = p_contact;

  -- The field-level history of the patient's appointments, enquiries and tasks repeats those values.
  perform set_config('app.history_purge', 'on', true);
  delete from public.record_history
   where org_id = p_org and (
     (table_name = 'appointments' and record_id = any (v_appt)) or
     (table_name = 'enquiries' and record_id = any (v_enq)) or
     (table_name = 'tasks' and record_id = any (v_task))
   );
  get diagnostics n = row_count; r := r || jsonb_build_object('history_rows_deleted', n);

  update public.contacts
     set first_name = 'Erased', last_name = 'patient', phone_e164 = null, wa_bsuid = null, email = null,
         gender = null, nationality = null, country = null, language = null, dob = null, label = null,
         owner_id = null, assignee_id = null, external_id = null, custom = '{}'::jsonb,
         wa_profile_name = null, promotions_opt_in = false, promotions_consent = null,
         stop_marketing = true,                                    -- an erased person is never messaged again
         clinical_messaging_consent = false,
         merged_into_id = null, deleted_at = coalesce(deleted_at, now()), erased_at = now()
   where id = p_contact;

  -- Counts of what is deliberately left (clinical records), so the reviewer sees it in the result.
  r := r || jsonb_build_object(
    'retained_visits', (select count(*) from public.visits where org_id = p_org and contact_id = p_contact),
    'retained_prescriptions', (select count(*) from public.prescriptions where org_id = p_org and contact_id = p_contact),
    'retained_followups', (select count(*) from public.clinical_followups where org_id = p_org and contact_id = p_contact),
    'retained_feedback', (select count(*) from public.clinical_feedback where org_id = p_org and contact_id = p_contact),
    'conversations', coalesce(array_length(v_conv, 1), 0),
    'appointments', coalesce(array_length(v_appt, 1), 0),
    'enquiries', coalesce(array_length(v_enq, 1), 0),
    'tasks', coalesce(array_length(v_task, 1), 0)
  );

  insert into public.audit_log (org_id, user_id, action, entity, entity_id, diff)
  values (p_org, p_actor, 'contact.erased', 'contact', p_contact::text, r);
  return r;
end;
$$;
revoke all on function public.erase_contact(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.erase_contact(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- offboard_member
-- ---------------------------------------------------------------------------
create or replace function public.offboard_member(
  p_org uuid,
  p_membership uuid,
  p_actor uuid,
  p_reassign_to uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_m public.memberships;
  v_is_admin boolean;
  v_admins integer;
  v_keys integer;
  v_conv integer;
  v_tasks integer;
  v_sessions integer;
  v_teams integer;
  v_result jsonb;
begin
  select * into v_m from public.memberships where id = p_membership and org_id = p_org for update;
  if not found then
    raise exception 'member not found' using errcode = 'no_data_found';
  end if;
  if v_m.user_id = p_actor then
    raise exception 'you cannot off-board yourself' using errcode = 'check_violation';
  end if;
  if v_m.status = 'suspended' then
    raise exception 'member is already suspended' using errcode = 'check_violation';
  end if;

  select exists (select 1 from public.roles r where r.id = v_m.role_id and r.permissions ? '*') into v_is_admin;
  if v_is_admin then
    select count(*) into v_admins
    from public.memberships m join public.roles r on r.id = m.role_id
    where m.org_id = p_org and m.status = 'active' and r.permissions ? '*';
    if v_admins <= 1 then
      raise exception 'this is the last administrator' using errcode = 'check_violation';
    end if;
  end if;

  if p_reassign_to is not null then
    if p_reassign_to = v_m.user_id then
      raise exception 'hand-over target must be someone else' using errcode = 'check_violation';
    end if;
    if not exists (select 1 from public.memberships m where m.org_id = p_org and m.user_id = p_reassign_to and m.status = 'active') then
      raise exception 'hand-over target is not an active member of this workspace' using errcode = 'check_violation';
    end if;
  end if;

  update public.memberships set status = 'suspended', presence = 'offline' where id = p_membership;

  update public.api_keys set revoked_at = now()
   where org_id = p_org and created_by = v_m.user_id and revoked_at is null;
  get diagnostics v_keys = row_count;

  update public.conversations set assignee_user_id = p_reassign_to
   where org_id = p_org and assignee_user_id = v_m.user_id and status <> 'closed';
  get diagnostics v_conv = row_count;

  update public.tasks set assignee_id = p_reassign_to
   where org_id = p_org and assignee_id = v_m.user_id and not done;
  get diagnostics v_tasks = row_count;

  -- Out of every team, so round-robin assignment cannot pick them while suspended.
  delete from public.team_members where org_id = p_org and user_id = v_m.user_id;
  get diagnostics v_teams = row_count;

  update public.user_sessions set revoked_at = now(), revoked_reason = 'offboarded'
   where org_id = p_org and user_id = v_m.user_id and revoked_at is null;
  get diagnostics v_sessions = row_count;

  v_result := jsonb_build_object(
    'user_id', v_m.user_id, 'api_keys_revoked', v_keys, 'conversations_reassigned', v_conv,
    'tasks_reassigned', v_tasks, 'teams_left', v_teams, 'sessions_marked_revoked', v_sessions,
    'reassigned_to', p_reassign_to
  );
  insert into public.audit_log (org_id, user_id, action, entity, entity_id, diff)
  values (p_org, p_actor, 'member.offboarded', 'membership', p_membership::text, v_result);
  return v_result;
end;
$$;
revoke all on function public.offboard_member(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.offboard_member(uuid, uuid, uuid, uuid) to service_role;

-- ======================================================================
-- Record the new migration versions so the Supabase CLI sees them as applied.
-- ======================================================================
insert into supabase_migrations.schema_migrations (version, name)
values
  ('20261011000100', 'security_foundation'),
  ('20261011000200', 'record_history'),
  ('20261011000300', 'privacy_offboarding')
on conflict (version) do nothing;
