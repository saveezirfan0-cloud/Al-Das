-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Finance access window: lets security_alerts record the new 'finance_access_denied' alert kind. Needs every earlier
-- file first, up to and including 60. The window is off until an administrator turns it on under Settings, Security.
-- Check the project name in the Supabase header first: this is for the Pulse project only.

-- ======================================================================
-- 20261121000100_finance_access_window.sql
-- ======================================================================
-- Finance access window (docs/36_FINANCE_ACCESS_WINDOW_NOTES.md).
-- The setting itself lives in orgs.settings->'finance_access' (no new table). This migration only lets
-- security_alerts hold the new alert kind raised when the window refuses a finance or accounting request.
alter table public.security_alerts drop constraint if exists security_alerts_kind_check;
alter table public.security_alerts add constraint security_alerts_kind_check
  check (kind in ('bulk_export', 'off_hours_access', 'failed_logins', 'role_change', 'bulk_api_read',
                  'finance_access_denied'));

insert into supabase_migrations.schema_migrations (version, name) values ('20261121000100', 'finance_access_window') on conflict (version) do nothing;
