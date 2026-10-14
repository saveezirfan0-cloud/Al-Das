-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Phase B branch access: who works in which branches (all, or one or several), a home branch, and the rule that
-- hides other branches' diary, front desk and enquiries from people limited to some branches. Everyone starts on
-- "all branches", so nothing changes until an administrator sets someone's branches under Settings, Users.
-- Needs every earlier file first, up to and including 62_flow_step_send_key.sql.
-- Check the project name in the Supabase header first: this is for the Pulse project only.

-- ======================================================================
-- 20261123000100_branch_access.sql
-- ======================================================================
-- Phase B (docs/34_CLINIC_OS_PLAN.md): branch access.
--
--   memberships.branch_scope      'all' (default, no change) | 'selected'
--   membership_locations          the branches a 'selected' member may work in (one or several)
--   memberships.home_location_id  the branch Pulse opens on for that person (must be one they may see)
--   locations.branch_code         the finance / Unite branch code (fin_ref_branches.code), so clinical and finance
--                                 branches finally meet
--
-- app.location_visible_to() is the one rule: RLS below and the service-role loaders (lib/branches/access.ts) both
-- follow it. A row with no branch (location_id null) stays visible to everyone who may see the table.

alter table public.memberships
  add column branch_scope text not null default 'all' check (branch_scope in ('all', 'selected')),
  add column home_location_id uuid references public.locations (id) on delete set null;

alter table public.locations add column branch_code text;
create unique index locations_org_branch_code_key on public.locations (org_id, branch_code)
  where branch_code is not null;

create table public.membership_locations (
  org_id uuid not null references public.orgs (id) on delete cascade,
  membership_id uuid not null references public.memberships (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (membership_id, location_id)
);
create index membership_locations_location_idx on public.membership_locations (location_id);
create trigger membership_locations_membership_org before insert or update on public.membership_locations
  for each row execute function app.check_parent_org('memberships', 'membership_id');
create trigger membership_locations_location_org before insert or update on public.membership_locations
  for each row execute function app.check_parent_org('locations', 'location_id');
create trigger memberships_home_location_org before insert or update of home_location_id on public.memberships
  for each row execute function app.check_parent_org('locations', 'home_location_id');

-- Members read their org's branch assignments (the Users page and the branch switcher); every write is a server
-- action with settings.manage through the service role.
alter table public.membership_locations enable row level security;
create policy membership_locations_select on public.membership_locations for select to authenticated
  using (app.is_org_member(org_id));

create or replace function app.location_visible_to(p_org_id uuid, p_user_id uuid, p_location_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_membership uuid;
  v_scope text;
begin
  if p_user_id is null then
    return false;
  end if;
  select m.id, m.branch_scope into v_membership, v_scope
  from public.memberships m
  where m.org_id = p_org_id and m.user_id = p_user_id and m.status = 'active';
  if v_membership is null then
    return false;
  end if;
  if v_scope = 'all' or p_location_id is null then
    return true;
  end if;
  return exists (
    select 1 from public.membership_locations ml
    where ml.membership_id = v_membership and ml.location_id = p_location_id
  );
end;
$$;
revoke all on function app.location_visible_to(uuid, uuid, uuid) from public, anon;
grant execute on function app.location_visible_to(uuid, uuid, uuid) to authenticated, service_role;

-- Appointments: the diary of a branch a member may not work in is hidden and read-only to them.
drop policy appointments_select on public.appointments;
create policy appointments_select on public.appointments for select to authenticated
  using (app.has_perm(org_id, 'appointments.view') and app.location_visible_to(org_id, auth.uid(), location_id));
drop policy appointments_insert on public.appointments;
create policy appointments_insert on public.appointments for insert to authenticated
  with check (app.has_perm(org_id, 'appointments.manage') and app.location_visible_to(org_id, auth.uid(), location_id));
drop policy appointments_update on public.appointments;
create policy appointments_update on public.appointments for update to authenticated
  using (app.has_perm(org_id, 'appointments.manage') and app.location_visible_to(org_id, auth.uid(), location_id))
  with check (app.has_perm(org_id, 'appointments.manage') and app.location_visible_to(org_id, auth.uid(), location_id));
drop policy appointments_delete on public.appointments;
create policy appointments_delete on public.appointments for delete to authenticated
  using (app.has_perm(org_id, 'appointments.manage') and app.location_visible_to(org_id, auth.uid(), location_id));

-- Enquiries: from the last definition (20261110000200_routing_presence.sql), branch added.
drop policy enquiries_select on public.enquiries;
create policy enquiries_select on public.enquiries for select to authenticated
  using (app.has_perm(org_id, 'enquiries.view')
         and app.enquiry_visible_to(org_id, auth.uid(), assignee_id, created_by)
         and app.location_visible_to(org_id, auth.uid(), location_id));
drop policy enquiries_update on public.enquiries;
create policy enquiries_update on public.enquiries for update to authenticated
  using (app.has_perm(org_id, 'enquiries.manage')
         and app.enquiry_visible_to(org_id, auth.uid(), assignee_id, created_by)
         and app.location_visible_to(org_id, auth.uid(), location_id))
  with check (app.has_perm(org_id, 'enquiries.manage'));
drop policy enquiries_delete on public.enquiries;
create policy enquiries_delete on public.enquiries for delete to authenticated
  using (app.has_perm(org_id, 'enquiries.delete')
         and app.enquiry_visible_to(org_id, auth.uid(), assignee_id, created_by)
         and app.location_visible_to(org_id, auth.uid(), location_id));

-- Front desk: waiting list and handover notes follow the branch too.
drop policy waitlist_entries_select on public.waitlist_entries;
create policy waitlist_entries_select on public.waitlist_entries for select to authenticated
  using (app.has_perm(org_id, 'frontdesk.use') and app.location_visible_to(org_id, auth.uid(), location_id));
drop policy waitlist_entries_update on public.waitlist_entries;
create policy waitlist_entries_update on public.waitlist_entries for update to authenticated
  using (app.has_perm(org_id, 'frontdesk.use') and app.has_perm(org_id, 'appointments.manage')
         and app.location_visible_to(org_id, auth.uid(), location_id))
  with check (app.has_perm(org_id, 'frontdesk.use') and app.has_perm(org_id, 'appointments.manage'));
drop policy waitlist_entries_delete on public.waitlist_entries;
create policy waitlist_entries_delete on public.waitlist_entries for delete to authenticated
  using (app.has_perm(org_id, 'frontdesk.use') and app.has_perm(org_id, 'appointments.manage')
         and app.location_visible_to(org_id, auth.uid(), location_id));

drop policy handover_notes_select on public.handover_notes;
create policy handover_notes_select on public.handover_notes for select to authenticated
  using (app.has_perm(org_id, 'frontdesk.use') and app.location_visible_to(org_id, auth.uid(), location_id));

-- New rows: a member may only create them in a branch they may see.
drop policy enquiries_insert on public.enquiries;
create policy enquiries_insert on public.enquiries for insert to authenticated
  with check (app.has_perm(org_id, 'enquiries.manage') and app.location_visible_to(org_id, auth.uid(), location_id));
drop policy waitlist_entries_insert on public.waitlist_entries;
create policy waitlist_entries_insert on public.waitlist_entries for insert to authenticated
  with check (app.has_perm(org_id, 'frontdesk.use') and app.has_perm(org_id, 'appointments.manage')
              and app.location_visible_to(org_id, auth.uid(), location_id));
drop policy handover_notes_insert on public.handover_notes;
create policy handover_notes_insert on public.handover_notes for insert to authenticated
  with check (app.has_perm(org_id, 'frontdesk.use') and created_by = (select auth.uid())
              and app.location_visible_to(org_id, auth.uid(), location_id));
drop policy handover_notes_update on public.handover_notes;
create policy handover_notes_update on public.handover_notes for update to authenticated
  using (app.has_perm(org_id, 'frontdesk.use') and app.location_visible_to(org_id, auth.uid(), location_id))
  with check (app.has_perm(org_id, 'frontdesk.use') and app.location_visible_to(org_id, auth.uid(), location_id));

insert into supabase_migrations.schema_migrations (version, name) values ('20261123000100', 'branch_access') on conflict (version) do nothing;
