-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Needs every earlier file first, up to and including 109_finance_group_pack_key.sql.
-- Production normally gets this through .github/workflows/db-migrate.yml on merge; this file is the manual route.

-- Make parity: the owner's answers to docs/49 (22 Oct 2026).
--
-- Recall and appointment reminders follow the live Make scenarios and the Airtable set-up. Make stays on (D20), so
-- Pulse runs beside it in Test mode until go-live.
--
--   1. Chronic recall view: segment_key (the engine picks the template by it; without it every chronic row was
--      skipped as "no template") and the Airtable "60 days >" long-prescription gate (D2).
--   2. contacts.long_prescription_flag: Airtable's "60 days >" (set by automation wflJ8HcmP16BqEv7z when a visit
--      medication has 60 or 90 dosage days), imported with the Unite patients and backfilled from the import refs.
--   3. Clinical setting chronic_recall_require_long_prescription (D2). Unsigned means the gate applies (fails closed,
--      and matches the Chronic view in Airtable).
--   4. Recall programme defaults: birthday at 12:00 like Make (D7) with no programme-level promotions opt-in (D6; the
--      template category rule still applies); chronic recall without per-patient clinical consent (D15). The name
--      variable is title-cased like Make's startcase (D17).
--   5. Reminder exclusions per branch (D10): the Make filters differ for Palm Jumeirah (Unite clinic DHA-F-0000419).
--
-- Nothing here signs a clinical value: D1 (86 days) and D2 are signed per workspace by a named person.

-- ---------------------------------------------------------------------------
-- 1. Long-prescription flag ("60 days >")
-- ---------------------------------------------------------------------------
alter table public.contacts add column if not exists long_prescription_flag boolean not null default false;
comment on column public.contacts.long_prescription_flag is
  'Airtable "60 days >" (Unite patients): a visit medication had 60 or 90 dosage days. Required for chronic recall while chronic_recall_require_long_prescription is not signed false (docs/49 D2).';

-- Backfill from the Airtable import refs (meta.sixty_days = "True"); a ref on a merged record counts for the survivor.
update public.contacts c
   set long_prescription_flag = true
  from public.external_refs er
  join public.contacts src on src.id = er.local_id and src.org_id = er.org_id
 where er.source = 'airtable'
   and er.entity = 'app7QJ2pvhADHQeBP.tbl9856qJP9S7OEqB'
   and er.local_table = 'contacts'
   and er.meta ->> 'sixty_days' = 'True'
   and c.org_id = er.org_id
   and c.id = coalesce(src.merged_into_id, src.id)
   and not c.long_prescription_flag;

-- Erasure clears it; a merge carries it to the surviving record (triggers, so a rewrite of erase/merge cannot forget it).
create or replace function app.contacts_long_prescription_erase()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.erased_at is not null then
    new.long_prescription_flag := false;
  end if;
  return new;
end;
$$;
revoke all on function app.contacts_long_prescription_erase() from public, anon, authenticated;
create trigger contacts_long_prescription_erase before update of erased_at on public.contacts
  for each row when (new.erased_at is not null) execute function app.contacts_long_prescription_erase();

create or replace function app.contacts_long_prescription_merge()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.merged_into_id is not null and new.merged_into_id is distinct from old.merged_into_id
     and new.long_prescription_flag then
    update public.contacts
       set long_prescription_flag = true
     where org_id = new.org_id and id = new.merged_into_id and not long_prescription_flag;
  end if;
  return new;
end;
$$;
revoke all on function app.contacts_long_prescription_merge() from public, anon, authenticated;
create trigger contacts_long_prescription_merge after update of merged_into_id on public.contacts
  for each row execute function app.contacts_long_prescription_merge();

-- ---------------------------------------------------------------------------
-- 2. Clinical setting for the gate (starts from 20261108000300; keeps chronic_condition_min_visits)
-- ---------------------------------------------------------------------------
create or replace function public.seed_clinical_settings_phase21(p_org uuid)
returns void
language sql
set search_path = ''
as $$
  insert into public.clinical_settings
    (org_id, key, label, category, value_type, proposed_value, live_value, sign_off_status, owner, notes, source)
  values
    (p_org, 'chronic_condition_min_visits', 'Chronic condition: visits with the diagnosis before it counts', 'recall', 'number',
     '1', null, 'awaiting', 'Abdul / Snezana',
     'Phase 21. A diagnosis flagged Chronic in the Diagnosis reference becomes one of the patient''s chronic conditions (and so a reason for chronic recall) once it has been coded on this many separate visits. In Airtable the patient-level Chronic Diagnosis list was filled from visits by the Make scenario "Update Chronic" (every diagnosis of every new visit, no Chronic filter); only Chronic-flagged codes counted for recall, and one coded visit was enough. Pulse imports only the Chronic-flagged links. Proposed 1 = any coded chronic diagnosis (as Airtable). Nothing is derived until this is signed off (OQ-104).',
     'pulse'),
    (p_org, 'chronic_recall_require_long_prescription', 'Chronic recall: only patients with a 60- or 90-day prescription', 'recall', 'boolean',
     'true', 'true', 'awaiting', 'Abdul / Snezana',
     'The Airtable "Chronic" view that Make reads requires "60 days >" (a visit medication with 60 or 90 dosage days, set by an Airtable automation). Owner decision 22 Oct 2026: keep it (docs/49 D2). Until this is signed, the gate applies; sign it false only to recall chronic patients without a long prescription.',
     'pulse')
  on conflict (org_id, key) do nothing;
$$;
revoke all on function public.seed_clinical_settings_phase21(uuid) from public, anon, authenticated;
grant execute on function public.seed_clinical_settings_phase21(uuid) to service_role;

select public.seed_clinical_settings_phase21(s.org_id)
from (select distinct org_id from public.clinical_settings) s;

-- ---------------------------------------------------------------------------
-- 3. Chronic recall eligibility (starts from 20261108000300). Same columns, two appended.
-- ---------------------------------------------------------------------------
create or replace view public.v_chronic_recall_eligibility with (security_invoker = true) as
with groups as (
  select cc.org_id, cc.contact_id,
         array_agg(distinct g.key order by g.key) as all_group_keys,
         (array_agg(g.key order by g.sort, g.key) filter (where g.messageable))[1] as primary_condition_group,
         array_remove(array_agg(distinct case when g.messageable then g.key end), null) as messageable_groups
  from public.contact_chronic_conditions cc
  join public.ref_diagnoses d on d.id = cc.ref_diagnosis_id
  join public.ref_condition_groups g on g.id = d.condition_group_id
  where d.chronic is true
  group by cc.org_id, cc.contact_id
),
prog as (select id, org_id from public.recall_programmes where key = 'chronic_90d')
select c.org_id, c.id as contact_id,
       s.last_visit_date, s.days_since_last_visit,
       g.primary_condition_group, g.messageable_groups,
       public.clinical_setting_num(c.org_id, 'chronic_recall_min_days') as min_days,
       (s.last_visit_date::text) as cycle_key,
       (   c.phone_e164 is not null
       and not coalesce(c.stop_marketing, false)
       and not coalesce(c.is_test_record, false)
       and g.primary_condition_group is not null
       and public.clinical_setting_num(c.org_id, 'chronic_recall_min_days') is not null
       and s.days_since_last_visit >= public.clinical_setting_num(c.org_id, 'chronic_recall_min_days')
       and (c.long_prescription_flag
            or coalesce(public.clinical_setting_bool(c.org_id, 'chronic_recall_require_long_prescription'), true) = false)
       and not exists (select 1 from public.recall_sends rs join prog p on p.id = rs.programme_id
                       where rs.contact_id = c.id and rs.cycle_key = s.last_visit_date::text
                         and rs.status not in ('cancelled','failed'))
       ) as eligible,
       g.primary_condition_group as segment_key,
       c.long_prescription_flag
from public.contacts c
join public.v_contact_visit_stats s on s.contact_id = c.id and s.org_id = c.org_id
join groups g on g.contact_id = c.id and g.org_id = c.org_id;

-- ---------------------------------------------------------------------------
-- 4. Recall programme defaults (starts from 20261224000200)
-- ---------------------------------------------------------------------------
create or replace function public.seed_recall_programmes(p_org uuid)
returns void language plpgsql set search_path = '' as $$
declare chronic uuid; bday uuid;
  first_name_map constant jsonb := '{"body.1":"contact.first_name|title|default:Patient"}'::jsonb;
begin
  insert into public.recall_programmes (org_id, key, name, kind, status, eligibility_view, cron_expression, repeat_policy, max_per_run, requires_marketing_opt_in, requires_clinical_consent, config)
  values
    (p_org, 'chronic_90d',   'Chronic condition recall',           'chronic',   'draft', 'v_chronic_recall_eligibility', '15 12 * * *', 'per_cycle', 100, false, false, '{"threshold_setting":"chronic_recall_min_days","order_by":"days_since_last_visit desc"}'),
    (p_org, 'birthday',      'Birthday message',                   'birthday',  'draft', 'v_birthday_today',              '0 12 * * *',  'per_cycle', 1000, false, false, '{"bands":["m_20_29","m_30_39","m_40_plus","f_18_35","f_36_45","f_46_65"]}'),
    (p_org, 'annual_checkup','Annual check-up reminder (330 days)','screening', 'draft', null, '0 9 * * *', 'per_cycle', 200, true, false, '{"min_days_since_visit":330}'),
    (p_org, 'dental',        'Annual dental check-up',             'screening', 'draft', null, '0 9 * * *', 'per_cycle', 200, true, false, '{}'),
    (p_org, 'pap_smear',     'Pap smear reminder',                 'screening', 'draft', null, '0 9 * * *', 'per_cycle', 200, true, false, '{}'),
    (p_org, 'colonoscopy',   'Colonoscopy screening',              'screening', 'draft', null, '0 9 * * *', 'per_cycle', 200, true, false, '{}'),
    (p_org, 'skin_check',    'Skin cancer screening & mole check', 'screening', 'draft', null, '0 9 * * *', 'per_cycle', 200, true, false, '{}'),
    (p_org, 'pre_menopause', 'Pre-menopause assessment',           'screening', 'draft', null, '0 9 * * *', 'per_cycle', 200, true, false, '{}'),
    (p_org, 'menopause',     'Menopause assessment',               'screening', 'draft', null, '0 9 * * *', 'per_cycle', 200, true, false, '{}'),
    (p_org, 'dormant',       'Dormant patient reactivation',       'dormant',   'draft', null, '0 9 * * *', 'once',      200, true, false, '{}')
  on conflict (org_id, key) do nothing;

  select id into chronic from public.recall_programmes where org_id = p_org and key = 'chronic_90d';
  select id into bday    from public.recall_programmes where org_id = p_org and key = 'birthday';

  -- Chronic: per-condition Sanoflow template ids from the live SWITCH (R-23). No default row (fail closed).
  insert into public.recall_programme_templates (org_id, programme_id, segment_key, legacy_sanoflow_template_id, variables_map) values
    (p_org, chronic, 'hypertension',   '13159', first_name_map),
    (p_org, chronic, 'diabetes',       '13164', first_name_map),
    (p_org, chronic, 'hyperlipidemia', '13163', first_name_map),
    (p_org, chronic, 'hypothyroidism', '13169', first_name_map),
    (p_org, chronic, 'ckd',            '13168', first_name_map),
    (p_org, chronic, 'asthma',         '13162', first_name_map),
    (p_org, chronic, 'copd',           '13165', first_name_map),
    (p_org, chronic, 'ra',             '13161', first_name_map),
    (p_org, chronic, 'af',             '13167', first_name_map),
    (p_org, chronic, 'epilepsy',       '13166', first_name_map)
  on conflict (programme_id, segment_key) do nothing;

  -- Birthday: gender/age bands from the Make scenario (OQ-17). Greeting: first name (owner decision D5).
  insert into public.recall_programme_templates (org_id, programme_id, segment_key, legacy_sanoflow_template_id, variables_map) values
    (p_org, bday, 'm_20_29',  '12294', first_name_map),
    (p_org, bday, 'm_30_39',  '12295', first_name_map),
    (p_org, bday, 'm_40_plus','12296', first_name_map),
    (p_org, bday, 'f_18_35',  '12289', first_name_map),
    (p_org, bday, 'f_36_45',  '12291', first_name_map),
    (p_org, bday, 'f_46_65',  '12291', first_name_map)
  on conflict (programme_id, segment_key) do nothing;
end $$;
revoke all on function public.seed_recall_programmes(uuid) from public, anon, authenticated;
grant execute on function public.seed_recall_programmes(uuid) to service_role;

-- Existing workspaces. Only values still at the earlier seeded default change; a person's own choice is kept.
update public.recall_programmes set requires_marketing_opt_in = false
 where key = 'birthday' and requires_marketing_opt_in;
update public.recall_programmes set cron_expression = '0 12 * * *'
 where key = 'birthday' and cron_expression = '0 9 * * *';
update public.recall_programmes set requires_clinical_consent = false
 where key = 'chronic_90d' and requires_clinical_consent;
update public.recall_programme_templates
   set variables_map = '{"body.1":"contact.first_name|title|default:Patient"}'::jsonb
 where variables_map = '{"body.1":"contact.first_name|default:Patient"}'::jsonb;

-- ---------------------------------------------------------------------------
-- 5. Reminder exclusions per branch (D10)
-- ---------------------------------------------------------------------------
alter table public.reminder_exclusions
  add column if not exists location_id uuid references public.locations(id) on delete cascade;
comment on column public.reminder_exclusions.location_id is
  'Null: the rule applies at every branch. Set: only for appointments at that branch (the Make filters differ per branch).';
create trigger reminder_exclusions_location_org_check before insert or update of location_id on public.reminder_exclusions
  for each row execute function app.check_parent_org('locations', 'location_id');

alter table public.reminder_exclusions drop constraint if exists reminder_exclusions_org_id_kind_match_type_value_key;
create unique index if not exists reminder_exclusions_rule_uidx on public.reminder_exclusions
  (org_id, kind, match_type, value, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Copied from the Appointment Reminders blueprints (3613818, 3913219). Unite clinics: DHA-F-6456618 and DHA-F-2116734
-- (Golden Mile, Meadows) share one filter; DHA-F-0000419 (Palm Jumeirah) has its own. Patient names compare without
-- case, doctor names with case, as in Make. Branches that are not in Pulse yet get their rows when the defaults are
-- loaded again after the Unite sync has created them; until then the earlier all-branch rows stay in force.
create or replace function public.seed_reminder_exclusions(p_org uuid)
returns void language plpgsql set search_path = '' as $$
declare
  shared_ids uuid[];
  palm uuid;
begin
  select array_agg(id) into shared_ids from public.locations
   where org_id = p_org and external_id in ('DHA-F-6456618', 'DHA-F-2116734');
  select id into palm from public.locations where org_id = p_org and external_id = 'DHA-F-0000419';

  -- Every branch.
  insert into public.reminder_exclusions (org_id, kind, match_type, value, reason) values
    (p_org, 'placeholder_name', 'equals',   'golden mile', 'Unite placeholder booking (from Make filter)'),
    (p_org, 'placeholder_name', 'equals',   'meadows',     'Unite placeholder booking (from Make filter)'),
    (p_org, 'doctor', 'equals',   'Dr. Tod Cahil',       'Excluded in Make filter; reason unknown (OQ-21)'),
    (p_org, 'doctor', 'equals',   'Mariam Abdel Malek',  'Excluded in Make filter; reason unknown (OQ-21)'),
    (p_org, 'doctor', 'equals',   'Luka Ciglic',         'Excluded in Make filter; reason unknown (OQ-21)'),
    (p_org, 'doctor', 'equals',   'Mariam Hermina',      'Excluded in Make filter; reason unknown (OQ-21)'),
    (p_org, 'doctor', 'contains', 'Patricia Oliveira',   'Excluded in Make filter; reason unknown (OQ-21)')
  on conflict do nothing;

  if shared_ids is null and palm is null then
    -- No Unite branches yet: the Golden Mile / Meadows filter for every branch (the earlier behaviour).
    insert into public.reminder_exclusions (org_id, kind, match_type, value, reason) values
      (p_org, 'placeholder_name', 'equals',   'SHORELINE', 'Unite placeholder booking (from Make filter)'),
      (p_org, 'placeholder_name', 'equals',   'block',     'Unite placeholder booking (from Make filter)'),
      (p_org, 'placeholder_name', 'contains', 'break',     'Unite placeholder booking (from Make filter)')
    on conflict do nothing;
    return;
  end if;

  -- Branches known: the all-branch versions of these three rules give way to the per-branch ones.
  update public.reminder_exclusions set active = false, updated_at = now()
   where org_id = p_org and location_id is null and kind = 'placeholder_name' and active
     and reason = 'Unite placeholder booking (from Make filter)'
     and ((match_type = 'equals' and value in ('SHORELINE', 'block')) or (match_type = 'contains' and value = 'break'));

  insert into public.reminder_exclusions (org_id, kind, match_type, value, reason, location_id)
  select p_org, 'placeholder_name', r.match_type, r.value, 'Unite placeholder booking (from Make filter)', l.id
    from unnest(coalesce(shared_ids, '{}'::uuid[])) as l(id)
   cross join (values ('equals', 'SHORELINE'), ('equals', 'block'), ('contains', 'break')) as r(match_type, value)
  on conflict do nothing;

  if palm is not null then
    insert into public.reminder_exclusions (org_id, kind, match_type, value, reason, location_id) values
      (p_org, 'placeholder_name', 'contains', 'SHORELINE', 'Unite placeholder booking (Palm Jumeirah Make filter)', palm),
      (p_org, 'placeholder_name', 'contains', 'block',     'Unite placeholder booking (Palm Jumeirah Make filter)', palm),
      (p_org, 'placeholder_name', 'equals',   'Break',     'Unite placeholder booking (Palm Jumeirah Make filter)', palm)
    on conflict do nothing;
  end if;
end $$;
revoke all on function public.seed_reminder_exclusions(uuid) from public, anon, authenticated;
grant execute on function public.seed_reminder_exclusions(uuid) to service_role;

create or replace function public.is_reminder_excluded(p_org uuid, p_patient_name text, p_doctor_name text, p_location uuid)
returns boolean language sql stable set search_path = '' as $$
  select exists (
    select 1 from public.reminder_exclusions x
    where x.org_id = p_org and x.active
      and (x.location_id is null or x.location_id = p_location)
      and (
        (x.kind = 'placeholder_name' and x.match_type = 'equals'   and lower(coalesce(p_patient_name,'')) = lower(x.value)) or
        (x.kind = 'placeholder_name' and x.match_type = 'contains' and strpos(lower(coalesce(p_patient_name,'')), lower(x.value)) > 0) or
        (x.kind = 'doctor'           and x.match_type = 'equals'   and coalesce(p_doctor_name,'') = x.value) or
        (x.kind = 'doctor'           and x.match_type = 'contains' and strpos(coalesce(p_doctor_name,''), x.value) > 0)
      ));
$$;

-- The earlier three-argument form: branch-less rules only.
create or replace function public.is_reminder_excluded(p_org uuid, p_patient_name text, p_doctor_name text)
returns boolean language sql stable set search_path = '' as $$
  select public.is_reminder_excluded(p_org, p_patient_name, p_doctor_name, null::uuid);
$$;
