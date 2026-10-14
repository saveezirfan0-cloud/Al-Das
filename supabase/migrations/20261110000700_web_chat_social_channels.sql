-- Phase 20e (G12): website chat widget, Instagram and Messenger as inbox channels.
--
-- 1. channels.type gains 'web', 'instagram' and 'messenger'. A non-WhatsApp channel has no WhatsApp Business Account
--    (waba_id = '') and its phone_number_id is a namespaced reference ('web:<org id>', 'instagram:<account id>',
--    'messenger:<page id>'), so it can never collide with a Meta phone number id and every WhatsApp lookup by
--    phone_number_id / waba_id keeps finding only WhatsApp numbers. WhatsApp-only screens and jobs filter type = 'whatsapp'.
-- 2. contact_channel_identities: the platform-scoped user id (Instagram IGSID / Messenger PSID) of a contact on one
--    channel. Never stored in contacts.phone_e164 or wa_bsuid. Org-scoped select policy (same audience as contacts);
--    written only by server code through channel_receive_social().
-- 3. web_chat_sessions: one row per website visitor who sent a message. The visitor's browser keeps a random 256-bit
--    token in localStorage (no cookie); only its SHA-256 is stored. Service-only (no policies): the widget routes run
--    as the service role after the origin, switch and rate-limit checks.
-- 4. web_chat_receive() / channel_receive_social(): the inbound path (contact -> conversation -> message) in one
--    transaction under an advisory lock, idempotent on the message id. Service role only.
-- 5. Erasure and merges follow the patient through triggers on contacts (like contacts_erase_phase20).
-- 6. Housekeeping: idle widget sessions are removed after 90 days (the contact and conversation stay).

-- ---------------------------------------------------------------------------
-- 1. Channel types
-- ---------------------------------------------------------------------------
alter table public.channels drop constraint if exists channels_type_check;
alter table public.channels add constraint channels_type_check
  check (type in ('whatsapp', 'web', 'instagram', 'messenger'));
alter table public.channels add constraint channels_non_whatsapp_ref_check
  check (type = 'whatsapp' or (waba_id = '' and phone_number_id like type || ':%'));

-- ---------------------------------------------------------------------------
-- 2. Platform-scoped user ids (Instagram, Messenger)
-- ---------------------------------------------------------------------------
create table public.contact_channel_identities (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  channel_id uuid not null references public.channels (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  platform text not null check (platform in ('instagram', 'messenger')),
  external_id text not null check (external_id ~ '^[0-9]{1,40}$'),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (channel_id, external_id)
);
create index contact_channel_identities_contact_idx on public.contact_channel_identities (contact_id);
create index contact_channel_identities_org_idx on public.contact_channel_identities (org_id, created_at);

create trigger contact_channel_identities_channel_org_check before insert or update on public.contact_channel_identities
  for each row execute function app.check_parent_org('channels', 'channel_id');
create trigger contact_channel_identities_contact_org_check before insert or update on public.contact_channel_identities
  for each row execute function app.check_parent_org('contacts', 'contact_id');

alter table public.contact_channel_identities enable row level security;
create policy contact_channel_identities_select on public.contact_channel_identities for select to authenticated
  using (app.is_org_member(org_id) and (app.has_perm(org_id, 'contacts.view') or app.has_perm(org_id, 'inbox.send') or app.has_perm(org_id, 'inbox.view_all')));
-- Writes: server code only (channel_receive_social, the merge and erase triggers).

-- ---------------------------------------------------------------------------
-- 3. Website chat sessions (service role only)
-- ---------------------------------------------------------------------------
create table public.web_chat_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  channel_id uuid not null references public.channels (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete set null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index web_chat_sessions_contact_idx on public.web_chat_sessions (contact_id);
create index web_chat_sessions_seen_idx on public.web_chat_sessions (last_seen_at);

create trigger web_chat_sessions_channel_org_check before insert or update on public.web_chat_sessions
  for each row execute function app.check_parent_org('channels', 'channel_id');
create trigger web_chat_sessions_contact_org_check before insert or update on public.web_chat_sessions
  for each row execute function app.check_parent_org('contacts', 'contact_id');

alter table public.web_chat_sessions enable row level security;
-- no API policies: service role only

-- ---------------------------------------------------------------------------
-- 4. Inbound path
-- ---------------------------------------------------------------------------

-- Appends one inbound message to the contact's live conversation on the channel (opening one when there is none).
-- Idempotent on p_wa_id (messages.wa_message_id is unique). Callers hold an advisory lock for the sender.
create or replace function app.channel_append_inbound(
  p_org uuid, p_channel uuid, p_contact uuid, p_wa_id text, p_kind text, p_body text, p_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conv public.conversations;
  v_msg uuid;
  v_opened boolean := false;
  v_preview text;
begin
  select id into v_msg from public.messages where wa_message_id = p_wa_id;
  if found then
    return jsonb_build_object('duplicate', true, 'message_id', v_msg);
  end if;

  select * into v_conv from public.conversations
   where channel_id = p_channel and contact_id = p_contact and status <> 'closed';
  if not found then
    begin
      insert into public.conversations (org_id, channel_id, contact_id, status, opened_at)
      values (p_org, p_channel, p_contact, 'open', p_at)
      returning * into v_conv;
      v_opened := true;
    exception when unique_violation then
      select * into v_conv from public.conversations
       where channel_id = p_channel and contact_id = p_contact and status <> 'closed';
    end;
  end if;

  insert into public.messages (org_id, conversation_id, direction, kind, body, payload, wa_message_id, status, at)
  values (p_org, v_conv.id, 'in', p_kind, p_body, '{}'::jsonb, p_wa_id, 'received', p_at)
  returning id into v_msg;

  v_preview := case when p_kind = 'text' then left(coalesce(p_body, ''), 200) else 'Attachment' end;
  update public.conversations
     set last_inbound_at = greatest(coalesce(last_inbound_at, p_at), p_at),
         last_message_at = greatest(coalesce(last_message_at, p_at), p_at),
         last_message_preview = case when last_message_at is null or last_message_at <= p_at then v_preview else last_message_preview end,
         last_message_direction = case when last_message_at is null or last_message_at <= p_at then 'in' else last_message_direction end,
         status = 'open', closed_at = null, closed_by = null,
         unread_count = unread_count + 1
   where id = v_conv.id;
  update public.contacts set last_interaction_at = greatest(coalesce(last_interaction_at, p_at), p_at) where id = p_contact;

  return jsonb_build_object(
    'duplicate', false, 'message_id', v_msg, 'conversation_id', v_conv.id, 'opened', v_opened,
    'unread_before', case when v_opened then 0 else v_conv.unread_count end,
    'assignee_user_id', v_conv.assignee_user_id, 'escalation_level', v_conv.escalation_level
  );
end;
$$;
revoke all on function app.channel_append_inbound(uuid, uuid, uuid, text, text, text, timestamptz) from public, anon, authenticated;

-- A website visitor's message. With p_create (the browser had no session yet) a new contact (source 'web_chat', no
-- phone) and session are created; otherwise the session must exist on this channel. Returns {error} for an unknown,
-- foreign or orphaned session so the route can tell the widget to start again.
create or replace function public.web_chat_receive(
  p_org uuid, p_channel uuid, p_token_hash text, p_create boolean, p_name text, p_client_id text,
  p_body text, p_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.web_chat_sessions;
  v_contact uuid;
  v_created boolean := false;
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  r jsonb;
begin
  if p_token_hash !~ '^[0-9a-f]{64}$' or p_client_id !~ '^[A-Za-z0-9_-]{8,64}$' then
    raise exception 'invalid web chat request' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.channels where id = p_channel and org_id = p_org and type = 'web' and status = 'active') then
    return jsonb_build_object('error', 'channel');
  end if;
  perform pg_advisory_xact_lock(hashtext('webchat:' || p_token_hash));

  select * into v_session from public.web_chat_sessions where token_hash = p_token_hash;
  if found then
    if v_session.org_id <> p_org or v_session.channel_id <> p_channel then
      return jsonb_build_object('error', 'session');
    end if;
    v_contact := v_session.contact_id;
    if exists (select 1 from public.contacts where id = v_contact and (deleted_at is not null or erased_at is not null)) then
      return jsonb_build_object('error', 'session');
    end if;
  elsif p_create then
    insert into public.contacts (org_id, first_name, last_name, source)
    values (p_org, coalesce(left(v_name, 60), 'Website'), case when v_name is null then 'visitor' else '' end, 'web_chat')
    returning id into v_contact;
    insert into public.web_chat_sessions (org_id, channel_id, contact_id, token_hash, created_at, last_seen_at)
    values (p_org, p_channel, v_contact, p_token_hash, p_at, p_at)
    returning * into v_session;
    v_created := true;
  else
    return jsonb_build_object('error', 'session');
  end if;

  r := app.channel_append_inbound(
    p_org, p_channel, v_contact, 'web:' || v_session.id::text || ':' || p_client_id, 'text', left(p_body, 2000), p_at
  );
  update public.web_chat_sessions
     set last_seen_at = greatest(last_seen_at, p_at),
         conversation_id = coalesce((r ->> 'conversation_id')::uuid, conversation_id)
   where id = v_session.id;
  return r || jsonb_build_object('contact_id', v_contact, 'session_id', v_session.id, 'created_contact', v_created);
end;
$$;
revoke all on function public.web_chat_receive(uuid, uuid, text, boolean, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.web_chat_receive(uuid, uuid, text, boolean, text, text, text, timestamptz) to service_role;

-- An Instagram or Messenger message. The sender is matched by the platform-scoped id on this channel only; a new
-- sender becomes a contact without a phone (source 'instagram' / 'messenger'). A sender whose contact was deleted
-- (not merged) gets a fresh contact.
create or replace function public.channel_receive_social(
  p_org uuid, p_channel uuid, p_platform text, p_external_id text, p_message_id text, p_kind text, p_body text,
  p_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ident public.contact_channel_identities;
  v_contact uuid;
  v_created boolean := false;
  r jsonb;
begin
  if p_platform not in ('instagram', 'messenger') or p_external_id !~ '^[0-9]{1,40}$'
     or coalesce(p_message_id, '') = '' or length(p_message_id) > 300 or p_kind not in ('text', 'unsupported') then
    raise exception 'invalid social message' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.channels where id = p_channel and org_id = p_org and type = p_platform) then
    return jsonb_build_object('error', 'channel');
  end if;
  perform pg_advisory_xact_lock(hashtext('social:' || p_channel::text || ':' || p_external_id));

  select * into v_ident from public.contact_channel_identities where channel_id = p_channel and external_id = p_external_id;
  if found then
    select c.id into v_contact from public.contacts c
     where c.id = v_ident.contact_id and c.deleted_at is null and c.erased_at is null;
  end if;
  if v_contact is null then
    insert into public.contacts (org_id, first_name, last_name, source)
    values (p_org, case p_platform when 'instagram' then 'Instagram' else 'Messenger' end, 'user', p_platform)
    returning id into v_contact;
    v_created := true;
    insert into public.contact_channel_identities (org_id, channel_id, contact_id, platform, external_id, created_at, last_seen_at)
    values (p_org, p_channel, v_contact, p_platform, p_external_id, p_at, p_at)
    on conflict (channel_id, external_id) do update set contact_id = excluded.contact_id, last_seen_at = excluded.last_seen_at;
  else
    update public.contact_channel_identities set last_seen_at = greatest(last_seen_at, p_at) where id = v_ident.id;
  end if;

  r := app.channel_append_inbound(
    p_org, p_channel, v_contact, case p_platform when 'instagram' then 'ig:' else 'fb:' end || p_message_id,
    p_kind, left(p_body, 4000), p_at
  );
  return r || jsonb_build_object('contact_id', v_contact, 'created_contact', v_created);
end;
$$;
revoke all on function public.channel_receive_social(uuid, uuid, text, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.channel_receive_social(uuid, uuid, text, text, text, text, text, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Erasure and merges
-- ---------------------------------------------------------------------------
create or replace function app.erase_contact_phase20e()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.contact_channel_identities where org_id = new.org_id and contact_id = new.id;
  delete from public.web_chat_sessions where org_id = new.org_id and contact_id = new.id;
  return new;
end;
$$;
create trigger contacts_erase_phase20e after update of erased_at on public.contacts
  for each row when (old.erased_at is null and new.erased_at is not null)
  execute function app.erase_contact_phase20e();

create or replace function app.move_channel_identities_on_merge()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.merged_into_id is not null and new.merged_into_id is distinct from old.merged_into_id then
    update public.contact_channel_identities set contact_id = new.merged_into_id
     where org_id = new.org_id and contact_id = new.id;
    update public.web_chat_sessions set contact_id = new.merged_into_id
     where org_id = new.org_id and contact_id = new.id;
  end if;
  return new;
end;
$$;
create trigger contacts_move_channel_identities_on_merge after update of merged_into_id on public.contacts
  for each row execute function app.move_channel_identities_on_merge();

-- ---------------------------------------------------------------------------
-- 6. Housekeeping
-- ---------------------------------------------------------------------------
select cron.schedule('pulse:housekeeping_20e_channels', '35 3 * * *', $$
  delete from public.web_chat_sessions where last_seen_at < now() - interval '90 days';
$$);
