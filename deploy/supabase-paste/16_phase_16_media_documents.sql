-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Phase 16 (Media Library and patient documents). Needs the earlier files first, including
-- 14_phase_14_front_desk.sql.
-- Check the project name in the Supabase header first: this is for the Pulse project only.
-- Creates two PRIVATE storage buckets (media-library, patient-documents) when the storage schema exists, grants the new
-- media.* and documents.* permissions to the existing Manager, Agent, Receptionist, Care coordinator and Marketing roles,
-- and schedules pulse:documents_maintenance (daily). Patient documents stay OFF until an administrator switches them on
-- under Settings > Patient documents (see docs/15_PHASE_16_NOTES.md, open question OQ-68).

-- ======================================================================
-- 20261015000100_media_library.sql
-- ======================================================================
-- Phase 16 (1/4): the Media Library.
--
--   media_folders    one flat level of folders per org
--   media_assets     org-wide images, PDFs and videos used by the template builder (header media), campaigns,
--                    quick replies and conversations. The bytes live in the private `media-library` bucket
--                    at <org>/<asset>/original.<ext> (+ thumb.jpg); file names chosen by people never reach a path.
--   quick_replies.media_asset_id   a quick reply may carry a library file
--   media_asset_usage()            where an asset is used, and whether that use blocks deleting it
--
-- Permissions media.view / media.manage are new. Existing system roles get them here (idempotent); new orgs
-- get them from lib/auth/permissions.ts. Writes to the tables below go through server code after can() with the
-- service role, so there are SELECT policies only (a signed-in browser client can read, never write).
-- No storage.objects policy is created either: files are reached only through short-lived signed URLs minted
-- by the server after a permission check.

-- ---------------------------------------------------------------------------
-- Permissions for existing system roles (Phase 16 also adds documents.* here, used by migration 2/4)
-- ---------------------------------------------------------------------------
do $$
declare
  g record;
begin
  for g in
    select * from (values
      ('Manager', 'media.view'), ('Manager', 'media.manage'),
      ('Manager', 'documents.view'), ('Manager', 'documents.manage'),
      ('Agent', 'media.view'),
      ('Receptionist', 'media.view'), ('Receptionist', 'documents.view'), ('Receptionist', 'documents.manage'),
      ('Care coordinator', 'media.view'), ('Care coordinator', 'documents.view'), ('Care coordinator', 'documents.manage'),
      ('Marketing', 'media.view'), ('Marketing', 'media.manage')
    ) as t (role_name, perm)
  loop
    update public.roles r
       set permissions = r.permissions || to_jsonb(g.perm)
     where r.is_system and r.name = g.role_name and not (r.permissions ? g.perm);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Storage buckets (skipped on plain Postgres, which has no storage schema)
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_tables where schemaname = 'storage' and tablename = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'media-library', 'media-library', false, 104857600,
      array[
        'image/jpeg', 'image/png', 'video/mp4', 'video/3gpp', 'application/pdf', 'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'text/plain'
      ]
    )
    on conflict (id) do nothing;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- media_folders
-- ---------------------------------------------------------------------------
create table public.media_folders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index media_folders_org_name_idx on public.media_folders (org_id, lower(name));

-- ---------------------------------------------------------------------------
-- media_assets
-- ---------------------------------------------------------------------------
create table public.media_assets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  folder_id uuid references public.media_folders (id) on delete set null,
  name text not null check (char_length(name) between 1 and 120),
  kind text not null check (kind in ('image', 'video', 'document')),
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0),
  original_size_bytes bigint check (original_size_bytes is null or original_size_bytes > 0),
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  storage_path text not null unique,
  thumb_path text,
  tags text[] not null default '{}' check (cardinality(tags) <= 10),
  -- 'pending' from the moment an upload is prepared until the server has checked the stored object.
  status text not null default 'pending' check (status in ('pending', 'ready')),
  -- 'unscanned' until a malware scanner is configured (docs/15_PHASE_16_NOTES.md); 'infected' is never served.
  scan_status text not null default 'unscanned' check (scan_status in ('unscanned', 'clean', 'infected', 'error')),
  scanned_at timestamptz,
  scan_engine text,
  uploaded_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index media_assets_org_status_idx on public.media_assets (org_id, status, created_at desc);
create index media_assets_org_folder_idx on public.media_assets (org_id, folder_id) where status = 'ready';
create index media_assets_tags_idx on public.media_assets using gin (tags);
create trigger media_assets_set_updated_at before update on public.media_assets
  for each row execute function app.set_updated_at();
create trigger media_assets_folder_org_check before insert or update on public.media_assets
  for each row execute function app.check_parent_org('media_folders', 'folder_id');

-- A quick reply may send a library file with its text. The foreign key (NO ACTION, checked at the end of the
-- statement) stops deleting a file that a quick reply uses, yet lets the whole org go in one cascade.
alter table public.quick_replies
  add column media_asset_id uuid references public.media_assets (id);
create trigger quick_replies_media_org_check before insert or update on public.quick_replies
  for each row execute function app.check_parent_org('media_assets', 'media_asset_id');
create index quick_replies_media_idx on public.quick_replies (media_asset_id) where media_asset_id is not null;

-- ---------------------------------------------------------------------------
-- Where is an asset used? Template (header media), campaign, quick reply.
-- A template or campaign variable map refers to the library as "media:<asset id>".
-- `blocking` = deleting the asset would break something live:
--   template   not archived and not REJECTED / DISABLED / DELETED / PENDING_DELETION
--   campaign   preparing, scheduled, queued, sending or paused (finished and cancelled ones only inform)
--   quick reply always
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
     and t.variable_map ->> 'header.media' = 'media:' || p_asset::text
  union all
  select 'campaign'::text, c.id, c.name, c.status,
         (c.status in ('preparing', 'scheduled', 'queued', 'sending', 'paused'))
    from public.campaigns c
   where c.org_id = p_org
     and jsonb_typeof(c.variable_map) = 'object'
     and exists (select 1 from jsonb_each_text(c.variable_map) e where e.value = 'media:' || p_asset::text)
  union all
  select 'quick_reply'::text, q.id, q.shortcut, null::text, true
    from public.quick_replies q
   where q.org_id = p_org and q.media_asset_id = p_asset;
$$;
revoke all on function public.media_asset_usage(uuid, uuid) from public, anon, authenticated;
grant execute on function public.media_asset_usage(uuid, uuid) to service_role;

-- Defence in depth: whatever deletes an asset, a live use blocks it. The org cascade is let through.
create or replace function app.media_assets_block_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.orgs o where o.id = old.org_id)
     and exists (select 1 from public.media_asset_usage(old.org_id, old.id) u where u.blocking) then
    raise exception 'this file is used by a live template, campaign or quick reply' using errcode = 'restrict_violation';
  end if;
  return old;
end;
$$;
create trigger media_assets_block_delete before delete on public.media_assets
  for each row execute function app.media_assets_block_delete();

-- ---------------------------------------------------------------------------
-- RLS: read with media.view or media.manage; no write policy (server code, service role, after can())
-- ---------------------------------------------------------------------------
alter table public.media_folders enable row level security;
alter table public.media_assets enable row level security;

create policy media_folders_select on public.media_folders for select to authenticated
  using (app.has_perm(org_id, 'media.view') or app.has_perm(org_id, 'media.manage'));
create policy media_assets_select on public.media_assets for select to authenticated
  using (app.has_perm(org_id, 'media.view') or app.has_perm(org_id, 'media.manage'));

-- ======================================================================
-- 20261015000200_patient_documents.sql
-- ======================================================================
-- Phase 16 (2/4): patient documents.
--
--   patient_documents             a patient's referral letters, lab reports, insurance cards and consent forms.
--                                 Bytes live in the private `patient-documents` bucket at
--                                 <org>/<contact>/<document>.<ext>; the title typed by staff stays in this row.
--   document_retention_policies   how long each category is kept, and whether the nightly job may delete (off by default)
--
-- Permissions documents.view / documents.manage are NOT inherited from contacts.* (granted to existing roles in
-- migration 1/4). The SELECT policy needs documents.view; writes are server-only (service role after can()), so
-- every upload, edit and delete is audited by the server action. Who opened a file goes to record_access_log.
-- Orphaned uploads (status 'pending') and expiring cards are handled by the daily documents_maintenance task.

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_tables where schemaname = 'storage' and tablename = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'patient-documents', 'patient-documents', false, 26214400,
      array[
        'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      ]
    )
    on conflict (id) do nothing;
  end if;
end $$;

create table public.patient_documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  category text not null check (category in ('referral', 'lab_report', 'insurance_card', 'consent', 'other')),
  title text not null check (char_length(title) between 1 and 120),
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0),
  storage_path text not null unique,
  status text not null default 'pending' check (status in ('pending', 'ready')),
  scan_status text not null default 'unscanned' check (scan_status in ('unscanned', 'clean', 'infected', 'error')),
  scanned_at timestamptz,
  scan_engine text,
  expires_on date,
  -- set when the "expiring soon" reminder was raised, so a retry never reminds twice
  expiry_notified_at timestamptz,
  uploaded_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index patient_documents_contact_idx on public.patient_documents (org_id, contact_id, created_at desc);
create index patient_documents_org_cat_idx on public.patient_documents (org_id, category) where status = 'ready';
create index patient_documents_pending_idx on public.patient_documents (created_at) where status = 'pending';
create index patient_documents_expiry_idx on public.patient_documents (org_id, expires_on)
  where status = 'ready' and expiry_notified_at is null and expires_on is not null;
create trigger patient_documents_set_updated_at before update on public.patient_documents
  for each row execute function app.set_updated_at();
create trigger patient_documents_contact_org_check before insert or update on public.patient_documents
  for each row execute function app.check_parent_org('contacts', 'contact_id');

-- When two patient records are merged the documents follow the surviving record. (A trigger rather than a
-- change to merge_contacts, so a later rewrite of that function cannot forget it.) The storage path keeps the
-- original contact id; the server only ever compares the org and the document id.
create or replace function app.move_documents_on_merge()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.merged_into_id is not null and new.merged_into_id is distinct from old.merged_into_id then
    update public.patient_documents set contact_id = new.merged_into_id
     where org_id = new.org_id and contact_id = new.id;
  end if;
  return new;
end;
$$;
create trigger contacts_move_documents_on_merge after update of merged_into_id on public.contacts
  for each row execute function app.move_documents_on_merge();

create table public.document_retention_policies (
  org_id uuid not null references public.orgs (id) on delete cascade,
  category text not null check (category in ('referral', 'lab_report', 'insurance_card', 'consent', 'other')),
  -- null = keep for ever. The clock starts at upload, or at the expiry date when that is later.
  retain_days integer check (retain_days is null or retain_days between 30 and 36500),
  -- off: documents past retention are only listed for review. on: the nightly task deletes them.
  auto_delete boolean not null default false,
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (org_id, category),
  check (not auto_delete or retain_days is not null)
);

alter table public.patient_documents enable row level security;
alter table public.document_retention_policies enable row level security;

create policy patient_documents_select on public.patient_documents for select to authenticated
  using (app.has_perm(org_id, 'documents.view'));
create policy document_retention_policies_select on public.document_retention_policies for select to authenticated
  using (app.has_perm(org_id, 'documents.manage') or app.has_perm(org_id, 'settings.manage'));

-- Daily upkeep: expiry reminders, abandoned uploads, retention (runs in the app so it can use Storage and notify).
select cron.schedule('pulse:documents_maintenance', '40 3 * * *', $$select app.ping_jobs('documents_maintenance')$$);

-- ======================================================================
-- 20261015000300_documents_erasure.sql
-- ======================================================================
-- Phase 16 (3/4): erasure covers a patient's documents.
--
-- public.erase_contact() is replaced with the Phase 15 body plus one step: the patient's rows in
-- patient_documents are deleted and the count is reported as documents_deleted. The files themselves are
-- removed from the private bucket by the server action BEFORE this function runs (storage is outside the
-- database transaction, so that step is retryable, exactly as for inbox media).

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

  -- Phase 16: the patient's uploaded documents (referrals, lab reports, insurance cards, consent forms).
  delete from public.patient_documents where org_id = p_org and contact_id = p_contact;
  get diagnostics n = row_count; r := r || jsonb_build_object('documents_deleted', n);

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

-- ======================================================================
-- 20261015000400_storage_usage.sql
-- ======================================================================
-- Phase 16 (4/4): the storage usage dashboard (Settings, Patient documents).
--
-- storage_usage_summary(org) returns one jsonb document of counts and byte totals for the Media Library and
-- patient documents: by type or category, by upload month (documents), files not yet scanned or blocked by the
-- scan, uploads that never finished, and insurance cards due to expire within 30 days. Counts and sizes only:
-- no titles, no names, no paths. Service role only (the page checks settings.manage first).
-- Files received from patients over WhatsApp live in the wa-media bucket and are not counted here: the message
-- rows do not store a size.

create or replace function public.storage_usage_summary(p_org uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'library', (
      select coalesce(jsonb_object_agg(k.kind, jsonb_build_object('files', k.files, 'bytes', k.bytes)), '{}'::jsonb)
      from (select kind, count(*) as files, coalesce(sum(size_bytes), 0)::bigint as bytes
              from public.media_assets where org_id = p_org and status = 'ready' group by kind) k
    ),
    'documents', (
      select coalesce(jsonb_object_agg(c.category, jsonb_build_object('files', c.files, 'bytes', c.bytes)), '{}'::jsonb)
      from (select category, count(*) as files, coalesce(sum(size_bytes), 0)::bigint as bytes
              from public.patient_documents where org_id = p_org and status = 'ready' group by category) c
    ),
    'documents_by_month', (
      select coalesce(jsonb_agg(jsonb_build_object('month', m.month, 'files', m.files, 'bytes', m.bytes) order by m.month), '[]'::jsonb)
      from (select to_char(date_trunc('month', created_at), 'YYYY-MM') as month, count(*) as files,
                   coalesce(sum(size_bytes), 0)::bigint as bytes
              from public.patient_documents
             where org_id = p_org and status = 'ready' and created_at > now() - interval '12 months'
             group by 1) m
    ),
    'library_unscanned', (select count(*) from public.media_assets where org_id = p_org and status = 'ready' and scan_status in ('unscanned', 'error')),
    'library_blocked', (select count(*) from public.media_assets where org_id = p_org and status = 'ready' and scan_status = 'infected'),
    'documents_unscanned', (select count(*) from public.patient_documents where org_id = p_org and status = 'ready' and scan_status in ('unscanned', 'error')),
    'documents_blocked', (select count(*) from public.patient_documents where org_id = p_org and status = 'ready' and scan_status = 'infected'),
    'pending_uploads', (
      (select count(*) from public.media_assets where org_id = p_org and status = 'pending')
      + (select count(*) from public.patient_documents where org_id = p_org and status = 'pending')
    ),
    'cards_expiring_30d', (
      select count(*) from public.patient_documents
       where org_id = p_org and status = 'ready' and category = 'insurance_card'
         and expires_on is not null and expires_on >= current_date and expires_on < current_date + 30
    ),
    'cards_expired', (
      select count(*) from public.patient_documents
       where org_id = p_org and status = 'ready' and category = 'insurance_card'
         and expires_on is not null and expires_on < current_date
    )
  );
$$;
revoke all on function public.storage_usage_summary(uuid) from public, anon, authenticated;
grant execute on function public.storage_usage_summary(uuid) to service_role;
