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
