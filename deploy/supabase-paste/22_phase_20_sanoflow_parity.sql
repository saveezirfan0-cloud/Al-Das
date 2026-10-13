-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Phase 20 (Sanoflow parity, docs/20 to docs/27). Needs every earlier file first, including 19b_phase_19b_integrations.sql and
-- 21_finance_insurance_overview.sql. Check the project name in the Supabase header first: this is for the Pulse project only.
-- 20a: Sanoflow import support (appointments.source 'import', reconcile refs), enquiry tags and the campaign history archive.
-- 20b: flow parity (new triggers, drip on segments, window-closing jobs). 20c: routing (fallback team, open-chat limits, office hours,
-- auto-reply, idle auto-away, restricted enquiry view, assignment and presence logs, reports) and booking capacity (buffers,
-- group places, slot length, weekly blocks). 20d: template delivery settings, retries and performance, recurring campaigns and the
-- monthly budget. 20e: website chat, Instagram and Messenger channels and Google Calendar busy sync. Integration: enquiry tags follow
-- the restricted enquiry view. Everything new is OFF or behaves as before until someone changes a setting.
-- Nothing here calls Unite, WhatsApp, Meta or Google. The migration-history lines are at the bottom of this file.

-- ======================================================================
-- 20261023000100_sanoflow_import.sql
-- ======================================================================
-- Phase 20a: Sanoflow migration completeness.
--
-- 1. Future appointments brought over from Sanoflow are booked through public.book_appointment (advisory
--    lock + overlap check) with source 'import', so reports, the Unite diff and the appointments list can
--    tell them from portal bookings. Their Sanoflow id lives in external_refs (source 'sanoflow').
-- 2. reconcile_snapshot also counts Sanoflow/Airtable refs whose local row is gone (enquiries, appointments,
--    segments, timeline entries, settings lists). A static-segment membership ref points at its segment.
--    Counts only.

alter table public.appointments drop constraint if exists appointments_source_check;
alter table public.appointments
  add constraint appointments_source_check check (source in ('portal', 'unite', 'bot', 'import'));

create or replace function public.reconcile_snapshot(p_org_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'refs', coalesce((
      select jsonb_object_agg(source || '/' || entity, n)
      from (select source, entity, count(*) as n from public.external_refs where org_id = p_org_id group by source, entity) r
    ), '{}'::jsonb),
    'reviews_open', coalesce((
      select jsonb_object_agg(source || '/' || entity, n)
      from (select source, entity, count(*) as n from public.sync_reviews where org_id = p_org_id and status = 'open' group by source, entity) r
    ), '{}'::jsonb),
    'reviews_dismissed', coalesce((
      select jsonb_object_agg(source || '/' || entity, n)
      from (select source, entity, count(*) as n from public.sync_reviews where org_id = p_org_id and status = 'dismissed' group by source, entity) r
    ), '{}'::jsonb),
    'reviews_resolved', coalesce((
      select jsonb_object_agg(source || '/' || entity, n)
      from (select source, entity, count(*) as n from public.sync_reviews where org_id = p_org_id and status = 'resolved' group by source, entity) r
    ), '{}'::jsonb),
    'orphan_refs', (
      select count(*) from public.external_refs r
      where r.org_id = p_org_id and r.local_table = 'contacts'
        and not exists (select 1 from public.contacts c where c.id = r.local_id)
    ),
    'orphan_refs_other', (
      select count(*) from public.external_refs r
      where r.org_id = p_org_id
        and r.local_table in ('enquiries', 'appointments', 'segments', 'pipelines', 'stages',
                              'tags', 'conv_categories', 'quick_replies', 'timeline_events')
        and case r.local_table
          when 'enquiries' then not exists (select 1 from public.enquiries x where x.id = r.local_id)
          when 'appointments' then not exists (select 1 from public.appointments x where x.id = r.local_id)
          when 'segments' then not exists (select 1 from public.segments x where x.id = r.local_id)
          when 'pipelines' then not exists (select 1 from public.pipelines x where x.id = r.local_id)
          when 'stages' then not exists (select 1 from public.stages x where x.id = r.local_id)
          when 'tags' then not exists (select 1 from public.tags x where x.id = r.local_id)
          when 'conv_categories' then not exists (select 1 from public.conv_categories x where x.id = r.local_id)
          when 'quick_replies' then not exists (select 1 from public.quick_replies x where x.id = r.local_id)
          when 'timeline_events' then not exists (select 1 from public.timeline_events x where x.id = r.local_id)
          else false
        end
    ),
    'refs_to_deleted_contacts', (
      select count(*) from public.external_refs r
      join public.contacts c on c.id = r.local_id
      where r.org_id = p_org_id and r.local_table = 'contacts'
        and c.deleted_at is not null and c.merged_into_id is null
    ),
    'contacts_live', (select count(*) from public.contacts where org_id = p_org_id and deleted_at is null),
    'contacts_imported', (
      select count(*) from public.contacts
      where org_id = p_org_id and deleted_at is null and source in ('import_airtable', 'import_sanoflow', 'import_csv')
    ),
    'contacts_without_identifier', (
      select count(*) from public.contacts
      where org_id = p_org_id and deleted_at is null
        and phone_e164 is null and wa_bsuid is null and external_id is null
    ),
    'duplicate_alternate_phones', (
      select count(*) from (
        select cp.phone_e164
        from public.contact_phones cp
        join public.contacts c on c.id = cp.contact_id and c.deleted_at is null
        where cp.org_id = p_org_id
        group by cp.phone_e164
        having count(distinct cp.contact_id) > 1
      ) d
    ),
    'alternate_phone_is_other_primary', (
      select count(*) from public.contact_phones cp
      join public.contacts c on c.id = cp.contact_id and c.deleted_at is null
      join public.contacts o on o.org_id = cp.org_id and o.phone_e164 = cp.phone_e164
        and o.deleted_at is null and o.id <> cp.contact_id
      where cp.org_id = p_org_id
    ),
    'merge_chains_over_1', (
      select count(*) from public.contacts c
      join public.contacts m on m.id = c.merged_into_id
      where c.org_id = p_org_id and m.merged_into_id is not null
    )
  );
$$;

revoke all on function public.reconcile_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.reconcile_snapshot(uuid) to service_role;

-- ======================================================================
-- 20261023000200_enquiry_tags_campaign_archive.sql
-- ======================================================================
-- Phase 20a follow-ups (docs/22):
--
-- 1. Enquiry tags. Tags with scope 'enquiry' (public.tags already allows it) are attached to enquiries
--    through enquiry_tags. Read with enquiries.view, changed with enquiries.manage; the tag must be an
--    enquiry tag of the same organisation.
-- 2. Campaign history from Sanoflow. Past campaigns cannot become rows of public.campaigns (those need a
--    Pulse template and channel, and the send engine acts on them), so they land in a read-only archive:
--    campaign_archive (one row per Sanoflow campaign, with totals) and campaign_archive_recipients (status
--    and times per patient). No message text, no phone numbers. Read with campaigns.view; written only by
--    the import (service role).
-- 3. Erasure and merges: when a contact is erased (erased_at set by public.erase_contact), their archived campaign
--    rows and their enquiries' tags go too; when two records are merged, archived campaign rows follow the
--    survivor. Triggers, so they keep working when erase_contact / merge_contacts are replaced.
-- 4. reconcile_snapshot counts orphan refs to the new tables as well.

-- ---------------------------------------------------------------------------
-- 1. Enquiry tags
-- ---------------------------------------------------------------------------
create table public.enquiry_tags (
  org_id uuid not null references public.orgs (id) on delete cascade,
  enquiry_id uuid not null references public.enquiries (id) on delete cascade,
  tag_id uuid not null references public.tags (id) on delete cascade,
  added_by uuid references public.profiles (id) on delete set null,
  added_at timestamptz not null default now(),
  primary key (enquiry_id, tag_id)
);
create index enquiry_tags_tag_idx on public.enquiry_tags (tag_id, enquiry_id);

create trigger enquiry_tags_enquiry_org_check before insert or update on public.enquiry_tags
  for each row execute function app.check_parent_org('enquiries', 'enquiry_id');
create trigger enquiry_tags_tag_org_check before insert or update on public.enquiry_tags
  for each row execute function app.check_parent_org('tags', 'tag_id');

create or replace function app.enquiry_tags_scope_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- a missing tag is the NOT NULL constraint's job (and row security answers first for another org)
  if new.tag_id is null then
    return new;
  end if;
  if not exists (select 1 from public.tags t where t.id = new.tag_id and t.scope = 'enquiry') then
    raise exception 'tag % is not an enquiry tag', new.tag_id using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger enquiry_tags_scope_check before insert or update of tag_id on public.enquiry_tags
  for each row execute function app.enquiry_tags_scope_check();

alter table public.enquiry_tags enable row level security;
create policy enquiry_tags_select on public.enquiry_tags for select to authenticated
  using (app.has_perm(org_id, 'enquiries.view'));
create policy enquiry_tags_insert on public.enquiry_tags for insert to authenticated
  with check (app.has_perm(org_id, 'enquiries.manage'));
create policy enquiry_tags_delete on public.enquiry_tags for delete to authenticated
  using (app.has_perm(org_id, 'enquiries.manage'));

-- ---------------------------------------------------------------------------
-- 2. Campaign history archive (Sanoflow)
-- ---------------------------------------------------------------------------
create table public.campaign_archive (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  source text not null default 'sanoflow' check (source in ('sanoflow')),
  name text not null check (char_length(name) between 1 and 200),
  template_name text check (template_name is null or char_length(template_name) <= 200),
  sent_at timestamptz,
  -- {"recipients": n, "sent": n, "delivered": n, "read": n, "replied": n, "failed": n, "other": n}
  totals jsonb not null default '{}'::jsonb check (jsonb_typeof(totals) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index campaign_archive_org_sent_idx on public.campaign_archive (org_id, sent_at desc);
create trigger campaign_archive_set_updated_at before update on public.campaign_archive
  for each row execute function app.set_updated_at();

create table public.campaign_archive_recipients (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  archive_id uuid not null references public.campaign_archive (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  status text not null check (status in ('sent', 'delivered', 'read', 'replied', 'failed', 'other')),
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  replied_at timestamptz,
  failed_at timestamptz,
  error_code integer,
  created_at timestamptz not null default now(),
  unique (archive_id, contact_id)
);
create index campaign_archive_recipients_contact_idx on public.campaign_archive_recipients (contact_id);
create trigger campaign_archive_recipients_archive_org_check before insert or update on public.campaign_archive_recipients
  for each row execute function app.check_parent_org('campaign_archive', 'archive_id');
create trigger campaign_archive_recipients_contact_org_check before insert or update on public.campaign_archive_recipients
  for each row execute function app.check_parent_org('contacts', 'contact_id');

alter table public.campaign_archive enable row level security;
alter table public.campaign_archive_recipients enable row level security;
-- Read-only for staff; the Sanoflow import writes with the service role.
create policy campaign_archive_select on public.campaign_archive for select to authenticated
  using (app.has_perm(org_id, 'campaigns.view'));
create policy campaign_archive_recipients_select on public.campaign_archive_recipients for select to authenticated
  using (app.has_perm(org_id, 'campaigns.view'));

-- ---------------------------------------------------------------------------
-- 3. Erasure
-- ---------------------------------------------------------------------------
create or replace function app.erase_contact_phase20()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.campaign_archive_recipients where org_id = new.org_id and contact_id = new.id;
  delete from public.enquiry_tags et
   using public.enquiries e
   where e.id = et.enquiry_id and e.org_id = new.org_id and e.contact_id = new.id;
  return new;
end;
$$;
create trigger contacts_erase_phase20 after update of erased_at on public.contacts
  for each row when (old.erased_at is null and new.erased_at is not null)
  execute function app.erase_contact_phase20();

-- A merge moves the archived campaign rows to the surviving record (a trigger, like patient documents, so a
-- later rewrite of merge_contacts cannot forget it). Where both records got the same campaign, the
-- survivor's row stays and the duplicate goes.
create or replace function app.move_campaign_archive_on_merge()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.merged_into_id is not null and new.merged_into_id is distinct from old.merged_into_id then
    delete from public.campaign_archive_recipients d
     where d.org_id = new.org_id and d.contact_id = new.id
       and exists (select 1 from public.campaign_archive_recipients k
                    where k.archive_id = d.archive_id and k.contact_id = new.merged_into_id);
    update public.campaign_archive_recipients set contact_id = new.merged_into_id
     where org_id = new.org_id and contact_id = new.id;
  end if;
  return new;
end;
$$;
create trigger contacts_move_campaign_archive_on_merge after update of merged_into_id on public.contacts
  for each row execute function app.move_campaign_archive_on_merge();

-- ---------------------------------------------------------------------------
-- 4. reconcile_snapshot: orphan refs to the new tables
-- ---------------------------------------------------------------------------
create or replace function public.reconcile_snapshot(p_org_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'refs', coalesce((
      select jsonb_object_agg(source || '/' || entity, n)
      from (select source, entity, count(*) as n from public.external_refs where org_id = p_org_id group by source, entity) r
    ), '{}'::jsonb),
    'reviews_open', coalesce((
      select jsonb_object_agg(source || '/' || entity, n)
      from (select source, entity, count(*) as n from public.sync_reviews where org_id = p_org_id and status = 'open' group by source, entity) r
    ), '{}'::jsonb),
    'reviews_dismissed', coalesce((
      select jsonb_object_agg(source || '/' || entity, n)
      from (select source, entity, count(*) as n from public.sync_reviews where org_id = p_org_id and status = 'dismissed' group by source, entity) r
    ), '{}'::jsonb),
    'reviews_resolved', coalesce((
      select jsonb_object_agg(source || '/' || entity, n)
      from (select source, entity, count(*) as n from public.sync_reviews where org_id = p_org_id and status = 'resolved' group by source, entity) r
    ), '{}'::jsonb),
    'orphan_refs', (
      select count(*) from public.external_refs r
      where r.org_id = p_org_id and r.local_table = 'contacts'
        and not exists (select 1 from public.contacts c where c.id = r.local_id)
    ),
    'orphan_refs_other', (
      select count(*) from public.external_refs r
      where r.org_id = p_org_id
        and r.local_table in ('enquiries', 'appointments', 'segments', 'pipelines', 'stages', 'tags',
                              'conv_categories', 'quick_replies', 'timeline_events', 'campaign_archive',
                              'campaign_archive_recipients')
        and case r.local_table
          when 'enquiries' then not exists (select 1 from public.enquiries x where x.id = r.local_id)
          when 'appointments' then not exists (select 1 from public.appointments x where x.id = r.local_id)
          when 'segments' then not exists (select 1 from public.segments x where x.id = r.local_id)
          when 'pipelines' then not exists (select 1 from public.pipelines x where x.id = r.local_id)
          when 'stages' then not exists (select 1 from public.stages x where x.id = r.local_id)
          when 'tags' then not exists (select 1 from public.tags x where x.id = r.local_id)
          when 'conv_categories' then not exists (select 1 from public.conv_categories x where x.id = r.local_id)
          when 'quick_replies' then not exists (select 1 from public.quick_replies x where x.id = r.local_id)
          when 'timeline_events' then not exists (select 1 from public.timeline_events x where x.id = r.local_id)
          when 'campaign_archive' then not exists (select 1 from public.campaign_archive x where x.id = r.local_id)
          when 'campaign_archive_recipients' then not exists (select 1 from public.campaign_archive_recipients x where x.id = r.local_id)
          else false
        end
    ),
    'refs_to_deleted_contacts', (
      select count(*) from public.external_refs r
      join public.contacts c on c.id = r.local_id
      where r.org_id = p_org_id and r.local_table = 'contacts'
        and c.deleted_at is not null and c.merged_into_id is null
    ),
    'contacts_live', (select count(*) from public.contacts where org_id = p_org_id and deleted_at is null),
    'contacts_imported', (
      select count(*) from public.contacts
      where org_id = p_org_id and deleted_at is null and source in ('import_airtable', 'import_sanoflow', 'import_csv')
    ),
    'contacts_without_identifier', (
      select count(*) from public.contacts
      where org_id = p_org_id and deleted_at is null
        and phone_e164 is null and wa_bsuid is null and external_id is null
    ),
    'duplicate_alternate_phones', (
      select count(*) from (
        select cp.phone_e164
        from public.contact_phones cp
        join public.contacts c on c.id = cp.contact_id and c.deleted_at is null
        where cp.org_id = p_org_id
        group by cp.phone_e164
        having count(distinct cp.contact_id) > 1
      ) d
    ),
    'alternate_phone_is_other_primary', (
      select count(*) from public.contact_phones cp
      join public.contacts c on c.id = cp.contact_id and c.deleted_at is null
      join public.contacts o on o.org_id = cp.org_id and o.phone_e164 = cp.phone_e164
        and o.deleted_at is null and o.id <> cp.contact_id
      where cp.org_id = p_org_id
    ),
    'merge_chains_over_1', (
      select count(*) from public.contacts c
      join public.contacts m on m.id = c.merged_into_id
      where c.org_id = p_org_id and m.merged_into_id is not null
    )
  );
$$;

revoke all on function public.reconcile_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.reconcile_snapshot(uuid) to service_role;

-- ======================================================================
-- 20261024000100_flow_parity.sql
-- ======================================================================
-- Phase 20b: flow parity (docs/23_PHASE_20B_NOTES.md).
--
-- 1. Four new flow triggers: message_received, window_closing, wa_flow_completed, segment_joined (drip).
-- 2. Segment drip: when contacts are added to a STATIC segment whose drip flow (segments.drip_flow_id, unused until now) is an
--    active segment_joined flow, one durable scheduled job per new member ('flow.drip', routed to the flow_steps queue). The
--    job handler re-checks everything at fire time (still a member, drip unchanged, flow still active), so this trigger only
--    has to be cheap and correct. Dynamic segments keep using the Recurring trigger. Existing members are never back-filled.
-- No new tables. New node types live in the graph JSON (validated in lib/flow-engine), so they need no schema change.

alter table public.flows drop constraint if exists flows_trigger_type_check;
alter table public.flows add constraint flows_trigger_type_check check (trigger_type in (
  'conversation_opened', 'conversation_closed', 'conversation_waiting', 'template_button',
  'shortcut', 'enquiry_added', 'enquiry_stage_updated', 'enquiry_status_updated',
  'webhook', 'recurring', 'appointment_created', 'appointment_updated', 'appointment_status_changed',
  'conversation_ai_tagged',
  'message_received', 'window_closing', 'wa_flow_completed', 'segment_joined'));

-- Statement-level so a bulk add of thousands of contacts is one INSERT … SELECT, not thousands of round trips.
create or replace function app.queue_segment_drip()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.scheduled_jobs (org_id, kind, payload, run_at, dedupe_key)
  select a.org_id,
         'flow.drip',
         jsonb_build_object('segment_id', a.segment_id, 'contact_id', a.contact_id, 'flow_id', s.drip_flow_id),
         now(),
         'flow.drip:' || a.segment_id || ':' || a.contact_id || ':' || s.drip_flow_id
    from added a
    join public.segments s on s.id = a.segment_id and s.org_id = a.org_id
    join public.flows f on f.id = s.drip_flow_id and f.org_id = s.org_id
   where s.kind = 'static'
     and f.status = 'active'
     and f.trigger_type = 'segment_joined'
  on conflict (dedupe_key) where done_at is null and dedupe_key is not null do nothing;
  return null;
end;
$$;
revoke all on function app.queue_segment_drip() from public;

create trigger segment_members_queue_drip
  after insert on public.segment_members
  referencing new table as added
  for each statement execute function app.queue_segment_drip();

-- A segment's drip flow must belong to the same workspace (the FK alone does not check the org).
create or replace function app.check_segment_drip_flow_org()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.drip_flow_id is not null and not exists (
    select 1 from public.flows f where f.id = new.drip_flow_id and f.org_id = new.org_id
  ) then
    raise exception 'drip flow % does not belong to org %', new.drip_flow_id, new.org_id using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger segments_drip_flow_org_check
  before insert or update of drip_flow_id, org_id on public.segments
  for each row execute function app.check_segment_drip_flow_org();

-- The message_received debounce looks up recent runs of one flow in one conversation.
create index if not exists flow_runs_flow_conversation_started_idx
  on public.flow_runs (flow_id, conversation_id, started_at desc)
  where conversation_id is not null;

-- ======================================================================
-- 20261025000100_routing_presence.sql
-- ======================================================================
-- Phase 20c (routing half, docs/24_PHASE_20C_ROUTING_NOTES.md): team auto-reply and fallback team, a per-member open
-- conversation limit honoured by round-robin, presence auto-away from browser heartbeats, a per-member restricted
-- enquiry view enforced in RLS, and two logs the G13 reports read (assignment events, presence changes).
--
--   teams.auto_reply_text         sent once per conversation when a new chat lands in the team outside its office hours or
--                                 while nobody in it is online (lib/inbox/routing.ts decides, queueOutbound sends)
--   teams.office_hours            the Office Hours node's schedule shape (lib/flow-engine/office-hours.ts); null = always open
--   teams.fallback_team_id        used when nobody in the team is online or everyone is at their limit (one hop, never chained)
--   memberships.max_open_conversations   null = no limit; checked inside the SQL picker under a per-member advisory lock
--   memberships.enquiry_scope     'all' (default, no change) | 'team' | 'own'; app.enquiry_visible_to() is the one rule
--   memberships.last_seen_at      last browser heartbeat (public.presence_heartbeat)
--   memberships.presence_auto     true while the sweep (not the person) has set them away; their next heartbeat brings them back
--   conversations.auto_reply_sent_at     claimed atomically before the auto-reply is queued (at most once)
--   orgs.settings.inbox.auto_away_minutes  null = off. Online members with no heartbeat for that long count as away
--                                 at once in routing, and the every-minute sweep marks them away.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

alter table public.teams
  add column auto_reply_text text check (auto_reply_text is null or char_length(btrim(auto_reply_text)) between 1 and 1024),
  add column office_hours jsonb check (office_hours is null or jsonb_typeof(office_hours) = 'object'),
  add column fallback_team_id uuid references public.teams (id) on delete set null,
  add constraint teams_fallback_not_self check (fallback_team_id is null or fallback_team_id <> id);

create trigger teams_fallback_org_check before insert or update of fallback_team_id on public.teams
  for each row execute function app.check_parent_org('teams', 'fallback_team_id');

alter table public.memberships
  add column max_open_conversations integer check (max_open_conversations is null or max_open_conversations between 1 and 500),
  add column enquiry_scope text not null default 'all' check (enquiry_scope in ('all', 'team', 'own')),
  add column last_seen_at timestamptz,
  add column presence_auto boolean not null default false;

alter table public.conversations add column auto_reply_sent_at timestamptz;

-- ---------------------------------------------------------------------------
-- Logs
-- ---------------------------------------------------------------------------

-- One row per change of a conversation's owner or team. User and team ids are plain uuids on purpose: a foreign key would
-- make deleting a profile or team fail (the FK's own SET NULL on conversations fires this log for the row being deleted).
create table public.conversation_assignment_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  kind text not null check (kind in ('assigned', 'reassigned', 'unassigned', 'team_changed')),
  from_user_id uuid,
  to_user_id uuid,
  from_team_id uuid,
  to_team_id uuid,
  actor_id uuid,                                      -- the signed-in person, when there was one
  source text not null check (source in ('user', 'routing', 'system')),
  at timestamptz not null default now()
);
create index conversation_assignment_events_org_at_idx on public.conversation_assignment_events (org_id, at desc);
create index conversation_assignment_events_conv_idx on public.conversation_assignment_events (conversation_id, at);

-- One row per presence change of a member.
create table public.member_presence_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null,                              -- plain uuid: removing a member keeps their history for the report
  presence text not null check (presence in ('online', 'away', 'offline')),
  previous text check (previous is null or previous in ('online', 'away', 'offline')),
  source text not null check (source in ('manual', 'auto_away', 'auto_back', 'admin')),
  at timestamptz not null default now()
);
create index member_presence_events_org_at_idx on public.member_presence_events (org_id, at);
create index member_presence_events_user_idx on public.member_presence_events (org_id, user_id, at);

alter table public.conversation_assignment_events enable row level security;
alter table public.member_presence_events enable row level security;

-- Read-only for people who see reports (the trigger functions below write them). A member also sees their own status log.
create policy conversation_assignment_events_select on public.conversation_assignment_events for select to authenticated
  using (app.has_perm(org_id, 'reports.view'));
create policy member_presence_events_select on public.member_presence_events for select to authenticated
  using (app.has_perm(org_id, 'reports.view') or (app.is_org_member(org_id) and user_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- Who did it: the signed-in user, or the x-pulse-actor header on a service-role request (the same rule as record_history).
-- ---------------------------------------------------------------------------

create or replace function app.request_actor()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_role text;
begin
  v_actor := auth.uid();
  if v_actor is null then
    v_role := coalesce(
      nullif(current_setting('request.jwt.claim.role', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
    );
    if v_role = 'service_role' then
      begin
        v_actor := nullif(nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-pulse-actor', '')::uuid;
      exception when others then
        v_actor := null;                                  -- a malformed header must never break the write
      end;
    end if;
  end if;
  return v_actor;
end;
$$;
revoke all on function app.request_actor() from public, anon, authenticated;

create or replace function app.log_conversation_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_actor uuid;
  v_source text;
  v_old_user uuid;
  v_old_team uuid;
begin
  if TG_OP = 'INSERT' then
    if new.assignee_user_id is null and new.assignee_team_id is null then
      return null;
    end if;
  elsif new.assignee_user_id is not distinct from old.assignee_user_id
    and new.assignee_team_id is not distinct from old.assignee_team_id then
    return null;
  end if;
  if TG_OP = 'UPDATE' then
    v_old_user := old.assignee_user_id;
    v_old_team := old.assignee_team_id;
  end if;
  if new.assignee_user_id is not distinct from v_old_user then
    v_kind := 'team_changed';
  elsif v_old_user is null then
    v_kind := 'assigned';
  elsif new.assignee_user_id is null then
    v_kind := 'unassigned';
  else
    v_kind := 'reassigned';
  end if;
  v_actor := app.request_actor();
  v_source := nullif(current_setting('pulse.assign_source', true), '');
  if v_source is null or v_source not in ('user', 'routing', 'system') then
    v_source := case when v_actor is null then 'system' else 'user' end;
  end if;
  insert into public.conversation_assignment_events
    (org_id, conversation_id, kind, from_user_id, to_user_id, from_team_id, to_team_id, actor_id, source)
  values
    (new.org_id, new.id, v_kind, v_old_user, new.assignee_user_id, v_old_team, new.assignee_team_id, v_actor, v_source);
  return null;
end;
$$;
revoke all on function app.log_conversation_assignment() from public, anon, authenticated;

create trigger conversations_assignment_log
  after insert or update of assignee_user_id, assignee_team_id on public.conversations
  for each row execute function app.log_conversation_assignment();

create or replace function app.log_member_presence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source text;
begin
  if new.presence is not distinct from old.presence then
    return null;
  end if;
  v_source := nullif(current_setting('pulse.presence_source', true), '');
  if v_source is null or v_source not in ('manual', 'auto_away', 'auto_back', 'admin') then
    v_source := case when auth.uid() = new.user_id then 'manual' else 'admin' end;
  end if;
  insert into public.member_presence_events (org_id, user_id, presence, previous, source)
  values (new.org_id, new.user_id, new.presence, old.presence, v_source);
  return null;
end;
$$;
revoke all on function app.log_member_presence() from public, anon, authenticated;

create trigger memberships_presence_log
  after update of presence on public.memberships
  for each row execute function app.log_member_presence();

-- ---------------------------------------------------------------------------
-- Presence: idle rule, heartbeat, manual changes, auto-away sweep
-- ---------------------------------------------------------------------------

-- orgs.settings.inbox.auto_away_minutes as an integer, or null when off or not a number (the app validates 5..480).
create or replace function app.auto_away_minutes(p_settings jsonb)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(p_settings -> 'inbox' -> 'auto_away_minutes') = 'number'
      then greatest(1, least(1440, (p_settings -> 'inbox' ->> 'auto_away_minutes')::numeric::integer))
  end;
$$;

-- Online for routing: presence says online and, with auto-away on, the last heartbeat is recent enough. The pure mirror
-- of this rule is isPresenceOnline() in lib/presence/idle.ts.
create or replace function app.presence_is_online(p_presence text, p_seen_at timestamptz, p_idle_minutes integer)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_presence = 'online'
    and (p_idle_minutes is null or (p_seen_at is not null and p_seen_at >= now() - make_interval(mins => p_idle_minutes)));
$$;

-- Manual status change from the user menu (same signature as before). Going online counts as being seen, and any
-- automatic away is over.
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
  perform set_config('pulse.presence_source', 'manual', true);
  update public.memberships
  set presence = p_presence,
      presence_at = now(),
      presence_auto = false,
      last_seen_at = case when p_presence = 'online' then now() else last_seen_at end
  where org_id = p_org_id and user_id = auth.uid() and status = 'active';
end;
$$;

-- Browser heartbeat (components/shell/shell-data.tsx sends one a minute while the person is active). Throttled to one
-- write per 30 seconds. Brings back someone the sweep set away; never overrides a status the person picked.
-- Returns the resulting presence so the user menu can repaint its dot.
create or replace function public.presence_heartbeat(p_org_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_presence text;
begin
  perform set_config('pulse.presence_source', 'auto_back', true);
  update public.memberships
  set last_seen_at = now(),
      presence = case when presence = 'away' and presence_auto then 'online' else presence end,
      presence_at = case when presence = 'away' and presence_auto then now() else presence_at end,
      presence_auto = false
  where org_id = p_org_id and user_id = auth.uid() and status = 'active'
    and (last_seen_at is null or last_seen_at < now() - interval '30 seconds' or presence_auto)
  returning presence into v_presence;
  if v_presence is null then
    select presence into v_presence from public.memberships
    where org_id = p_org_id and user_id = auth.uid() and status = 'active';
  end if;
  return v_presence;
end;
$$;
revoke all on function public.presence_heartbeat(uuid) from public, anon;
grant execute on function public.presence_heartbeat(uuid) to authenticated, service_role;

-- Every minute (pg_cron, plain SQL, no HTTP job): online members whose last heartbeat is older than their org's
-- auto_away_minutes become away (presence_auto = true). Returns how many changed.
create or replace function public.presence_auto_away_sweep()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  perform set_config('pulse.presence_source', 'auto_away', true);
  update public.memberships m
  set presence = 'away', presence_at = now(), presence_auto = true
  from public.orgs o
  where o.id = m.org_id
    and m.presence = 'online'
    and m.status = 'active'
    and app.auto_away_minutes(o.settings) is not null
    and not app.presence_is_online(m.presence, coalesce(m.last_seen_at, m.presence_at), app.auto_away_minutes(o.settings));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.presence_auto_away_sweep() from public, anon, authenticated;
grant execute on function public.presence_auto_away_sweep() to service_role;

select cron.schedule('pulse:presence_auto_away', '* * * * *', $$select public.presence_auto_away_sweep()$$);

-- ---------------------------------------------------------------------------
-- Routing
-- ---------------------------------------------------------------------------

create or replace function app.team_has_online_member(p_org_id uuid, p_team_id uuid, p_idle_minutes integer)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.team_members tm
    join public.memberships m on m.org_id = tm.org_id and m.user_id = tm.user_id
    where tm.team_id = p_team_id and tm.org_id = p_org_id and m.status = 'active'
      and app.presence_is_online(m.presence, coalesce(m.last_seen_at, m.presence_at), p_idle_minutes)
  );
$$;
revoke all on function app.team_has_online_member(uuid, uuid, integer) from public, anon, authenticated;

-- The one round-robin picker. Online (idle-aware) active members with weight > 0, least recently assigned first. With
-- p_check_capacity, a member at max_open_conversations is skipped; the count runs under a per-member advisory lock that
-- is held until the caller's transaction ends, so two routings in flight can never both take the last place. A lock
-- someone else holds means that member is being checked right now: skip them (no waiting, no deadlock).
create or replace function app.pick_team_assignee(p_org_id uuid, p_team_id uuid, p_check_capacity boolean)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_idle integer;
  v_open integer;
  r record;
begin
  select app.auto_away_minutes(o.settings) into v_idle from public.orgs o where o.id = p_org_id;
  for r in
    select tm.user_id, m.max_open_conversations as cap
    from public.team_members tm
    join public.memberships m on m.org_id = tm.org_id and m.user_id = tm.user_id
    where tm.team_id = p_team_id
      and tm.org_id = p_org_id
      and tm.rr_weight > 0
      and m.status = 'active'
      and app.presence_is_online(m.presence, coalesce(m.last_seen_at, m.presence_at), v_idle)
    order by tm.last_assigned_at asc nulls first, tm.rr_weight desc, tm.user_id
  loop
    if p_check_capacity and r.cap is not null then
      if not pg_try_advisory_xact_lock(hashtextextended('pulse:capacity:' || p_org_id::text || ':' || r.user_id::text, 0)) then
        continue;
      end if;
      select count(*) into v_open
      from public.conversations c
      where c.org_id = p_org_id and c.assignee_user_id = r.user_id and c.status <> 'closed' and not c.campaign_only;
      if v_open >= r.cap then
        continue;
      end if;
    end if;
    perform 1 from public.team_members tm
    where tm.team_id = p_team_id and tm.user_id = r.user_id
    for update skip locked;
    if not found then
      continue;
    end if;
    update public.team_members set last_assigned_at = now() where team_id = p_team_id and user_id = r.user_id;
    return r.user_id;
  end loop;
  return null;
end;
$$;
revoke all on function app.pick_team_assignee(uuid, uuid, boolean) from public, anon, authenticated;

-- Unchanged signature (enquiry assignment rules use it); now idle-aware. No capacity check: the limit is about
-- open conversations, not enquiries.
create or replace function public.pick_round_robin_assignee(p_org_id uuid, p_team_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  return app.pick_team_assignee(p_org_id, p_team_id, false);
end;
$$;

-- Capacity-aware pick for the inbox "Auto-assign" button (the assignment itself follows in a separate request).
create or replace function public.pick_round_robin_assignee_capped(p_org_id uuid, p_team_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  return app.pick_team_assignee(p_org_id, p_team_id, true);
end;
$$;
revoke all on function public.pick_round_robin_assignee_capped(uuid, uuid) from public, anon, authenticated;
grant execute on function public.pick_round_robin_assignee_capped(uuid, uuid) to service_role;

-- Routes an unowned conversation into p_team_id in ONE transaction: pick (capacity-aware) and write the owner together,
-- so the limit holds under concurrent inbound webhooks. Falls back to the team's fallback team (one hop) when nobody in
-- the team is online, or when round-robin found nobody (everyone away or at their limit). Without anyone online there
-- either, the conversation stays in the first team. A conversation that already has an owner is left alone.
-- Returns {team_id, user_id, fallback, team_online, auto_reply_text, office_hours} for the team it landed in.
create or replace function public.route_conversation(p_org_id uuid, p_conversation_id uuid, p_team_id uuid, p_round_robin boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conv record;
  v_team record;
  v_fb record;
  v_idle integer;
  v_user uuid;
  v_final uuid;
  v_fallback boolean := false;
  v_tried_rr boolean := false;
  v_out record;
begin
  select c.id, c.assignee_user_id, c.assignee_team_id into v_conv
  from public.conversations c
  where c.id = p_conversation_id and c.org_id = p_org_id
  for update;
  if not found then
    return null;
  end if;
  if v_conv.assignee_user_id is not null then
    return jsonb_build_object('team_id', v_conv.assignee_team_id, 'user_id', v_conv.assignee_user_id,
                              'fallback', false, 'team_online', true, 'auto_reply_text', null, 'office_hours', null);
  end if;
  select t.id, t.round_robin, t.fallback_team_id into v_team
  from public.teams t where t.id = p_team_id and t.org_id = p_org_id;
  if not found then
    return jsonb_build_object('team_id', v_conv.assignee_team_id, 'user_id', null,
                              'fallback', false, 'team_online', false, 'auto_reply_text', null, 'office_hours', null);
  end if;

  perform set_config('pulse.assign_source', 'routing', true);
  select app.auto_away_minutes(o.settings) into v_idle from public.orgs o where o.id = p_org_id;

  v_final := v_team.id;
  if p_round_robin and v_team.round_robin then
    v_tried_rr := true;
    v_user := app.pick_team_assignee(p_org_id, v_team.id, true);
  end if;
  if v_user is null and v_team.fallback_team_id is not null
     and (v_tried_rr or not app.team_has_online_member(p_org_id, v_team.id, v_idle)) then
    select t.id, t.round_robin into v_fb
    from public.teams t where t.id = v_team.fallback_team_id and t.org_id = p_org_id;
    if found then
      if p_round_robin and v_fb.round_robin then
        v_user := app.pick_team_assignee(p_org_id, v_fb.id, true);
      end if;
      if v_user is not null or app.team_has_online_member(p_org_id, v_fb.id, v_idle) then
        v_final := v_fb.id;
        v_fallback := true;
      end if;
    end if;
  end if;

  update public.conversations
  set assignee_team_id = v_final, assignee_user_id = v_user
  where id = p_conversation_id;

  select t.auto_reply_text, t.office_hours into v_out from public.teams t where t.id = v_final;
  return jsonb_build_object(
    'team_id', v_final,
    'user_id', v_user,
    'fallback', v_fallback,
    'team_online', v_user is not null or app.team_has_online_member(p_org_id, v_final, v_idle),
    'auto_reply_text', v_out.auto_reply_text,
    'office_hours', v_out.office_hours
  );
end;
$$;
revoke all on function public.route_conversation(uuid, uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.route_conversation(uuid, uuid, uuid, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- Restricted enquiry view
-- ---------------------------------------------------------------------------

-- The one rule (RLS below and the service-role list queries in lib/enquiries/query.ts both call it):
--   all   every enquiry (default)
--   own   assigned to me, or unassigned and created by me
--   team  assigned to me or to someone who shares a team with me, or unassigned (so the team can pick new ones up)
-- A person who is not an active member sees nothing.
create or replace function app.enquiry_visible_to(p_org_id uuid, p_user_id uuid, p_assignee_id uuid, p_created_by uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_scope text;
begin
  if p_user_id is null then
    return false;
  end if;
  select m.enquiry_scope into v_scope
  from public.memberships m
  where m.org_id = p_org_id and m.user_id = p_user_id and m.status = 'active';
  if v_scope is null then
    return false;
  end if;
  if v_scope = 'all' or p_assignee_id = p_user_id then
    return true;
  end if;
  if v_scope = 'own' then
    return p_assignee_id is null and p_created_by = p_user_id;
  end if;
  if p_assignee_id is null then
    return true;
  end if;
  return exists (
    select 1
    from public.team_members a
    join public.team_members b on b.team_id = a.team_id and b.org_id = a.org_id
    where a.org_id = p_org_id and a.user_id = p_user_id and b.user_id = p_assignee_id
  );
end;
$$;
revoke all on function app.enquiry_visible_to(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function app.enquiry_visible_to(uuid, uuid, uuid, uuid) to authenticated, service_role;

drop policy enquiries_select on public.enquiries;
create policy enquiries_select on public.enquiries for select to authenticated
  using (app.has_perm(org_id, 'enquiries.view') and app.enquiry_visible_to(org_id, auth.uid(), assignee_id, created_by));
drop policy enquiries_update on public.enquiries;
create policy enquiries_update on public.enquiries for update to authenticated
  using (app.has_perm(org_id, 'enquiries.manage') and app.enquiry_visible_to(org_id, auth.uid(), assignee_id, created_by))
  with check (app.has_perm(org_id, 'enquiries.manage'));
drop policy enquiries_delete on public.enquiries;
create policy enquiries_delete on public.enquiries for delete to authenticated
  using (app.has_perm(org_id, 'enquiries.delete') and app.enquiry_visible_to(org_id, auth.uid(), assignee_id, created_by));

-- Server code (service role, after can()) filters a list of ids down to the ones a member may see.
create or replace function public.enquiry_ids_visible_to(p_org_id uuid, p_user_id uuid, p_ids uuid[])
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.id
  from public.enquiries e
  where e.org_id = p_org_id
    and e.id = any (p_ids)
    and app.enquiry_visible_to(e.org_id, p_user_id, e.assignee_id, e.created_by);
$$;
revoke all on function public.enquiry_ids_visible_to(uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.enquiry_ids_visible_to(uuid, uuid, uuid[]) to service_role;

-- ======================================================================
-- 20261025000200_routing_reports.sql
-- ======================================================================
-- Phase 20c / G13 reports (docs/24_PHASE_20C_ROUTING_NOTES.md). Source views (lib/reports/registry.ts `requires`) plus
-- report functions. Service role only, called by lib/reports after can('reports.view'). Each returns a bounded,
-- aggregated result (counts, seconds, staff ids): never patient data or message text.
--
-- Definitions:
--   first-assign-to-close   closed_at minus the first time the conversation got an owner (assignment log, at or before close)
--   last-assign-to-close    closed_at minus the last time it got a (new) owner before it was closed
--   owner removed           an assignment event that took the conversation away from a person (unassigned or reassigned)
--   AI assisted             a staff member used an AI draft in the conversation (ai_suggestion_outcomes)
--   bot engaged             a flow sent at least one message in it (messages.flow_run_id)
--   closed without a human  closed with no outbound message sent by a staff member (messages.sent_by_user_id);
--                           "handled by automation" = of those, at least one automated outbound message was sent
--   days                    org-local (orgs.timezone), like the other reports
-- The assignment and presence logs start when 20261025000100 is applied; older conversations have no assignment events.

-- ---------------------------------------------------------------------------
-- Source views (security_invoker; revoked from API roles like the other report views)
-- ---------------------------------------------------------------------------

create view public.v_assignment_events
with (security_invoker = true) as
select e.id,
       e.org_id,
       e.conversation_id,
       e.kind,
       e.from_user_id,
       e.to_user_id,
       e.from_team_id,
       e.to_team_id,
       e.source,
       e.at,
       (e.at at time zone o.timezone)::date as day
from public.conversation_assignment_events e
join public.orgs o on o.id = e.org_id;

create view public.v_presence_events
with (security_invoker = true) as
select e.id, e.org_id, e.user_id, e.presence, e.previous, e.source, e.at
from public.member_presence_events e;

-- One row per conversation with the engagement flags the AI report counts. Only cheap EXISTS probes on indexed
-- conversation_id columns; callers always filter by org and closed_day first.
create view public.v_conversation_engagement
with (security_invoker = true) as
select c.id as conversation_id,
       c.org_id,
       c.channel_id,
       c.assignee_team_id,
       c.assignee_user_id,
       c.status,
       c.closed_at,
       case when c.closed_at is not null then (c.closed_at at time zone o.timezone)::date end as closed_day,
       exists (select 1 from public.ai_suggestion_outcomes s where s.conversation_id = c.id) as ai_assisted,
       exists (select 1 from public.messages m
               where m.conversation_id = c.id and m.direction = 'out' and m.flow_run_id is not null) as bot_engaged,
       exists (select 1 from public.messages m
               where m.conversation_id = c.id and m.direction = 'out' and m.sent_by_user_id is not null) as human_replied,
       exists (select 1 from public.messages m
               where m.conversation_id = c.id and m.direction = 'out' and m.sent_by_user_id is null
                 and m.kind <> 'reaction') as automated_reply
from public.conversations c
join public.orgs o on o.id = c.org_id;

revoke all on public.v_assignment_events, public.v_presence_events, public.v_conversation_engagement
  from public, anon, authenticated;
grant select on public.v_assignment_events, public.v_presence_events, public.v_conversation_engagement to service_role;

-- ---------------------------------------------------------------------------
-- Report functions
-- ---------------------------------------------------------------------------

create or replace function public.report_assignment_close(
  p_org uuid, p_from date, p_to date, p_teams uuid[] default null, p_users uuid[] default null
)
returns table (
  user_id uuid, is_total boolean, closed integer, with_assignment integer,
  first_avg_seconds numeric, first_median_seconds numeric,
  last_avg_seconds numeric, last_median_seconds numeric
)
language sql stable
set search_path = public, pg_temp
as $$
  with c as (
    select v.conversation_id as id, v.closed_at, v.assignee_user_id
    from public.v_conversation_engagement v
    where v.org_id = p_org and v.status = 'closed' and v.closed_day between p_from and p_to
      and (p_teams is null or cardinality(p_teams) = 0 or v.assignee_team_id = any (p_teams))
      and (p_users is null or cardinality(p_users) = 0 or v.assignee_user_id = any (p_users))
  ),
  a as (
    select c.id,
           extract(epoch from c.closed_at - min(e.at))::numeric as first_s,
           extract(epoch from c.closed_at - max(e.at))::numeric as last_s
    from c
    join public.v_assignment_events e on e.conversation_id = c.id
    where e.org_id = p_org and e.to_user_id is not null and e.kind in ('assigned', 'reassigned') and e.at <= c.closed_at
    group by c.id, c.closed_at
  )
  select c.assignee_user_id,
         grouping(c.assignee_user_id) = 1,
         count(*)::integer,
         count(a.id)::integer,
         round(avg(a.first_s), 0),
         round(percentile_cont(0.5) within group (order by a.first_s)::numeric, 0),
         round(avg(a.last_s), 0),
         round(percentile_cont(0.5) within group (order by a.last_s)::numeric, 0)
  from c left join a on a.id = c.id
  group by grouping sets ((c.assignee_user_id), ())
  order by 2 desc, 3 desc
  limit 300;
$$;

create or replace function public.report_owner_removed(
  p_org uuid, p_from date, p_to date, p_teams uuid[] default null, p_users uuid[] default null
)
returns table (
  user_id uuid, is_total boolean, removed integer, unassigned integer, reassigned integer,
  by_staff integer, by_routing_or_system integer
)
language sql stable
set search_path = public, pg_temp
as $$
  select e.from_user_id,
         grouping(e.from_user_id) = 1,
         count(*)::integer,
         count(*) filter (where e.kind = 'unassigned')::integer,
         count(*) filter (where e.kind = 'reassigned')::integer,
         count(*) filter (where e.source = 'user')::integer,
         count(*) filter (where e.source <> 'user')::integer
  from public.v_assignment_events e
  where e.org_id = p_org
    and e.from_user_id is not null
    and e.kind in ('unassigned', 'reassigned')
    and e.day between p_from and p_to
    and (p_teams is null or cardinality(p_teams) = 0 or e.from_team_id = any (p_teams))
    and (p_users is null or cardinality(p_users) = 0 or e.from_user_id = any (p_users))
  group by grouping sets ((e.from_user_id), ())
  order by 2 desc, 3 desc
  limit 300;
$$;

create or replace function public.report_ai_engagement(
  p_org uuid, p_from date, p_to date, p_channels uuid[] default null, p_teams uuid[] default null
)
returns table (
  closed integer, ai_assisted integer, bot_engaged integer, engaged integer,
  closed_without_human integer, handled_by_automation integer, closed_without_reply integer
)
language sql stable
set search_path = public, pg_temp
as $$
  select count(*)::integer,
         count(*) filter (where v.ai_assisted)::integer,
         count(*) filter (where v.bot_engaged)::integer,
         count(*) filter (where v.ai_assisted or v.bot_engaged)::integer,
         count(*) filter (where not v.human_replied)::integer,
         count(*) filter (where not v.human_replied and v.automated_reply)::integer,
         count(*) filter (where not v.human_replied and not v.automated_reply)::integer
  from public.v_conversation_engagement v
  where v.org_id = p_org and v.status = 'closed' and v.closed_day between p_from and p_to
    and (p_channels is null or cardinality(p_channels) = 0 or v.channel_id = any (p_channels))
    and (p_teams is null or cardinality(p_teams) = 0 or v.assignee_team_id = any (p_teams));
$$;

-- Enquiries created in the period, grouped by the org-local month they were created, with where they are now.
create or replace function public.report_enquiry_cohorts(
  p_org uuid, p_from date, p_to date, p_users uuid[] default null
)
returns table (
  month date, created integer, open integer, won integer, lost integer, disqualified integer,
  won_value numeric, median_days_to_close numeric
)
language sql stable
set search_path = public, pg_temp
as $$
  select date_trunc('month', f.created_day)::date,
         count(*)::integer,
         count(*) filter (where f.status = 'open')::integer,
         count(*) filter (where f.status = 'won')::integer,
         count(*) filter (where f.status = 'lost')::integer,
         count(*) filter (where f.status = 'disqualified')::integer,
         coalesce(sum(f.est_value) filter (where f.status = 'won'), 0),
         round((percentile_cont(0.5) within group (order by extract(epoch from f.closed_at - f.created_at) / 86400.0)
                filter (where f.closed_at is not null))::numeric, 1)
  from public.v_enquiry_facts f
  where f.org_id = p_org
    and f.created_day between p_from and p_to
    and (p_users is null or cardinality(p_users) = 0 or f.assignee_id = any (p_users))
  group by 1
  order by 1
  limit 400;
$$;

-- Presence changes for the member status log, as ONE jsonb value (PostgREST caps set results at max-rows; a year of
-- changes for a team can exceed that). seed = each member's state when the window opens (the last change before it,
-- else the state before the first change inside it, else their current state); events = changes inside the window,
-- capped at 50 000 (truncated = true when cut). Durations per day are worked out by lib/reports/presence.ts (pure).
create or replace function public.report_presence_events(
  p_org uuid, p_from timestamptz, p_to timestamptz, p_users uuid[] default null
)
returns jsonb
language sql stable
set search_path = public, pg_temp
as $$
  with people as (
    select m.user_id, m.presence from public.memberships m
    where m.org_id = p_org
      and (p_users is null or cardinality(p_users) = 0 or m.user_id = any (p_users))
    union
    select distinct e.user_id, null::text from public.v_presence_events e
    where e.org_id = p_org and e.at < p_to
      and not exists (select 1 from public.memberships m where m.org_id = p_org and m.user_id = e.user_id)
      and (p_users is null or cardinality(p_users) = 0 or e.user_id = any (p_users))
  ),
  seed as (
    select p.user_id,
           coalesce(
             (select e.presence from public.v_presence_events e
              where e.org_id = p_org and e.user_id = p.user_id and e.at < p_from order by e.at desc, e.id desc limit 1),
             (select e.previous from public.v_presence_events e
              where e.org_id = p_org and e.user_id = p.user_id and e.at >= p_from order by e.at, e.id limit 1),
             p.presence,
             'offline'
           ) as presence
    from people p
  ),
  ev as (
    select e.user_id, e.presence, e.at, e.id
    from public.v_presence_events e
    where e.org_id = p_org and e.at >= p_from and e.at < p_to
      and e.user_id in (select user_id from people)
    order by e.at, e.id
    limit 50001
  )
  select jsonb_build_object(
    'seed', coalesce((select jsonb_agg(jsonb_build_object('user_id', s.user_id, 'presence', s.presence)) from seed s), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('user_id', x.user_id, 'presence', x.presence, 'at', x.at) order by x.at, x.id)
                        from (select * from ev order by at, id limit 50000) x), '[]'::jsonb),
    'truncated', (select count(*) from ev) > 50000
  );
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.report_assignment_close(uuid, date, date, uuid[], uuid[])',
    'public.report_owner_removed(uuid, date, date, uuid[], uuid[])',
    'public.report_ai_engagement(uuid, date, date, uuid[], uuid[])',
    'public.report_enquiry_cohorts(uuid, date, date, uuid[])',
    'public.report_presence_events(uuid, timestamptz, timestamptz, uuid[])'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;

-- ======================================================================
-- 20261026000100_booking_capacity.sql
-- ======================================================================
-- Phase 20c (booking half, G6): booking capacity. docs/25_PHASE_20C_BOOKING_NOTES.md.
--
-- 1. services:    buffer_before_min / buffer_after_min (the specialist is busy that long before and after the
--                 visit) and capacity (patients one session can take at once; default 1).
-- 2. specialists: slot_length_min (step of their slot list; null = the org's slot_granularity_min) and
--                 max_per_slot (bookings they accept in one slot; default 1).
-- 3. specialist_recurring_blocks: weekly unavailable time by weekday (lunch, admin time), wall-clock minutes in
--                 the location's timezone, like working_hours. Settings table: members read, settings.manage writes.
-- 4. app.slot_conflict(): the one SQL rule, mirrored by lib/appointments/slots.ts (slotFits). Under the existing
--                 per-specialist advisory lock, book_appointment / move_appointment / accept_slot_offer re-check
--                 buffers, recurring blocks and capacity atomically. Signatures are unchanged.
-- 5. appointment_capacity_conflicts(): flags rows that break the rules (e.g. a Unite appointment). Read-only:
--                 the Unite sync writes appointments directly and is never checked or refused.
--
-- The rule. Every interval is widened by its own service buffers. A candidate fits when it overlaps no one-off
-- or recurring block, and the number n of busy appointments (awaiting / confirmed / completed) whose widened
-- interval overlaps the candidate's widened interval is 0, or n < the smallest "places" among the candidate and
-- every overlapping appointment, where places = least(service.capacity, specialist.max_per_slot) (no service = 1).
-- With every default (capacity 1, max 1, no buffers, no recurring blocks) this is exactly the old rule: any
-- overlap is slot_taken. Counting every overlapping booking (not the peak at one instant) can only refuse more,
-- never overbook.

-- ---------------------------------------------------------------------------
-- 1–2. Columns
-- ---------------------------------------------------------------------------
alter table public.services
  add column buffer_before_min integer not null default 0 check (buffer_before_min between 0 and 240),
  add column buffer_after_min integer not null default 0 check (buffer_after_min between 0 and 240),
  add column capacity integer not null default 1 check (capacity between 1 and 50);

alter table public.specialists
  add column slot_length_min integer check (slot_length_min is null or slot_length_min between 5 and 240),
  add column max_per_slot integer not null default 1 check (max_per_slot between 1 and 50);

-- ---------------------------------------------------------------------------
-- 3. Recurring blocks
-- ---------------------------------------------------------------------------
create table public.specialist_recurring_blocks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  specialist_id uuid not null references public.specialists (id) on delete cascade,
  -- null = at every location the specialist works at
  location_id uuid references public.locations (id) on delete cascade,
  weekday smallint not null check (weekday between 1 and 7),           -- ISO: 1 = Monday … 7 = Sunday
  start_min smallint not null check (start_min between 0 and 1439),    -- minutes after local midnight
  end_min smallint not null check (end_min between 1 and 1440),
  reason text check (reason is null or char_length(reason) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_min > start_min)
);
create index specialist_recurring_blocks_specialist_idx
  on public.specialist_recurring_blocks (specialist_id, weekday);

create trigger specialist_recurring_blocks_set_updated_at before update on public.specialist_recurring_blocks
  for each row execute function app.set_updated_at();
create trigger specialist_recurring_blocks_specialist_org_check before insert or update on public.specialist_recurring_blocks
  for each row execute function app.check_parent_org('specialists', 'specialist_id');
create trigger specialist_recurring_blocks_location_org_check before insert or update on public.specialist_recurring_blocks
  for each row execute function app.check_parent_org('locations', 'location_id');

alter table public.specialist_recurring_blocks enable row level security;
-- Same as working_hours: any member reads (slot lists need it), settings.manage writes.
create policy specialist_recurring_blocks_select on public.specialist_recurring_blocks for select to authenticated
  using (app.is_org_member(org_id));
create policy specialist_recurring_blocks_insert on public.specialist_recurring_blocks for insert to authenticated
  with check (app.has_perm(org_id, 'settings.manage'));
create policy specialist_recurring_blocks_update on public.specialist_recurring_blocks for update to authenticated
  using (app.has_perm(org_id, 'settings.manage'))
  with check (app.has_perm(org_id, 'settings.manage'));
create policy specialist_recurring_blocks_delete on public.specialist_recurring_blocks for delete to authenticated
  using (app.has_perm(org_id, 'settings.manage'));

-- ---------------------------------------------------------------------------
-- 4. The rule
-- ---------------------------------------------------------------------------

-- Volatile on purpose (like the old assert_slot_free): called right after the advisory lock, it must read
-- what committed while we waited.
-- null = the interval fits; 'blocked' = a one-off or recurring block; 'full' = no place left.
-- p_service_id may be null (no buffers, one place). p_exclude_id: the appointment being moved or checked.
create or replace function app.slot_conflict(
  p_org_id uuid, p_specialist_id uuid, p_location_id uuid, p_service_id uuid,
  p_starts_at timestamptz, p_ends_at timestamptz, p_exclude_id uuid
)
returns text
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_before integer := 0;
  v_after integer := 0;
  v_places integer := 1;
  v_max integer := 1;
  v_s timestamptz;
  v_e timestamptz;
  v_tz text;
  v_n integer;
  v_min_places integer;
begin
  if p_service_id is not null then
    select s.buffer_before_min, s.buffer_after_min, s.capacity
      into v_before, v_after, v_places
      from public.services s where s.id = p_service_id and s.org_id = p_org_id;
  end if;
  select sp.max_per_slot into v_max from public.specialists sp where sp.id = p_specialist_id and sp.org_id = p_org_id;
  v_places := least(coalesce(v_places, 1), coalesce(v_max, 1));
  v_s := p_starts_at - make_interval(mins => coalesce(v_before, 0));
  v_e := p_ends_at + make_interval(mins => coalesce(v_after, 0));

  -- One-off blocks (that apply to this location), against the buffered interval.
  if exists (
    select 1 from public.time_blocks b
    where b.org_id = p_org_id and b.specialist_id = p_specialist_id
      and (b.location_id is null or b.location_id = p_location_id)
      and b.starts_at < v_e and b.ends_at > v_s
  ) then
    return 'blocked';
  end if;

  -- Recurring blocks: expand each local date the buffered interval touches in the location's clock.
  select l.timezone into v_tz from public.locations l where l.id = p_location_id and l.org_id = p_org_id;
  if v_tz is null then
    select o.timezone into v_tz from public.orgs o where o.id = p_org_id;
  end if;
  v_tz := coalesce(v_tz, 'Asia/Dubai');
  if exists (
    select 1
    from public.specialist_recurring_blocks r,
         generate_series(0, ((v_e at time zone v_tz)::date - (v_s at time zone v_tz)::date)) as g(i)
    where r.org_id = p_org_id and r.specialist_id = p_specialist_id
      and (r.location_id is null or r.location_id = p_location_id)
      and r.weekday = extract(isodow from ((v_s at time zone v_tz)::date + g.i))
      and ((((v_s at time zone v_tz)::date + g.i) + make_interval(mins => r.start_min::int)) at time zone v_tz) < v_e
      and ((((v_s at time zone v_tz)::date + g.i) + make_interval(mins => r.end_min::int)) at time zone v_tz) > v_s
  ) then
    return 'blocked';
  end if;

  -- Capacity. The first two range conditions are index-friendly (buffers are at most 240 minutes).
  select count(*)::int, min(least(coalesce(s.capacity, 1), coalesce(v_max, 1)))::int
    into v_n, v_min_places
    from public.appointments a
    left join public.services s on s.id = a.service_id
   where a.org_id = p_org_id and a.specialist_id = p_specialist_id
     and a.status in ('awaiting', 'confirmed', 'completed')
     and (p_exclude_id is null or a.id <> p_exclude_id)
     and a.starts_at < v_e + interval '240 minutes'
     and a.ends_at > v_s - interval '240 minutes'
     and a.starts_at - make_interval(mins => coalesce(s.buffer_before_min, 0)) < v_e
     and a.ends_at + make_interval(mins => coalesce(s.buffer_after_min, 0)) > v_s;
  if v_n > 0 and v_n >= least(v_places, v_min_places) then
    return 'full';
  end if;
  return null;
end;
$$;

create or replace function app.assert_slot_fits(
  p_org_id uuid, p_specialist_id uuid, p_location_id uuid, p_service_id uuid,
  p_starts_at timestamptz, p_ends_at timestamptz, p_exclude_id uuid
)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if app.slot_conflict(p_org_id, p_specialist_id, p_location_id, p_service_id, p_starts_at, p_ends_at, p_exclude_id) is not null then
    raise exception 'slot_taken' using errcode = 'P0001';
  end if;
end;
$$;

-- Kept for compatibility (same signature as 20261012000100): no service, so no own buffers and one place.
create or replace function app.assert_slot_free(
  p_org_id uuid, p_specialist_id uuid, p_location_id uuid,
  p_starts_at timestamptz, p_ends_at timestamptz, p_exclude_id uuid
)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform app.assert_slot_fits(p_org_id, p_specialist_id, p_location_id, null, p_starts_at, p_ends_at, p_exclude_id);
end;
$$;

revoke all on function app.slot_conflict(uuid, uuid, uuid, uuid, timestamptz, timestamptz, uuid) from public, anon, authenticated;
revoke all on function app.assert_slot_fits(uuid, uuid, uuid, uuid, timestamptz, timestamptz, uuid) from public, anon, authenticated;

-- Same signatures as 20261012000100; only the check changed (now with the service).
create or replace function public.book_appointment(
  p_org_id uuid, p_contact_id uuid, p_location_id uuid, p_specialist_id uuid, p_service_id uuid,
  p_department_id uuid, p_starts_at timestamptz, p_ends_at timestamptz, p_status text,
  p_notes text, p_notify_early boolean, p_source text, p_created_by uuid, p_enforce boolean
)
returns public.appointments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.appointments;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_specialist_id::text, 0));
  if p_enforce then
    perform app.assert_slot_fits(p_org_id, p_specialist_id, p_location_id, p_service_id, p_starts_at, p_ends_at, null);
  end if;
  insert into public.appointments (
    org_id, contact_id, location_id, specialist_id, service_id, department_id,
    starts_at, ends_at, status, notes, notify_early, source, created_by
  ) values (
    p_org_id, p_contact_id, p_location_id, p_specialist_id, p_service_id, p_department_id,
    p_starts_at, p_ends_at, p_status, p_notes, coalesce(p_notify_early, false), p_source, p_created_by
  ) returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.move_appointment(
  p_org_id uuid, p_appointment_id uuid, p_location_id uuid, p_specialist_id uuid,
  p_starts_at timestamptz, p_ends_at timestamptz, p_status text, p_enforce boolean
)
returns public.appointments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.appointments;
  v_service uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_specialist_id::text, 0));
  if p_enforce then
    select a.service_id into v_service from public.appointments a where a.id = p_appointment_id and a.org_id = p_org_id;
    perform app.assert_slot_fits(p_org_id, p_specialist_id, p_location_id, v_service, p_starts_at, p_ends_at, p_appointment_id);
  end if;
  update public.appointments
     set starts_at = p_starts_at, ends_at = p_ends_at, specialist_id = p_specialist_id,
         location_id = p_location_id, status = p_status
   where id = p_appointment_id and org_id = p_org_id
  returning * into v_row;
  if v_row.id is null then
    raise exception 'appointment_not_found' using errcode = 'P0001';
  end if;
  return v_row;
end;
$$;

-- Same as 20261014000300 except the re-check now uses the offered service (buffers and places).
create or replace function public.accept_slot_offer(
  p_org_id uuid,
  p_offer_id uuid,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o public.slot_offers;
  e public.waitlist_entries;
  v_appt public.appointments;
  v_department uuid;
begin
  select * into o from public.slot_offers where id = p_offer_id and org_id = p_org_id;
  if o.id is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- Same key as book_appointment / move_appointment.
  perform pg_advisory_xact_lock(hashtextextended(o.specialist_id::text, 0));

  select * into o from public.slot_offers where id = p_offer_id and org_id = p_org_id for update;
  if o.status <> 'pending' then
    return jsonb_build_object('result', case when o.status = 'taken' then 'taken' else 'not_pending' end,
                              'status', o.status);
  end if;
  if o.expires_at <= p_now then
    update public.slot_offers set status = 'expired', responded_at = p_now where id = o.id;
    return jsonb_build_object('result', 'expired');
  end if;

  select * into e from public.waitlist_entries where id = o.waitlist_entry_id and org_id = p_org_id for update;
  if e.id is null or e.status <> 'waiting' then
    update public.slot_offers set status = 'withdrawn', responded_at = p_now where id = o.id;
    return jsonb_build_object('result', 'not_pending', 'status', 'withdrawn');
  end if;

  -- Someone else (another patient's YES, or a staff booking) may have taken the last place.
  if app.slot_conflict(p_org_id, o.specialist_id, o.location_id, o.service_id, o.starts_at, o.ends_at, null) is not null then
    update public.slot_offers set status = 'taken', responded_at = p_now where id = o.id;
    return jsonb_build_object('result', 'taken');
  end if;

  select coalesce(s.department_id, sp.department_id) into v_department
    from public.services s, public.specialists sp
   where s.id = o.service_id and sp.id = o.specialist_id;

  v_appt := public.book_appointment(
    p_org_id, e.contact_id, o.location_id, o.specialist_id, o.service_id, v_department,
    o.starts_at, o.ends_at, 'confirmed', null, false, 'bot', null, true
  );

  update public.slot_offers
     set status = 'accepted', responded_at = p_now, appointment_id = v_appt.id
   where id = o.id;
  update public.waitlist_entries
     set status = 'booked', booked_appointment_id = v_appt.id
   where id = e.id;
  -- Everyone else holding an offer for this slot is told it has gone only when no place is left.
  if app.slot_conflict(p_org_id, o.specialist_id, o.location_id, o.service_id, o.starts_at, o.ends_at, null) is not null then
    update public.slot_offers
       set status = 'taken', responded_at = p_now
     where org_id = p_org_id and specialist_id = o.specialist_id and starts_at = o.starts_at
       and status = 'pending' and id <> o.id;
  end if;

  return jsonb_build_object('result', 'booked', 'appointment_id', v_appt.id, 'contact_id', e.contact_id,
                            'entry_id', e.id);
end;
$$;
revoke all on function public.accept_slot_offer(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.accept_slot_offer(uuid, uuid, timestamptz) to service_role;

revoke all on function public.book_appointment(uuid, uuid, uuid, uuid, uuid, uuid, timestamptz, timestamptz, text, text, boolean, text, uuid, boolean) from public, anon, authenticated;
revoke all on function public.move_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, text, boolean) from public, anon, authenticated;
grant execute on function public.book_appointment(uuid, uuid, uuid, uuid, uuid, uuid, timestamptz, timestamptz, text, text, boolean, text, uuid, boolean) to service_role;
grant execute on function public.move_appointment(uuid, uuid, uuid, uuid, timestamptz, timestamptz, text, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Conflict flags (display only; nothing is refused or changed)
-- ---------------------------------------------------------------------------
-- Upcoming-style rows (awaiting / confirmed) among p_ids that break the rule against everything else.
create or replace function public.appointment_capacity_conflicts(p_org_id uuid, p_ids uuid[])
returns table (appointment_id uuid, reason text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select x.id, x.reason
  from (
    select a.id,
           app.slot_conflict(a.org_id, a.specialist_id, a.location_id, a.service_id, a.starts_at, a.ends_at, a.id) as reason
    from public.appointments a
    where a.org_id = p_org_id
      and a.id = any (p_ids[1:2000])
      and a.specialist_id is not null
      and a.status in ('awaiting', 'confirmed')
  ) x
  where x.reason is not null;
$$;
revoke all on function public.appointment_capacity_conflicts(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.appointment_capacity_conflicts(uuid, uuid[]) to service_role;

-- ======================================================================
-- 20261027000100_phase20d_template_delivery.sql
-- ======================================================================
-- Phase 20d (docs/26_PHASE_20D_NOTES.md): template delivery settings, retry-on-fail, template performance.
-- Service role writes everything here; no new table, so no new policy (wa_templates / messages keep theirs).
--
--   wa_templates.retry_on_fail   (existing since Phase 3, unused until now) one bounded WhatsApp retry chain for a
--                                non-campaign template message that failed with a retryable code
--   wa_templates.sms_fallback    may an appointment reminder sent with this template fall back to SMS (Phase 19a path)?
--                                Default true keeps the Phase 19 behaviour; it never applies to MARKETING templates
--                                (lib/templates/delivery.ts smsFallbackAllowed)
--   wa_templates.ttl_seconds     a message of this template that could not be sent within this many seconds of being
--                                queued is not sent at all (outbound job guard); null = no limit
--   messages.retry_of_message_id the failed message a retry copies; unique, so a failure is retried at most once
--   v_template_message_facts     template sends (ids, statuses, times only) for the template performance report
--   report_template_performance  sent / delivered / read / replied / quick-reply clicks / failed per template and range
--   (media_asset_usage() learns carousel card headers in 20261027000200, next to recurring campaigns)

alter table public.wa_templates
  add column if not exists sms_fallback boolean not null default true,
  add column if not exists ttl_seconds integer
    check (ttl_seconds is null or ttl_seconds between 60 and 2592000);

comment on column public.wa_templates.retry_on_fail is
  'Phase 20d: a non-campaign message of this template that fails with a retryable code is sent again (bounded, lib/templates/delivery.ts).';
comment on column public.wa_templates.sms_fallback is
  'Phase 20d: an appointment reminder sent with this template may fall back to SMS (Phase 19a). Never for MARKETING templates.';
comment on column public.wa_templates.ttl_seconds is
  'Phase 20d: not sent when the message is older than this when the outbound job reaches it (null = no limit). Pulse-side guard; Meta''s own template TTL is not set from here.';

alter table public.messages
  add column if not exists retry_of_message_id uuid references public.messages (id) on delete set null;
create unique index if not exists messages_retry_of_uidx on public.messages (retry_of_message_id)
  where retry_of_message_id is not null;
comment on column public.messages.retry_of_message_id is
  'Phase 20d: the failed template message this one retries (retry_on_fail). Unique: one retry per failed message.';

-- Template performance reads outbound template messages by org and time, and quick-reply taps by the message they answer.
create index if not exists messages_org_template_out_idx on public.messages (org_id, at)
  where direction = 'out' and kind = 'template';
create index if not exists messages_in_reply_to_idx on public.messages (reply_to_wa_message_id)
  where direction = 'in' and reply_to_wa_message_id is not null;

-- ---------------------------------------------------------------------------
-- Template message facts (ids, statuses and times only; no body, no payload values).
-- ---------------------------------------------------------------------------
create or replace view public.v_template_message_facts
with (security_invoker = true) as
select m.id,
       m.org_id,
       m.conversation_id,
       cv.channel_id,
       (m.payload -> 'send' ->> 'template_id') as template_key,
       m.status,
       m.error_code,
       m.wa_message_id,
       m.at,
       m.campaign_recipient_id is not null as from_campaign,
       m.retry_of_message_id is not null as is_retry,
       (m.at at time zone o.timezone)::date as day
from public.messages m
join public.conversations cv on cv.id = m.conversation_id
join public.orgs o on o.id = m.org_id
where m.direction = 'out' and m.kind = 'template';

revoke all on public.v_template_message_facts from public, anon, authenticated;
grant select on public.v_template_message_facts to service_role;

-- sent/delivered/read are cumulative like the campaign funnel. replied = the patient wrote in the same conversation
-- within 24 hours of the template message; clicked = a quick-reply button tap that answers it (Meta reports no URL
-- button clicks). A retry is its own message row and is counted as such (`retries`).
create or replace function public.report_template_performance(
  p_org uuid, p_from date, p_to date, p_channels uuid[] default null, p_template uuid default null
)
returns table (
  template_id uuid, name text, language text, category text,
  messages integer, sent integer, delivered integer, read_count integer, replied integer, clicked integer,
  failed integer, pending integer, retries integer, from_campaigns integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with bounds as (
    select (p_from::timestamp at time zone o.timezone) as t0,
           ((p_to + 1)::timestamp at time zone o.timezone) as t1
    from public.orgs o
    where o.id = p_org
  ),
  m as (
    select f.*
    from public.v_template_message_facts f, bounds b
    where f.org_id = p_org
      and f.at >= b.t0 and f.at < b.t1
      and (p_template is null or f.template_key = p_template::text)
      and (p_channels is null or cardinality(p_channels) = 0 or f.channel_id = any (p_channels))
  ),
  scored as (
    select m.*,
           exists (
             select 1 from public.messages r
             where r.conversation_id = m.conversation_id and r.direction = 'in' and r.kind <> 'reaction'
               and r.at > m.at and r.at <= m.at + interval '24 hours'
           ) as was_replied,
           (m.wa_message_id is not null and exists (
             select 1 from public.messages r
             where r.reply_to_wa_message_id = m.wa_message_id and r.direction = 'in' and r.kind = 'button'
               and r.org_id = m.org_id
           )) as was_clicked
    from m
  )
  select t.id, t.name, t.language, t.category,
         count(*)::integer,
         count(*) filter (where s.status in ('sent', 'delivered', 'read'))::integer,
         count(*) filter (where s.status in ('delivered', 'read'))::integer,
         count(*) filter (where s.status = 'read')::integer,
         count(*) filter (where s.was_replied)::integer,
         count(*) filter (where s.was_clicked)::integer,
         count(*) filter (where s.status = 'failed')::integer,
         count(*) filter (where s.status in ('queued', 'sending'))::integer,
         count(*) filter (where s.is_retry)::integer,
         count(*) filter (where s.from_campaign)::integer
  from scored s
  join public.wa_templates t on t.id::text = s.template_key and t.org_id = p_org
  group by t.id, t.name, t.language, t.category
  order by count(*) desc, t.name
  limit 200;
$$;
revoke all on function public.report_template_performance(uuid, date, date, uuid[], uuid) from public, anon, authenticated;
grant execute on function public.report_template_performance(uuid, date, date, uuid[], uuid) to service_role;

-- ======================================================================
-- 20261027000200_phase20d_recurring_campaigns_budget.sql
-- ======================================================================
-- Phase 20d (docs/26_PHASE_20D_NOTES.md): recurring campaigns and the monthly campaign message budget.
--
--   campaign_recurrences        a repeating campaign: what to send (number, template, mapping, retries, guardrails),
--                               to which segment, and when (5-field cron in a timezone). Each run creates an ORDINARY
--                               campaign (campaigns.recurrence_id + run_key), so the audience is re-evaluated, the
--                               engine, funnel, retry rounds and guardrails are the existing ones, and a run can never
--                               be created twice (unique recurrence_id + run_key; next_run_at claimed atomically).
--   campaign_budget_months      messages dispatched by campaigns per org and calendar month (org timezone). The
--                               fanout claims room here BEFORE it dispatches (campaign_budget_claim), so the limit an
--                               administrator sets (orgs.settings.campaign_budget.monthly_limit) is a hard stop.
--   media_asset_usage()         also sees carousel card headers in a template mapping and library files in an active
--                               recurring campaign's mapping (reported as kind 'campaign').
--
-- RLS: both tables are readable with campaigns.view; every write is the service role (server actions after can(),
-- the campaign jobs). No contact data in either table.

-- ---------------------------------------------------------------------------
-- Recurring campaigns
-- ---------------------------------------------------------------------------
create table public.campaign_recurrences (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  channel_id uuid not null references public.channels (id) on delete restrict,
  template_id uuid not null references public.wa_templates (id) on delete restrict,
  segment_id uuid references public.segments (id) on delete set null,
  variable_map jsonb not null default '{}'::jsonb,
  fallbacks jsonb not null default '{}'::jsonb,
  retry_rounds integer not null default 0 check (retry_rounds between 0 and 3),
  retry_delay_minutes integer not null default 60 check (retry_delay_minutes between 5 and 1440),
  guardrails jsonb not null default '{}'::jsonb,
  cron text not null check (char_length(cron) between 9 and 120),
  timezone text not null check (char_length(timezone) between 1 and 64),
  status text not null default 'active' check (status in ('active', 'paused')),
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_run_outcome text check (last_run_outcome is null or char_length(last_run_outcome) <= 80),
  last_campaign_id uuid references public.campaigns (id) on delete set null,
  runs integer not null default 0,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status = 'paused' or next_run_at is not null)
);
create index campaign_recurrences_org_idx on public.campaign_recurrences (org_id, created_at desc);
create index campaign_recurrences_due_idx on public.campaign_recurrences (next_run_at) where status = 'active';
create trigger campaign_recurrences_set_updated_at before update on public.campaign_recurrences
  for each row execute function app.set_updated_at();
create trigger campaign_recurrences_channel_org_check before insert or update on public.campaign_recurrences
  for each row execute function app.check_parent_org('channels', 'channel_id');
create trigger campaign_recurrences_template_org_check before insert or update on public.campaign_recurrences
  for each row execute function app.check_parent_org('wa_templates', 'template_id');
create trigger campaign_recurrences_segment_org_check before insert or update on public.campaign_recurrences
  for each row execute function app.check_parent_org('segments', 'segment_id');

alter table public.campaign_recurrences enable row level security;
create policy campaign_recurrences_select on public.campaign_recurrences for select to authenticated
  using (app.has_perm(org_id, 'campaigns.view'));
-- writes: server actions (campaigns.create, service role after can()) and the campaign jobs

alter table public.campaigns
  add column if not exists recurrence_id uuid references public.campaign_recurrences (id) on delete set null,
  add column if not exists run_key text check (run_key is null or char_length(run_key) <= 40);
create unique index if not exists campaigns_recurrence_run_uidx on public.campaigns (recurrence_id, run_key)
  where recurrence_id is not null;
create index if not exists campaigns_recurrence_idx on public.campaigns (recurrence_id, created_at desc)
  where recurrence_id is not null;
comment on column public.campaigns.run_key is
  'Phase 20d: the scheduled time (UTC, minute) of the recurring run that created this campaign; one campaign per run.';

-- One run of a recurring campaign. Atomically moves next_run_at from p_run_at to p_next_run_at (only the caller that
-- still sees p_run_at wins: overlapping jobs, the tick safety net and a replayed job cannot run it twice). With a
-- skip reason the run is only recorded; otherwise a 'preparing' campaign is created for it (the caller snapshots the
-- audience and starts it). Returns the new campaign id, or null (not claimed, paused, stale time or skipped).
create or replace function public.campaign_recurrence_claim(
  p_recurrence_id uuid, p_run_at timestamptz, p_next_run_at timestamptz, p_skip_reason text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.campaign_recurrences;
  v_id uuid;
  v_key text;
begin
  if p_next_run_at is null or p_next_run_at <= p_run_at then
    raise exception 'next run must be after this run' using errcode = 'invalid_parameter_value';
  end if;
  update public.campaign_recurrences
     set next_run_at = p_next_run_at, last_run_at = now(), runs = runs + 1,
         last_run_outcome = case when p_skip_reason is null then 'running' else left('skipped:' || p_skip_reason, 80) end
   where id = p_recurrence_id and status = 'active' and next_run_at = p_run_at
  returning * into r;
  if r.id is null or p_skip_reason is not null then
    return null;
  end if;
  v_key := to_char(p_run_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"');
  insert into public.campaigns (
    org_id, name, channel_id, template_id, audience_type, segment_id, variable_map, fallbacks, status,
    retry_rounds, retry_delay_minutes, guardrails, created_by, recurrence_id, run_key
  )
  values (
    r.org_id, left(r.name || ' · ' || to_char(p_run_at at time zone r.timezone, 'DD Mon YYYY HH24:MI'), 120),
    r.channel_id, r.template_id, 'segment', r.segment_id, r.variable_map, r.fallbacks, 'preparing',
    r.retry_rounds, r.retry_delay_minutes, r.guardrails, r.created_by, r.id, v_key
  )
  on conflict (recurrence_id, run_key) where recurrence_id is not null do nothing
  returning id into v_id;
  if v_id is not null then
    update public.campaign_recurrences set last_campaign_id = v_id, last_run_outcome = 'created' where id = r.id;
  end if;
  return v_id;
end;
$$;
revoke all on function public.campaign_recurrence_claim(uuid, timestamptz, timestamptz, text) from public, anon, authenticated;
grant execute on function public.campaign_recurrence_claim(uuid, timestamptz, timestamptz, text) to service_role;

-- ---------------------------------------------------------------------------
-- Monthly campaign message budget
-- ---------------------------------------------------------------------------
create table public.campaign_budget_months (
  org_id uuid not null references public.orgs (id) on delete cascade,
  month date not null check (extract(day from month) = 1),
  used integer not null default 0 check (used >= 0),
  updated_at timestamptz not null default now(),
  primary key (org_id, month)
);
alter table public.campaign_budget_months enable row level security;
create policy campaign_budget_months_select on public.campaign_budget_months for select to authenticated
  using (app.has_perm(org_id, 'campaigns.view'));
-- writes: campaign_budget_claim / campaign_budget_refund (service role)

-- The limit an administrator set (orgs.settings.campaign_budget.monthly_limit), null = no limit. A value that is
-- present but not a whole number fails closed (0) rather than lifting the stop.
create or replace function app.campaign_budget_limit(p_settings jsonb)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case
    when p_settings is null or p_settings -> 'campaign_budget' -> 'monthly_limit' is null
      or jsonb_typeof(p_settings -> 'campaign_budget' -> 'monthly_limit') = 'null' then null
    when (p_settings -> 'campaign_budget' ->> 'monthly_limit') ~ '^[0-9]{1,9}$'
      then (p_settings -> 'campaign_budget' ->> 'monthly_limit')::integer
    else 0
  end;
$$;

-- Claims room for p_requested campaign messages in the current month (org timezone) and returns how many may be
-- dispatched now: all of them without a limit, at most what is left with one, 0 once the limit is reached. The
-- month row is locked, so two fanouts running at once can never pass the limit together.
create or replace function public.campaign_budget_claim(p_org uuid, p_requested integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer;
  v_month date;
  v_used integer;
  v_grant integer;
begin
  if coalesce(p_requested, 0) <= 0 then
    return 0;
  end if;
  select app.campaign_budget_limit(o.settings), date_trunc('month', now() at time zone o.timezone)::date
    into v_limit, v_month
    from public.orgs o where o.id = p_org;
  if v_month is null then
    return 0; -- unknown org: fail closed
  end if;
  insert into public.campaign_budget_months (org_id, month) values (p_org, v_month)
  on conflict (org_id, month) do nothing;
  select used into v_used from public.campaign_budget_months where org_id = p_org and month = v_month for update;
  v_grant := case when v_limit is null then p_requested else greatest(0, least(p_requested, v_limit - v_used)) end;
  if v_grant > 0 then
    update public.campaign_budget_months set used = used + v_grant, updated_at = now()
     where org_id = p_org and month = v_month;
  end if;
  return v_grant;
end;
$$;
revoke all on function public.campaign_budget_claim(uuid, integer) from public, anon, authenticated;
grant execute on function public.campaign_budget_claim(uuid, integer) to service_role;

-- Gives back room that was claimed but not used (recipients skipped at dispatch). Never below zero.
create or replace function public.campaign_budget_refund(p_org uuid, p_count integer)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.campaign_budget_months b
     set used = greatest(0, b.used - greatest(coalesce(p_count, 0), 0)), updated_at = now()
    from public.orgs o
   where o.id = p_org and b.org_id = p_org
     and b.month = date_trunc('month', now() at time zone o.timezone)::date
     and coalesce(p_count, 0) > 0;
$$;
revoke all on function public.campaign_budget_refund(uuid, integer) from public, anon, authenticated;
grant execute on function public.campaign_budget_refund(uuid, integer) to service_role;

-- The meter: this month's use and the limit (null = none).
create or replace function public.campaign_budget_status(p_org uuid)
returns table (month date, used integer, monthly_limit integer)
language sql
stable
security definer
set search_path = ''
as $$
  select m.month, coalesce(b.used, 0), app.campaign_budget_limit(o.settings)
    from public.orgs o
    cross join lateral (select date_trunc('month', now() at time zone o.timezone)::date as month) m
    left join public.campaign_budget_months b on b.org_id = o.id and b.month = m.month
   where o.id = p_org;
$$;
revoke all on function public.campaign_budget_status(uuid) from public, anon, authenticated;
grant execute on function public.campaign_budget_status(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- media_asset_usage: carousel card headers (any key of a template mapping) and active recurring campaigns.
-- Same contract as 20261015000100_media_library.sql.
-- ---------------------------------------------------------------------------
create or replace function public.media_asset_usage(p_org uuid, p_asset uuid)
returns table (kind text, ref_id uuid, ref_name text, ref_status text, blocking boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select 'template'::text, t.id, t.name, t.status,
         (t.archived_at is null and t.status not in ('REJECTED', 'DISABLED', 'DELETED', 'PENDING_DELETION'))
    from public.wa_templates t
   where t.org_id = p_org
     and jsonb_typeof(t.variable_map) = 'object'
     and exists (select 1 from jsonb_each_text(t.variable_map) e where e.value = 'media:' || p_asset::text)
  union all
  select 'campaign'::text, c.id, c.name, c.status,
         (c.status in ('preparing', 'scheduled', 'queued', 'sending', 'paused'))
    from public.campaigns c
   where c.org_id = p_org
     and jsonb_typeof(c.variable_map) = 'object'
     and exists (select 1 from jsonb_each_text(c.variable_map) e where e.value = 'media:' || p_asset::text)
  union all
  select 'campaign'::text, r.id, left('Recurring: ' || r.name, 140), 'recurring ' || r.status, (r.status = 'active')
    from public.campaign_recurrences r
   where r.org_id = p_org
     and jsonb_typeof(r.variable_map) = 'object'
     and exists (select 1 from jsonb_each_text(r.variable_map) e where e.value = 'media:' || p_asset::text)
  union all
  select 'quick_reply'::text, q.id, q.shortcut, null::text, true
    from public.quick_replies q
   where q.org_id = p_org and q.media_asset_id = p_asset;
$$;
revoke all on function public.media_asset_usage(uuid, uuid) from public, anon, authenticated;
grant execute on function public.media_asset_usage(uuid, uuid) to service_role;

-- ======================================================================
-- 20261028000100_web_chat_social_channels.sql
-- ======================================================================
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

-- ======================================================================
-- 20261028000200_google_calendar_sync.sql
-- ======================================================================
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

-- ======================================================================
-- 20261029000100_phase20_integration.sql
-- ======================================================================
-- Phase 20 integration: enquiry tags follow the restricted enquiry view (20c). The tag rows of an enquiry a member
-- may not see are hidden too; the enquiries policy (app.enquiry_visible_to) decides inside the exists.

drop policy enquiry_tags_select on public.enquiry_tags;
create policy enquiry_tags_select on public.enquiry_tags for select to authenticated
  using (
    app.has_perm(org_id, 'enquiries.view')
    and exists (select 1 from public.enquiries e where e.id = enquiry_id)
  );

drop policy enquiry_tags_insert on public.enquiry_tags;
create policy enquiry_tags_insert on public.enquiry_tags for insert to authenticated
  with check (
    app.has_perm(org_id, 'enquiries.manage')
    and exists (select 1 from public.enquiries e where e.id = enquiry_id)
  );

drop policy enquiry_tags_delete on public.enquiry_tags;
create policy enquiry_tags_delete on public.enquiry_tags for delete to authenticated
  using (
    app.has_perm(org_id, 'enquiries.manage')
    and exists (select 1 from public.enquiries e where e.id = enquiry_id)
  );

insert into supabase_migrations.schema_migrations (version, name) values ('20261023000100', 'sanoflow_import') on conflict (version) do nothing;
insert into supabase_migrations.schema_migrations (version, name) values ('20261023000200', 'enquiry_tags_campaign_archive') on conflict (version) do nothing;
insert into supabase_migrations.schema_migrations (version, name) values ('20261024000100', 'flow_parity') on conflict (version) do nothing;
insert into supabase_migrations.schema_migrations (version, name) values ('20261025000100', 'routing_presence') on conflict (version) do nothing;
insert into supabase_migrations.schema_migrations (version, name) values ('20261025000200', 'routing_reports') on conflict (version) do nothing;
insert into supabase_migrations.schema_migrations (version, name) values ('20261026000100', 'booking_capacity') on conflict (version) do nothing;
insert into supabase_migrations.schema_migrations (version, name) values ('20261027000100', 'phase20d_template_delivery') on conflict (version) do nothing;
insert into supabase_migrations.schema_migrations (version, name) values ('20261027000200', 'phase20d_recurring_campaigns_budget') on conflict (version) do nothing;
insert into supabase_migrations.schema_migrations (version, name) values ('20261028000100', 'web_chat_social_channels') on conflict (version) do nothing;
insert into supabase_migrations.schema_migrations (version, name) values ('20261028000200', 'google_calendar_sync') on conflict (version) do nothing;
insert into supabase_migrations.schema_migrations (version, name) values ('20261029000100', 'phase20_integration') on conflict (version) do nothing;
