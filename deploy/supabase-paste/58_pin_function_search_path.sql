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
