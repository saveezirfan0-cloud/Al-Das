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
