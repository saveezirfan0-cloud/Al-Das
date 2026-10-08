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
