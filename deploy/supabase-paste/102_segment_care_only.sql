-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Care-only segments and the consent rule in SQL (Track P5 follow-up).
-- Needs every earlier file first, up to and including 101_lifecycle_segments.sql.
-- Check the project name in the Supabase header first: this is for the Pulse project only.

-- ======================================================================
-- 20261220000300_segment_care_only.sql
-- ======================================================================
-- Care-only segments and the consent rule in SQL (docs/45 P5 follow-up).
--
-- 1. segments.care_only: a segment that may build care audiences (recall, follow-up) but never a marketing one.
--    A dynamic segment becomes care only by itself when its filter uses a clinical / care-only field or points at a
--    care-only segment (trigger below; it cannot be saved otherwise, from any code path). A static segment becomes care
--    only when it is filled from a clinical filter or marked by hand (app code), and only the server-side function
--    public.segment_set_care_only can release it.
-- 2. campaign_snapshot_segment now takes the segment and the purpose and refuses a marketing snapshot of a care-only
--    segment itself, so the rule no longer rests on TypeScript alone.
--
-- The list in app.marketing_safe_filter_fields() is the SQL twin of lib/filters/field-registry.ts (a field with
-- clinical = false and careOnly = false). tests/unit/campaigns/care-only-parity.test.ts keeps them identical: change
-- both together. Anything not in the list (and not a custom.* field) counts as care only: unknown fails closed.

alter table public.segments
  add column care_only boolean not null default false,
  add column care_only_reason text,
  add column care_only_set_by uuid references public.profiles (id) on delete set null,
  add column care_only_set_at timestamptz;

alter table public.segments
  add constraint segments_care_only_reason_check
  check (care_only = (care_only_reason is not null)
         and (care_only_reason is null or care_only_reason in ('clinical_filter', 'filled_from_clinical_filter', 'manual')));

-- ---------------------------------------------------------------------------
-- Filter helpers (immutable, no table access)
-- ---------------------------------------------------------------------------

create or replace function app.marketing_safe_filter_fields()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'full_name','first_name','last_name','gender','nationality','tags','segments','country','phone','alternate_phone',
    'email','dob','birthday','language','label','created_at','updated_at','created_by','owner','assignee','home_branch',
    'external_id','stop_marketing','promotions_opt_in','source','next_due_task','last_interaction_at','mentioned_user',
    'conversation_channel','conversation_status','enquiry_stage','enquiry_status','enquiry_lost_reason',
    'enquiry_est_value','enquiry_created_at','enquiry_closed_at','enquiry_created_by','enquiry_channel',
    'enquiry_location','enquiry_service','enquiry_source','enquiry_count','appointment_date','appointment_status',
    'appointment_location','appointment_created_at','appointment_created_by','appointment_notify_early',
    'appointment_count','age_band','campaign'
  ]::text[];
$$;

-- Every field key a filter AST mentions, at any depth.
create or replace function app.filter_field_keys(p_filter jsonb)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(distinct f), '{}'::text[])
  from (
    select v #>> '{}' as f
    from jsonb_path_query(coalesce(p_filter, '{}'::jsonb), 'lax $.**.field') as v
    where jsonb_typeof(v) = 'string'
  ) x;
$$;

-- True when the filter uses a field that is not marketing safe (unknown fields count: fail closed).
create or replace function app.filter_uses_care_fields(p_filter jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select exists (
    select 1 from unnest(app.filter_field_keys(p_filter)) as f
    where not (f = any (app.marketing_safe_filter_fields()) or f like 'custom.%')
  );
$$;

-- The segment ids a filter points at (condition field "segments"); values that are not uuids are ignored.
create or replace function app.filter_segment_ids(p_filter jsonb)
returns uuid[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v jsonb;
  e jsonb;
  out uuid[] := '{}';
  s text;
begin
  for v in
    select x from jsonb_path_query(coalesce(p_filter, '{}'::jsonb), 'lax $.** ? (@.field == "segments").value') as x
  loop
    for e in
      select case when jsonb_typeof(v) = 'array' then j else v end
      from jsonb_array_elements(case when jsonb_typeof(v) = 'array' then v else jsonb_build_array(v) end) as j
    loop
      s := e #>> '{}';
      if s ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        out := out || s::uuid;
      end if;
    end loop;
  end loop;
  return out;
end;
$$;

-- ---------------------------------------------------------------------------
-- Is this segment care only right now? Own flag, own filter, or anything it includes (re-read at use time).
-- An unknown segment, or a chain deeper than 5, fails closed.
-- ---------------------------------------------------------------------------

create or replace function app.segment_care_only(p_org uuid, p_segment uuid, p_depth integer default 0)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s record;
  ref uuid;
begin
  if p_depth > 5 then
    return true;
  end if;
  select sg.care_only, sg.kind, sg.filter into s
  from public.segments sg
  where sg.id = p_segment and sg.org_id = p_org;
  if not found then
    return true;
  end if;
  if s.care_only then
    return true;
  end if;
  if s.kind = 'dynamic' then
    if app.filter_uses_care_fields(s.filter) then
      return true;
    end if;
    foreach ref in array app.filter_segment_ids(s.filter) loop
      if app.segment_care_only(p_org, ref, p_depth + 1) then
        return true;
      end if;
    end loop;
  end if;
  return false;
end;
$$;
revoke all on function app.segment_care_only(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function app.segment_care_only(uuid, uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- Guard trigger: a dynamic segment with a care filter is always care only; a care-only mark is released only through
-- public.segment_set_care_only (it sets the transaction-local flag this trigger looks for).
-- ---------------------------------------------------------------------------

create or replace function app.segments_care_only_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  ref uuid;
  forced boolean := false;
begin
  if new.kind = 'dynamic' and new.filter is not null then
    if app.filter_uses_care_fields(new.filter) then
      forced := true;
    else
      foreach ref in array app.filter_segment_ids(new.filter) loop
        if app.segment_care_only(new.org_id, ref) then
          forced := true;
        end if;
      end loop;
    end if;
  end if;

  if forced then
    new.care_only := true;
    if new.care_only_reason is null then
      new.care_only_reason := 'clinical_filter';
    end if;
  elsif tg_op = 'UPDATE' and new.kind = 'dynamic' and new.care_only_reason = 'clinical_filter' then
    -- The mark came from the filter alone and the filter no longer needs it (re-evaluated from scratch above).
    new.care_only := false;
  elsif tg_op = 'UPDATE' and old.care_only and not new.care_only
        and coalesce(current_setting('app.care_only_release', true), '') <> new.id::text then
    raise exception 'A care-only segment can only be released by an administrator.' using errcode = '42501';
  end if;

  if new.care_only and new.care_only_reason is null then
    new.care_only_reason := 'manual';
  end if;
  if not new.care_only then
    new.care_only_reason := null;
    new.care_only_set_by := null;
    new.care_only_set_at := null;
  elsif tg_op = 'INSERT' or not old.care_only then
    new.care_only_set_at := coalesce(new.care_only_set_at, now());
  end if;
  return new;
end;
$$;

create trigger segments_care_only_guard
  before insert or update on public.segments
  for each row execute function app.segments_care_only_guard();

-- Server-side only: marks or releases a static segment. The caller (a server action) has checked the permission.
create or replace function public.segment_set_care_only(
  p_org uuid, p_segment uuid, p_value boolean, p_user uuid, p_reason text default 'manual'
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text;
begin
  select kind into v_kind from public.segments where id = p_segment and org_id = p_org;
  if v_kind is null then
    raise exception 'segment not found' using errcode = 'no_data_found';
  end if;
  perform set_config('app.care_only_release', p_segment::text, true);
  update public.segments
     set care_only = p_value,
         care_only_reason = case when p_value then coalesce(p_reason, 'manual') else null end,
         care_only_set_by = case when p_value then p_user else null end,
         care_only_set_at = case when p_value then now() else null end
   where id = p_segment and org_id = p_org;
  -- A dynamic segment with a care filter stays marked whatever was asked (the trigger forces it).
  return (select care_only from public.segments where id = p_segment);
end;
$$;
revoke all on function public.segment_set_care_only(uuid, uuid, boolean, uuid, text) from public, anon, authenticated;
grant execute on function public.segment_set_care_only(uuid, uuid, boolean, uuid, text) to service_role;

-- Backfill: existing dynamic segments whose filter uses a care field (including the appointment and enquiry fields
-- newly treated as care only). Twice, so a segment that includes a segment flagged in the first pass is caught too.
-- The count is reported in the migration log; the segments list shows the "Care only" badge.
do $$
declare
  n1 integer;
  n2 integer;
begin
  update public.segments set care_only = care_only where kind = 'dynamic' and not care_only;
  get diagnostics n1 = row_count;
  update public.segments set care_only = care_only where kind = 'dynamic' and not care_only;
  get diagnostics n2 = row_count;
  raise notice 'care_only backfill: % dynamic segments re-evaluated (second pass %)', n1, n2;
end $$;

-- ---------------------------------------------------------------------------
-- campaign_snapshot_segment: now takes the segment and the purpose.
-- A marketing snapshot (any purpose but 'care') needs a segment and refuses a care-only one; a real snapshot must be
-- for the campaign's own segment. Same body otherwise.
-- ---------------------------------------------------------------------------

drop function if exists public.campaign_snapshot_segment(uuid, uuid, text, jsonb, boolean, integer, boolean);

create or replace function public.campaign_snapshot_segment(
  p_org_id uuid, p_campaign_id uuid, p_where text, p_params jsonb, p_marketing boolean,
  p_limit integer, p_dry boolean default false,
  p_segment_id uuid default null, p_purpose text default 'marketing'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if p_where is null or btrim(p_where) = '' then
    p_where := 'true';
  end if;
  if coalesce(p_purpose, 'marketing') <> 'care' then
    if p_segment_id is null then
      raise exception 'A marketing audience needs a segment.' using errcode = '22023';
    end if;
    if app.segment_care_only(p_org_id, p_segment_id) then
      raise exception 'This segment is for care programmes only (recall and follow-up), not marketing.' using errcode = '42501';
    end if;
  end if;
  if not p_dry then
    if not exists (select 1 from public.campaigns where id = p_campaign_id and org_id = p_org_id) then
      raise exception 'campaign not found' using errcode = 'no_data_found';
    end if;
    if p_segment_id is not null
       and exists (select 1 from public.campaigns where id = p_campaign_id and org_id = p_org_id and segment_id is distinct from p_segment_id) then
      raise exception 'The audience is not the campaign''s own segment.' using errcode = '22023';
    end if;
  end if;
  execute format($q$
    with src as (
      select c.id,
             app.campaign_skip_reason(c.deleted_at, c.phone_e164, c.wa_bsuid, c.promotions_opt_in, c.stop_marketing, $3) as reason
      from public.contacts c
      where c.org_id = $2 and c.deleted_at is null and (%s)
      order by c.created_at, c.id
      limit $4
    ), ins as (
      insert into public.campaign_recipients (org_id, campaign_id, contact_id, status, skip_reason)
      select $2, $5, id, case when reason is null then 'pending' else 'skipped' end, reason
      from src where not $6
      on conflict (campaign_id, contact_id) do nothing
      returning 1
    )
    select jsonb_build_object(
      'total', (select count(*) from src),
      'eligible', (select count(*) from src where reason is null),
      'skipped', coalesce((select jsonb_object_agg(reason, n) from (select reason, count(*) as n from src where reason is not null group by reason) x), '{}'::jsonb)
    )
  $q$, p_where) into v_result
  using coalesce(p_params, '[]'::jsonb), p_org_id, p_marketing, greatest(1, p_limit), p_campaign_id, coalesce(p_dry, false);
  return v_result;
end;
$$;
revoke all on function public.campaign_snapshot_segment(uuid, uuid, text, jsonb, boolean, integer, boolean, uuid, text) from public, anon, authenticated;
grant execute on function public.campaign_snapshot_segment(uuid, uuid, text, jsonb, boolean, integer, boolean, uuid, text) to service_role;

-- Service-role wrapper so server code asks the one SQL rule instead of re-implementing it.
create or replace function public.segment_is_care_only(p_org uuid, p_segment uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.segment_care_only(p_org, p_segment);
$$;
revoke all on function public.segment_is_care_only(uuid, uuid) from public, anon, authenticated;
grant execute on function public.segment_is_care_only(uuid, uuid) to service_role;
