-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Pins search_path on six helper functions (Supabase security advisor). Needs every earlier file first, up to and
-- including 57_portal_bulk_edit_tags.sql. Behaviour is unchanged.
-- Check the project name in the Supabase header first: this is for the Pulse project only.

-- ======================================================================
-- 20261118000100_pin_function_search_path.sql
-- ======================================================================
-- Security advisor (function_search_path_mutable): pin search_path on the six helper
-- functions created before the repo convention of `set search_path = ''`.
-- Every body already schema-qualifies its tables (public.*) and only uses pg_catalog
-- built-ins, so behaviour is unchanged.
alter function public.clinical_setting(uuid, text) set search_path = '';
alter function public.clinical_setting_num(uuid, text) set search_path = '';
alter function public.clinical_setting_bool(uuid, text) set search_path = '';
alter function public.is_reminder_excluded(uuid, text, text) set search_path = '';
alter function public.is_working_day(uuid, date, uuid) set search_path = '';
alter function public.workdays_between(uuid, date, date, uuid) set search_path = '';

insert into supabase_migrations.schema_migrations (version, name) values ('20261118000100', 'pin_function_search_path') on conflict (version) do nothing;
