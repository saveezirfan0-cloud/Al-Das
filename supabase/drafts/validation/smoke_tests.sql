-- Smoke tests for the Phase 0 drafts. Synthetic data only (no names, no real numbers).
-- Fails loudly (RAISE EXCEPTION) on any unexpected result.
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- Fixtures: two orgs, one user each
-- ---------------------------------------------------------------------------
insert into public.orgs (id, name) values
  ('00000000-0000-0000-0000-00000000000a', 'Org A'),
  ('00000000-0000-0000-0000-00000000000b', 'Org B');
insert into public.profiles (id) values
  ('00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000b1');
insert into public.memberships (org_id, user_id) values
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000b1');

select public.seed_condition_groups('00000000-0000-0000-0000-00000000000a');
select public.seed_clinical_settings('00000000-0000-0000-0000-00000000000a');
select public.seed_recall_programmes('00000000-0000-0000-0000-00000000000a');
select public.seed_reminder_exclusions('00000000-0000-0000-0000-00000000000a');
select public.seed_unite_appointment_status_map('00000000-0000-0000-0000-00000000000a');
select public.seed_condition_groups('00000000-0000-0000-0000-00000000000b');
select public.seed_clinical_settings('00000000-0000-0000-0000-00000000000b');
select public.seed_recall_programmes('00000000-0000-0000-0000-00000000000b');

do $$
declare n int;
begin
  select count(*) into n from public.clinical_settings where org_id = '00000000-0000-0000-0000-00000000000a';
  if n < 50 then raise exception 'expected >= 50 seeded settings, got %', n; end if;
  select count(*) into n from public.clinical_settings where org_id = '00000000-0000-0000-0000-00000000000a' and sign_off_status = 'blocking';
  if n <> 4 then raise exception 'expected 4 BLOCKING settings, got %', n; end if;
  select count(*) into n from public.clinical_settings where org_id = '00000000-0000-0000-0000-00000000000a' and sign_off_status = 'approved';
  if n <> 4 then raise exception 'expected 4 approved settings, got %', n; end if;
  select count(*) into n from public.ref_condition_groups where org_id = '00000000-0000-0000-0000-00000000000a' and messageable;
  if n <> 10 then raise exception 'expected 10 messageable groups, got %', n; end if;
  select count(*) into n from public.recall_programme_templates t join public.recall_programmes p on p.id = t.programme_id
   where p.org_id = '00000000-0000-0000-0000-00000000000a' and p.key = 'chronic_90d';
  if n <> 10 then raise exception 'expected 10 chronic templates, got %', n; end if;
  raise notice 'seeds OK';
end $$;

-- ---------------------------------------------------------------------------
-- Fail-closed settings accessor
-- ---------------------------------------------------------------------------
do $$
declare v text; org uuid := '00000000-0000-0000-0000-00000000000a';
begin
  v := public.clinical_setting(org, 'chronic_recall_min_days');
  if v is not null then raise exception 'unsigned setting must read NULL when allow_unsigned_defaults is false, got %', v; end if;
  v := public.clinical_setting(org, 'governance_no_diagnosis_over_whatsapp');
  if v is null then raise exception 'approved setting must be readable'; end if;
  update public.clinical_settings set approved_value = 'true', sign_off_status = 'approved', signed_by = 'test', signed_at = current_date
   where org_id = org and key = 'allow_unsigned_defaults';
  v := public.clinical_setting(org, 'chronic_recall_min_days');
  if v <> '90' then raise exception 'with unsigned defaults allowed, proposed value 90 expected, got %', v; end if;
  if public.clinical_setting_num(org, 'spo2_low_pct') <> 94 then raise exception 'numeric accessor failed'; end if;
  if public.clinical_setting_bool(org, 'clinical_messaging_enabled') is distinct from false then raise exception 'bool accessor failed'; end if;
  -- blocking settings have no proposed value and stay NULL even with unsigned defaults allowed
  if public.clinical_setting(org, 'day3_halt_threshold') is not null then raise exception 'BLOCKING setting must stay NULL'; end if;
  raise notice 'settings accessor OK';
end $$;

-- ---------------------------------------------------------------------------
-- Chronic recall eligibility at 30 / 85 / 90 / 120 days
-- ---------------------------------------------------------------------------
do $$
declare org uuid := '00000000-0000-0000-0000-00000000000a';
        c45 uuid; c95 uuid; c130 uuid; cnophone uuid; cmental uuid; dx_htn uuid; dx_anx uuid;
        n int;
begin
  insert into public.ref_diagnoses (org_id, code, short_description, chronic, top30, condition_group_id)
  values (org, 'I10', 'Essential (primary) hypertension', true, true, (select id from public.ref_condition_groups where org_id = org and key = 'hypertension'))
  returning id into dx_htn;
  insert into public.ref_diagnoses (org_id, code, short_description, chronic, top30, condition_group_id)
  values (org, 'F41.1', 'Generalized anxiety disorder', true, true, (select id from public.ref_condition_groups where org_id = org and key = 'anxiety'))
  returning id into dx_anx;

  insert into public.contacts (org_id, first_name, phone_e164, dob, gender) values (org, 'T1', '+971500000001', '1970-01-01', 'male') returning id into c45;
  insert into public.contacts (org_id, first_name, phone_e164, dob, gender) values (org, 'T2', '+971500000002', '1970-01-01', 'male') returning id into c95;
  insert into public.contacts (org_id, first_name, phone_e164, dob, gender) values (org, 'T3', '+971500000003', '1970-01-01', 'male') returning id into c130;
  insert into public.contacts (org_id, first_name, phone_e164, dob, gender) values (org, 'T4', null,             '1970-01-01', 'male') returning id into cnophone;
  insert into public.contacts (org_id, first_name, phone_e164, dob, gender) values (org, 'T5', '+971500000005', '1970-01-01', 'male') returning id into cmental;

  insert into public.contact_chronic_conditions (org_id, contact_id, ref_diagnosis_id) values
    (org, c45, dx_htn), (org, c95, dx_htn), (org, c130, dx_htn), (org, cnophone, dx_htn), (org, cmental, dx_anx);

  insert into public.visits (org_id, contact_id, external_id, visit_date) values
    (org, c45,      'V45',  current_date - 45),
    (org, c95,      'V95',  current_date - 95),
    (org, c130,     'V130', current_date - 130),
    (org, cnophone, 'VNP',  current_date - 95),
    (org, cmental,  'VM',   current_date - 95);

  -- threshold 90 (proposed, unsigned defaults allowed from the previous block)
  select count(*) into n from public.v_chronic_recall_eligibility where org_id = org and eligible;
  if n <> 2 then raise exception 'threshold 90: expected 2 eligible (95, 130 days), got %', n; end if;
  if exists (select 1 from public.v_chronic_recall_eligibility where contact_id = cnophone and eligible) then raise exception 'no phone must not be eligible'; end if;
  if exists (select 1 from public.v_chronic_recall_eligibility where contact_id = cmental and eligible) then raise exception 'mental-health-only must not be eligible'; end if;

  -- threshold 30 (the live Airtable value)
  update public.clinical_settings set approved_value = '30', sign_off_status = 'approved', signed_by = 'test', signed_at = current_date
   where org_id = org and key = 'chronic_recall_min_days';
  select count(*) into n from public.v_chronic_recall_eligibility where org_id = org and eligible;
  if n <> 3 then raise exception 'threshold 30: expected 3 eligible, got %', n; end if;

  -- threshold 85
  update public.clinical_settings set approved_value = '85' where org_id = org and key = 'chronic_recall_min_days';
  select count(*) into n from public.v_chronic_recall_eligibility where org_id = org and eligible;
  if n <> 2 then raise exception 'threshold 85: expected 2 eligible, got %', n; end if;

  -- a send for the current cycle removes the contact from eligibility
  insert into public.recall_sends (org_id, programme_id, contact_id, cycle_key, segment_key, send_mode, status, sent_at, sent_to_phone_e164, days_since_last_visit_at_send, last_visit_date_at_send)
  values (org, (select id from public.recall_programmes where org_id = org and key = 'chronic_90d'), c130, (current_date - 130)::text, 'hypertension', 'live', 'sent', now() - interval '5 days', '+971500000003', 130, current_date - 130);
  select count(*) into n from public.v_chronic_recall_eligibility where org_id = org and eligible;
  if n <> 1 then raise exception 'after send: expected 1 eligible, got %', n; end if;

  -- call list: sent 5 days ago, no reply → call_now (recall_followup_workdays = 3 proposed) and overdue (130 > 120)
  if not exists (select 1 from public.v_recall_call_list where org_id = org and contact_id = c130 and call_now and overdue) then
    raise exception 'call list: expected call_now + overdue for the 130-day contact';
  end if;
  raise notice 'eligibility OK';
end $$;

-- ---------------------------------------------------------------------------
-- Uniqueness / constraints
-- ---------------------------------------------------------------------------
do $$
declare org uuid := '00000000-0000-0000-0000-00000000000a'; v uuid; ok boolean;
begin
  select id into v from public.visits where org_id = org and external_id = 'V95';
  insert into public.visit_rule_evaluations (org_id, visit_id, engine_version, rules_fired, trigger_category, dedupe_key, follow_up_due_date)
  values (org, v, 'test', '{GP-01-VITALS}', 'vitals', 'V95-vitals', public.add_workdays(org, current_date, 1));
  ok := false;
  begin
    insert into public.visit_rule_evaluations (org_id, visit_id, engine_version, rules_fired, trigger_category, dedupe_key)
    values (org, v, 'test', '{GP-01-VITALS}', 'vitals', 'V95-vitals');
  exception when unique_violation then ok := true; end;
  if not ok then raise exception 'duplicate dedupe_key must be rejected'; end if;

  ok := false;
  begin
    insert into public.visit_rule_evaluations (org_id, visit_id, engine_version, rules_fired, trigger_category)
    values (org, v, 'test', '{}', 'vitals');
  exception when check_violation then ok := true; end;
  if not ok then raise exception 'category without rules must be rejected'; end if;

  ok := false;
  begin
    insert into public.clinical_message_log (org_id, template_key, idempotency_key) values (org, 'ABX_DAY3', 'V95-1:ABX_DAY3');
    insert into public.clinical_message_log (org_id, template_key, idempotency_key) values (org, 'ABX_DAY3', 'V95-1:ABX_DAY3');
  exception when unique_violation then ok := true; end;
  if not ok then raise exception 'duplicate idempotency_key must be rejected'; end if;

  ok := false;
  begin
    update public.recall_sends set follow_up_status = 'booked' where org_id = org and booked_at is null;
  exception when check_violation then ok := true; end;
  if not ok then raise exception 'booked without booked_at must be rejected'; end if;

  ok := false;
  begin
    insert into public.ref_medication_classes (org_id, unite_local_code, class, classified_by) values (org, 'X1', 'antibiotic', 'heuristic');
  exception when check_violation then ok := true; end;
  if not ok then raise exception 'heuristic classification must stay unclassified'; end if;

  ok := false;
  begin
    insert into public.visits (org_id, external_id, visit_date, bp_systolic) values (org, 'VBAD', current_date, 999);
  exception when check_violation then ok := true; end;
  if not ok then raise exception 'implausible BP must be rejected'; end if;

  -- workday helpers: default calendar Mon–Fri; Friday + 1 workday = Monday
  if public.add_workdays(org, date '2026-10-09', 1) <> date '2026-10-12' then raise exception 'add_workdays Friday→Monday failed'; end if;
  insert into public.clinic_calendar (org_id, working_weekdays, holidays) values (org, '{1,2,3,4,5,6}', '{2026-10-12}');
  if public.add_workdays(org, date '2026-10-09', 1) <> date '2026-10-10' then raise exception 'add_workdays with Saturday working day failed'; end if;
  if public.add_workdays(org, date '2026-10-10', 1) <> date '2026-10-13' then raise exception 'add_workdays over Sunday + holiday failed'; end if;
  raise notice 'constraints OK';
end $$;

-- ---------------------------------------------------------------------------
-- RLS: user of Org A must not see Org B rows (and vice versa)
-- ---------------------------------------------------------------------------
insert into public.contacts (org_id, first_name, phone_e164) values ('00000000-0000-0000-0000-00000000000b', 'B1', '+971500000099');
insert into public.visits (org_id, external_id, visit_date, contact_id)
  select '00000000-0000-0000-0000-00000000000b', 'VB1', current_date, id from public.contacts where org_id = '00000000-0000-0000-0000-00000000000b';

set role app_user;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
do $$
declare n int;
begin
  select count(*) into n from public.visits where org_id = '00000000-0000-0000-0000-00000000000b';
  if n <> 0 then raise exception 'RLS leak: org A user sees % org B visits', n; end if;
  select count(*) into n from public.clinical_settings where org_id = '00000000-0000-0000-0000-00000000000b';
  if n <> 0 then raise exception 'RLS leak: org A user sees % org B settings', n; end if;
  select count(*) into n from public.recall_sends where org_id = '00000000-0000-0000-0000-00000000000b';
  if n <> 0 then raise exception 'RLS leak: recall_sends'; end if;
  select count(*) into n from public.visits where org_id = '00000000-0000-0000-0000-00000000000a';
  if n < 5 then raise exception 'org A user should see own visits, got %', n; end if;
  select count(*) into n from public.v_chronic_recall_eligibility where org_id = '00000000-0000-0000-0000-00000000000b';
  if n <> 0 then raise exception 'RLS leak through view'; end if;
  begin
    insert into public.visits (org_id, external_id, visit_date) values ('00000000-0000-0000-0000-00000000000b', 'VX', current_date);
    raise exception 'RLS leak: org A user inserted into org B';
  exception when insufficient_privilege then null;
  end;
  raise notice 'RLS OK';
end $$;
reset role;

select 'ALL SMOKE TESTS PASSED' as result;
