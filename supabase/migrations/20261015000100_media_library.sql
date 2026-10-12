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
