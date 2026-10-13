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
