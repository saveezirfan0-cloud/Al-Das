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
      {"name":"Manager","description":"Runs the clinic day to day: all operational modules and reports, no user/role management.","permissions":["inbox.view_all","inbox.send","contacts.view","contacts.manage","contacts.export","enquiries.view","enquiries.manage","tasks.manage","appointments.view","appointments.manage","campaigns.view","campaigns.create","templates.manage","flows.manage","portal.*","reports.view","reports.export","ai.use","kb.manage"]},
      {"name":"Agent","description":"Handles patient conversations, enquiries and tasks.","permissions":["inbox.send","contacts.view","contacts.manage","enquiries.view","enquiries.manage","tasks.manage","appointments.view","portal.*.read","ai.use"]},
      {"name":"Receptionist","description":"Front desk: bookings, patient details and walk-in enquiries.","permissions":["inbox.send","contacts.view","contacts.manage","enquiries.view","enquiries.manage","tasks.manage","appointments.view","appointments.manage","portal.*.read","ai.use"]},
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
