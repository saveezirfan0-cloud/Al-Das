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
      {"name":"Manager","description":"Runs the clinic day to day: all operational modules and reports, no user/role management.","permissions":["inbox.view_all","inbox.send","contacts.view","contacts.manage","contacts.export","enquiries.view","enquiries.manage","tasks.manage","appointments.view","appointments.manage","campaigns.view","campaigns.create","templates.manage","flows.manage","portal.*","reports.view"]},
      {"name":"Agent","description":"Handles patient conversations, enquiries and tasks.","permissions":["inbox.send","contacts.view","contacts.manage","enquiries.view","enquiries.manage","tasks.manage","appointments.view","portal.*.read"]},
      {"name":"Receptionist","description":"Front desk: bookings, patient details and walk-in enquiries.","permissions":["inbox.send","contacts.view","contacts.manage","enquiries.view","enquiries.manage","tasks.manage","appointments.view","appointments.manage","portal.*.read"]},
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
-- Phase 3: a fake WhatsApp number, two synthetic contacts, conversations,
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

  insert into public.contacts (org_id, first_name, last_name, phone_e164, wa_profile_name, source, last_interaction_at)
  values (v_org, 'Test', 'Patient', '+971500000001', 'Test Patient', 'whatsapp', now() - interval '10 minutes')
  returning id into v_contact1;
  insert into public.contacts (org_id, first_name, last_name, phone_e164, wa_profile_name, source, last_interaction_at)
  values (v_org, 'Sample', 'Visitor', '+971500000002', 'Sample Visitor', 'whatsapp', now() - interval '2 days')
  returning id into v_contact2;

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
