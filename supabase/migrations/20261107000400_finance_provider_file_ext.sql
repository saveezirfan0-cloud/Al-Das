-- Phase 20E: lab and provider imports keep the file's extension only, never its name (file names can carry patient or
-- staff names). The same rule as fin_bank_imports (20261107000200).

create or replace function app.fin_provider_files_file_ext()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.file_name := lower(substring(new.file_name from '\.([A-Za-z0-9]{1,8})\s*$'));
  return new;
end;
$$;
revoke all on function app.fin_provider_files_file_ext() from public, anon, authenticated;
create trigger fin_provider_files_file_ext before insert or update of file_name on public.fin_provider_files
  for each row execute function app.fin_provider_files_file_ext();

update public.fin_provider_files set file_name = null where file_name is not null;
alter table public.fin_provider_files
  add constraint fin_provider_files_file_ext_only check (file_name is null or file_name ~ '^[a-z0-9]{1,8}$');
comment on column public.fin_provider_files.file_name is 'The uploaded file''s extension only (csv, xlsx); never its name.';
