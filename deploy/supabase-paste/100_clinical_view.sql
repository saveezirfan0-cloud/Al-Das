-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Patient 360 (P3): the clinical.view permission for Doctor, Medical Director and Care coordinator, and the clinical tables readable with it (visits also follow the branch rule).
-- Needs every earlier file first, up to and including 93_finance_controls.sql.
-- Check the project name in the Supabase header first: this is for the Pulse project only.

-- ======================================================================
-- 20261220000100_clinical_view.sql
-- ======================================================================
-- Patient 360 (Track P, slice P3, docs/45): the `clinical.view` permission.
--
-- Clinical data (visits, diagnoses, prescriptions, chronic conditions, follow-ups, feedback) was readable only with a
-- portal key. The patient page needs a plain key that is never implied by contacts.* or portal keys, so:
--   1. The system roles Doctor, Medical Director and Care coordinator of every existing workspace get clinical.view
--      (new workspaces get it from SYSTEM_ROLES in lib/auth/permissions.ts). Additive and idempotent.
--   2. SELECT on those tables also allows clinical.view. Only the select policy is replaced; write policies, which
--      stay with the portal keys and the service role, are untouched. RLS stays keyed on org_id.
--   3. Visits additionally follow the branch rule (app.location_visible_to): a visit in a branch the member is not
--      assigned to is hidden. A visit with no branch stays visible. (The related tables are only reached through a
--      visit in the page; their own rows carry no branch.)

-- 1. Roles
update public.roles r
   set permissions = r.permissions || to_jsonb('clinical.view'::text)
 where r.is_system
   and r.name in ('Doctor', 'Medical Director', 'Care coordinator')
   and jsonb_typeof(r.permissions) = 'array'
   and not (r.permissions ? 'clinical.view');

-- 2. Select policies
drop policy if exists visits_select on public.visits;
create policy visits_select on public.visits for select to authenticated
  using (
    (app.has_perm_wild(org_id, 'portal.clinical_visits.read') or app.has_perm_wild(org_id, 'clinical.view'))
    and app.location_visible_to(org_id, auth.uid(), location_id)
  );

drop policy if exists visit_diagnoses_select on public.visit_diagnoses;
create policy visit_diagnoses_select on public.visit_diagnoses for select to authenticated
  using (app.has_perm_wild(org_id, 'portal.clinical_visits.read') or app.has_perm_wild(org_id, 'clinical.view'));

drop policy if exists prescriptions_select on public.prescriptions;
create policy prescriptions_select on public.prescriptions for select to authenticated
  using (app.has_perm_wild(org_id, 'portal.clinical_visits.read') or app.has_perm_wild(org_id, 'clinical.view'));

drop policy if exists contact_chronic_conditions_select on public.contact_chronic_conditions;
create policy contact_chronic_conditions_select on public.contact_chronic_conditions for select to authenticated
  using (app.has_perm_wild(org_id, 'portal.clinical_visits.read') or app.has_perm_wild(org_id, 'clinical.view'));

drop policy if exists clinical_followups_select on public.clinical_followups;
create policy clinical_followups_select on public.clinical_followups for select to authenticated
  using (app.has_perm_wild(org_id, 'portal.clinical_followups.read') or app.has_perm_wild(org_id, 'clinical.view'));

drop policy if exists clinical_feedback_select on public.clinical_feedback;
create policy clinical_feedback_select on public.clinical_feedback for select to authenticated
  using (app.has_perm_wild(org_id, 'portal.clinical_followups.read') or app.has_perm_wild(org_id, 'clinical.view'));
