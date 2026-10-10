-- Finance F7: one read-only view that tells a finance user how fresh and how
-- complete the data behind the portal is ("data as of", setup checklist).
--
-- It runs with the owner's rights because the raw tables and credentials are
-- service-only, and exposes nothing but dates, counts and yes/no flags. It is
-- filtered by app.has_perm(org_id, 'finance.view'), so a member only ever sees
-- their own org and only with the Finance permission.

create view public.v_fin_data_freshness with (security_invoker = false) as
select s.org_id,
       s.enabled                                                                   as capture_enabled,
       exists (select 1 from public.integration_accounts a
               where a.org_id = s.org_id and a.kind = 'unite')                     as credentials_configured,
       (select max(b.processed_at) from public.fin_raw_unite_batches b
         where b.org_id = s.org_id and b.process_status = 'processed')             as last_capture_at,
       (select max(f.committed_at) from public.fin_raw_diligence_files f
         where f.org_id = s.org_id and f.status = 'committed')                     as last_import_at,
       (select count(*) from public.fin_raw_unite_batches b where b.org_id = s.org_id)      as batch_count,
       (select count(*) from public.fin_invoices i where i.org_id = s.org_id and not i.is_deleted) as invoice_count,
       (select count(*) from public.ins_claim_activities c where c.org_id = s.org_id)       as claim_count,
       (select count(*) from public.fin_ref_branches r
         where r.org_id = s.org_id and r.active and r.unite_clinic_long_name is not null)   as branches_mapped,
       (select count(*) from public.fin_ref_exception_rules x
         where x.org_id = s.org_id and x.active)                                   as active_rules,
       (select count(*) from public.ops_exceptions e
         where e.org_id = s.org_id and e.status in ('open', 'in_progress'))        as open_exceptions
from public.fin_capture_settings s
where app.has_perm(s.org_id, 'finance.view');

revoke all on public.v_fin_data_freshness from anon;
grant select on public.v_fin_data_freshness to authenticated, service_role;
