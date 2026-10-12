-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Phase 14 (front desk, households, waiting list, help and training mode, demo reset). Needs the earlier files first,
-- including 13_phase_13_notifications_speed.sql.
-- Check the project name in the Supabase header first: this is for the Pulse project only.
-- After running it: give the Receptionist role the "Use the Front desk workspace" permission if you edited the preset
-- (existing Receptionist and Manager roles get it automatically), choose the waiting-list offer template under
-- Settings > Front desk, and add a map pin to each location under Settings > Appointment rules.

-- ======================================================================
-- 20261014000100_front_desk_core.sql
-- ======================================================================
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

-- ======================================================================
-- 20261014000200_household.sql
-- ======================================================================
-- Phase 14 (2/3): households. A dependant (usually a child) hangs under a guardian contact, so appointment
-- reminders go to the guardian's WhatsApp number and name the patient, and the guardian and the child are never
-- offered to each other as duplicates.
--
--   household_links   one row per dependant (a dependant has one guardian; a guardian has many dependants).
--                     A dependant has no phone of its own: contacts.phone_e164 is unique per org, and the
--                     shared number belongs to the guardian. Chains are refused (a guardian cannot be a
--                     dependant), so "who gets the message" is always one hop.
--
-- merge_contacts and contact_duplicate_candidates are replaced (create or replace) to know about links.
-- The merge body is the Phase 2 function plus the household steps marked "Phase 14".

create table public.household_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  guardian_contact_id uuid not null references public.contacts (id) on delete cascade,
  dependant_contact_id uuid not null references public.contacts (id) on delete cascade,
  relationship text not null default 'child' check (relationship in ('child', 'parent', 'spouse', 'other')),
  -- Send this dependant's appointment messages to the guardian. Turn off for an adult with their own WhatsApp.
  reminders_to_guardian boolean not null default true,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (org_id, dependant_contact_id),
  check (guardian_contact_id <> dependant_contact_id)
);
create index household_links_guardian_idx on public.household_links (org_id, guardian_contact_id);

create trigger household_links_guardian_org_check before insert or update on public.household_links
  for each row execute function app.check_parent_org('contacts', 'guardian_contact_id');
create trigger household_links_dependant_org_check before insert or update on public.household_links
  for each row execute function app.check_parent_org('contacts', 'dependant_contact_id');

-- One hop only: a guardian is never a dependant, and a dependant is never a guardian.
create or replace function app.household_no_chain()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.household_links h
    where h.org_id = new.org_id and h.id <> new.id and h.dependant_contact_id = new.guardian_contact_id
  ) then
    raise exception 'that guardian is already a dependant of someone else' using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from public.household_links h
    where h.org_id = new.org_id and h.id <> new.id and h.guardian_contact_id = new.dependant_contact_id
  ) then
    raise exception 'that dependant is already a guardian of someone else' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger household_links_no_chain before insert or update on public.household_links
  for each row execute function app.household_no_chain();

alter table public.household_links enable row level security;
create policy household_links_select on public.household_links for select to authenticated
  using (app.has_perm(org_id, 'contacts.view'));
create policy household_links_insert on public.household_links for insert to authenticated
  with check (app.has_perm(org_id, 'contacts.manage'));
create policy household_links_update on public.household_links for update to authenticated
  using (app.has_perm(org_id, 'contacts.manage'))
  with check (app.has_perm(org_id, 'contacts.manage'));
create policy household_links_delete on public.household_links for delete to authenticated
  using (app.has_perm(org_id, 'contacts.manage'));

-- ---------------------------------------------------------------------------
-- merge_contacts: Phase 2 body + household handling
-- ---------------------------------------------------------------------------
create or replace function public.merge_contacts(
  p_org_id uuid,
  p_primary_id uuid,
  p_secondary_id uuid,
  p_fields jsonb default '{}'::jsonb,
  p_user_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.contacts;
  s public.contacts;
begin
  if p_primary_id = p_secondary_id then
    raise exception 'cannot merge a contact into itself' using errcode = 'check_violation';
  end if;
  select * into p from public.contacts where id = p_primary_id and org_id = p_org_id and deleted_at is null for update;
  select * into s from public.contacts where id = p_secondary_id and org_id = p_org_id and deleted_at is null for update;
  if p.id is null or s.id is null then
    raise exception 'contact not found' using errcode = 'no_data_found';
  end if;

  -- Phase 14: a guardian and their own dependant are two people who share a phone, not a duplicate.
  if exists (
    select 1 from public.household_links h
    where h.org_id = p_org_id
      and ((h.guardian_contact_id = p_primary_id and h.dependant_contact_id = p_secondary_id)
        or (h.guardian_contact_id = p_secondary_id and h.dependant_contact_id = p_primary_id))
  ) then
    raise exception 'a guardian and their dependant are different people: remove the household link first'
      using errcode = 'check_violation';
  end if;
  -- Moving the secondary's dependants under a primary that is itself a dependant would make a chain.
  if exists (select 1 from public.household_links h where h.org_id = p_org_id and h.dependant_contact_id = p_primary_id)
     and exists (select 1 from public.household_links h where h.org_id = p_org_id and h.guardian_contact_id = p_secondary_id) then
    raise exception 'the contact being merged has dependants but the surviving contact is a dependant: unlink first'
      using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.household_links h where h.org_id = p_org_id and h.guardian_contact_id = p_primary_id)
     and exists (select 1 from public.household_links h where h.org_id = p_org_id and h.dependant_contact_id = p_secondary_id) then
    raise exception 'the surviving contact has dependants but the contact being merged is a dependant: unlink first'
      using errcode = 'check_violation';
  end if;

  -- Free the secondary's unique identifiers before moving them.
  update public.contacts set phone_e164 = null, wa_bsuid = null, external_id = null, email = null,
    deleted_at = now(), merged_into_id = p_primary_id
  where id = p_secondary_id;

  -- Resolved scalar fields: caller-chosen values, then fill blanks from the secondary.
  update public.contacts set
    first_name = coalesce(nullif(p_fields ->> 'first_name', ''), nullif(p.first_name, ''), s.first_name),
    last_name = coalesce(nullif(p_fields ->> 'last_name', ''), nullif(p.last_name, ''), s.last_name),
    phone_e164 = coalesce(nullif(p_fields ->> 'phone_e164', ''), p.phone_e164, s.phone_e164),
    wa_bsuid = coalesce(p.wa_bsuid, s.wa_bsuid),
    email = coalesce(nullif(p_fields ->> 'email', ''), p.email, s.email),
    gender = coalesce(nullif(p_fields ->> 'gender', ''), p.gender, s.gender),
    nationality = coalesce(nullif(p_fields ->> 'nationality', ''), p.nationality, s.nationality),
    country = coalesce(nullif(p_fields ->> 'country', ''), p.country, s.country),
    language = coalesce(nullif(p_fields ->> 'language', ''), p.language, s.language),
    dob = coalesce((nullif(p_fields ->> 'dob', ''))::date, p.dob, s.dob),
    label = coalesce(nullif(p_fields ->> 'label', ''), p.label, s.label),
    owner_id = coalesce(p.owner_id, s.owner_id),
    assignee_id = coalesce(p.assignee_id, s.assignee_id),
    external_id = coalesce(nullif(p_fields ->> 'external_id', ''), p.external_id, s.external_id),
    promotions_opt_in = p.promotions_opt_in or s.promotions_opt_in,
    stop_marketing = p.stop_marketing or s.stop_marketing,      -- opt-outs always win
    custom = s.custom || p.custom,                                -- primary keys win
    last_interaction_at = greatest(p.last_interaction_at, s.last_interaction_at)
  where id = p_primary_id;

  -- The losing primary phone (if different) becomes an alternate phone.
  insert into public.contact_phones (org_id, contact_id, phone_e164, label)
  select p_org_id, p_primary_id, ph, 'merged'
  from unnest(array[p.phone_e164, s.phone_e164]) as ph
  where ph is not null and ph <> (select phone_e164 from public.contacts where id = p_primary_id)
  on conflict (contact_id, phone_e164) do nothing;

  insert into public.contact_phones (org_id, contact_id, phone_e164, label)
  select org_id, p_primary_id, phone_e164, label from public.contact_phones where contact_id = p_secondary_id
  on conflict (contact_id, phone_e164) do nothing;
  delete from public.contact_phones where contact_id = p_secondary_id;
  delete from public.contact_phones where contact_id = p_primary_id
    and phone_e164 = (select phone_e164 from public.contacts where id = p_primary_id);

  insert into public.contact_tags (org_id, contact_id, tag_id, added_by)
  select org_id, p_primary_id, tag_id, added_by from public.contact_tags where contact_id = p_secondary_id
  on conflict do nothing;
  delete from public.contact_tags where contact_id = p_secondary_id;

  insert into public.segment_members (org_id, segment_id, contact_id, added_by)
  select org_id, segment_id, p_primary_id, added_by from public.segment_members where contact_id = p_secondary_id
  on conflict do nothing;
  delete from public.segment_members where contact_id = p_secondary_id;

  update public.timeline_events set contact_id = p_primary_id where contact_id = p_secondary_id;
  update public.mentions set contact_id = p_primary_id where contact_id = p_secondary_id;
  update public.external_refs set local_id = p_primary_id where local_table = 'contacts' and local_id = p_secondary_id;
  update public.contacts set merged_into_id = p_primary_id where merged_into_id = p_secondary_id;

  -- Phase 14: household links follow the surviving contact. If both were dependants, the primary keeps its guardian.
  update public.household_links set guardian_contact_id = p_primary_id
   where org_id = p_org_id and guardian_contact_id = p_secondary_id;
  delete from public.household_links
   where org_id = p_org_id and dependant_contact_id = p_secondary_id
     and exists (select 1 from public.household_links x where x.org_id = p_org_id and x.dependant_contact_id = p_primary_id);
  update public.household_links set dependant_contact_id = p_primary_id
   where org_id = p_org_id and dependant_contact_id = p_secondary_id;

  insert into public.timeline_events (org_id, contact_id, type, actor_type, actor_id, payload)
  values (p_org_id, p_primary_id, 'contact.merged', case when p_user_id is null then 'system' else 'user' end, p_user_id,
          jsonb_build_object('merged_contact_id', p_secondary_id));
end;
$$;
revoke all on function public.merge_contacts(uuid, uuid, uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.merge_contacts(uuid, uuid, uuid, jsonb, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- contact_duplicate_candidates: household members are not duplicates of each other
-- ---------------------------------------------------------------------------
create or replace function public.contact_duplicate_candidates(p_org_id uuid, p_limit integer default 200)
returns table (a_id uuid, b_id uuid, reason text)
language sql
security definer
set search_path = ''
as $$
  select d.a_id, d.b_id, d.reason from (
    select least(a.id, b.id) as a_id, greatest(a.id, b.id) as b_id, 'email' as reason
    from public.contacts a
    join public.contacts b on b.org_id = a.org_id and b.id > a.id and b.deleted_at is null and lower(b.email) = lower(a.email)
    where a.org_id = p_org_id and a.deleted_at is null and a.email is not null
    union
    select least(a.id, b.id), greatest(a.id, b.id), 'name_dob'
    from public.contacts a
    join public.contacts b on b.org_id = a.org_id and b.id > a.id and b.deleted_at is null
      and lower(b.full_name) = lower(a.full_name) and b.dob = a.dob
    where a.org_id = p_org_id and a.deleted_at is null and a.dob is not null and a.full_name <> ''
    union
    select least(a.id, cp.contact_id), greatest(a.id, cp.contact_id), 'phone'
    from public.contacts a
    join public.contact_phones cp on cp.org_id = a.org_id and cp.phone_e164 = a.phone_e164 and cp.contact_id <> a.id
    join public.contacts b on b.id = cp.contact_id and b.deleted_at is null
    where a.org_id = p_org_id and a.deleted_at is null
  ) d
  where not exists (
    select 1 from public.household_links h
    where h.org_id = p_org_id
      and ((h.guardian_contact_id = d.a_id and h.dependant_contact_id = d.b_id)
        or (h.guardian_contact_id = d.b_id and h.dependant_contact_id = d.a_id)
        -- two dependants of the same guardian (siblings) are not duplicates either
        or (h.dependant_contact_id = d.a_id and exists (
              select 1 from public.household_links h2
              where h2.org_id = p_org_id and h2.guardian_contact_id = h.guardian_contact_id and h2.dependant_contact_id = d.b_id)))
  )
  order by d.reason, d.a_id
  limit greatest(1, coalesce(p_limit, 200));
$$;
revoke all on function public.contact_duplicate_candidates(uuid, integer) from public, anon, authenticated;
grant execute on function public.contact_duplicate_candidates(uuid, integer) to service_role;

-- ======================================================================
-- 20261014000300_waitlist.sql
-- ======================================================================
-- Phase 14 (3/3): waitlist and slot offers.
--
--   waitlist_entries   a patient waiting for a doctor and/or a service (and optionally a place). Order = created_at.
--   slot_offers        one row per (entry, freed slot): the WhatsApp offer, its expiry and its outcome. Written by
--                      server code only (service role); staff read them. The unique key makes a replayed
--                      "appointment cancelled" job offer nothing twice.
--
-- accept_slot_offer() is where "first YES wins": it takes the SAME per-specialist advisory lock that
-- book_appointment / move_appointment take, re-reads the offer under the lock, re-checks that the slot is still
-- free, books it and marks every other pending offer for that slot as 'taken', all in one transaction. Two
-- patients answering YES in the same instant therefore serialise, and exactly one books. Service role only.

create table public.waitlist_entries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  specialist_id uuid references public.specialists (id) on delete cascade,
  service_id uuid references public.services (id) on delete cascade,
  location_id uuid references public.locations (id) on delete cascade,
  -- Stop offering after this date (inclusive, clinic time).
  not_after date,
  notes text check (notes is null or char_length(notes) <= 500),
  status text not null default 'waiting' check (status in ('waiting', 'booked', 'removed')),
  booked_appointment_id uuid references public.appointments (id) on delete set null,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (specialist_id is not null or service_id is not null)
);
-- A patient waits once per doctor/service pair.
create unique index waitlist_entries_active_uidx on public.waitlist_entries (
  org_id, contact_id,
  coalesce(specialist_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(service_id, '00000000-0000-0000-0000-000000000000'::uuid)
) where status = 'waiting';
create index waitlist_entries_queue_idx on public.waitlist_entries (org_id, status, created_at);
create index waitlist_entries_contact_idx on public.waitlist_entries (contact_id);

create trigger waitlist_entries_set_updated_at
  before update on public.waitlist_entries for each row execute function app.set_updated_at();
create trigger waitlist_entries_contact_org_check before insert or update on public.waitlist_entries
  for each row execute function app.check_parent_org('contacts', 'contact_id');
create trigger waitlist_entries_specialist_org_check before insert or update on public.waitlist_entries
  for each row execute function app.check_parent_org('specialists', 'specialist_id');
create trigger waitlist_entries_service_org_check before insert or update on public.waitlist_entries
  for each row execute function app.check_parent_org('services', 'service_id');
create trigger waitlist_entries_location_org_check before insert or update on public.waitlist_entries
  for each row execute function app.check_parent_org('locations', 'location_id');
create trigger waitlist_entries_appointment_org_check before insert or update on public.waitlist_entries
  for each row execute function app.check_parent_org('appointments', 'booked_appointment_id');

alter table public.waitlist_entries enable row level security;
create policy waitlist_entries_select on public.waitlist_entries for select to authenticated
  using (app.has_perm(org_id, 'frontdesk.use'));
create policy waitlist_entries_insert on public.waitlist_entries for insert to authenticated
  with check (app.has_perm(org_id, 'frontdesk.use') and app.has_perm(org_id, 'appointments.manage'));
create policy waitlist_entries_update on public.waitlist_entries for update to authenticated
  using (app.has_perm(org_id, 'frontdesk.use') and app.has_perm(org_id, 'appointments.manage'))
  with check (app.has_perm(org_id, 'frontdesk.use') and app.has_perm(org_id, 'appointments.manage'));
create policy waitlist_entries_delete on public.waitlist_entries for delete to authenticated
  using (app.has_perm(org_id, 'frontdesk.use') and app.has_perm(org_id, 'appointments.manage'));

-- ---------------------------------------------------------------------------
create table public.slot_offers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  waitlist_entry_id uuid not null references public.waitlist_entries (id) on delete cascade,
  -- The appointment whose cancellation freed the slot (kept for the audit trail).
  source_appointment_id uuid references public.appointments (id) on delete set null,
  specialist_id uuid not null references public.specialists (id) on delete cascade,
  location_id uuid not null references public.locations (id) on delete cascade,
  service_id uuid not null references public.services (id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined', 'expired', 'taken', 'failed', 'withdrawn')),
  -- How the offer went out: free text inside the 24-hour window, otherwise the approved template.
  sent_as text check (sent_as in ('text', 'template')),
  message_id uuid references public.messages (id) on delete set null,
  expires_at timestamptz not null,
  responded_at timestamptz,
  appointment_id uuid references public.appointments (id) on delete set null,
  failure_reason text check (failure_reason is null or char_length(failure_reason) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (waitlist_entry_id, specialist_id, starts_at),
  check (ends_at > starts_at)
);
create index slot_offers_pending_idx on public.slot_offers (org_id, specialist_id, starts_at) where status = 'pending';
create index slot_offers_entry_idx on public.slot_offers (waitlist_entry_id);
create index slot_offers_message_idx on public.slot_offers (message_id) where message_id is not null;

create trigger slot_offers_set_updated_at
  before update on public.slot_offers for each row execute function app.set_updated_at();
create trigger slot_offers_entry_org_check before insert or update on public.slot_offers
  for each row execute function app.check_parent_org('waitlist_entries', 'waitlist_entry_id');
create trigger slot_offers_specialist_org_check before insert or update on public.slot_offers
  for each row execute function app.check_parent_org('specialists', 'specialist_id');
create trigger slot_offers_location_org_check before insert or update on public.slot_offers
  for each row execute function app.check_parent_org('locations', 'location_id');
create trigger slot_offers_service_org_check before insert or update on public.slot_offers
  for each row execute function app.check_parent_org('services', 'service_id');

-- Staff read offers; there is deliberately no write policy (offers are created and answered by server code).
alter table public.slot_offers enable row level security;
create policy slot_offers_select on public.slot_offers for select to authenticated
  using (app.has_perm(org_id, 'frontdesk.use'));

-- ---------------------------------------------------------------------------
-- First YES wins.
-- Returns {"result": "booked" | "taken" | "expired" | "not_pending" | "not_found", ...}.
-- ---------------------------------------------------------------------------
create or replace function public.accept_slot_offer(
  p_org_id uuid,
  p_offer_id uuid,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o public.slot_offers;
  e public.waitlist_entries;
  v_appt public.appointments;
  v_department uuid;
begin
  select * into o from public.slot_offers where id = p_offer_id and org_id = p_org_id;
  if o.id is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- Same key as book_appointment / move_appointment: acceptance, staff bookings and moves for this
  -- specialist all queue behind one another.
  perform pg_advisory_xact_lock(hashtextextended(o.specialist_id::text, 0));

  -- Re-read under the lock: the winner may have committed while we waited.
  select * into o from public.slot_offers where id = p_offer_id and org_id = p_org_id for update;
  if o.status <> 'pending' then
    return jsonb_build_object('result', case when o.status = 'taken' then 'taken' else 'not_pending' end,
                              'status', o.status);
  end if;
  if o.expires_at <= p_now then
    update public.slot_offers set status = 'expired', responded_at = p_now where id = o.id;
    return jsonb_build_object('result', 'expired');
  end if;

  select * into e from public.waitlist_entries where id = o.waitlist_entry_id and org_id = p_org_id for update;
  if e.id is null or e.status <> 'waiting' then
    update public.slot_offers set status = 'withdrawn', responded_at = p_now where id = o.id;
    return jsonb_build_object('result', 'not_pending', 'status', 'withdrawn');
  end if;

  -- Someone else (another patient's YES, or a staff booking) may have taken the slot.
  begin
    perform app.assert_slot_free(p_org_id, o.specialist_id, o.location_id, o.starts_at, o.ends_at, null);
  exception when others then
    if sqlerrm <> 'slot_taken' then
      raise;
    end if;
    update public.slot_offers set status = 'taken', responded_at = p_now where id = o.id;
    return jsonb_build_object('result', 'taken');
  end;

  select coalesce(s.department_id, sp.department_id) into v_department
    from public.services s, public.specialists sp
   where s.id = o.service_id and sp.id = o.specialist_id;

  v_appt := public.book_appointment(
    p_org_id, e.contact_id, o.location_id, o.specialist_id, o.service_id, v_department,
    o.starts_at, o.ends_at, 'confirmed', null, false, 'bot', null, true
  );

  update public.slot_offers
     set status = 'accepted', responded_at = p_now, appointment_id = v_appt.id
   where id = o.id;
  update public.waitlist_entries
     set status = 'booked', booked_appointment_id = v_appt.id
   where id = e.id;
  -- Everyone else holding an offer for this very slot is told it has gone.
  update public.slot_offers
     set status = 'taken', responded_at = p_now
   where org_id = p_org_id and specialist_id = o.specialist_id and starts_at = o.starts_at
     and status = 'pending' and id <> o.id;

  return jsonb_build_object('result', 'booked', 'appointment_id', v_appt.id, 'contact_id', e.contact_id,
                            'entry_id', e.id);
end;
$$;
revoke all on function public.accept_slot_offer(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.accept_slot_offer(uuid, uuid, timestamptz) to service_role;

-- ======================================================================
-- 20261014000400_demo_reset.sql
-- ======================================================================
-- Phase 14: support for `pnpm demo:reset` (scripts/demo-reset.ts).
--
-- public.demo_wipe_org(org) deletes every row of a DEMO workspace so the script can seed it again. It refuses to
-- touch an org unless BOTH flags are set: orgs.is_training (Settings, Training mode) and settings.demo_seed = 'true'
-- (written only by the demo script). It keeps the org row, its roles and memberships (system roles cannot be
-- deleted by design), teams, invitations, and the append-only logs (audit_log, record_access_log, auth_events,
-- record_history), and everything tied to a person's own login (notification settings, push devices, sessions).
-- Service role only.
--
-- Everything else with an org_id column is emptied. Foreign keys decide the order: a table that still has children
-- is retried on the next pass. The result lists anything that could not be emptied, so a new table with an
-- unexpected delete guard is noticed instead of silently left behind.

create or replace function public.demo_wipe_org(p_org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ok boolean;
  v_keep constant text[] := array[
    'orgs', 'roles', 'memberships', 'teams', 'team_members', 'invites',
    'audit_log', 'record_access_log', 'auth_events', 'record_history', 'security_alerts',
    'access_reviews', 'privacy_requests', 'user_sessions',
    'notification_preferences', 'push_subscriptions', 'notification_digest_log'
  ];
  v_tables text[];
  v_pending text[];
  v_failed jsonb := '{}'::jsonb;
  v_deleted bigint := 0;
  v_n bigint;
  v_pass int;
  t text;
begin
  select (o.is_training and coalesce(o.settings ->> 'demo_seed', '') = 'true')
    into v_ok from public.orgs o where o.id = p_org_id;
  if not coalesce(v_ok, false) then
    raise exception 'demo_wipe_org: this workspace is not a demo workspace' using errcode = '42501';
  end if;

  select array_agg(c.relname::text order by c.relname) into v_tables
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
   where n.nspname = 'public' and c.relkind = 'r' and not (c.relname = any (v_keep));

  v_pending := v_tables;
  for v_pass in 1..8 loop
    exit when coalesce(array_length(v_pending, 1), 0) = 0;
    declare
      v_next text[] := '{}';
    begin
      foreach t in array v_pending loop
        begin
          execute format('delete from public.%I where org_id = $1', t) using p_org_id;
          get diagnostics v_n = row_count;
          v_deleted := v_deleted + v_n;
          -- A cascade can leave rows behind only when something refused; look for what is left.
          execute format('select count(*) from public.%I where org_id = $1', t) into v_n using p_org_id;
          if v_n > 0 then v_next := v_next || t; end if;
        exception when others then
          v_next := v_next || t;
          v_failed := v_failed || jsonb_build_object(t, sqlstate);
        end;
      end loop;
      v_pending := v_next;
    end;
  end loop;

  -- Only the errors of tables that are still not empty matter (a foreign-key refusal on an early pass is normal).
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_failed
    from jsonb_each(v_failed) as e (k, v) where k = any (coalesce(v_pending, '{}'));

  return jsonb_build_object('deleted', v_deleted, 'left_behind', to_jsonb(coalesce(v_pending, '{}')), 'errors', v_failed);
end;
$$;
revoke all on function public.demo_wipe_org(uuid) from public, anon, authenticated;
grant execute on function public.demo_wipe_org(uuid) to service_role;
