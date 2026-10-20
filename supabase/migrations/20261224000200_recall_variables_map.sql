-- Recall template values (docs/49 D16).
--
-- recall_programme_templates.variables_map says which value fills each {{n}} of the linked template. The seed left it
-- '{}', so a chronic or birthday template with {{1}} failed with "Missing template values" (on Meta and on the Sanoflow
-- path alike). Make fills {{1}} with the patient's first name, else "Patient"; Pulse now seeds the same rule and the
-- Recall page can change it per group (saveTemplateVariables, lib/recall/variables.ts).
--
--   1. seed_recall_programmes (last defined in 20261010000800_recall.sql) gives every chronic and birthday row
--      {"body.1": "contact.first_name|default:Patient"}. Everything else is unchanged.
--   2. Existing workspaces: chronic and birthday rows whose map is still '{}' get the same value once. A map someone
--      already set is never overwritten. Screening and dormant rows stay '{}' (no view and no template yet).

create or replace function public.seed_recall_programmes(p_org uuid)
returns void language plpgsql set search_path = '' as $$
declare chronic uuid; bday uuid;
  first_name_map constant jsonb := '{"body.1":"contact.first_name|default:Patient"}'::jsonb;
begin
  insert into public.recall_programmes (org_id, key, name, kind, status, eligibility_view, cron_expression, repeat_policy, max_per_run, requires_marketing_opt_in, requires_clinical_consent, config)
  values
    (p_org, 'chronic_90d',   'Chronic condition recall',           'chronic',   'draft', 'v_chronic_recall_eligibility', '15 12 * * *', 'per_cycle', 100, false, true,  '{"threshold_setting":"chronic_recall_min_days","order_by":"days_since_last_visit desc"}'),
    (p_org, 'birthday',      'Birthday message',                   'birthday',  'draft', 'v_birthday_today',              '0 9 * * *',   'per_cycle', 1000, true, false, '{"bands":["m_20_29","m_30_39","m_40_plus","f_18_35","f_36_45","f_46_65"]}'),
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

  -- Birthday: gender/age bands from the Make scenario (OQ-17). Greeting name: first name (D5 still open).
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

-- Workspaces seeded before this migration: fill only maps that are still empty.
update public.recall_programme_templates t
   set variables_map = '{"body.1":"contact.first_name|default:Patient"}'::jsonb
  from public.recall_programmes p
 where p.id = t.programme_id
   and p.key in ('chronic_90d', 'birthday')
   and t.variables_map = '{}'::jsonb;
