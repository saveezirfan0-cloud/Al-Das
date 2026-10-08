-- 0101_clinical_settings.sql  (DRAFT — Phase 0)
-- Clinically-governed parameters. Source: Acute.Settings (tbl69r1kelxG4g93L), 30 live rows,
-- plus Phase 0 additions (source = 'pulse'). "NEVER hardcode these thresholds … read them from here."
-- Depends on 0100 (helpers) and Phase 1 orgs/memberships.

do $$ begin
  if not exists (select 1 from pg_type where typname = 'clinical_setting_category') then
    create type public.clinical_setting_category as enum
      ('paediatrics','gp_adults','gynaecology','medication_sequence','escalation','operational','recall','engine');
  end if;
  if not exists (select 1 from pg_type where typname = 'sign_off_status') then
    create type public.sign_off_status as enum
      ('blocking','awaiting','confirm_exclusion','approved');
  end if;
  if not exists (select 1 from pg_type where typname = 'setting_value_type') then
    create type public.setting_value_type as enum ('text','number','boolean','json','list');
  end if;
end $$;

create table if not exists public.clinical_settings (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.orgs(id) on delete cascade,
  key                 text not null,
  label               text not null,                          -- Airtable "Parameter" verbatim
  category            public.clinical_setting_category not null,
  value_type          public.setting_value_type not null default 'text',
  proposed_value      text,                                   -- fldg7eo4b6905Vouh
  approved_value      text,                                   -- fld5xepAeK9pdB6mE (null until signed)
  live_value          text,                                   -- what the Airtable formula / Make blueprint actually uses today
  sign_off_status     public.sign_off_status not null default 'awaiting',
  owner               text,                                   -- fldD5bnejIIX8YMqO
  notes               text,                                   -- fldOGCNJX09G2Rlms
  source              text not null default 'airtable',       -- airtable | pulse
  airtable_record_id  text,
  signed_by           text,                                   -- fldU8lQx3G30drRGi
  signed_at           date,                                   -- fld51DuMTqkow2Qic
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (org_id, key),
  constraint approved_requires_signature
    check (sign_off_status <> 'approved' or (approved_value is not null and signed_by is not null and signed_at is not null))
);

alter table public.clinical_settings enable row level security;
drop policy if exists clinical_settings_member on public.clinical_settings;
create policy clinical_settings_member on public.clinical_settings
  for all using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
drop trigger if exists set_updated_at on public.clinical_settings;
create trigger set_updated_at before update on public.clinical_settings
  for each row execute function public.set_updated_at();

-- Audit every change to a clinical setting (DHA-defensible trail).
create table if not exists public.clinical_settings_history (
  id            bigserial primary key,
  org_id        uuid not null,
  setting_key   text not null,
  changed_at    timestamptz not null default now(),
  changed_by    uuid,                                          -- auth.uid() when available
  old_row       jsonb,
  new_row       jsonb
);
alter table public.clinical_settings_history enable row level security;
drop policy if exists clinical_settings_history_member on public.clinical_settings_history;
create policy clinical_settings_history_member on public.clinical_settings_history
  for select using (public.is_org_member(org_id));

create or replace function public.clinical_settings_audit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.clinical_settings_history (org_id, setting_key, changed_by, old_row, new_row)
  values (coalesce(new.org_id, old.org_id), coalesce(new.key, old.key), auth.uid(),
          to_jsonb(old), to_jsonb(new));
  return coalesce(new, old);
end $$;
drop trigger if exists clinical_settings_audit on public.clinical_settings;
create trigger clinical_settings_audit after insert or update or delete on public.clinical_settings
  for each row execute function public.clinical_settings_audit();

-- ---------------------------------------------------------------------------
-- Fail-closed accessor. Returns the approved value; otherwise the proposed value only when the
-- org has explicitly enabled unsigned defaults; otherwise NULL (rule must not fire).
-- ---------------------------------------------------------------------------
create or replace function public.clinical_setting(p_org uuid, p_key text)
returns text language sql stable as $$
  with s as (select * from public.clinical_settings where org_id = p_org and key = p_key),
       allow_unsigned as (
         select coalesce(
           (select (coalesce(approved_value, proposed_value))::boolean
              from public.clinical_settings where org_id = p_org and key = 'allow_unsigned_defaults'),
           false) as v)
  select case
           when s.approved_value is not null then s.approved_value
           when (select v from allow_unsigned) then s.proposed_value
           else null
         end
  from s;
$$;

create or replace function public.clinical_setting_num(p_org uuid, p_key text)
returns numeric language sql stable as $$
  select nullif(regexp_replace(coalesce(public.clinical_setting(p_org, p_key), ''), '[^0-9.\-]', '', 'g'), '')::numeric;
$$;

create or replace function public.clinical_setting_bool(p_org uuid, p_key text)
returns boolean language sql stable as $$
  select case lower(coalesce(public.clinical_setting(p_org, p_key), ''))
           when 'true' then true when 'yes' then true when '1' then true
           when 'false' then false when 'no' then false when '0' then false
           else null end;
$$;

-- ---------------------------------------------------------------------------
-- Seed: the 30 live Airtable rows (labels + notes verbatim) and the Phase 0 engine settings.
-- Run per org: select public.seed_clinical_settings('<org uuid>');
-- ---------------------------------------------------------------------------
create or replace function public.seed_clinical_settings(p_org uuid)
returns void language plpgsql as $$
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
 '["infect","pneumonia","uti","cellulitis","abscess","infected wound"]','same','awaiting','Abdul / Snezana','Verbatim from the live TRIGGER GP formula.','pulse',null),
(p_org,'unite_min_interval_ms','Unite API minimum interval between calls (ms)','operational','number','250',null,'awaiting','Saveez',
 'Conservative rate limit for the live production EMR (CLAUDE.md rule 7). Engineering setting, not clinical.','pulse',null)
on conflict (org_id, key) do nothing;

-- Rows that are already "Approved" in the Airtable Settings table carry their sign-off across
-- (the check constraint requires approved_value + signed_by + signed_at together, hence one UPDATE).
update public.clinical_settings
   set sign_off_status = 'approved',
       approved_value  = proposed_value,
       signed_by       = 'Airtable Settings sign-off (imported 2026-10-08)',
       signed_at       = current_date
 where org_id = p_org and approved_value is null
   and key in ('governance_doctor_approved_templates_only','governance_no_diagnosis_over_whatsapp',
               'governance_audit_trail_retention','unite_min_interval_ms');
end $$;
