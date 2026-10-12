-- Records the new migration versions. First it moves the earlier 'finance_ui_views' row to its new version number.
update supabase_migrations.schema_migrations set version = '20261010001200' where version = '20261009001000' and name = 'finance_ui_views';

insert into supabase_migrations.schema_migrations (version, name)
values
  ('20261009001000', 'ai_kb'),
  ('20261009001100', 'api_webhooks'),
  ('20261009001200', 'metrics'),
  ('20261009001300', 'report_functions'),
  ('20261009001400', 'appointment_reports'),
  ('20261010000100', 'campaigns'),
  ('20261010000200', 'templates'),
  ('20261010000300', 'enquiries'),
  ('20261010000400', 'portal_ref_tables'),
  ('20261010000500', 'portal_framework'),
  ('20261010000600', 'flows'),
  ('20261010000700', 'recall_reference'),
  ('20261010000800', 'recall'),
  ('20261010000900', 'recall_phase8'),
  ('20261010001000', 'enquiry_campaign_reports'),
  ('20261010001100', 'task_appointment_link'),
  ('20261010001200', 'finance_ui_views')
on conflict (version) do nothing;
