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
