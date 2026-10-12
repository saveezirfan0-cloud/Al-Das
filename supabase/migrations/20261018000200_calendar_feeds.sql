-- Phase 19a (2/4): doctor calendar feeds (ICS, read-only).
--
-- A feed is a secret URL a doctor adds to Outlook, Google or Apple Calendar. Only the SHA-256 of the token is stored; the URL is
-- shown once when it is created or rotated. A feed belongs to ONE specialist, or to one user ("my appointments": every specialist
-- profile linked to that user). The feed carries start, end, a generic title and the location name, never a patient detail.
-- Access is counted (access_count / last_access_at and integration_usage_daily), not logged per request.

create table public.calendar_feeds (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  kind text not null check (kind in ('specialist', 'user')),
  specialist_id uuid references public.specialists (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete cascade,
  label text not null check (char_length(label) between 1 and 80),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  revoked_at timestamptz,
  last_access_at timestamptz,
  access_count bigint not null default 0,
  check (
    (kind = 'specialist' and specialist_id is not null and user_id is null)
    or (kind = 'user' and user_id is not null and specialist_id is null)
  )
);
create index calendar_feeds_org_idx on public.calendar_feeds (org_id, created_at desc);
create index calendar_feeds_specialist_idx on public.calendar_feeds (specialist_id) where specialist_id is not null;

create trigger calendar_feeds_specialist_org_check before insert or update of specialist_id, org_id on public.calendar_feeds
  for each row execute function app.check_parent_org('specialists', 'specialist_id');

-- A "my appointments" feed can only belong to an active member of the same org.
create or replace function app.calendar_feed_user_check()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.user_id is not null and not exists (
    select 1 from public.memberships m where m.org_id = new.org_id and m.user_id = new.user_id and m.status = 'active'
  ) then
    raise exception 'user % is not an active member of org %', new.user_id, new.org_id using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger calendar_feeds_user_check before insert or update of user_id, org_id on public.calendar_feeds
  for each row execute function app.calendar_feed_user_check();

alter table public.calendar_feeds enable row level security;
create policy calendar_feeds_select on public.calendar_feeds for select to authenticated
  using (app.has_perm(org_id, 'integrations.calendar'));
-- writes: server actions only (service role after can('integrations.calendar'))

-- Aggregate access counter (one atomic bump per fetch; no per-request row).
create or replace function public.calendar_feed_touch(p_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.calendar_feeds set access_count = access_count + 1, last_access_at = now() where id = p_id;
$$;
revoke all on function public.calendar_feed_touch(uuid) from public, anon, authenticated;
grant execute on function public.calendar_feed_touch(uuid) to service_role;
