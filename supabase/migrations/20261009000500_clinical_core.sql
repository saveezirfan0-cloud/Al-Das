-- Phase 6 (6c): clinical engine core. Promoted from supabase/drafts/0100–0103 with these changes:
--   * clinical_setting() honours approved_value only when sign_off_status = 'approved', and a DB
--     constraint forbids an approved_value on a row that is not signed off.
--   * app.clinical_messaging_enabled(org): the patient-facing gate. True only for a signed-off row set
--     to true; allow_unsigned_defaults can never open it.
--   * Clinical data is PHI: reads need a portal permission (the drafts let any member read visits).
--   * The clinic calendar is the appointments booking-rule calendar (orgs.settings->'appointments'),
--     not a second table. Recall, reference-data and Unite visit-feed tables stay in the drafts.
--
-- Nothing in here sends a message. Patient-facing clinical messages stay off until the
-- clinical_messaging_enabled setting is signed off (CLAUDE.md: Phase 6).

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
create type public.clinical_setting_category as enum
  ('paediatrics','gp_adults','gynaecology','medication_sequence','escalation','operational','recall','engine');
create type public.sign_off_status as enum ('blocking','awaiting','confirm_exclusion','approved');
create type public.setting_value_type as enum ('text','number','boolean','json','list');
create type public.department_mapped as enum ('paediatrics','gp','gynaecology','dermatology','other');
create type public.pap_result as enum ('positive','negative','pending','not_available');
create type public.trigger_category as enum
  ('paediatric_high_concern','bleeding','vitals','infection_labs','post_procedure','clinical_check');
create type public.sequence_status as enum
  ('not_started','day3_sent','awaiting_day3_reply','awaiting_clarification','awaiting_probiotic',
   'probiotic_sent','outcome_sent','complete','halted_clinical');
create type public.medication_class as enum
  ('antibiotic','steroid','probiotic','supplement','enzyme','other','unclassified');
create type public.followup_priority as enum ('high','medium');
create type public.call_status as enum ('pending','completed','escalated','no_answer');
create type public.followup_outcome as enum ('improving','same','worse');
create type public.escalation_status as enum ('none','open','escalated','resolved');
create type public.feedback_stage as enum ('day3_antibiotics','after_antibiotics','after_probiotics','post_procedure');
create type public.clinical_send_status as enum
  ('scheduled','suppressed_gate','suppressed_test_record','blocked','sent','delivered','read','failed','cancelled');

-- ---------------------------------------------------------------------------
-- RLS helper: reads and writes each gated by a permission (clinical data is PHI)
-- ---------------------------------------------------------------------------
create or replace function app.add_tenant_rls_gated(p_table text, p_read_perm text, p_write_perm text default null)
returns void
language plpgsql
set search_path = ''
as $$
begin
  execute format('alter table public.%I enable row level security', p_table);

    execute format('drop policy if exists %I on public.%I', p_table || '_select', p_table);
    execute format('drop policy if exists %I on public.%I', p_table || '_insert', p_table);
    execute format('drop policy if exists %I on public.%I', p_table || '_update', p_table);
    execute format('drop policy if exists %I on public.%I', p_table || '_delete', p_table);
  execute format('create policy %I on public.%I for select to authenticated using (app.has_perm_wild(org_id, %L))',
                 p_table || '_select', p_table, p_read_perm);
  if p_write_perm is not null then
    execute format('create policy %I on public.%I for insert to authenticated with check (app.has_perm_wild(org_id, %L))',
                   p_table || '_insert', p_table, p_write_perm);
    execute format('create policy %I on public.%I for update to authenticated using (app.has_perm_wild(org_id, %L)) with check (app.has_perm_wild(org_id, %L))',
                   p_table || '_update', p_table, p_write_perm, p_write_perm);
    execute format('create policy %I on public.%I for delete to authenticated using (app.has_perm_wild(org_id, %L))',
                   p_table || '_delete', p_table, p_write_perm);
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = p_table and column_name = 'updated_at') then
    execute format('drop trigger if exists %I on public.%I', p_table || '_set_updated_at', p_table);
    execute format('create trigger %I before update on public.%I for each row execute function app.set_updated_at()',
                   p_table || '_set_updated_at', p_table);
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Columns the engine and the gate read on existing tables
-- ---------------------------------------------------------------------------
alter table public.contacts
  add column is_test_record boolean not null default false,                 -- internal validation people: the only live-test recipients
  add column clinical_messaging_consent boolean not null default false;     -- separate from marketing opt-in
alter table public.wa_templates
  add column internal_key text,                                              -- ABX_DAY3, PROBIOTIC_START, …
  add column clinical_approval text not null default 'awaiting'
    check (clinical_approval in ('approved','awaiting','to_be_drafted'));
create unique index wa_templates_org_internal_key_uidx on public.wa_templates (org_id, internal_key) where internal_key is not null;

-- ---------------------------------------------------------------------------
-- clinical_settings (+ audit trail + fail-closed accessors)
-- ---------------------------------------------------------------------------
create table public.clinical_settings (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.orgs(id) on delete cascade,
  key                 text not null,
  label               text not null,
  category            public.clinical_setting_category not null,
  value_type          public.setting_value_type not null default 'text',
  proposed_value      text,
  approved_value      text,                                    -- counts only while sign_off_status = 'approved'
  live_value          text,                                    -- what the Airtable formula / Make blueprint used
  sign_off_status     public.sign_off_status not null default 'awaiting',
  owner               text,
  notes               text,
  source              text not null default 'airtable',        -- airtable | pulse
  airtable_record_id  text,
  signed_by           text,
  signed_at           date,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (org_id, key),
  constraint approved_requires_signature
    check (sign_off_status <> 'approved' or (approved_value is not null and signed_by is not null and signed_at is not null)),
  constraint approved_value_requires_approved_status
    check (approved_value is null or sign_off_status = 'approved')
);
-- everyone in the org may read thresholds; sign-off needs clinical.settings.manage
select app.add_tenant_rls('clinical_settings', 'clinical.settings.manage');

create table public.clinical_settings_history (
  id            bigserial primary key,
  org_id        uuid not null,
  setting_key   text not null,
  changed_at    timestamptz not null default now(),
  changed_by    uuid,                                           -- auth.uid(); null for service-role writes (seeds)
  old_row       jsonb,
  new_row       jsonb
);
create index clinical_settings_history_key_idx on public.clinical_settings_history (org_id, setting_key, changed_at desc);
alter table public.clinical_settings_history enable row level security;
create policy clinical_settings_history_select on public.clinical_settings_history
  for select to authenticated using (app.has_perm_wild(org_id, 'clinical.settings.manage'));

create or replace function public.clinical_settings_audit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.clinical_settings_history (org_id, setting_key, changed_by, old_row, new_row)
  values (coalesce(new.org_id, old.org_id), coalesce(new.key, old.key), auth.uid(), to_jsonb(old), to_jsonb(new));
  return coalesce(new, old);
end $$;
create trigger clinical_settings_audit after insert or update or delete on public.clinical_settings
  for each row execute function public.clinical_settings_audit();

-- The value a rule may use: the signed-off value; else the proposed value ONLY while the org has
-- explicitly (and with sign-off) enabled unsigned defaults; else NULL (the rule must not fire).
create or replace function public.clinical_setting(p_org uuid, p_key text)
returns text language sql stable as $$
  select case
           when s.sign_off_status = 'approved' and s.approved_value is not null then s.approved_value
           when exists (select 1 from public.clinical_settings a
                         where a.org_id = p_org and a.key = 'allow_unsigned_defaults'
                           and a.sign_off_status = 'approved'
                           and lower(coalesce(a.approved_value, '')) in ('true', 'yes', '1')) then s.proposed_value
           else null
         end
  from public.clinical_settings s
  where s.org_id = p_org and s.key = p_key;
$$;

create or replace function public.clinical_setting_num(p_org uuid, p_key text)
returns numeric language sql stable as $$
  select case when v ~ '^-?[0-9]+(\.[0-9]+)?$' then v::numeric end
  from (select btrim(coalesce(public.clinical_setting(p_org, p_key), '')) as v) t;
$$;

create or replace function public.clinical_setting_bool(p_org uuid, p_key text)
returns boolean language sql stable as $$
  select case lower(coalesce(public.clinical_setting(p_org, p_key), ''))
           when 'true' then true when 'yes' then true when '1' then true
           when 'false' then false when 'no' then false when '0' then false
           else null end;
$$;

-- THE GATE. No patient-facing clinical message leaves while this is false. Only a signed-off row set to
-- true opens it; allow_unsigned_defaults and proposed values are deliberately not consulted.
create or replace function app.clinical_messaging_enabled(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select s.sign_off_status = 'approved' and lower(coalesce(s.approved_value, '')) in ('true', 'yes', '1')
       from public.clinical_settings s
      where s.org_id = p_org and s.key = 'clinical_messaging_enabled'),
    false);
$$;
revoke all on function app.clinical_messaging_enabled(uuid) from public, anon;
grant execute on function app.clinical_messaging_enabled(uuid) to authenticated, service_role;

create or replace function public.seed_clinical_settings(p_org uuid)
returns void language plpgsql set search_path = '' as $$
begin
insert into public.clinical_settings
  (org_id, key, label, category, value_type, proposed_value, live_value, sign_off_status, owner, notes, source, airtable_record_id)
values
-- ---- Airtable Settings table, 30 rows -------------------------------------------------------------
(p_org,'post_procedure_followup_interval','Post-procedure follow-up interval','gp_adults','text','48 hours','WORKDAY(+2)','awaiting','Abdul / Snezana',
 'Specified as 48 hours or per doctor note. Rule GP-04.','airtable','rec1GjMbqh07hYFDc'),
(p_org,'gyn_imaging_structural_exclusion','Gynaecology imaging / structural exclusion','gynaecology','text','EXCLUDED - no automated action','excluded','confirm_exclusion','Abdul / Snezana',
 'Rejected with the reasoning: ''the diagnosis is not static, it varies from person to person and so does the treatment.'' Covers TVUS findings, endometrial thickness and ovarian morphology.','airtable','rec46jH8tdqbIln9l'),
(p_org,'day3_halt_threshold','Day-3 HALT threshold','medication_sequence','number',null,null,'blocking','Abdul / Snezana',
 'CANNOT BE DEFAULTED BY IT. This is the score at or below which a patient is routed to an appointment instead of being handed probiotics. The original specification fired the probiotic message on date alone, meaning a patient doing badly at day 3 would still be told the course succeeded. This is the one place the original spec is arguably unsafe.','airtable','rec4F4F8AxuculYHr'),
(p_org,'side_effect_keywords','Side-effect keyword list','escalation','list',null,null,'blocking','Abdul / Snezana',
 'CANNOT BE DEFAULTED BY IT. Keyword choice is a clinical decision. Candidate starting set for review only: rash, swelling, vomiting, diarrhoea, dizziness, breathing difficulty, allergic reaction. A side effect must fire the red flag even when the score is high.','airtable','rec4L09OGd4xzC36H'),
(p_org,'governance_doctor_approved_templates_only','Governance: doctor-approved templates only','operational','text','Standing rule - always applies','Standing rule - always applies','awaiting','Abdul / Snezana',
 'Every word a patient receives must carry clinical sign-off before it is created.','airtable','rec5bmxEObCZa23Jb'),
(p_org,'pap_smear_trigger_scope','Pap smear trigger scope','gynaecology','text','Positive results ONLY','Positive results ONLY','confirm_exclusion','Abdul / Snezana',
 'Narrowed from the original ''Pap smear with symptoms'' to prevent every routine screening generating a follow-up task. Rule GYN-08.','airtable','rec6q82j90eJ5YNDJ'),
(p_org,'escalation_notification_recipients','Escalation notification recipients','escalation','text','Treating doctor AND care coordinator',null,'awaiting','Abdul / Snezana',
 'Dual notification was explicit in the specification: the doctor for clinical judgement, the coordinator to ensure the loop closes.','airtable','rec8f3zMRWQyYRw4S'),
(p_org,'sanoflow_reply_attribution','Sanoflow reply attribution','operational','text','UNKNOWN',null,'awaiting','Saveez',
 'Can Sanoflow reliably attribute a free-text reply to a specific outbound template? The day-3 branch and outcome capture both depend on it. Confirm before building the branch. (Pulse: attribution is native, see make-replacement-design.md §6.)','airtable','recA2t8rdtsgoHSFh'),
(p_org,'pap_result_available_in_unite','Pap Result field availability in Unite','operational','text','UNKNOWN','Not available in Unite','awaiting','Sharafadin',
 'If Unite does not supply a structured Pap result, rule GYN-08 cannot be built safely. Do NOT fall back to triggering on all smears.','airtable','recAGrMtNGdnMic3E'),
(p_org,'infant_age_cutoff_years','Infant age cut-off','paediatrics','number','2','2','awaiting','Abdul / Snezana',
 'Must be age AT VISIT, not age today. Boundary tested: 1y11m at 38.0 triggers; 2y1m at 38.0 does not. (Airtable: ''Under 2 years at visit'')','airtable','recAS7SVGo5KHCYfv'),
(p_org,'gyn_bp_systolic_low','Gynaecology BP threshold','gynaecology','number','95','95','awaiting','Abdul / Snezana',
 'Deliberately higher than the adult threshold and conditional on symptoms. Rule GYN-06. (Airtable: ''Systolic < 95 WITH symptoms'')','airtable','recEX8CrlRJERWqZW'),
(p_org,'spo2_low_pct','O2 saturation threshold','paediatrics','number','94','94','awaiting','Abdul / Snezana',
 'Applies to both paediatric (PAED-04) and adult (GP-01) rules. (Airtable: ''<= 94 %'')','airtable','recEii2zuvF5OGdcK'),
(p_org,'governance_no_diagnosis_over_whatsapp','Governance: no diagnosis over WhatsApp','operational','text','Standing rule - always applies','Standing rule - always applies','awaiting','Abdul / Snezana',
 'The system must never diagnose via WhatsApp. Messages check in, prompt bookings and capture scores; they never interpret.','airtable','recGS770TnBpyhFlK'),
(p_org,'paediatric_seizure_exclusion','Paediatric seizure exclusion','paediatrics','text','EXCLUDED - no automated action','excluded','confirm_exclusion','Abdul / Snezana',
 'Febrile seizure, seizure and convulsion were clinically rejected because such cases need a real clinical pathway, not an automated message. Sound, but was one person''s informal reading - confirm rather than inherit.','airtable','recItdRfdgWDfOemw'),
(p_org,'clinic_working_week','Clinic working week','operational','json',null,'Mon-Fri (WORKDAY default)','blocking','Abdul',
 'Needed for the ''next working day'' calculation. A Friday visit rolls to which day? Currently using Airtable WORKDAY() which assumes Mon-Fri - almost certainly wrong for a UAE clinic.','airtable','recJNlfQbZwgmtlhw'),
(p_org,'probiotic_default_days','Probiotic default duration','medication_sequence','number','10','10','awaiting','Abdul / Snezana',
 'Original specification said 7-10 days. Drives the TREATMENT_OUTCOME send date.','airtable','recJaHYIbaXuvsKTa'),
(p_org,'adult_bp_systolic_low','Adult BP thresholds (systolic)','gp_adults','number','90','90','awaiting','Abdul / Snezana',
 'Rule GP-01. Requires BP to be parsed from the Unite string into two numeric fields. (Airtable: ''Systolic < 90 OR diastolic < 60'')','airtable','recJxLJ3CoQIPzVxZ'),
(p_org,'adult_bp_diastolic_low','Adult BP thresholds (diastolic)','gp_adults','number','60','60','awaiting','Abdul / Snezana',
 'Rule GP-01. Requires BP to be parsed from the Unite string into two numeric fields. (Airtable: ''Systolic < 90 OR diastolic < 60'')','airtable','recJxLJ3CoQIPzVxZ'),
(p_org,'adult_pulse_high','Adult pulse threshold','gp_adults','number','110','110','awaiting','Abdul / Snezana',
 'Specified as especially relevant with fever, chest symptoms or dehydration. Rule GP-01. (Airtable: ''>= 110'')','airtable','recLzztFvzDU6MWmk'),
(p_org,'red_flag_score_threshold','Red flag score threshold','escalation','number','5','5','awaiting','Abdul / Snezana',
 'Bilal-era value. Triggers notification of the treating doctor AND the care coordinator. (Airtable: ''<= 5'')','airtable','recN6P7zSSZUq7XjZ'),
(p_org,'gyn_pulse_high','Gynaecology pulse threshold','gynaecology','number','100','100','awaiting','Abdul / Snezana',
 'Rule GYN-06. (Airtable: ''>= 100 WITH pain or bleeding'')','airtable','recQeGIDmbug0PYQZ'),
(p_org,'phase2_internal_validation_period','Phase 2 internal validation period','operational','text','To be agreed',null,'awaiting','Abdul',
 'Phase 2 launches with internal nurse and call-centre tasks only. Patient-facing messages switch on only after internal validation has run clean for an agreed period.','airtable','recV67ZZUqDOGHPmr'),
(p_org,'adult_fever_temp_c','Adult fever threshold','gp_adults','number','39.0','39.0','awaiting','Abdul / Snezana',
 'Rule GP-01. (Airtable: ''>= 39.0 C'')','airtable','recc6rmRSUWENP1ax'),
(p_org,'day3_offset_days','Day-3 check timing','medication_sequence','number','2','2','awaiting','Abdul / Snezana',
 'CONFIRM: does day 3 mean the third day of the course (start + 2) or 72 hours after the first dose (start + 3)? Built as a single configurable offset. (Airtable: ''Start Date + 2 days'')','airtable','reccJSh54Hws4ejxs'),
(p_org,'paeds_fever_temp_c','Paediatric general fever threshold','paediatrics','number','39.0','39.0','awaiting','Abdul / Snezana',
 'Bilal stated thresholds could be tightened or loosened per the doctors'' preference, so this was always provisional. Rule PAED-01. (Airtable: ''>= 39.0 C'')','airtable','reclT3EQz5HkNfqSI'),
(p_org,'drug_class_derivable_from_unite_codes','Drug class derivable from Unite code list','operational','text','UNKNOWN','text heuristic on MEDICINE TYPE','awaiting','Sharafadin',
 'Can Medication Class be derived from the existing drug code list, or does it need clinical mapping? Blocks the entire Phase 1 medication sequence.','airtable','recm46b5KLxsyJF1P'),
(p_org,'followup_queue_staffing','Follow-Up Queue staffing','operational','text',null,null,'blocking','Abdul',
 'VOLUME RISK. Paediatric and GP rules trigger on EVERY consultation meeting criteria - materially more than the 20-30 patient chronic cohort. The trigger engine will work; the question is whether anyone can action what it produces.','airtable','recmA5IHoK3rk8o0j'),
(p_org,'probiotics_required_by_default','Probiotics required by default after antibiotics','medication_sequence','boolean','true','true','awaiting','Abdul / Snezana',
 'Set per drug in Medication Reference, overridable on the individual prescription record. (Airtable: ''Yes, clinically overridable per prescription'')','airtable','recpV6wSmVIw827Me'),
(p_org,'infant_fever_temp_c','Paediatric INFANT fever threshold','paediatrics','number','38.0','38.0','awaiting','Abdul / Snezana',
 'The sharpest clinical rule in the specification. Lower threshold for infants because parents are at peak anxiety and next-morning contact is the highest-value clinic contact. Rule PAED-02. Do not simplify to a single temperature. (Airtable: ''>= 38.0 C AND age at visit < 2'')','airtable','recyn87u8hGNZNw91'),
(p_org,'governance_audit_trail_retention','Governance: audit trail retention','operational','text','Timestamps, prescription linkage, consent','Timestamps, prescription linkage, consent','awaiting','Abdul / Snezana',
 'Must be DHA-defensible. Message Log and the Notified At stamp on Feedback records exist for this purpose.','airtable','reczV7J5zbH6xZxgm'),
(p_org,'gp05_compliance_check_days','Medication compliance check interval','gp_adults','text','3-5',null,'awaiting','Abdul / Snezana',
 'Rule GP-05. Requires the Has Antibiotic / Has Steroid rollups to be added. (Airtable: ''Day 3-5 after start'')','airtable','recZtJeu3OEhKhGRF'),
-- ---- Phase 0 additions (engine + recall) ------------------------------------------------------------
(p_org,'clinical_messaging_enabled','Patient-facing clinical messaging enabled','engine','boolean','false','false','awaiting','Abdul',
 'Phase gate (clinical-rules R-26). Nothing clinical reaches a real patient while false; the engine still fills the follow-up queue and logs would-send rows.','pulse',null),
(p_org,'allow_unsigned_defaults','Allow proposed values where sign-off is pending','engine','boolean','false','false','awaiting','Abdul',
 'When false (default) every rule that needs an unsigned setting does not fire. Switch on only for internal validation.','pulse',null),
(p_org,'recall_send_mode','Recall send mode','recall','text','test','Live (Make SEND_MODE variable)','awaiting','Saveez',
 'test = all recall/clinical sends go to test_recipient_numbers; live = real patients. Mirrors the Make SEND_MODE variable and the Send Mode column.','pulse',null),
(p_org,'test_recipient_numbers','Internal validation recipient numbers','recall','list',null,null,'awaiting','Saveez',
 'E.164 numbers of the internal validation group (TP-15 names the people). Set in the portal, never in a seed.','pulse',null),
(p_org,'chronic_recall_min_days','Chronic recall: minimum days since last visit','recall','number','90','30','awaiting','Abdul / Snezana',
 'Live Airtable formula uses >= 30 days; the field description says 90+ (''Every 3 months''); go-live feedback cites 85. Decide one (OQ-01).','pulse',null),
(p_org,'chronic_recall_overdue_days','Chronic recall: overdue alert threshold (days)','recall','number','120','120','awaiting','Abdul / Snezana',
 'Recall Overdue Flag: ''OVERDUE'' = days since last visit over 120, meaning the recall caught a very late patient rather than one on schedule.','pulse',null),
(p_org,'recall_followup_workdays','Recall: working days without reply before the call list','recall','number','3','3','awaiting','Abdul',
 'A live send with no reply after 3 working days moves to the care coordinator''s active call list. Uses clinic_calendar.','pulse',null),
(p_org,'recall_reply_attribution_days','Recall: days a reply is attributed to an open send','recall','number','14',null,'awaiting','Saveez',
 'Replaces the Chronic Update webhook''s phone-only match (OQ-22).','pulse',null),
(p_org,'recall_booking_attribution_days','Recall: days a booking counts as a conversion','recall','number','30',null,'awaiting','Management',
 'Booking rate KPI (target 30%). OQ-33.','pulse',null),
(p_org,'paeds_age_cutoff_years','Paediatric department override: age at visit below','engine','number','14','14','awaiting','Abdul / Snezana',
 'Department Effective step 1: anyone under 14 at the visit is forced to Paediatrics regardless of what Unite says.','pulse',null),
(p_org,'doctor_routing_gynaecology','Doctor routing list: Gynaecology','engine','list','[]','[]','awaiting','Abdul',
 'Exact Doctor names as Unite sends them. Empty today, so the routing step never fires (OQ-08).','pulse',null),
(p_org,'doctor_routing_paediatrics','Doctor routing list: Paediatrics','engine','list','[]','[]','awaiting','Abdul',
 'Exact Doctor names as Unite sends them.','pulse',null),
(p_org,'doctor_routing_gp','Doctor routing list: GP','engine','list','[]','[]','awaiting','Abdul',
 'Exact Doctor names as Unite sends them.','pulse',null),
(p_org,'negation_cues','Negation cues for narrative scrubbing','engine','list',
 '["no","not","denies","denied","deny","negative for","without","nil","absent","-ve","no evidence of","rules out","ruled out","free of"]',
 null,'awaiting','Abdul / Snezana',
 'R-03. The live Make sync performs no scrubbing although the field descriptions say it does (OQ-31).','pulse',null),
(p_org,'gp02_redflag_terms','GP-02 red-flag terms','gp_adults','list',
 '["chest pain","shortness of breath","syncope","fainting","palpitations","severe abdominal pain","persistent vomiting","blood in stool","severe headache","neurological deficit","confusion"]',
 'same','awaiting','Abdul / Snezana','Verbatim from the live TRIGGER GP formula.','pulse',null),
(p_org,'paed05_respiratory_terms','PAED-05 respiratory terms','paediatrics','list',
 '["shortness of breath","wheeze","bronchiolitis","pneumonia","croup","respiratory distress"]','same','awaiting','Abdul / Snezana','Verbatim from the live TRIGGER Paediatrics formula.','pulse',null),
(p_org,'paed07_infection_terms','PAED-07 infection terms','paediatrics','list',
 '["uti","pyelonephritis","tonsillitis","otitis media","pneumonia","cellulitis"]','same','awaiting','Abdul / Snezana','Verbatim; apply word boundaries to ''uti'' (OQ-31).','pulse',null),
(p_org,'gp03_infection_terms','GP-03 infection terms','gp_adults','list',
 '["infect","pneumonia","uti","cellulitis","abscess","infected wound"]','same','awaiting','Abdul / Snezana','Verbatim from the live TRIGGER GP formula.','pulse',null)
,
-- ---- Rule term lists and follow-up timing the live formulas hard-code (verbatim proposed values) ------------
(p_org,'paed06_gi_terms','PAED-06 GI terms','paediatrics','list','["vomit","diarrh"]','same','awaiting','Abdul / Snezana','Verbatim from the live TRIGGER Paediatrics formula. Stems match the start of a word.','pulse',null),
(p_org,'paed06_dehydration_terms','PAED-06 dehydration terms','paediatrics','list','["poor intake","dehydrat","dry mouth","reduced urine","lethargic"]','same','awaiting','Abdul / Snezana','Verbatim from the live TRIGGER Paediatrics formula.','pulse',null),
(p_org,'paed09_plan_terms','PAED-09 plan terms','paediatrics','list','["er advised","ed advised","return if worse","follow up advised","follow-up advised"]','same','awaiting','Abdul / Snezana','Verbatim from the live TRIGGER Paediatrics formula.','pulse',null),
(p_org,'gp06_plan_terms','GP-06 plan terms','gp_adults','list','["follow up advised","follow-up advised","review in","return tomorrow"]','same','awaiting','Abdul / Snezana','Verbatim from the live TRIGGER GP formula.','pulse',null),
(p_org,'gyn01_bleed_terms','GYN-01 bleeding terms (coded fields)','gynaecology','list','["abnormal uterine bleeding","aub","postcoital","intermenstrual","menorrhagia"]','same','awaiting','Abdul / Snezana','Verbatim; short terms such as aub match whole words only.','pulse',null),
(p_org,'gyn02_bleed_terms','GYN-02 bleeding terms (notes)','gynaecology','list','["contact bleeding","active bleeding"]','same','awaiting','Abdul / Snezana','Verbatim from the live TRIGGER Gynaecology formula.','pulse',null),
(p_org,'gyn04_obs_terms','GYN-04 infection terms (notes)','gynaecology','list','["green discharge","yellow discharge","foul"]','same','awaiting','Abdul / Snezana','Verbatim from the live TRIGGER Gynaecology formula.','pulse',null),
(p_org,'gyn04_investigation_terms','GYN-04 infection terms (investigations)','gynaecology','list','["hvs","vaginal swab","culture"]','same','awaiting','Abdul / Snezana','Verbatim from the live TRIGGER Gynaecology formula.','pulse',null),
(p_org,'gyn04_diagnosis_terms','GYN-04 infection terms (diagnosis)','gynaecology','list','["vaginitis","cervicitis","pid","pelvic inflammatory"]','same','awaiting','Abdul / Snezana','Verbatim; pid matches the whole word only.','pulse',null),
(p_org,'gyn05_pain_terms','GYN-05 pain terms','gynaecology','list','["pelvic pain","perineal pain","dysmenorrh"]','same','awaiting','Abdul / Snezana','Verbatim from the live TRIGGER Gynaecology formula.','pulse',null),
(p_org,'gyn05_structural_terms','GYN-05 structural diagnoses (need a symptom)','gynaecology','list','["adenomyosis","fibroid","endometriosis"]','same','awaiting','Abdul / Snezana','Structural diagnoses never trigger alone (OQ-10).','pulse',null),
(p_org,'gyn05_symptom_terms','GYN-05 symptom terms','gynaecology','list','["pain","bleed","heavy","discomfort"]','same','awaiting','Abdul / Snezana','Verbatim from the live TRIGGER Gynaecology formula.','pulse',null),
(p_org,'gyn07_proc_terms','GYN-07 procedure terms','gynaecology','list','["biopsy","cervical examination"]','same','awaiting','Abdul / Snezana','Verbatim from the live TRIGGER Gynaecology formula.','pulse',null),
(p_org,'gyn09_plan_terms','GYN-09 plan terms','gynaecology','list','["follow up advised","review after results","monitor symptoms"]','same','awaiting','Abdul / Snezana','Verbatim from the live TRIGGER Gynaecology formula.','pulse',null),
(p_org,'category_bleeding_terms','Trigger category: bleeding terms (coded fields only)','engine','list','["bleed","menorrhagia","spotting","haemorrhage","hemorrhage"]','same','awaiting','Abdul / Snezana','R-09 step 2. Never applied to narrative notes (the ''denies blood in stool'' incident).','pulse',null),
(p_org,'category_infection_terms','Trigger category: infection terms','engine','list','["infect","pneumonia","uti","cellulitis","abscess","vaginitis","cervicitis","pid"]','same','awaiting','Abdul / Snezana','R-09 step 4.','pulse',null),
(p_org,'followup_days_urgent','Follow-up due: working days (urgent categories)','operational','number','1','1','awaiting','Abdul / Snezana','Paediatric High-Concern, Vitals, Bleeding, Infection-Labs. R-10.','pulse',null),
(p_org,'followup_days_standard','Follow-up due: working days (other categories)','operational','number','2','2','awaiting','Abdul / Snezana','All other categories. R-10.','pulse',null),
(p_org,'followup_review_cap_days','Follow-up due: longest ''review in X days'' honoured','operational','number','30',null,'awaiting','Abdul / Snezana','OQ-40: a plan saying ''review in 5 days'' sets the due date to that many days, up to this cap.','pulse',null)

on conflict (org_id, key) do nothing;

-- Rows already "Approved" in the Airtable Settings table carry their sign-off across (the check
-- constraints need approved_value + signed_by + signed_at together, hence one UPDATE).
update public.clinical_settings
   set sign_off_status = 'approved',
       approved_value  = proposed_value,
       signed_by       = 'Airtable Settings sign-off (imported 2026-10-08)',
       signed_at       = current_date
 where org_id = p_org and approved_value is null
   and key in ('governance_doctor_approved_templates_only','governance_no_diagnosis_over_whatsapp',
               'governance_audit_trail_retention');

end $$;
revoke all on function public.seed_clinical_settings(uuid) from public, anon, authenticated;
grant execute on function public.seed_clinical_settings(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Medication classes (R-05): classify by CODE; unknown codes fail closed
-- ---------------------------------------------------------------------------
create table public.ref_medication_classes (
  id                           uuid primary key default gen_random_uuid(),
  org_id                       uuid not null references public.orgs(id) on delete cascade,
  unite_local_code             text not null,
  medication_name              text,
  class                        public.medication_class not null default 'unclassified',
  requires_probiotics_default  boolean not null default false,
  classified_by                text,                                -- 'heuristic' = suggestion only
  classified_at                timestamptz,
  notes                        text,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  unique (org_id, unite_local_code),
  constraint heuristic_is_unclassified check (classified_by is distinct from 'heuristic' or class = 'unclassified')
);
select app.add_tenant_rls_gated('ref_medication_classes', 'portal.clinical_visits.read', 'portal.medication_classes.write');

-- ---------------------------------------------------------------------------
-- Visits, prescriptions, sequences, evaluations
-- ---------------------------------------------------------------------------
create table public.visits (
  id                          uuid primary key default gen_random_uuid(),
  org_id                      uuid not null references public.orgs(id) on delete cascade,
  contact_id                  uuid references public.contacts(id) on delete set null,
  external_id                 text not null,                       -- Unite medical-record id
  source                      text not null default 'unite',
  visit_date                  date not null,
  location_id                 uuid references public.locations(id) on delete set null,
  specialist_id               uuid references public.specialists(id) on delete set null,
  doctor_name                 text,                                -- exact string for doctor routing (R-07)
  department_raw              text,
  department_mapped           public.department_mapped,            -- R-04
  height_cm                   numeric(5,1),
  weight_kg                   numeric(5,1),
  temp_c                      numeric(4,1),
  pulse                       int,
  bp_systolic                 int,
  bp_diastolic                int,
  spo2                        int,
  vitals_raw                  jsonb not null default '{}'::jsonb,   -- original strings (R-01/R-02)
  description                 text,
  complaints                  text,
  hpi                         text,
  doctor_notes                text,
  nurse_notes                 text,
  therapy_notes               text,
  procedure_notes             text,
  physical_exam_notes         text,
  review_of_systems           text,
  plan_of_treatment           text,
  observation_notes_raw       text,
  observation_notes_scrubbed  text,
  scrub_version               int,
  primary_diagnosis_code      text,
  primary_diagnosis_text      text,
  secondary_diagnosis_codes   text,
  investigations_ordered      text,                                -- GYN-04 reads the text
  investigation_count         int,                                 -- PAED-08 / GP-03 / category; null = not known. The feed decides what counts (OQ-31)
  pap_result                  public.pap_result,
  symptomatic                 boolean,                             -- OQ-29
  is_test_record              boolean not null default false,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  unique (org_id, external_id),
  constraint bp_plausible check (
    (bp_systolic is null or bp_systolic between 30 and 300) and (bp_diastolic is null or bp_diastolic between 10 and 200)),
  constraint temp_plausible check (temp_c is null or temp_c between 30 and 45),
  constraint spo2_plausible check (spo2 is null or spo2 between 50 and 100),
  constraint pulse_plausible check (pulse is null or pulse between 20 and 250),
  constraint investigation_count_nonneg check (investigation_count is null or investigation_count >= 0)
);
create index visits_contact_date_idx on public.visits (org_id, contact_id, visit_date desc);
create index visits_date_idx on public.visits (org_id, visit_date desc);

create table public.prescriptions (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.orgs(id) on delete cascade,
  visit_id             uuid references public.visits(id) on delete cascade,
  contact_id           uuid references public.contacts(id) on delete set null,
  position             int,
  external_key         text not null,                              -- '<visit external_id>-<position>'
  medication_code      text,                                       -- Unite local code (classified by CODE, R-05)
  medication_name      text,
  class                public.medication_class not null default 'unclassified',
  duration_days        int,
  dosage_instruction   text,
  total_quantity       numeric(10,2),
  start_date           date,
  is_test_record       boolean not null default false,
  source               text not null default 'unite',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, external_key)
);
create index prescriptions_visit_idx on public.prescriptions (visit_id);
create index prescriptions_unclassified_idx on public.prescriptions (org_id) where class = 'unclassified';

create table public.prescription_sequences (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null references public.orgs(id) on delete cascade,
  prescription_id           uuid not null unique references public.prescriptions(id) on delete cascade,
  requires_probiotics       boolean not null default false,
  probiotic_duration_days   int,
  day3_offset_days          int,
  antibiotic_end_date       date,
  day3_check_date           date,
  probiotic_start_date      date,
  probiotic_end_date        date,
  status                    public.sequence_status not null default 'not_started',
  day3_score                int,
  outcome_score             int,
  outcome_symptoms          text,
  halted_at                 timestamptz,
  halted_reason             text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint scores_in_range check (
    (day3_score is null or day3_score between 1 and 10) and (outcome_score is null or outcome_score between 1 and 10)),
  constraint halted_has_timestamp check (status <> 'halted_clinical' or halted_at is not null)
);
create index prescription_sequences_due_idx on public.prescription_sequences (org_id, status, day3_check_date, probiotic_start_date, probiotic_end_date);

create table public.visit_rule_evaluations (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references public.orgs(id) on delete cascade,
  visit_id               uuid not null references public.visits(id) on delete cascade,
  engine_version         text not null,
  settings_snapshot      jsonb not null default '{}'::jsonb,       -- the setting values used
  inputs_hash            text,                                        -- skip re-evaluation when nothing changed
  age_at_visit           int,
  department_effective   public.department_mapped,
  vitals_complete        boolean,
  rules_fired            text[] not null default '{}',
  missing_settings       text[] not null default '{}',              -- unsigned settings that kept rules from running
  trigger_category       public.trigger_category,
  follow_up_due_date     date,
  dedupe_key             text,                                        -- <visit external_id>-<category>
  is_current             boolean not null default true,
  evaluated_at           timestamptz not null default now(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint category_iff_rules check ((trigger_category is null) = (cardinality(rules_fired) = 0)),
  constraint dedupe_key_iff_category check ((dedupe_key is null) = (trigger_category is null))
);
create unique index visit_rule_evaluations_dedupe on public.visit_rule_evaluations (org_id, dedupe_key) where is_current and dedupe_key is not null;
create unique index visit_rule_evaluations_current on public.visit_rule_evaluations (visit_id) where is_current;

-- ---------------------------------------------------------------------------
-- Follow-up queue, feedback, message log, call scripts
-- ---------------------------------------------------------------------------
create table public.clinical_followups (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references public.orgs(id) on delete cascade,
  ref                     text,
  visit_id                uuid references public.visits(id) on delete set null,
  contact_id              uuid references public.contacts(id) on delete set null,
  rule_evaluation_id      uuid references public.visit_rule_evaluations(id) on delete set null,
  prescription_id         uuid references public.prescriptions(id) on delete set null,
  trigger_category        public.trigger_category,
  priority                public.followup_priority not null default 'medium',
  due_date                date,
  assigned_team_id        uuid references public.teams(id) on delete set null,
  assigned_user_id        uuid references public.profiles(id) on delete set null,
  call_status             public.call_status not null default 'pending',
  outcome                 public.followup_outcome,
  doctor_alert_required   boolean not null default false,
  doctor_notified_at      timestamptz,
  escalation_status       public.escalation_status not null default 'none',
  doctor_response_notes   text,
  notes                   text,
  dedupe_key              text,
  closed_at               timestamptz,
  closed_reason           text,                                        -- completed | superseded | no_longer_triggered | duplicate
  is_test_record          boolean not null default false,
  source                  text not null default 'engine',              -- engine | sequence | feedback | manual
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create unique index clinical_followups_dedupe on public.clinical_followups (org_id, dedupe_key) where closed_at is null and dedupe_key is not null;
create index clinical_followups_queue_idx on public.clinical_followups (org_id, call_status, due_date) where closed_at is null;

-- Engine-owned columns can't be rewritten from a user session (staff edit the call outcome only).
create or replace function app.guard_followup_engine_columns()
returns trigger language plpgsql set search_path = '' as $$
begin
  if auth.uid() is not null and (
       new.org_id is distinct from old.org_id or new.dedupe_key is distinct from old.dedupe_key
       or new.trigger_category is distinct from old.trigger_category or new.visit_id is distinct from old.visit_id
       or new.contact_id is distinct from old.contact_id or new.rule_evaluation_id is distinct from old.rule_evaluation_id
       or new.prescription_id is distinct from old.prescription_id or new.source is distinct from old.source
       or new.ref is distinct from old.ref or new.is_test_record is distinct from old.is_test_record) then
    raise exception 'engine-owned follow-up columns cannot be edited' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger clinical_followups_guard before update on public.clinical_followups
  for each row execute function app.guard_followup_engine_columns();

create table public.clinical_feedback (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null references public.orgs(id) on delete cascade,
  ref                       text,
  contact_id                uuid references public.contacts(id) on delete set null,
  prescription_id           uuid references public.prescriptions(id) on delete set null,
  visit_id                  uuid references public.visits(id) on delete set null,
  stage                     public.feedback_stage not null,
  score                     int,
  reply_text                text,                                          -- verbatim (R-16)
  symptoms_reported         text,
  symptoms_improved         boolean,
  side_effects_flagged      boolean not null default false,
  needs_doctor_review       boolean not null default false,
  red_flag_threshold_used   int,                                           -- null = evaluated fail-closed
  doctor_notified_at        timestamptz,
  coordinator_notified_at   timestamptz,
  source_message_id         uuid references public.messages(id) on delete set null,
  is_test_record            boolean not null default false,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint score_in_range check (score is null or score between 1 and 10),
  constraint red_flag_notification_pair check (
    not needs_doctor_review
    or (doctor_notified_at is null and coordinator_notified_at is null)
    or (doctor_notified_at is not null and coordinator_notified_at is not null))
);
create index clinical_feedback_redflag_idx on public.clinical_feedback (org_id, created_at desc) where needs_doctor_review;

create table public.clinical_message_log (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.orgs(id) on delete cascade,
  ref                  text,
  template_key         text not null,
  wa_template_id       uuid references public.wa_templates(id) on delete set null,
  trigger_category     public.trigger_category,
  idempotency_key      text not null,                                      -- '<prescription or visit external key>:<template_key>'
  contact_id           uuid references public.contacts(id) on delete set null,
  visit_id             uuid references public.visits(id) on delete set null,
  prescription_id      uuid references public.prescriptions(id) on delete set null,
  followup_id          uuid references public.clinical_followups(id) on delete set null,
  send_mode            text not null default 'test' check (send_mode in ('test','live')),
  status               public.clinical_send_status not null default 'scheduled',
  block_reason         text,                                               -- why it was suppressed / blocked
  scheduled_at         timestamptz,
  sent_at              timestamptz,
  delivered_at         timestamptz,
  read_at              timestamptz,
  replied_at           timestamptz,
  reply_text           text,
  reply_parsed_score   int,
  message_id           uuid references public.messages(id) on delete set null,
  reply_message_id     uuid references public.messages(id) on delete set null,
  error_code           text,
  is_test_record       boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, idempotency_key),
  constraint parsed_score_in_range check (reply_parsed_score is null or reply_parsed_score between 1 and 10),
  constraint test_records_never_live check (not (is_test_record and send_mode = 'live' and status in ('sent','delivered','read')))
);
create index clinical_message_log_sched_idx on public.clinical_message_log (org_id, status, scheduled_at);

create table public.clinical_call_scripts (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.orgs(id) on delete cascade,
  key                text not null,
  purpose            text,
  trigger_category   public.trigger_category,
  script             text not null,
  clinical_approval  text not null default 'awaiting' check (clinical_approval in ('approved','awaiting','to_be_drafted')),
  phase              int,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (org_id, key)
);

-- Org consistency for references. `update of <column>` so an unrelated update (a nurse recording a call
-- outcome) never has to be able to SEE the referenced row.
create trigger visits_contact_org_check before insert or update of contact_id on public.visits
  for each row execute function app.check_parent_org('contacts', 'contact_id');
create trigger visits_location_org_check before insert or update of location_id on public.visits
  for each row execute function app.check_parent_org('locations', 'location_id');
create trigger visits_specialist_org_check before insert or update of specialist_id on public.visits
  for each row execute function app.check_parent_org('specialists', 'specialist_id');
create trigger prescriptions_visit_org_check before insert or update of visit_id on public.prescriptions
  for each row execute function app.check_parent_org('visits', 'visit_id');
create trigger prescription_sequences_rx_org_check before insert or update of prescription_id on public.prescription_sequences
  for each row execute function app.check_parent_org('prescriptions', 'prescription_id');
create trigger visit_rule_evaluations_visit_org_check before insert or update of visit_id on public.visit_rule_evaluations
  for each row execute function app.check_parent_org('visits', 'visit_id');
create trigger clinical_followups_visit_org_check before insert or update of visit_id on public.clinical_followups
  for each row execute function app.check_parent_org('visits', 'visit_id');
create trigger clinical_followups_contact_org_check before insert or update of contact_id on public.clinical_followups
  for each row execute function app.check_parent_org('contacts', 'contact_id');
create trigger clinical_followups_team_org_check before insert or update of assigned_team_id on public.clinical_followups
  for each row execute function app.check_parent_org('teams', 'assigned_team_id');

-- ---------------------------------------------------------------------------
-- Views for the portal (security invoker: RLS applies through them)
-- ---------------------------------------------------------------------------
create view public.v_followup_queue with (security_invoker = true) as
select f.*, e.rules_fired, e.age_at_visit, e.department_effective, v.visit_date, v.doctor_name
from public.clinical_followups f
left join public.visit_rule_evaluations e on e.id = f.rule_evaluation_id
left join public.visits v on v.id = f.visit_id
where f.closed_at is null;

create view public.v_visit_data_quality with (security_invoker = true) as
select v.org_id, v.id as visit_id, v.external_id, v.visit_date, v.contact_id,
       (v.temp_c is null) as missing_temp,
       (v.bp_systolic is null or v.bp_diastolic is null) as missing_bp,
       (v.spo2 is null) as missing_spo2,
       (v.pulse is null) as missing_pulse,
       (v.contact_id is null) as unmatched_patient
from public.visits v
where v.temp_c is null or v.bp_systolic is null or v.bp_diastolic is null or v.spo2 is null or v.pulse is null or v.contact_id is null;

create view public.v_unclassified_medications with (security_invoker = true) as
select p.org_id, p.medication_code, max(p.medication_name) as medication_name,
       count(*) as prescription_count, min(p.start_date) as first_seen, max(p.start_date) as last_seen
from public.prescriptions p
where p.class = 'unclassified'
group by p.org_id, p.medication_code;

-- ---------------------------------------------------------------------------
-- RLS. Clinical data is PHI: reads need a portal permission. Visits, prescriptions, evaluations and
-- the message log are written only by the engine / sync (service role).
-- ---------------------------------------------------------------------------
select app.add_tenant_rls_gated('visits',                  'portal.clinical_visits.read');
select app.add_tenant_rls_gated('prescriptions',           'portal.clinical_visits.read');
select app.add_tenant_rls_gated('prescription_sequences',  'portal.clinical_visits.read', 'portal.prescription_sequences.write');
select app.add_tenant_rls_gated('visit_rule_evaluations',  'portal.clinical_followups.read');
select app.add_tenant_rls_gated('clinical_followups',      'portal.clinical_followups.read', 'portal.clinical_followups.write');
select app.add_tenant_rls_gated('clinical_feedback',       'portal.clinical_followups.read', 'portal.clinical_feedback.write');
select app.add_tenant_rls_gated('clinical_message_log',    'portal.clinical_followups.read');
select app.add_tenant_rls('clinical_call_scripts', 'clinical.settings.manage');

-- Evaluate new visits every 10 minutes (lib/jobs/handlers/clinical.ts).
select cron.schedule('pulse:clinical_evaluate', '*/10 * * * *', $$select app.ping_jobs('clinical_evaluate')$$);
