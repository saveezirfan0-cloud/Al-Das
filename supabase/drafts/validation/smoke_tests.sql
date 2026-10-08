-- Smoke tests for the Phase 0 drafts on top of the real Phase 1 tenancy. Synthetic data only.
-- Fails loudly (RAISE EXCEPTION) on any unexpected result.
\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

-- ---------------------------------------------------------------------------
-- Fixtures: two orgs through the Phase 1 create_org RPC (service role), three users.
--   A1 = Admin of Org A ('*'), A2 = Agent of Org A (portal.*.read only), A3 = Coordinator (portal.* + clinical.settings.manage)
--   B1 = Admin of Org B
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'a1@test.local'),
  ('00000000-0000-0000-0000-0000000000a2', 'a2@test.local'),
  ('00000000-0000-0000-0000-0000000000a3', 'a3@test.local'),
  ('00000000-0000-0000-0000-0000000000b1', 'b1@test.local');

set role service_role;
select public.create_org('Org A', 'org-a',
  '[{"name":"Admin","description":"all","permissions":["*"]},
    {"name":"Agent","description":"read","permissions":["inbox.send","portal.*.read"]},
    {"name":"Coordinator","description":"care coordinator","permissions":["portal.*","clinical.settings.manage","appointments.manage"]}]'::jsonb,
  '00000000-0000-0000-0000-0000000000a1') \gset org_a_
select public.create_org('Org B', 'org-b',
  '[{"name":"Admin","description":"all","permissions":["*"]}]'::jsonb,
  '00000000-0000-0000-0000-0000000000b1') \gset org_b_
reset role;

insert into public.memberships (org_id, user_id, role_id)
select :'org_a_create_org', '00000000-0000-0000-0000-0000000000a2', id from public.roles where org_id = :'org_a_create_org' and name = 'Agent';
insert into public.memberships (org_id, user_id, role_id)
select :'org_a_create_org', '00000000-0000-0000-0000-0000000000a3', id from public.roles where org_id = :'org_a_create_org' and name = 'Coordinator';

set role service_role;
select public.seed_condition_groups(:'org_a_create_org');
select public.seed_clinical_settings(:'org_a_create_org');
select public.seed_recall_programmes(:'org_a_create_org');
select public.seed_reminder_exclusions(:'org_a_create_org');
select public.seed_unite_appointment_status_map(:'org_a_create_org');
select public.seed_condition_groups(:'org_b_create_org');
select public.seed_clinical_settings(:'org_b_create_org');
select public.seed_recall_programmes(:'org_b_create_org');
reset role;

create temp table t_ctx as select :'org_a_create_org'::uuid as org_a, :'org_b_create_org'::uuid as org_b;
grant select on t_ctx to authenticated;

do $$
declare n int; org uuid := (select org_a from t_ctx);
begin
  select count(*) into n from public.clinical_settings where org_id = org;
  if n < 50 then raise exception 'expected >= 50 seeded settings, got %', n; end if;
  select count(*) into n from public.clinical_settings where org_id = org and sign_off_status = 'blocking';
  if n <> 4 then raise exception 'expected 4 BLOCKING settings, got %', n; end if;
  select count(*) into n from public.clinical_settings where org_id = org and sign_off_status = 'approved';
  if n <> 4 then raise exception 'expected 4 approved settings, got %', n; end if;
  select count(*) into n from public.ref_condition_groups where org_id = org and messageable;
  if n <> 10 then raise exception 'expected 10 messageable groups, got %', n; end if;
  select count(*) into n from public.recall_programme_templates t join public.recall_programmes p on p.id = t.programme_id
   where p.org_id = org and p.key = 'chronic_90d';
  if n <> 10 then raise exception 'expected 10 chronic templates, got %', n; end if;
  select count(*) into n from public.clinical_settings_history where org_id = org;
  if n < 50 then raise exception 'settings audit trail missing, got % rows', n; end if;
  raise notice 'seeds OK';
end $$;

-- ---------------------------------------------------------------------------
-- Fail-closed settings accessor
-- ---------------------------------------------------------------------------
do $$
declare v text; org uuid := (select org_a from t_ctx);
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
  if public.clinical_setting(org, 'day3_halt_threshold') is not null then raise exception 'BLOCKING setting must stay NULL'; end if;
  raise notice 'settings accessor OK';
end $$;

-- ---------------------------------------------------------------------------
-- Chronic recall eligibility at 30 / 85 / 90 / 120 days
-- ---------------------------------------------------------------------------
do $$
declare org uuid := (select org_a from t_ctx);
        c45 uuid; c95 uuid; c130 uuid; cnophone uuid; cmental uuid; dx_htn uuid; dx_anx uuid; n int;
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

  select count(*) into n from public.v_chronic_recall_eligibility where org_id = org and eligible;
  if n <> 2 then raise exception 'threshold 90: expected 2 eligible (95, 130 days), got %', n; end if;
  if exists (select 1 from public.v_chronic_recall_eligibility where contact_id = cnophone and eligible) then raise exception 'no phone must not be eligible'; end if;
  if exists (select 1 from public.v_chronic_recall_eligibility where contact_id = cmental and eligible) then raise exception 'mental-health-only must not be eligible'; end if;

  update public.clinical_settings set approved_value = '30', sign_off_status = 'approved', signed_by = 'test', signed_at = current_date
   where org_id = org and key = 'chronic_recall_min_days';
  select count(*) into n from public.v_chronic_recall_eligibility where org_id = org and eligible;
  if n <> 3 then raise exception 'threshold 30: expected 3 eligible, got %', n; end if;

  update public.clinical_settings set approved_value = '85' where org_id = org and key = 'chronic_recall_min_days';
  select count(*) into n from public.v_chronic_recall_eligibility where org_id = org and eligible;
  if n <> 2 then raise exception 'threshold 85: expected 2 eligible, got %', n; end if;

  insert into public.recall_sends (org_id, programme_id, contact_id, cycle_key, segment_key, send_mode, status, sent_at, sent_to_phone_e164, days_since_last_visit_at_send, last_visit_date_at_send)
  values (org, (select id from public.recall_programmes where org_id = org and key = 'chronic_90d'), c130, (current_date - 130)::text, 'hypertension', 'live', 'sent', now() - interval '5 days', '+971500000003', 130, current_date - 130);
  select count(*) into n from public.v_chronic_recall_eligibility where org_id = org and eligible;
  if n <> 1 then raise exception 'after send: expected 1 eligible, got %', n; end if;

  if not exists (select 1 from public.v_recall_call_list where org_id = org and contact_id = c130 and call_now and overdue) then
    raise exception 'call list: expected call_now + overdue for the 130-day contact';
  end if;
  raise notice 'eligibility OK';
end $$;

-- ---------------------------------------------------------------------------
-- Uniqueness / constraints / workday maths
-- ---------------------------------------------------------------------------
do $$
declare org uuid := (select org_a from t_ctx); v uuid; ok boolean;
begin
  select id into v from public.visits where org_id = org and external_id = 'V95';
  insert into public.visit_rule_evaluations (org_id, visit_id, engine_version, rules_fired, trigger_category, dedupe_key, follow_up_due_date)
  values (org, v, 'test', '{GP-01-VITALS}', 'vitals', 'V95-vitals', public.add_workdays(org, current_date, 1));
  insert into public.clinical_followups (org_id, visit_id, trigger_category, priority, due_date, dedupe_key)
  values (org, v, 'vitals', 'medium', current_date + 1, 'V95-vitals');
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

  if public.add_workdays(org, date '2026-10-09', 1) <> date '2026-10-12' then raise exception 'add_workdays Friday→Monday failed'; end if;
  insert into public.clinic_calendar (org_id, working_weekdays, holidays) values (org, '{1,2,3,4,5,6}', '{2026-10-12}');
  if public.add_workdays(org, date '2026-10-09', 1) <> date '2026-10-10' then raise exception 'add_workdays with Saturday working day failed'; end if;
  if public.add_workdays(org, date '2026-10-10', 1) <> date '2026-10-13' then raise exception 'add_workdays over Sunday + holiday failed'; end if;
  raise notice 'constraints OK';
end $$;

-- ---------------------------------------------------------------------------
-- RLS: cross-org isolation and permission-gated writes, evaluated exactly as PostgREST does
-- ---------------------------------------------------------------------------
insert into public.contacts (org_id, first_name, phone_e164) select org_b, 'B1', '+971500000099' from t_ctx;
insert into public.visits (org_id, external_id, visit_date, contact_id)
  select c.org_id, 'VB1', current_date, c.id from public.contacts c join t_ctx x on c.org_id = x.org_b;

-- Agent of Org A: reads own org, nothing from Org B, cannot write portal objects
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', false);
do $$
declare n int; org_a uuid := (select org_a from t_ctx); org_b uuid := (select org_b from t_ctx);
begin
  select count(*) into n from public.visits where org_id = org_b;
  if n <> 0 then raise exception 'RLS leak: org A agent sees % org B visits', n; end if;
  select count(*) into n from public.clinical_settings where org_id = org_b;
  if n <> 0 then raise exception 'RLS leak: settings'; end if;
  select count(*) into n from public.recall_sends where org_id = org_b;
  if n <> 0 then raise exception 'RLS leak: recall_sends'; end if;
  select count(*) into n from public.v_chronic_recall_eligibility where org_id = org_b;
  if n <> 0 then raise exception 'RLS leak through view'; end if;
  select count(*) into n from public.visits where org_id = org_a;
  if n < 5 then raise exception 'org A agent should see own visits, got %', n; end if;
  select count(*) into n from public.clinical_settings_history where org_id = org_a;
  if n <> 0 then raise exception 'agent must not read the settings audit trail'; end if;

  -- writes without the permission are rejected (RLS returns a policy violation on insert/update)
  begin
    update public.clinical_followups set notes = 'x' where org_id = org_a;
    if found then raise exception 'RLS leak: agent updated clinical_followups'; end if;
  exception when insufficient_privilege then null; end;
  begin
    insert into public.visits (org_id, external_id, visit_date) values (org_b, 'VX', current_date);
    raise exception 'RLS leak: agent inserted into org B';
  exception when insufficient_privilege then null; end;
  begin
    update public.clinical_settings set approved_value = '1' where org_id = org_a and key = 'red_flag_score_threshold';
    if found then raise exception 'RLS leak: agent signed off a clinical setting'; end if;
  exception when insufficient_privilege then null; end;
  raise notice 'RLS agent OK';
end $$;

-- Coordinator of Org A: may edit the call list and follow-up queue, may sign off settings
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}', false);
do $$
declare org_a uuid := (select org_a from t_ctx); n int;
begin
  update public.clinical_followups set call_status = 'completed', outcome = 'improving' where org_id = org_a;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'coordinator should update 1 follow-up, got %', n; end if;
  update public.recall_sends set follow_up_status = 'booked', booked_at = now() where org_id = org_a;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'coordinator should update 1 recall send, got %', n; end if;
  update public.clinical_settings set approved_value = '5', sign_off_status = 'approved', signed_by = 'Coordinator', signed_at = current_date
   where org_id = org_a and key = 'red_flag_score_threshold';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'coordinator should sign off 1 setting, got %', n; end if;
  select count(*) into n from public.clinical_settings_history where org_id = org_a and setting_key = 'red_flag_score_threshold';
  if n < 2 then raise exception 'sign-off must be audited'; end if;
  -- still cannot write engine-owned tables
  begin
    insert into public.visits (org_id, external_id, visit_date) values (org_a, 'VCOORD', current_date);
    raise exception 'RLS leak: coordinator inserted a visit';
  exception when insufficient_privilege then null; end;
  raise notice 'RLS coordinator OK';
end $$;
reset role;
select set_config('request.jwt.claims', '', false);

select 'ALL SMOKE TESTS PASSED' as result;
