-- Finance access window (docs/36_FINANCE_ACCESS_WINDOW_NOTES.md).
-- The setting itself lives in orgs.settings->'finance_access' (no new table). This migration only lets
-- security_alerts hold the new alert kind raised when the window refuses a finance or accounting request.
alter table public.security_alerts drop constraint if exists security_alerts_kind_check;
alter table public.security_alerts add constraint security_alerts_kind_check
  check (kind in ('bulk_export', 'off_hours_access', 'failed_logins', 'role_change', 'bulk_api_read',
                  'finance_access_denied'));
