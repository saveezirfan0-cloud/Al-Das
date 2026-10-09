-- Local development seed. FAKE DATA ONLY (CLAUDE.md rule 10).
-- Creates one dev admin and the workspace with the system roles + two teams.
--   email:    admin@pulse.local
--   password: pulse-dev-password

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change, email_change_token_new
) values (
  '00000000-0000-0000-0000-000000000000',
  'a0000000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', 'admin@pulse.local',
  crypt('pulse-dev-password', gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"first_name":"Dev","last_name":"Admin"}'::jsonb,
  now(), now(), '', '', '', ''
) on conflict (id) do nothing;

insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
values (
  gen_random_uuid(), 'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'email',
  '{"sub":"a0000000-0000-4000-8000-000000000001","email":"admin@pulse.local","email_verified":true}'::jsonb,
  now(), now(), now()
) on conflict do nothing;

-- Role catalogue mirrors lib/auth/permissions.ts SYSTEM_ROLES.
do $$
declare
  v_org uuid;
  v_admin uuid := 'a0000000-0000-4000-8000-000000000001';
begin
  v_org := public.create_org(
    'Al Das Medical (dev)',
    'al-das-dev',
    '[
      {"name":"Admin","description":"Full access to everything, including settings and system health.","permissions":["*"]},
      {"name":"Manager","description":"Runs the clinic day to day: all operational modules and reports, no user/role management.","permissions":["inbox.view_all","inbox.send","contacts.view","contacts.manage","contacts.export","enquiries.view","enquiries.manage","enquiries.export","enquiries.delete","tasks.view","tasks.manage","appointments.view","appointments.manage","campaigns.view","campaigns.create","templates.manage","flows.manage","portal.*","reports.view"]},
      {"name":"Agent","description":"Handles patient conversations, enquiries and tasks.","permissions":["inbox.send","contacts.view","contacts.manage","enquiries.view","enquiries.manage","tasks.view","tasks.manage","appointments.view","portal.*.read"]},
      {"name":"Receptionist","description":"Front desk: bookings, patient details and walk-in enquiries.","permissions":["inbox.send","contacts.view","contacts.manage","enquiries.view","enquiries.manage","tasks.view","tasks.manage","appointments.view","appointments.manage","portal.*.read"]},
      {"name":"Care coordinator","description":"Works the clinical Follow-Up Queue and patient conversations. Cannot sign off clinical settings.","permissions":["inbox.send","contacts.view","contacts.manage","tasks.view","tasks.manage","appointments.view","appointments.manage","portal.*"]},
      {"name":"Marketing","description":"Campaigns, templates, flows and reporting.","permissions":["inbox.view_all","contacts.view","contacts.export","campaigns.view","campaigns.create","templates.manage","flows.manage","reports.view"]}
    ]'::jsonb,
    v_admin
  );

  insert into public.teams (org_id, name, description, round_robin) values
    (v_org, 'Front desk', 'Reception and bookings', true),
    (v_org, 'Patient care', 'Clinical follow-ups', false);

  insert into public.team_members (org_id, team_id, user_id)
  select v_org, id, v_admin from public.teams where org_id = v_org;

  insert into public.notifications (org_id, user_id, type, title, body)
  values (v_org, v_admin, 'system', 'Welcome to Pulse', 'The workspace is set up. Invite your team from Settings → Users.');
end $$;

-- ---------------------------------------------------------------------------
-- Phase 2: CRM demo data. FAKE DATA ONLY — synthetic names, +9715000000xx numbers.
-- ---------------------------------------------------------------------------
do $$
declare
  v_org uuid;
  v_admin uuid := 'a0000000-0000-4000-8000-000000000001';
  v_tag_vip uuid;
  v_tag_derma uuid;
  v_tag_dental uuid;
  v_tag_followup uuid;
  v_seg_static uuid;
  v_seg_dynamic uuid;
  v_id uuid;
  i integer;
  first_names text[] := array['Amina','Bilal','Chen','Dana','Elias','Farah','Georgi','Hana','Ivan','Jana','Karim','Lina','Marco','Noor','Omar','Priya','Rami','Sara','Tariq','Uma','Victor','Wafa','Yusuf','Zara'];
  last_names text[] := array['Example','Sample','Test','Demo','Placeholder','Fixture'];
  nationalities text[] := array['United Arab Emirates','India','United Kingdom','Egypt','Philippines','Lebanon'];
begin
  select id into v_org from public.orgs where slug = 'al-das-dev';
  if v_org is null then return; end if;

  insert into public.custom_fields (org_id, entity, key, label, type, options, sort) values
    (v_org, 'contact', 'insurance_plan', 'Insurance plan', 'select', '[{"value":"mednet","label":"Mednet"},{"value":"axa","label":"AXA"},{"value":"self_pay","label":"Self-pay"}]', 0),
    (v_org, 'contact', 'preferred_branch', 'Preferred branch', 'select', '[{"value":"golden_mile","label":"Golden Mile"},{"value":"meadows","label":"Meadows"},{"value":"palm_jumeirah","label":"Palm Jumeirah"}]', 1),
    (v_org, 'contact', 'interests', 'Interests', 'multi_select', '[{"value":"derma","label":"Dermatology"},{"value":"dental","label":"Dental"},{"value":"gp","label":"General practice"},{"value":"nutrition","label":"Nutrition"}]', 2),
    (v_org, 'contact', 'last_visit_date', 'Last visit (Unite)', 'date', '[]', 3),
    (v_org, 'contact', 'is_test_record', 'Test record', 'boolean', '[]', 4)
  on conflict do nothing;

  insert into public.tags (org_id, name, color) values (v_org, 'VIP', 'amber') returning id into v_tag_vip;
  insert into public.tags (org_id, name, color) values (v_org, 'Dermatology', 'purple') returning id into v_tag_derma;
  insert into public.tags (org_id, name, color) values (v_org, 'Dental', 'teal') returning id into v_tag_dental;
  insert into public.tags (org_id, name, color) values (v_org, 'Needs follow-up', 'red') returning id into v_tag_followup;

  for i in 1..24 loop
    insert into public.contacts (
      org_id, first_name, last_name, phone_e164, email, gender, nationality, country, language, dob,
      source, external_id, promotions_opt_in, stop_marketing, custom, last_interaction_at, created_by, created_at
    ) values (
      v_org,
      first_names[i],
      last_names[1 + (i % 6)],
      '+9715000000' || lpad(i::text, 2, '0'),
      case when i % 3 = 0 then lower(first_names[i]) || '@example.test' end,
      case when i % 2 = 0 then 'female' else 'male' end,
      nationalities[1 + (i % 6)],
      'AE',
      case when i % 4 = 0 then 'ar' else 'en' end,
      date '1960-01-01' + (i * 731)::int,
      case when i % 5 = 0 then 'import_airtable' when i % 3 = 0 then 'inbox' else 'manual' end,
      case when i % 2 = 0 then 'PIN-' || lpad(i::text, 4, '0') end,
      i % 3 <> 0,
      i = 7,
      jsonb_build_object(
        'insurance_plan', (array['mednet','axa','self_pay'])[1 + (i % 3)],
        'preferred_branch', (array['golden_mile','meadows','palm_jumeirah'])[1 + (i % 3)],
        'interests', case when i % 2 = 0 then '["derma","dental"]'::jsonb else '["gp"]'::jsonb end,
        'last_visit_date', (current_date - (i * 9))::text
      ),
      case when i <= 6 then now() - (i || ' days')::interval when i <= 14 then now() - ((i + 10) || ' days')::interval when i <= 20 then now() - ((i * 5) || ' days')::interval end,
      v_admin,
      now() - (i || ' days')::interval
    ) returning id into v_id;

    insert into public.timeline_events (org_id, contact_id, type, actor_type, actor_id, payload)
    values (v_org, v_id, 'contact.created', 'user', v_admin, '{}');
    if i % 4 = 0 then
      insert into public.contact_tags (org_id, contact_id, tag_id, added_by) values (v_org, v_id, v_tag_vip, v_admin);
    end if;
    if i % 2 = 0 then
      insert into public.contact_tags (org_id, contact_id, tag_id, added_by) values (v_org, v_id, v_tag_derma, v_admin);
    end if;
    if i % 6 = 0 then
      insert into public.contact_tags (org_id, contact_id, tag_id, added_by) values (v_org, v_id, v_tag_dental, v_admin);
      insert into public.contact_phones (org_id, contact_id, phone_e164, label) values (v_org, v_id, '+9715001000' || lpad(i::text, 2, '0'), 'home');
    end if;
    if i = 3 then
      insert into public.timeline_events (org_id, contact_id, type, actor_type, actor_id, payload)
      values (v_org, v_id, 'note', 'user', v_admin, '{"text":"Demo note: prefers morning appointments."}');
    end if;
  end loop;

  -- A near-duplicate pair for the Duplicates view (same name + DOB, different phone)
  insert into public.contacts (org_id, first_name, last_name, phone_e164, dob, source, created_by)
  values (v_org, 'Amina', 'Sample', '+971500000091', date '1960-01-01' + 731, 'manual', v_admin);

  insert into public.segments (org_id, name, kind, created_by) values (v_org, 'Call list — October', 'static', v_admin) returning id into v_seg_static;
  insert into public.segment_members (org_id, segment_id, contact_id, added_by)
  select v_org, v_seg_static, id, v_admin from public.contacts where org_id = v_org and deleted_at is null order by created_at desc limit 5;
  update public.segments set member_count = 5, count_refreshed_at = now() where id = v_seg_static;

  insert into public.segments (org_id, name, kind, filter, created_by) values (
    v_org, 'Derma opt-ins (dynamic)', 'dynamic',
    jsonb_build_object(
      'include', jsonb_build_object('type', 'group', 'logic', 'and', 'children', jsonb_build_array(
        jsonb_build_object('type', 'condition', 'field', 'tags', 'op', 'has_any', 'value', jsonb_build_array(v_tag_derma::text)),
        jsonb_build_object('type', 'condition', 'field', 'promotions_opt_in', 'op', 'is_true')
      )),
      'exclude', jsonb_build_object('type', 'group', 'logic', 'and', 'children', jsonb_build_array(
        jsonb_build_object('type', 'condition', 'field', 'stop_marketing', 'op', 'is_true')
      ))
    ),
    v_admin
  ) returning id into v_seg_dynamic;
  update public.segments set member_count = (
    select count(*) from public.contacts c where c.org_id = v_org and c.deleted_at is null and c.promotions_opt_in and not c.stop_marketing
      and exists (select 1 from public.contact_tags ct where ct.contact_id = c.id and ct.tag_id = v_tag_derma)
  ), count_refreshed_at = now() where id = v_seg_dynamic;

  -- A mention so the "Mentions" view has a row
  insert into public.mentions (org_id, user_id, contact_id, mentioned_by)
  select v_org, v_admin, id, v_admin from public.contacts where org_id = v_org and first_name = 'Bilal' limit 1;
end $$;

-- ---------------------------------------------------------------------------
-- Phase 3: a fake WhatsApp number, two conversations on Phase 2 contacts,
-- messages, a label, a close category and quick replies. FAKE DATA ONLY.
-- ---------------------------------------------------------------------------
do $$
declare
  v_org uuid;
  v_admin uuid := 'a0000000-0000-4000-8000-000000000001';
  v_channel uuid;
  v_team uuid;
  v_contact1 uuid;
  v_contact2 uuid;
  v_conv1 uuid;
  v_conv2 uuid;
  v_label uuid;
begin
  select id into v_org from public.orgs where slug = 'al-das-dev';
  select id into v_team from public.teams where org_id = v_org and name = 'Front desk';

  insert into public.channels (org_id, name, waba_id, phone_number_id, display_phone, verified_name, quality_rating, messaging_limit_tier, name_status)
  values (v_org, 'Reception (dev)', '200000000000001', '100000000000001', '+971 4 000 0000', 'Al Das Medical (dev)', 'GREEN', 'TIER_1K', 'APPROVED')
  returning id into v_channel;

  insert into public.wa_templates (org_id, channel_id, waba_id, meta_template_id, name, language, category, status, type, components, variable_map)
  values (v_org, v_channel, '200000000000001', '300000000000001', 'appointment_reminder', 'en', 'UTILITY', 'APPROVED', 'media_interactive',
    '[{"type":"BODY","text":"Hello {{1}}, this is a reminder of your appointment on {{2}}. Reply 1 to confirm.","example":{"body_text":[["Sara","Mon 10:00"]]}},{"type":"FOOTER","text":"Al Das Medical"},{"type":"BUTTONS","buttons":[{"type":"QUICK_REPLY","text":"Confirm"},{"type":"QUICK_REPLY","text":"Reschedule"}]}]'::jsonb,
    '{"body.1":"contact.first_name"}'::jsonb);

  -- Reuse two of the Phase 2 demo contacts (same fake numbers the wa-fixtures use).
  select id into v_contact1 from public.contacts where org_id = v_org and phone_e164 = '+971500000001' and deleted_at is null;
  if v_contact1 is null then
    insert into public.contacts (org_id, first_name, last_name, phone_e164, source) values (v_org, 'Test', 'Patient', '+971500000001', 'whatsapp') returning id into v_contact1;
  end if;
  update public.contacts set wa_profile_name = 'Test Patient', last_interaction_at = now() - interval '10 minutes' where id = v_contact1;
  select id into v_contact2 from public.contacts where org_id = v_org and phone_e164 = '+971500000002' and deleted_at is null;
  if v_contact2 is null then
    insert into public.contacts (org_id, first_name, last_name, phone_e164, source) values (v_org, 'Sample', 'Visitor', '+971500000002', 'whatsapp') returning id into v_contact2;
  end if;
  update public.contacts set wa_profile_name = 'Sample Visitor', last_interaction_at = now() - interval '2 days' where id = v_contact2;

  insert into public.tags (org_id, name, color, scope) values (v_org, 'Appointment request', 'blue', 'conversation') returning id into v_label;
  insert into public.tags (org_id, name, color, scope) values (v_org, 'Booked', 'green', 'conversation');
  insert into public.conv_categories (org_id, name, sort) values (v_org, 'Booking made', 1), (v_org, 'Information', 2), (v_org, 'No reply', 3);
  insert into public.quick_replies (org_id, shortcut, text, created_by) values
    (v_org, 'hours', 'Hi {contact.first_name}, our clinics are open daily from 8am to 8pm.', v_admin),
    (v_org, 'location', 'We are at Golden Mile, Palm Jumeirah. Reply here if you need directions.', v_admin);

  insert into public.conversations (org_id, channel_id, contact_id, status, assignee_team_id, assignee_user_id, last_inbound_at, last_message_at, last_message_preview, last_message_direction, unread_count)
  values (v_org, v_channel, v_contact1, 'open', v_team, v_admin, now() - interval '10 minutes', now() - interval '10 minutes', 'Hello, I would like to book an appointment', 'in', 1)
  returning id into v_conv1;
  insert into public.conversations (org_id, channel_id, contact_id, status, last_inbound_at, last_message_at, last_message_preview, last_message_direction, unread_count)
  values (v_org, v_channel, v_contact2, 'waiting', now() - interval '2 days', now() - interval '2 days', 'Thanks, I will let you know', 'in', 0)
  returning id into v_conv2;

  insert into public.conversation_labels (org_id, conversation_id, tag_id, added_by) values (v_org, v_conv1, v_label, v_admin);

  insert into public.messages (org_id, conversation_id, direction, kind, body, wa_message_id, status, at) values
    (v_org, v_conv1, 'in', 'text', 'Hello, I would like to book an appointment', 'wamid.SEED_1', 'received', now() - interval '10 minutes'),
    (v_org, v_conv2, 'in', 'text', 'Hi, do you have availability this week?', 'wamid.SEED_2', 'received', now() - interval '2 days 1 hour');
  insert into public.messages (org_id, conversation_id, direction, kind, body, wa_message_id, status, sent_by_user_id, at) values
    (v_org, v_conv2, 'out', 'text', 'Yes, we have slots on Thursday. Shall I book one?', 'wamid.SEED_3', 'read', v_admin, now() - interval '2 days 30 minutes');
  insert into public.messages (org_id, conversation_id, direction, kind, body, wa_message_id, status, at) values
    (v_org, v_conv2, 'in', 'text', 'Thanks, I will let you know', 'wamid.SEED_4', 'received', now() - interval '2 days');
  insert into public.messages (org_id, conversation_id, direction, kind, body, status, error_code, error_message, sent_by_user_id, at) values
    (v_org, v_conv2, 'out', 'text', 'Just checking in — would Thursday still work?', 'failed', 131047, 'More than 24 hours since the patient last replied: send a template instead.', v_admin, now() - interval '1 hour');

  update public.orgs set settings = settings || jsonb_build_object('inbox', jsonb_build_object('default_team_id', v_team, 'auto_assign', 'round_robin', 'require_summary_on_close', false)) where id = v_org;
end $$;

-- Phase 6: appointments demo data (FAKE). One clinic, two specialists, a few bookings, and the
-- reminder template mapped so the sweep job schedules reminders for the upcoming bookings.
do $$
declare
  v_org uuid;
  v_loc uuid;
  v_gp uuid;
  v_paeds uuid;
  v_svc_gp uuid;
  v_svc_paeds uuid;
  v_alex uuid;
  v_sam uuid;
  v_contact1 uuid;
  v_contact2 uuid;
  v_tpl uuid;
  v_base timestamp := date_trunc('day', now() at time zone 'Asia/Dubai');
  d int;
begin
  select id into v_org from public.orgs where slug = 'al-das-dev';
  if v_org is null or exists (select 1 from public.locations where org_id = v_org) then
    return;
  end if;

  insert into public.locations (org_id, name, timezone, address, external_id)
  values (v_org, 'Test Clinic', 'Asia/Dubai', '1 Example Street, Dubai', 'DHA-F-0000000') returning id into v_loc;
  insert into public.departments (org_id, name) values (v_org, 'General Practice') returning id into v_gp;
  insert into public.departments (org_id, name) values (v_org, 'Paediatrics') returning id into v_paeds;
  insert into public.services (org_id, department_id, name, duration_min, price)
  values (v_org, v_gp, 'GP consultation', 30, 250) returning id into v_svc_gp;
  insert into public.services (org_id, department_id, name, duration_min, price)
  values (v_org, v_paeds, 'Paediatric consultation', 30, 300) returning id into v_svc_paeds;
  insert into public.services (org_id, department_id, name, duration_min) values (v_org, v_gp, 'Follow-up', 15);

  insert into public.specialists (org_id, name, title, department_id, external_id)
  values (v_org, 'Dr Alex Example', 'General Practitioner', v_gp, 'DOC-1') returning id into v_alex;
  insert into public.specialists (org_id, name, title, department_id, external_id)
  values (v_org, 'Dr Sam Sample', 'Paediatrician', v_paeds, 'DOC-2') returning id into v_sam;
  insert into public.specialist_locations (org_id, specialist_id, location_id)
  values (v_org, v_alex, v_loc), (v_org, v_sam, v_loc);
  insert into public.specialist_services (org_id, specialist_id, service_id)
  select v_org, v_alex, id from public.services where org_id = v_org and department_id = v_gp
  union all select v_org, v_sam, v_svc_paeds;
  for d in 1..6 loop  -- Monday to Saturday, split shift
    insert into public.working_hours (org_id, specialist_id, location_id, weekday, start_min, end_min)
    select v_org, sp.id, v_loc, d, h.from_min, h.to_min
    from unnest(array[v_alex, v_sam]) as sp(id), (values (540, 780), (960, 1200)) as h(from_min, to_min);
  end loop;

  select id into v_contact1 from public.contacts where org_id = v_org and phone_e164 = '+971500000001' and deleted_at is null;
  select id into v_contact2 from public.contacts where org_id = v_org and phone_e164 = '+971500000002' and deleted_at is null;
  if v_contact1 is not null then
    insert into public.appointments (org_id, contact_id, location_id, specialist_id, service_id, department_id, starts_at, ends_at, status, source)
    values (v_org, v_contact1, v_loc, v_alex, v_svc_gp, v_gp,
            (v_base + interval '2 days 10 hours') at time zone 'Asia/Dubai',
            (v_base + interval '2 days 10 hours 30 minutes') at time zone 'Asia/Dubai', 'awaiting', 'portal');
  end if;
  if v_contact2 is not null then
    insert into public.appointments (org_id, contact_id, location_id, specialist_id, service_id, department_id, starts_at, ends_at, status, source)
    values (v_org, v_contact2, v_loc, v_sam, v_svc_paeds, v_paeds,
            (v_base + interval '3 days 17 hours') at time zone 'Asia/Dubai',
            (v_base + interval '3 days 17 hours 30 minutes') at time zone 'Asia/Dubai', 'confirmed', 'portal');
  end if;

  -- Reminder template: name, time and doctor; Confirm / Reschedule / Cancel quick replies.
  update public.wa_templates
  set components = '[{"type":"BODY","text":"Hello {{1}}, this is a reminder of your appointment on {{2}} with {{3}}.","example":{"body_text":[["Sara","Mon 12 Oct, 10:00 AM","Dr Example"]]}},{"type":"FOOTER","text":"Al Das Medical"},{"type":"BUTTONS","buttons":[{"type":"QUICK_REPLY","text":"Confirm"},{"type":"QUICK_REPLY","text":"Reschedule"},{"type":"QUICK_REPLY","text":"Cancel"}]}]'::jsonb,
      variable_map = '{"body.1":"contact.first_name","body.2":"appointment.datetime","body.3":"appointment.specialist"}'::jsonb
  where org_id = v_org and name = 'appointment_reminder'
  returning id into v_tpl;

  update public.orgs
  set settings = settings || jsonb_build_object('appointments', jsonb_build_object(
    'templates', jsonb_build_object('reminder', v_tpl, 'confirmed', null, 'cancelled', null, 'rescheduled', null),
    'reminder_test_mode', true,
    'reminder_test_numbers', jsonb_build_array('+971500000001')))
  where id = v_org;
end $$;

-- ---------------------------------------------------------------------------
-- Phase 6c: clinical settings (all unsigned: the rules stay inert until a clinical lead signs them off,
-- and patient-facing messaging stays OFF) plus two SYNTHETIC visits flagged as test records.
-- ---------------------------------------------------------------------------
do $$
declare
  v_org uuid;
  v_c1 uuid;
  v_c2 uuid;
begin
  select id into v_org from public.orgs where slug = 'al-das-dev';
  if v_org is null then
    return;
  end if;
  perform public.seed_clinical_settings(v_org);

  select id into v_c1 from public.contacts where org_id = v_org and phone_e164 = '+971500000001' and deleted_at is null;
  select id into v_c2 from public.contacts where org_id = v_org and phone_e164 = '+971500000002' and deleted_at is null;
  if v_c1 is not null then
    update public.contacts set is_test_record = true, clinical_messaging_consent = true where id in (v_c1, v_c2);
    insert into public.visits (org_id, external_id, visit_date, department_raw, contact_id, temp_c, bp_systolic, bp_diastolic, spo2, pulse, is_test_record)
    values (v_org, 'SEED-V-1', current_date - 1, 'General Practice', v_c1, 39.6, 118, 76, 97, 92, true)
    on conflict do nothing;
  end if;
  if v_c2 is not null then
    insert into public.visits (org_id, external_id, visit_date, department_raw, contact_id, temp_c, spo2, pulse, is_test_record)
    values (v_org, 'SEED-V-2', current_date - 1, 'Paediatrics', v_c2, 38.2, 98, 110, true)
    on conflict do nothing;
  end if;

  if (select count(*) from public.clinical_settings where org_id = v_org) < 50
     or app.clinical_messaging_enabled(v_org) then
    raise exception 'seed validation: clinical settings missing, or the messaging gate is not OFF';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Phase 5: enquiries + tasks demo data. FAKE DATA ONLY — synthetic names, no real patients.
-- ---------------------------------------------------------------------------
do $$
declare
  v_org uuid;
  v_admin uuid := 'a0000000-0000-4000-8000-000000000001';
  v_team uuid;
  v_loc uuid;
  v_dep_gp uuid;
  v_svc uuid;
  v_spec uuid;
  v_p1 uuid;
  v_p2 uuid;
  v_s1 uuid[];
  v_s2 uuid[];
  v_enq uuid;
  v_contacts uuid[];
  i int;
  v_status text;
  v_stage uuid;
begin
  select id into v_org from public.orgs where slug = 'al-das-dev';
  if v_org is null then
    return;
  end if;
  if exists (select 1 from public.pipelines where org_id = v_org) then
    return;
  end if;
  select id into v_team from public.teams where org_id = v_org and name = 'Front desk';
  -- Reuse the Phase 6 clinic lists (locations, departments, services, specialists).
  select id into v_loc from public.locations where org_id = v_org order by created_at limit 1;
  select id into v_dep_gp from public.departments where org_id = v_org and name = 'General Practice';
  select id into v_svc from public.services where org_id = v_org and name = 'GP consultation';
  select id into v_spec from public.specialists where org_id = v_org and name = 'Dr Alex Example';

  -- Two pipelines: reception (30-minute SLA, default) and insurance review (5-minute SLA).
  insert into public.pipelines (org_id, name, sort, is_default, sla_minutes, card_fields)
  values (v_org, 'Reception', 0, true, 30, '{number,contact,source,created_at,assignee}') returning id into v_p1;
  insert into public.pipelines (org_id, name, sort, sla_minutes, card_fields)
  values (v_org, 'Insurance review', 1, 5, '{number,contact,phone,created_at}') returning id into v_p2;

  with s as (
    insert into public.stages (org_id, pipeline_id, name, color, sort) values
      (v_org, v_p1, 'New', 'blue', 0),
      (v_org, v_p1, 'Contacted', 'amber', 1),
      (v_org, v_p1, 'Awaiting patient', 'purple', 2),
      (v_org, v_p1, 'Booked', 'green', 3)
    returning id, sort
  ) select array_agg(id order by sort) into v_s1 from s;
  with s as (
    insert into public.stages (org_id, pipeline_id, name, color, sort) values
      (v_org, v_p2, 'To verify', 'blue', 0),
      (v_org, v_p2, 'With insurer', 'amber', 1),
      (v_org, v_p2, 'Verified', 'green', 2)
    returning id, sort
  ) select array_agg(id order by sort) into v_s2 from s;

  insert into public.custom_fields (org_id, entity, key, label, type, options, sort) values
    (v_org, 'enquiry', 'insurer', 'Insurer', 'select', '[{"value":"alpha","label":"Alpha Health"},{"value":"beta","label":"Beta Cover"}]', 0),
    (v_org, 'enquiry', 'referral_code', 'Referral code', 'text', '[]', 1);

  select array_agg(id order by created_at, id) into v_contacts
  from (select id, created_at from public.contacts where org_id = v_org and deleted_at is null order by created_at, id limit 15) c;

  for i in 1 .. coalesce(array_length(v_contacts, 1), 0) loop
    v_status := case when i % 7 = 0 then 'won' when i % 7 = 3 then 'lost' when i = 11 then 'disqualified' else 'open' end;
    v_stage := case when i <= 10 then v_s1[1 + (i % 4)] else v_s2[1 + (i % 3)] end;
    insert into public.enquiries (
      org_id, pipeline_id, stage_id, status, lost_reason, contact_id, title, source, assignee_id, est_value,
      location_id, department_id, specialist_id, service_id, appt_date, custom, created_by, created_at, stage_entered_at, sla_due_at, first_touch_at
    ) values (
      v_org, case when i <= 10 then v_p1 else v_p2 end, v_stage, v_status,
      case v_status when 'lost' then 'Chose another clinic' when 'disqualified' then 'Not a patient enquiry' end,
      v_contacts[i], 'Consultation enquiry ' || i,
      (array['WhatsApp','Phone call','Website','Walk-in'])[1 + (i % 4)],
      case when i % 3 = 0 then null else v_admin end,
      (array[350, 400, 500, 1200])[1 + (i % 4)],
      v_loc, v_dep_gp, v_spec, v_svc,
      case when i % 4 = 0 then now() + (i || ' days')::interval end,
      case when i % 2 = 0 then '{"insurer":"alpha"}'::jsonb else '{}'::jsonb end,
      v_admin, now() - (i || ' hours')::interval, now() - (i || ' hours')::interval,
      -- a couple of breached SLAs for the demo: untouched and past due
      case when i in (1, 2) then now() - interval '10 minutes' else now() - (i || ' hours')::interval + interval '30 minutes' end,
      case when i in (1, 2) then null else now() - (i || ' hours')::interval + interval '10 minutes' end
    ) returning id into v_enq;
    insert into public.timeline_events (org_id, contact_id, enquiry_id, type, actor_type, actor_id, payload, at)
    values (v_org, v_contacts[i], v_enq, 'enquiry.created', 'user', v_admin, jsonb_build_object('number', i), now() - (i || ' hours')::interval);
    if v_status = 'open' and i % 2 = 1 then
      insert into public.tasks (org_id, type, subject, due_at, assignee_id, contact_id, enquiry_id, created_by)
      values (v_org, 'follow_up', 'Follow up on enquiry ' || i, now() + ((i - 5) || ' hours')::interval, v_admin, v_contacts[i], v_enq, v_admin);
    end if;
  end loop;

  insert into public.tasks (org_id, type, subject, notes, due_at, assignee_id, created_by) values
    (v_org, 'call', 'Call the supplier about stock', 'Fake task for the demo.', now() + interval '1 day', v_admin, v_admin),
    (v_org, 'other', 'Order printer paper', null, now() - interval '1 day', v_admin, v_admin);
  insert into public.tasks (org_id, type, subject, due_at, done, done_at, completed_by, assignee_id, created_by)
  values (v_org, 'email', 'Send the weekly report', now() - interval '2 days', true, now() - interval '2 days', v_admin, v_admin, v_admin);

  insert into public.enquiry_assignment_rules (org_id, name, sort, conditions, action)
  values (v_org, 'WhatsApp → Front desk', 0, '{"sources":["WhatsApp"]}'::jsonb, jsonb_build_object('type', 'team_round_robin', 'team_id', v_team));

  insert into public.enquiry_views (org_id, owner_id, name, pipeline_id, mode, filter, shared_all)
  values (v_org, v_admin, 'Unassigned', v_p1, 'table',
    '{"include":{"type":"group","logic":"and","children":[{"type":"condition","field":"assignee","op":"is_empty"}]},"exclude":null}'::jsonb, true);
end $$;
