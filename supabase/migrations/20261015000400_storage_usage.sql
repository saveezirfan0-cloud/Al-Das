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
