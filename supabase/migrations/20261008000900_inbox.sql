-- Phase 3 / 3: inbox — conversations, messages, labels, quick replies,
-- categories, saved views, mentions, round-robin picker, realtime, media bucket.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.conv_categories (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  unique (org_id, name)
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  channel_id uuid not null references public.channels (id) on delete restrict,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  status text not null default 'open' check (status in ('open', 'waiting', 'closed')),
  assignee_user_id uuid references public.profiles (id) on delete set null,
  assignee_team_id uuid references public.teams (id) on delete set null,
  bot_active boolean not null default false,
  flow_run_id uuid,                                  -- Phase 8
  last_inbound_at timestamptz,                       -- drives the 24h customer-service window
  last_outbound_at timestamptz,
  last_message_at timestamptz,
  last_message_preview text,
  last_message_direction text check (last_message_direction is null or last_message_direction in ('in', 'out', 'note')),
  unread_count integer not null default 0 check (unread_count >= 0),
  category_id uuid references public.conv_categories (id) on delete set null,
  summary text,
  ai_tags text[] not null default '{}',
  ad_referral jsonb,                                 -- CTWA referral captured on open
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One live conversation per contact per number.
create unique index conversations_live_idx on public.conversations (channel_id, contact_id) where status <> 'closed';
create index conversations_org_list_idx on public.conversations (org_id, status, last_message_at desc nulls last);
create index conversations_org_assignee_idx on public.conversations (org_id, assignee_user_id) where status <> 'closed';
create index conversations_org_team_idx on public.conversations (org_id, assignee_team_id) where status <> 'closed';
create index conversations_contact_idx on public.conversations (contact_id, last_message_at desc);
create trigger conversations_set_updated_at before update on public.conversations for each row execute function app.set_updated_at();

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  direction text not null check (direction in ('in', 'out', 'note')),
  kind text not null check (kind in (
    'text', 'image', 'video', 'audio', 'document', 'sticker', 'location', 'contacts',
    'interactive', 'button', 'reaction', 'template', 'order', 'system', 'unsupported', 'note'
  )),
  body text,                                         -- text body / caption / note text
  payload jsonb not null default '{}'::jsonb,        -- raw Meta message object (in) or send payload (out)
  media_path text,                                   -- Supabase Storage path in the wa-media bucket
  media_mime text,
  media_filename text,
  media_meta_id text,                                -- Meta media id (inbound: to fetch; outbound: after upload)
  wa_message_id text,
  reply_to_wa_message_id text,
  status text not null default 'received' check (status in ('received', 'queued', 'sending', 'sent', 'delivered', 'read', 'failed')),
  error_code integer,
  error_message text,
  sent_by_user_id uuid references public.profiles (id) on delete set null,
  flow_run_id uuid,
  campaign_recipient_id uuid,
  at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index messages_wa_message_id_idx on public.messages (wa_message_id) where wa_message_id is not null;
create index messages_conversation_at_idx on public.messages (conversation_id, at);
create index messages_org_failed_idx on public.messages (org_id, at desc) where status = 'failed';
create index messages_org_media_idx on public.messages (org_id, conversation_id) where media_path is not null;
create trigger messages_set_updated_at before update on public.messages for each row execute function app.set_updated_at();

create table public.conversation_labels (
  org_id uuid not null references public.orgs (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  tag_id uuid not null references public.tags (id) on delete cascade,
  added_at timestamptz not null default now(),
  added_by uuid references public.profiles (id) on delete set null,
  primary key (conversation_id, tag_id)
);
create index conversation_labels_org_added_idx on public.conversation_labels (org_id, added_at);

create table public.quick_replies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  shortcut text not null check (shortcut ~ '^[a-z0-9_-]{1,40}$'),
  text text not null,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, shortcut)
);
create trigger quick_replies_set_updated_at before update on public.quick_replies for each row execute function app.set_updated_at();

create table public.inbox_views (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  filter jsonb not null default '{}'::jsonb,
  shared_team_ids uuid[] not null default '{}',
  shared_all boolean not null default false,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index inbox_views_org_idx on public.inbox_views (org_id);
create trigger inbox_views_set_updated_at before update on public.inbox_views for each row execute function app.set_updated_at();

create table public.mentions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  message_id uuid not null references public.messages (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  unique (message_id, user_id)
);
create index mentions_user_unread_idx on public.mentions (user_id, created_at desc) where read_at is null;

-- ---------------------------------------------------------------------------
-- Integrity: channel / contact / category / assignee team belong to the org.
-- ---------------------------------------------------------------------------

create or replace function app.check_conversation_org()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select org_id into v_org from public.channels where id = new.channel_id;
  if v_org is distinct from new.org_id then
    raise exception 'channel % does not belong to org %', new.channel_id, new.org_id using errcode = 'check_violation';
  end if;
  select org_id into v_org from public.contacts where id = new.contact_id;
  if v_org is distinct from new.org_id then
    raise exception 'contact % does not belong to org %', new.contact_id, new.org_id using errcode = 'check_violation';
  end if;
  if new.assignee_team_id is not null then
    select org_id into v_org from public.teams where id = new.assignee_team_id;
    if v_org is distinct from new.org_id then
      raise exception 'team % does not belong to org %', new.assignee_team_id, new.org_id using errcode = 'check_violation';
    end if;
  end if;
  if new.assignee_user_id is not null and not exists (
    select 1 from public.memberships m where m.org_id = new.org_id and m.user_id = new.assignee_user_id
  ) then
    raise exception 'user % is not a member of org %', new.assignee_user_id, new.org_id using errcode = 'check_violation';
  end if;
  if new.category_id is not null then
    select org_id into v_org from public.conv_categories where id = new.category_id;
    if v_org is distinct from new.org_id then
      raise exception 'category % does not belong to org %', new.category_id, new.org_id using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
create trigger conversations_org_check before insert or update on public.conversations
  for each row execute function app.check_conversation_org();

create or replace function app.check_message_org()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select org_id into v_org from public.conversations where id = new.conversation_id;
  if v_org is distinct from new.org_id then
    raise exception 'conversation % does not belong to org %', new.conversation_id, new.org_id using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger messages_org_check before insert or update of conversation_id, org_id on public.messages
  for each row execute function app.check_message_org();
create trigger mentions_org_check before insert or update on public.mentions
  for each row execute function app.check_message_org();

create or replace function app.check_conversation_label_org()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select org_id into v_org from public.conversations where id = new.conversation_id;
  if v_org is distinct from new.org_id then
    raise exception 'conversation % does not belong to org %', new.conversation_id, new.org_id using errcode = 'check_violation';
  end if;
  select org_id into v_org from public.tags where id = new.tag_id;
  if v_org is distinct from new.org_id then
    raise exception 'tag % does not belong to org %', new.tag_id, new.org_id using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger conversation_labels_org_check before insert or update on public.conversation_labels
  for each row execute function app.check_conversation_label_org();

-- ---------------------------------------------------------------------------
-- Message status only moves forward. Mirrored in lib/whatsapp/status.ts.
--   received(0)  queued(1) sending(2) sent(3) delivered(4) read(5)  failed(9, terminal)
-- A late 'failed' after 'sent'/'delivered' is accepted (Meta can report it);
-- 'read' never regresses; nothing moves after 'failed'.
-- ---------------------------------------------------------------------------

create or replace function app.message_status_rank(p_status text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p_status
    when 'received' then 0
    when 'queued' then 1
    when 'sending' then 2
    when 'sent' then 3
    when 'delivered' then 4
    when 'read' then 5
    when 'failed' then 9
    else -1 end;
$$;

create or replace function app.guard_message_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    if old.status = 'failed' and new.status <> 'failed' then
      new.status := old.status;
    elsif app.message_status_rank(new.status) < app.message_status_rank(old.status) then
      new.status := old.status;
    elsif new.status = 'failed' and old.status = 'read' then
      new.status := old.status;
    end if;
  end if;
  return new;
end;
$$;
create trigger messages_status_forward before update of status on public.messages
  for each row execute function app.guard_message_status();

-- Apply a status webhook. Returns true when the row changed. Service role only.
create or replace function public.apply_message_status(
  p_wa_message_id text,
  p_status text,
  p_at timestamptz,
  p_error_code integer default null,
  p_error_message text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old text;
  v_new text;
  v_id uuid;
begin
  select id, status into v_id, v_old from public.messages where wa_message_id = p_wa_message_id for update;
  if v_id is null then
    return false;
  end if;
  update public.messages
  set status = p_status,
      error_code = case when p_status = 'failed' then p_error_code else error_code end,
      error_message = case when p_status = 'failed' then left(p_error_message, 500) else error_message end
  where id = v_id
  returning status into v_new;
  return v_new is distinct from v_old;
end;
$$;
revoke all on function public.apply_message_status(text, text, timestamptz, integer, text) from public, anon, authenticated;
grant execute on function public.apply_message_status(text, text, timestamptz, integer, text) to service_role;

-- ---------------------------------------------------------------------------
-- Round-robin: next online member of a team (rr_weight > 0), least recently
-- assigned first. Updates last_assigned_at atomically. Null when nobody is online.
-- ---------------------------------------------------------------------------

create or replace function public.pick_round_robin_assignee(p_org_id uuid, p_team_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  select tm.user_id into v_user
  from public.team_members tm
  join public.memberships m on m.org_id = tm.org_id and m.user_id = tm.user_id
  where tm.team_id = p_team_id
    and tm.org_id = p_org_id
    and tm.rr_weight > 0
    and m.status = 'active'
    and m.presence = 'online'
  order by tm.last_assigned_at asc nulls first, tm.rr_weight desc, tm.user_id
  limit 1
  for update of tm skip locked;
  if v_user is null then
    return null;
  end if;
  update public.team_members set last_assigned_at = now() where team_id = p_team_id and user_id = v_user;
  return v_user;
end;
$$;
revoke all on function public.pick_round_robin_assignee(uuid, uuid) from public, anon, authenticated;
grant execute on function public.pick_round_robin_assignee(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- RLS. Visibility: inbox.view_all sees every conversation in the org; other
-- members see conversations assigned to them, to one of their teams, or unassigned.
-- All inbox writes go through server actions (service role after can()).
-- ---------------------------------------------------------------------------

create or replace function app.user_team_ids(p_org_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select tm.team_id from public.team_members tm where tm.org_id = p_org_id and tm.user_id = auth.uid();
$$;

create or replace function app.can_view_conversation(p_org_id uuid, p_assignee_user_id uuid, p_assignee_team_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.is_org_member(p_org_id) and (
    app.has_perm(p_org_id, 'inbox.view_all')
    or p_assignee_user_id = auth.uid()
    or (p_assignee_team_id is not null and p_assignee_team_id in (select app.user_team_ids(p_org_id)))
    or (p_assignee_user_id is null and p_assignee_team_id is null)
  );
$$;
grant execute on function app.user_team_ids(uuid), app.can_view_conversation(uuid, uuid, uuid) to authenticated, service_role;

alter table public.conv_categories enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.conversation_labels enable row level security;
alter table public.quick_replies enable row level security;
alter table public.inbox_views enable row level security;
alter table public.mentions enable row level security;

create policy conv_categories_select on public.conv_categories for select to authenticated
  using (app.is_org_member(org_id));

create policy conversations_select on public.conversations for select to authenticated
  using (app.can_view_conversation(org_id, assignee_user_id, assignee_team_id));

create policy messages_select on public.messages for select to authenticated
  using (exists (
    select 1 from public.conversations c
    where c.id = messages.conversation_id
      and app.can_view_conversation(c.org_id, c.assignee_user_id, c.assignee_team_id)
  ));

create policy conversation_labels_select on public.conversation_labels for select to authenticated
  using (app.is_org_member(org_id));

create policy quick_replies_select on public.quick_replies for select to authenticated
  using (app.is_org_member(org_id));

create policy inbox_views_select on public.inbox_views for select to authenticated
  using (
    app.is_org_member(org_id) and (
      owner_id = auth.uid() or shared_all
      or shared_team_ids && array(select app.user_team_ids(org_id))
    )
  );

create policy mentions_select on public.mentions for select to authenticated
  using (user_id = auth.uid() and app.is_org_member(org_id));
create policy mentions_update on public.mentions for update to authenticated
  using (user_id = auth.uid() and app.is_org_member(org_id))
  with check (user_id = auth.uid() and app.is_org_member(org_id));

-- ---------------------------------------------------------------------------
-- Realtime: conversations, messages and mentions stream to the inbox (RLS applies).
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.conversations;
    alter publication supabase_realtime add table public.messages;
    alter publication supabase_realtime add table public.mentions;
  end if;
end $$;
alter table public.conversations replica identity full;
alter table public.messages replica identity full;
alter table public.mentions replica identity full;

-- ---------------------------------------------------------------------------
-- Storage: private bucket for WhatsApp media and attachments.
-- Paths: <org_id>/<conversation_id>/<message_id>.<ext>. Members read via RLS;
-- uploads happen server-side (signed upload URLs) with the service role.
-- Guarded so the migration also applies on a plain Postgres.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_tables where schemaname = 'storage' and tablename = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('wa-media', 'wa-media', false, 104857600)
    on conflict (id) do nothing;
    execute $p$
      create policy wa_media_select on storage.objects for select to authenticated
        using (bucket_id = 'wa-media' and app.is_org_member(((storage.foldername(name))[1])::uuid))
    $p$;
  end if;
end $$;

-- Inbox housekeeping (auto-close, auto-remove labels, unread alerts) runs in the
-- app so it can read org settings and send email: pg_cron pings the task route.
select cron.schedule('pulse:inbox_housekeeping', '*/5 * * * *', $$select app.ping_jobs('inbox_housekeeping')$$);
