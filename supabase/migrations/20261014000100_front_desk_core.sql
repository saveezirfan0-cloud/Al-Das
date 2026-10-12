-- Phase 14 (1/3): front desk core.
--
--   orgs.is_training              sandbox flag. A training org shows a banner and never reaches Meta (the app blocks
--                                 every send; see lib/training/). Set from Settings, Training; audited.
--   appointments.checkin_status   Arrived / With doctor / Done / Checked out, kept in Pulse only (Unite stays
--                                 read-only; the Unite sync never writes these columns) plus a timestamp per step.
--   appointments.is_walk_in       registered at the desk, not booked ahead.
--   locations.latitude/longitude/maps_url   for the "send location" one-tap action.
--   quick_replies.text_ar/label   bilingual quick replies; {{variables}} are filled in by lib/inbox/quick-reply.ts.
--   handover_notes                shift handover notes for the next person on the desk.
--   help_feedback                 the Feedback button in the Help menu.
--
-- Permission frontdesk.use opens the Front desk workspace. Existing Receptionist and Manager roles get it here;
-- new orgs get it from lib/auth/permissions.ts. Every new table has RLS keyed on org_id.

-- ---------------------------------------------------------------------------
-- Training org flag
-- ---------------------------------------------------------------------------
alter table public.orgs add column is_training boolean not null default false;

-- ---------------------------------------------------------------------------
-- Check-in on the appointment (Pulse only)
-- ---------------------------------------------------------------------------
alter table public.appointments
  add column checkin_status text check (checkin_status in ('arrived', 'with_doctor', 'done', 'checked_out')),
  add column arrived_at timestamptz,
  add column with_doctor_at timestamptz,
  add column done_at timestamptz,
  add column checked_out_at timestamptz,
  add column is_walk_in boolean not null default false,
  add constraint appointments_checkin_coherent check (checkin_status is null or arrived_at is not null);

-- ---------------------------------------------------------------------------
-- Locations: where to send people
-- ---------------------------------------------------------------------------
alter table public.locations
  add column latitude numeric(9, 6) check (latitude is null or latitude between -90 and 90),
  add column longitude numeric(9, 6) check (longitude is null or longitude between -180 and 180),
  add column maps_url text check (maps_url is null or maps_url ~ '^https://');
alter table public.locations
  add constraint locations_coordinates_pair check ((latitude is null) = (longitude is null));

-- ---------------------------------------------------------------------------
-- Bilingual quick replies
-- ---------------------------------------------------------------------------
alter table public.quick_replies
  add column text_ar text check (text_ar is null or char_length(text_ar) between 1 and 4096),
  add column label text check (label is null or char_length(label) <= 80);

-- ---------------------------------------------------------------------------
-- Shift handover notes: frontdesk.use reads and writes; only an administrator deletes (staff resolve).
-- ---------------------------------------------------------------------------
create table public.handover_notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  location_id uuid references public.locations (id) on delete set null,
  body text not null check (char_length(body) between 1 and 2000),
  pinned boolean not null default false,
  resolved_at timestamptz,
  resolved_by uuid references public.profiles (id) on delete set null,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (resolved_by is null or resolved_at is not null)
);
create index handover_notes_org_created_idx on public.handover_notes (org_id, created_at desc);
create trigger handover_notes_set_updated_at
  before update on public.handover_notes for each row execute function app.set_updated_at();
create trigger handover_notes_location_org_check before insert or update on public.handover_notes
  for each row execute function app.check_parent_org('locations', 'location_id');

alter table public.handover_notes enable row level security;
create policy handover_notes_select on public.handover_notes for select to authenticated
  using (app.has_perm(org_id, 'frontdesk.use'));
create policy handover_notes_insert on public.handover_notes for insert to authenticated
  with check (app.has_perm(org_id, 'frontdesk.use') and created_by = (select auth.uid()));
create policy handover_notes_update on public.handover_notes for update to authenticated
  using (app.has_perm(org_id, 'frontdesk.use'))
  with check (app.has_perm(org_id, 'frontdesk.use'));
create policy handover_notes_delete on public.handover_notes for delete to authenticated
  using (app.has_perm(org_id, 'settings.manage'));

-- ---------------------------------------------------------------------------
-- Help feedback. A signed-in member writes their own row (the server action does it with the service role after
-- checking membership); settings.manage reads everyone's and moves it along.
-- ---------------------------------------------------------------------------
create table public.help_feedback (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete set null,
  page text not null check (char_length(page) between 1 and 200),
  kind text not null default 'idea' check (kind in ('idea', 'problem', 'question', 'praise')),
  message text not null check (char_length(message) between 1 and 2000),
  status text not null default 'new' check (status in ('new', 'seen', 'done')),
  created_at timestamptz not null default now()
);
create index help_feedback_org_created_idx on public.help_feedback (org_id, created_at desc);

alter table public.help_feedback enable row level security;
create policy help_feedback_select on public.help_feedback for select to authenticated
  using (
    app.is_org_member(org_id) and (user_id = (select auth.uid()) or app.has_perm(org_id, 'settings.manage'))
  );
create policy help_feedback_insert on public.help_feedback for insert to authenticated
  with check (app.is_org_member(org_id) and user_id = (select auth.uid()));
create policy help_feedback_update on public.help_feedback for update to authenticated
  using (app.has_perm(org_id, 'settings.manage'))
  with check (app.has_perm(org_id, 'settings.manage'));

-- ---------------------------------------------------------------------------
-- Permission for existing orgs. Idempotent: only appends a key a system role does not already hold.
-- ---------------------------------------------------------------------------
update public.roles r
   set permissions = r.permissions || to_jsonb('frontdesk.use'::text)
 where r.is_system
   and r.name in ('Receptionist', 'Manager')
   and not (r.permissions ? 'frontdesk.use');
