-- Paste into Supabase > SQL Editor > New query, then Run. Needs 37_finance_fixes_payables.sql applied first.
-- The migration-history line is included at the bottom of this file.

-- Phase 20 review fixes: controls (docs/20_PHASE_20F_NOTES.md, docs/20_PHASE_20C_NOTES.md).
--
--   * Revenue share, maker / checker / approver: whoever drafted (or last edited) a scheme version, or built a run, can no
--     longer approve it after someone else verified it. Function check (fin_revshare_scheme_step, fin_revshare_run_step)
--     and CHECK constraints (approved_by <> created_by, approved_by <> built_by; nulls allowed for deleted users).
--   * Revenue share, scheme fingerprint: rule_hash is now the sha256 of {doctor_dha_id, effective_from, rule}, so moving a
--     draft's start month (or anything else that decides which months it covers) changes the hash a verifier or approver
--     must have seen. Existing rows are recomputed here. A DRAFT run built before this migration carries the old hashes in
--     its inputs and must be rebuilt before it can be verified; verified and later runs are frozen and unaffected.
--   * Bank imports: the uploaded file's name is no longer kept (names of files can carry a person's name). A trigger
--     keeps the extension only (csv, xlsx), the existing names are cleared, and a CHECK keeps it that way.

-- ---------------------------------------------------------------------------
-- 1. Revenue share: the scheme fingerprint covers the doctor and the start month
-- ---------------------------------------------------------------------------
create or replace function app.fin_revshare_scheme_hash(p_doctor text, p_effective_from date, p_rule jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select app.fin_jsonb_sha256(jsonb_build_object('doctor_dha_id', p_doctor, 'effective_from', p_effective_from, 'rule', p_rule));
$$;
revoke all on function app.fin_revshare_scheme_hash(text, date, jsonb) from public, anon, authenticated;

create or replace function app.fin_revshare_scheme_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_cols text[] := array['created_by', 'verified_by', 'approved_by', 'retired_by'];
  c text;
begin
  if tg_op = 'DELETE' then
    if old.status in ('approved', 'retired') and exists (select 1 from public.orgs o where o.id = old.org_id) then
      raise exception 'an approved scheme version cannot be deleted' using errcode = 'check_violation';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'draft' or new.verified_by is not null or new.approved_by is not null or new.retired_by is not null then
      raise exception 'a scheme version starts as a draft' using errcode = 'check_violation';
    end if;
    new.rule_hash := app.fin_revshare_scheme_hash(new.doctor_dha_id, new.effective_from, new.rule);
    return new;
  end if;

  -- UPDATE
  if new.org_id <> old.org_id or new.doctor_dha_id <> old.doctor_dha_id or new.version <> old.version then
    raise exception 'the doctor and version of a scheme cannot change' using errcode = 'check_violation';
  end if;
  if old.status in ('approved', 'retired') then
    -- only approved -> retired, or the FK action that nulls a deleted user's id
    for c in select unnest(v_user_cols) loop
      if (to_jsonb(new) ->> c) is not null and (to_jsonb(new) ->> c) is distinct from (to_jsonb(old) ->> c)
         and not (old.status = 'approved' and new.status = 'retired' and c = 'retired_by') then
        raise exception 'an approved scheme version is immutable; create a new version' using errcode = 'check_violation';
      end if;
    end loop;
    if (to_jsonb(new) - v_user_cols - 'updated_at' - 'status' - 'retired_at')
       is distinct from (to_jsonb(old) - v_user_cols - 'updated_at' - 'status' - 'retired_at')
       or not ((old.status = new.status and new.retired_at is not distinct from old.retired_at)
               or (old.status = 'approved' and new.status = 'retired')) then
      raise exception 'an approved scheme version is immutable; create a new version' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if not (
       (old.status = 'draft' and new.status in ('draft', 'verified'))
    or (old.status = 'verified' and new.status in ('draft', 'approved', 'verified'))
  ) then
    raise exception 'invalid scheme transition % -> %', old.status, new.status using errcode = 'check_violation';
  end if;
  new.rule_hash := app.fin_revshare_scheme_hash(new.doctor_dha_id, new.effective_from, new.rule);
  if old.status = 'verified' and new.status in ('verified', 'approved')
     and (new.rule is distinct from old.rule or new.effective_from is distinct from old.effective_from
          or new.verified_at is distinct from old.verified_at
          or (new.verified_by is not null and new.verified_by is distinct from old.verified_by)) then
    raise exception 'a verified scheme cannot be edited; editing returns it to draft' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function app.fin_revshare_scheme_guard() from public, anon, authenticated;

-- Recompute the stored fingerprints (approved versions are immutable to every role, so the guard is paused for this one
-- statement; nothing but rule_hash changes, and updated_at is left as it was).
alter table public.fin_revshare_schemes disable trigger user;
update public.fin_revshare_schemes
   set rule_hash = app.fin_revshare_scheme_hash(doctor_dha_id, effective_from, rule)
 where rule_hash is distinct from app.fin_revshare_scheme_hash(doctor_dha_id, effective_from, rule);
alter table public.fin_revshare_schemes enable trigger user;

-- ---------------------------------------------------------------------------
-- 2. Revenue share: three different people (preparer, verifier, approver)
-- ---------------------------------------------------------------------------
alter table public.fin_revshare_schemes
  add constraint fin_revshare_schemes_approver_not_preparer
  check (approved_by is null or created_by is null or approved_by <> created_by);
alter table public.fin_revshare_runs
  add constraint fin_revshare_runs_approver_not_builder
  check (approved_by is null or built_by is null or approved_by <> built_by);

-- p_step: 'verify' (draft -> verified), 'approve' (verified -> approved, a third person), 'retire' (approved ->
-- retired), 'delete' (a draft or verified version is removed). p_hash must be the scheme hash the person saw.
create or replace function public.fin_revshare_scheme_step(
  p_org_id uuid, p_scheme_id uuid, p_step text, p_user_id uuid, p_hash text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.fin_revshare_schemes;
begin
  select * into v from public.fin_revshare_schemes where id = p_scheme_id and org_id = p_org_id for update;
  if not found then
    raise exception 'scheme not found' using errcode = 'no_data_found';
  end if;
  if p_hash is distinct from v.rule_hash then
    raise exception 'the rule changed since you opened it; reload and review it again' using errcode = 'check_violation';
  end if;
  if p_step = 'verify' then
    if v.status <> 'draft' then
      raise exception 'only a draft can be verified (this version is %)', v.status using errcode = 'check_violation';
    end if;
    if v.created_by = p_user_id then
      raise exception 'the person who prepared this version cannot verify it' using errcode = 'check_violation';
    end if;
    update public.fin_revshare_schemes set status = 'verified', verified_by = p_user_id, verified_at = now() where id = v.id;
  elsif p_step = 'approve' then
    if v.status <> 'verified' then
      raise exception 'only a verified version can be approved (this version is %)', v.status using errcode = 'check_violation';
    end if;
    if v.created_by = p_user_id then
      raise exception 'the person who prepared this version cannot approve it' using errcode = 'check_violation';
    end if;
    if v.verified_by = p_user_id then
      raise exception 'the verification and the approval must be two different people' using errcode = 'check_violation';
    end if;
    update public.fin_revshare_schemes set status = 'approved', approved_by = p_user_id, approved_at = now() where id = v.id;
  elsif p_step = 'retire' then
    if v.status <> 'approved' then
      raise exception 'only an approved version can be retired' using errcode = 'check_violation';
    end if;
    update public.fin_revshare_schemes set status = 'retired', retired_by = p_user_id, retired_at = now() where id = v.id;
  elsif p_step = 'delete' then
    if v.status not in ('draft', 'verified') then
      raise exception 'only a version in preparation can be deleted' using errcode = 'check_violation';
    end if;
    delete from public.fin_revshare_schemes where id = v.id;
  else
    raise exception 'unknown step' using errcode = 'invalid_parameter_value';
  end if;
end;
$$;
revoke all on function public.fin_revshare_scheme_step(uuid, uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.fin_revshare_scheme_step(uuid, uuid, text, uuid, text) to service_role;

-- p_step: 'verify' (draft -> verified: the inputs must still be current), 'withdraw' (verified -> draft),
-- 'approve' (verified -> approved by a third person). p_hash must be the snapshot hash the person saw.
create or replace function public.fin_revshare_run_step(
  p_org_id uuid, p_run_id uuid, p_step text, p_user_id uuid, p_hash text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.fin_revshare_runs;
begin
  select * into v from public.fin_revshare_runs where id = p_run_id and org_id = p_org_id for update;
  if not found then
    raise exception 'run not found' using errcode = 'no_data_found';
  end if;
  if p_hash is distinct from v.snapshot_hash then
    raise exception 'the run changed since you opened it; reload and review it again' using errcode = 'check_violation';
  end if;
  if p_step = 'verify' then
    if v.status <> 'draft' then
      raise exception 'only a draft can be verified (this run is %)', v.status using errcode = 'check_violation';
    end if;
    if (v.snapshot -> 'inputs') is distinct from public.fin_revshare_inputs(p_org_id, v.month) then
      raise exception 'the source data changed since this draft was built; rebuild it, then verify' using errcode = 'check_violation';
    end if;
    if v.built_by = p_user_id then
      raise exception 'the person who built this run cannot verify it' using errcode = 'check_violation';
    end if;
    update public.fin_revshare_runs set status = 'verified', verified_by = p_user_id, verified_at = now() where id = v.id;
  elsif p_step = 'withdraw' then
    if v.status <> 'verified' then
      raise exception 'only a verified run waiting for approval can be returned to draft' using errcode = 'check_violation';
    end if;
    update public.fin_revshare_runs set status = 'draft', verified_by = null, verified_at = null where id = v.id;
  elsif p_step = 'approve' then
    if v.status <> 'verified' then
      raise exception 'only a verified run can be approved (this run is %)', v.status using errcode = 'check_violation';
    end if;
    if v.built_by = p_user_id then
      raise exception 'the person who built this run cannot approve it' using errcode = 'check_violation';
    end if;
    if v.verified_by = p_user_id then
      raise exception 'the verification and the approval must be two different people' using errcode = 'check_violation';
    end if;
    update public.fin_revshare_runs set status = 'approved', approved_by = p_user_id, approved_at = now() where id = v.id;
  else
    raise exception 'unknown step' using errcode = 'invalid_parameter_value';
  end if;
end;
$$;
revoke all on function public.fin_revshare_run_step(uuid, uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.fin_revshare_run_step(uuid, uuid, text, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Bank imports keep the file's extension only, never its name
-- ---------------------------------------------------------------------------
create or replace function app.fin_bank_imports_file_ext()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.file_name := lower(substring(new.file_name from '\.([A-Za-z0-9]{1,8})\s*$'));
  return new;
end;
$$;
revoke all on function app.fin_bank_imports_file_ext() from public, anon, authenticated;
create trigger fin_bank_imports_file_ext before insert or update of file_name on public.fin_bank_imports
  for each row execute function app.fin_bank_imports_file_ext();

update public.fin_bank_imports set file_name = null where file_name is not null;
alter table public.fin_bank_imports
  add constraint fin_bank_imports_file_ext_only check (file_name is null or file_name ~ '^[a-z0-9]{1,8}$');
comment on column public.fin_bank_imports.file_name is 'The uploaded file''s extension only (csv, xlsx); never its name.';

insert into supabase_migrations.schema_migrations (version, name) values ('20261107000200', 'finance_fixes_controls') on conflict (version) do nothing;
