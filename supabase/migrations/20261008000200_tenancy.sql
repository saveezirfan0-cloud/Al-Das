-- Phase 1 / 2: tenancy, users, roles, teams, invites, audit log, notifications.
-- Every tenant table carries org_id and is protected by RLS keyed on memberships.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  timezone text not null default 'Asia/Dubai',
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  first_name text not null default '',
  last_name text not null default '',
  designation text,
  avatar_path text,
  timezone text,
  language text not null default 'en',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null,
  description text,
  permissions jsonb not null default '[]'::jsonb,   -- array of permission keys, '*' = everything
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name),
  check (jsonb_typeof(permissions) = 'array')
);

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  -- references profiles (not auth.users) so the API can join memberships → profiles
  user_id uuid not null references public.profiles (id) on delete cascade,
  role_id uuid not null references public.roles (id) on delete restrict,
  status text not null default 'active' check (status in ('active', 'suspended')),
  presence text not null default 'offline' check (presence in ('online', 'away', 'offline')),
  presence_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, user_id)
);
create index memberships_user_id_idx on public.memberships (user_id);
create index memberships_org_role_idx on public.memberships (org_id, role_id);

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null,
  description text,
  round_robin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);

create table public.team_members (
  org_id uuid not null references public.orgs (id) on delete cascade,
  team_id uuid not null references public.teams (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  rr_weight integer not null default 1 check (rr_weight between 0 and 100),
  last_assigned_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (team_id, user_id)
);
create index team_members_org_user_idx on public.team_members (org_id, user_id);

create table public.invites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  email text not null,
  role_id uuid not null references public.roles (id) on delete cascade,
  team_ids uuid[] not null default '{}',
  token_hash text not null unique,                   -- sha256 of the token in the link
  invited_by uuid references auth.users (id) on delete set null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index invites_org_email_idx on public.invites (org_id, lower(email));

create table public.audit_log (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  action text not null,                              -- e.g. 'role.updated'
  entity text not null,                              -- e.g. 'role'
  entity_id text,
  diff jsonb,
  at timestamptz not null default now()
);
create index audit_log_org_at_idx on public.audit_log (org_id, at desc);
create index audit_log_entity_idx on public.audit_log (org_id, entity, entity_id);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  type text not null,                                -- e.g. 'mention', 'task.due', 'system'
  title text not null,
  body text,
  payload jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_unread_idx on public.notifications (user_id, created_at desc) where read_at is null;
create index notifications_user_idx on public.notifications (user_id, created_at desc);

-- updated_at triggers
create trigger orgs_set_updated_at before update on public.orgs for each row execute function app.set_updated_at();
create trigger profiles_set_updated_at before update on public.profiles for each row execute function app.set_updated_at();
create trigger roles_set_updated_at before update on public.roles for each row execute function app.set_updated_at();
create trigger memberships_set_updated_at before update on public.memberships for each row execute function app.set_updated_at();
create trigger teams_set_updated_at before update on public.teams for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- Profile bootstrap: every auth user gets a profile row.
-- ---------------------------------------------------------------------------

create or replace function app.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, first_name, last_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'first_name', ''),
    coalesce(new.raw_user_meta_data ->> 'last_name', '')
  )
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- RLS helpers. SECURITY DEFINER so the memberships policy does not recurse.
-- ---------------------------------------------------------------------------

create or replace function app.user_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.org_id
  from public.memberships m
  where m.user_id = auth.uid()
    and m.status = 'active';
$$;

create or replace function app.is_org_member(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = p_org_id
      and m.user_id = auth.uid()
      and m.status = 'active'
  );
$$;

-- True when the caller's role in the org grants the permission (or '*').
create or replace function app.has_perm(p_org_id uuid, p_perm text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    join public.roles r on r.id = m.role_id
    where m.org_id = p_org_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and (r.permissions ? '*' or r.permissions ? p_perm)
  );
$$;

-- True when the two users share at least one org (used for profile visibility).
create or replace function app.shares_org_with(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships mine
    join public.memberships theirs on theirs.org_id = mine.org_id
    where mine.user_id = auth.uid()
      and mine.status = 'active'
      and theirs.user_id = p_user_id
  );
$$;

grant execute on function app.user_org_ids(), app.is_org_member(uuid), app.has_perm(uuid, text), app.shares_org_with(uuid), app.current_user_id()
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS policies
-- ---------------------------------------------------------------------------

alter table public.orgs enable row level security;
alter table public.profiles enable row level security;
alter table public.roles enable row level security;
alter table public.memberships enable row level security;
alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.invites enable row level security;
alter table public.audit_log enable row level security;
alter table public.notifications enable row level security;

-- orgs: members read; settings.manage updates; creation is server-side only.
create policy orgs_select on public.orgs for select to authenticated
  using (app.is_org_member(id));
create policy orgs_update on public.orgs for update to authenticated
  using (app.has_perm(id, 'settings.manage'))
  with check (app.has_perm(id, 'settings.manage'));

-- profiles: your own, plus colleagues in a shared org.
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or app.shares_org_with(id));
create policy profiles_insert on public.profiles for insert to authenticated
  with check (id = auth.uid());
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- roles: members read; settings.manage writes (system roles are protected by trigger below).
create policy roles_select on public.roles for select to authenticated
  using (app.is_org_member(org_id));
create policy roles_insert on public.roles for insert to authenticated
  with check (app.has_perm(org_id, 'settings.manage'));
create policy roles_update on public.roles for update to authenticated
  using (app.has_perm(org_id, 'settings.manage'))
  with check (app.has_perm(org_id, 'settings.manage'));
create policy roles_delete on public.roles for delete to authenticated
  using (app.has_perm(org_id, 'settings.manage') and not is_system);

-- memberships: members read; role/status changes go through the service role
-- after can() checks (presence uses the set_presence RPC below).
create policy memberships_select on public.memberships for select to authenticated
  using (app.is_org_member(org_id));

-- teams / team_members: members read; settings.manage writes.
create policy teams_select on public.teams for select to authenticated
  using (app.is_org_member(org_id));
create policy teams_insert on public.teams for insert to authenticated
  with check (app.has_perm(org_id, 'settings.manage'));
create policy teams_update on public.teams for update to authenticated
  using (app.has_perm(org_id, 'settings.manage'))
  with check (app.has_perm(org_id, 'settings.manage'));
create policy teams_delete on public.teams for delete to authenticated
  using (app.has_perm(org_id, 'settings.manage'));

create policy team_members_select on public.team_members for select to authenticated
  using (app.is_org_member(org_id));
create policy team_members_insert on public.team_members for insert to authenticated
  with check (app.has_perm(org_id, 'settings.manage'));
create policy team_members_update on public.team_members for update to authenticated
  using (app.has_perm(org_id, 'settings.manage'))
  with check (app.has_perm(org_id, 'settings.manage'));
create policy team_members_delete on public.team_members for delete to authenticated
  using (app.has_perm(org_id, 'settings.manage'));

-- invites: only settings.manage can see them; the accept flow is server-side.
create policy invites_select on public.invites for select to authenticated
  using (app.has_perm(org_id, 'settings.manage'));

-- audit_log: settings.manage can read; writes are server-side only.
create policy audit_log_select on public.audit_log for select to authenticated
  using (app.has_perm(org_id, 'settings.manage'));

-- notifications: your own, within orgs you belong to.
create policy notifications_select on public.notifications for select to authenticated
  using (user_id = auth.uid() and app.is_org_member(org_id));
create policy notifications_update on public.notifications for update to authenticated
  using (user_id = auth.uid() and app.is_org_member(org_id))
  with check (user_id = auth.uid() and app.is_org_member(org_id));
create policy notifications_delete on public.notifications for delete to authenticated
  using (user_id = auth.uid() and app.is_org_member(org_id));

-- ---------------------------------------------------------------------------
-- Integrity guards
-- ---------------------------------------------------------------------------

-- A membership's role must belong to the same org.
create or replace function app.check_membership_role_org()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_role_org uuid;
begin
  select org_id into v_role_org from public.roles where id = new.role_id;
  if v_role_org is distinct from new.org_id then
    raise exception 'role % does not belong to org %', new.role_id, new.org_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger memberships_role_org_check
  before insert or update of role_id, org_id on public.memberships
  for each row execute function app.check_membership_role_org();

-- Same for invites.
create trigger invites_role_org_check
  before insert or update of role_id, org_id on public.invites
  for each row execute function app.check_membership_role_org();

-- A team member must belong to the team's org, and the team must be in org_id.
create or replace function app.check_team_member_org()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_team_org uuid;
begin
  select org_id into v_team_org from public.teams where id = new.team_id;
  if v_team_org is distinct from new.org_id then
    raise exception 'team % does not belong to org %', new.team_id, new.org_id
      using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from public.memberships m where m.org_id = new.org_id and m.user_id = new.user_id
  ) then
    raise exception 'user % is not a member of org %', new.user_id, new.org_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger team_members_org_check
  before insert or update on public.team_members
  for each row execute function app.check_team_member_org();

-- System roles keep their name and cannot be deleted.
create or replace function app.protect_system_roles()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.is_system then
      raise exception 'system role % cannot be deleted', old.name using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if old.is_system and (new.name <> old.name or new.is_system = false) then
    raise exception 'system role % cannot be renamed', old.name using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger roles_protect_system
  before update or delete on public.roles
  for each row execute function app.protect_system_roles();

-- ---------------------------------------------------------------------------
-- RPCs (public schema so supabase-js can call them)
-- ---------------------------------------------------------------------------

-- Presence is the only membership field a user may change themselves.
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
  update public.memberships
  set presence = p_presence, presence_at = now()
  where org_id = p_org_id and user_id = auth.uid() and status = 'active';
end;
$$;
revoke all on function public.set_presence(uuid, text) from public;
grant execute on function public.set_presence(uuid, text) to authenticated, service_role;

-- Mark all of the caller's notifications in an org as read.
create or replace function public.mark_all_notifications_read(p_org_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.notifications
  set read_at = now()
  where org_id = p_org_id and user_id = auth.uid() and read_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.mark_all_notifications_read(uuid) from public;
grant execute on function public.mark_all_notifications_read(uuid) to authenticated, service_role;

-- Creates an org, seeds its roles from the given catalogue and makes p_owner_id
-- the Admin. Transactional. Service role only: the app decides who may create
-- workspaces (ALLOW_WORKSPACE_CREATION) and passes the owner explicitly.
-- p_roles: [{"name":"Admin","description":"...","permissions":["*"]}, ...]
create or replace function public.create_org(
  p_name text,
  p_slug text,
  p_roles jsonb,
  p_owner_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := coalesce(p_owner_id, auth.uid());
  v_org uuid;
  v_admin_role uuid;
  r jsonb;
begin
  if v_owner is null then
    raise exception 'no owner for new org' using errcode = 'insufficient_privilege';
  end if;
  if auth.uid() is not null and p_owner_id is not null and p_owner_id <> auth.uid() then
    raise exception 'cannot create an org for another user' using errcode = 'insufficient_privilege';
  end if;
  if jsonb_typeof(p_roles) <> 'array' or jsonb_array_length(p_roles) = 0 then
    raise exception 'p_roles must be a non-empty array' using errcode = 'check_violation';
  end if;

  insert into public.orgs (name, slug) values (p_name, p_slug) returning id into v_org;

  for r in select * from jsonb_array_elements(p_roles) loop
    insert into public.roles (org_id, name, description, permissions, is_system)
    values (v_org, r ->> 'name', r ->> 'description', coalesce(r -> 'permissions', '[]'::jsonb), true);
  end loop;

  select id into v_admin_role from public.roles where org_id = v_org and permissions ? '*' order by created_at limit 1;
  if v_admin_role is null then
    raise exception 'role catalogue must include a role with the * permission' using errcode = 'check_violation';
  end if;

  insert into public.memberships (org_id, user_id, role_id, status) values (v_org, v_owner, v_admin_role, 'active');

  insert into public.audit_log (org_id, user_id, action, entity, entity_id, diff)
  values (v_org, v_owner, 'org.created', 'org', v_org::text, jsonb_build_object('name', p_name, 'slug', p_slug));

  return v_org;
end;
$$;
revoke all on function public.create_org(text, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.create_org(text, text, jsonb, uuid) to service_role;
