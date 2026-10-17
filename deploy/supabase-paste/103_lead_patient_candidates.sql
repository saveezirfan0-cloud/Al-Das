-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Sanoflow lead to Unite patient candidates (Track P4 follow-up).
-- Needs every earlier file first, up to and including 102_segment_care_only.sql.
-- Check the project name in the Supabase header first: this is for the Pulse project only.

-- ======================================================================
-- 20261220000400_lead_patient_candidates.sql
-- ======================================================================
-- Sanoflow lead to Unite patient candidates (docs/45 P4).
--
-- A lead is a contact with no Unite PIN (a WhatsApp or Sanoflow contact); a patient has one (external_id). The same
-- person often exists as both: the lead's WhatsApp number is written differently in Unite, or Unite has no phone for
-- them at all but the name matches. This function only BLOCKS: it lists cheap candidate pairs (same last nine digits
-- of a phone, or the same name of at least two words). The decision (confidence, ambiguity, family rule) is made in
-- TypeScript (lib/contacts/lead-match.ts) with the family-aware comparePerson; nothing is merged here or there.
-- Household members are never candidates of each other.

create or replace function app.national_phone_key(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when length(regexp_replace(coalesce(p, ''), '\D', '', 'g')) >= 9
              then right(regexp_replace(p, '\D', '', 'g'), 9) end;
$$;

-- Lower-cased words sorted, so "Layla Demo" and "Demo Layla" meet; '' unless there are at least two words.
create or replace function app.name_block_key(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when count(*) >= 2 then string_agg(t, ' ' order by t) else '' end
  from regexp_split_to_table(lower(regexp_replace(coalesce(p, ''), '[\s.,_\-]+', ' ', 'g')), ' ') as t
  where t <> '';
$$;

create or replace function public.lead_patient_blocks(p_org_id uuid, p_limit integer default 400)
returns table (lead_id uuid, patient_id uuid, via text)
language sql
stable
security definer
set search_path = ''
as $$
  with people as (
    select c.id,
           (c.external_id is not null and btrim(c.external_id) <> '') as is_patient,
           app.name_block_key(c.full_name) as name_key
    from public.contacts c
    where c.org_id = p_org_id and c.deleted_at is null and c.merged_into_id is null
  ),
  phones as (
    select c.id, app.national_phone_key(c.phone_e164) as k
    from public.contacts c
    where c.org_id = p_org_id and c.deleted_at is null and c.merged_into_id is null and c.phone_e164 is not null
    union
    select cp.contact_id, app.national_phone_key(cp.phone_e164)
    from public.contact_phones cp
    join public.contacts c on c.id = cp.contact_id
    where cp.org_id = p_org_id and c.deleted_at is null and c.merged_into_id is null
  ),
  pairs as (
    select l.id as lead_id, p.id as patient_id, 'phone'::text as via
    from phones lp
    join phones pp on pp.k = lp.k
    join people l on l.id = lp.id and not l.is_patient
    join people p on p.id = pp.id and p.is_patient
    where lp.k is not null
    union
    select l.id, p.id, 'name'::text
    from people l
    join people p on p.name_key = l.name_key
    where not l.is_patient and p.is_patient and l.name_key <> ''
  )
  select d.lead_id, d.patient_id, d.via
  from pairs d
  where not exists (
    select 1 from public.household_links h
    where h.org_id = p_org_id
      and ((h.guardian_contact_id = d.lead_id and h.dependant_contact_id = d.patient_id)
        or (h.guardian_contact_id = d.patient_id and h.dependant_contact_id = d.lead_id)
        or (h.dependant_contact_id = d.lead_id and exists (
              select 1 from public.household_links h2
              where h2.org_id = p_org_id and h2.guardian_contact_id = h.guardian_contact_id and h2.dependant_contact_id = d.patient_id)))
  )
  order by d.via, d.lead_id, d.patient_id
  limit greatest(1, least(coalesce(p_limit, 400), 2000));
$$;
revoke all on function public.lead_patient_blocks(uuid, integer) from public, anon, authenticated;
grant execute on function public.lead_patient_blocks(uuid, integer) to service_role;
