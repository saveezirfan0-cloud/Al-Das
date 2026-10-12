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
