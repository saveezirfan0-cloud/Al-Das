-- Phase 11: counts-only snapshot used by `pnpm reconcile` (migration sign-off).
-- Returns numbers, never rows: no names, phones or message text leave the database.
-- Service role only.

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
