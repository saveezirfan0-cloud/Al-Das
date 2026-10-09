-- Phase 11: hardening.
--   1. Postgres-backed fixed-window rate limiter (no Redis): rate_limit_hits + rate_limit_hit().
--   2. audit_log is append-only even for the service role (RLS alone does not bind it).

-- ---------------------------------------------------------------------------
-- Rate limiter. One row per (key, window). rate_limit_hit() is an atomic
-- insert-or-increment that reports whether the call is still within the limit.
-- Keys are opaque strings built by lib/rate-limit.ts (hashed IPs, API key ids,
-- user ids); never put phone numbers or tokens in a key.
-- ---------------------------------------------------------------------------

create table public.rate_limit_hits (
  key text not null,
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (key, window_start)
);
create index rate_limit_hits_window_idx on public.rate_limit_hits (window_start);

alter table public.rate_limit_hits enable row level security;
-- no API policies: service role only

create or replace function public.rate_limit_hit(p_key text, p_limit integer, p_window_seconds integer)
returns table (allowed boolean, hits integer, retry_after integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window integer := greatest(p_window_seconds, 1);
  v_start timestamptz;
  v_hits integer;
begin
  if p_key is null or length(p_key) = 0 or length(p_key) > 200 then
    raise exception 'invalid rate limit key';
  end if;
  v_start := to_timestamp(floor(extract(epoch from now()) / v_window) * v_window);
  insert into public.rate_limit_hits as r (key, window_start, hits)
  values (p_key, v_start, 1)
  on conflict (key, window_start) do update set hits = r.hits + 1
  returning r.hits into v_hits;
  allowed := v_hits <= greatest(p_limit, 1);
  hits := v_hits;
  retry_after := case when allowed then 0
    else greatest(1, ceil(extract(epoch from (v_start + make_interval(secs => v_window) - now())))::integer) end;
  return next;
end;
$$;
revoke all on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;

select cron.schedule('pulse:housekeeping_rate_limits', '35 3 * * *', $$
  delete from public.rate_limit_hits where window_start < now() - interval '1 day';
$$);

-- ---------------------------------------------------------------------------
-- audit_log is append-only. Deleting the org cascades (orgs are never deleted
-- in normal operation) and ON DELETE SET NULL on user_id is an UPDATE of the
-- user_id column only, so both stay possible; everything else is blocked.
-- ---------------------------------------------------------------------------

create or replace function app.audit_log_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    -- Allow only the FK action that nulls user_id when a user is removed.
    if new.user_id is null
       and (new.id, new.org_id, new.action, new.entity, new.entity_id, new.diff, new.at)
           is not distinct from (old.id, old.org_id, old.action, old.entity, old.entity_id, old.diff, old.at) then
      return new;
    end if;
    raise exception 'audit_log is append-only' using errcode = '42501';
  elsif tg_op = 'DELETE' then
    -- Rows may only disappear through the orgs cascade.
    if exists (select 1 from public.orgs o where o.id = old.org_id) then
      raise exception 'audit_log is append-only' using errcode = '42501';
    end if;
    return old;
  end if;
  return null;
end;
$$;

create trigger audit_log_append_only
  before update or delete on public.audit_log
  for each row execute function app.audit_log_guard();

-- ---------------------------------------------------------------------------
-- Function grants. Supabase's default privileges grant EXECUTE on new public
-- functions to anon explicitly, which `revoke ... from public` does not remove.
-- The two RPCs meant for signed-in users must not be callable anonymously.
-- ---------------------------------------------------------------------------

revoke execute on function public.mark_all_notifications_read(uuid) from anon;
revoke execute on function public.set_presence(uuid, text) from anon;
