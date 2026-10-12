-- Phase 15 (3/3): patient data export / erasure requests and the off-boarding action.
--
--   privacy_requests   one row per export or erasure request. Two-person rule: the person who approves a
--                      request cannot be the person who raised it (enforced by a CHECK, not only in code).
--   erase_contact()    anonymises one patient inside a single transaction (service role only)
--   offboard_member()  suspends a member, revokes their API keys and sessions, hands over their open
--                      conversations and tasks, and writes the audit row, all in one transaction
--
-- Erasure is anonymisation, not row deletion: the contact row, appointments and enquiries stay so counts,
-- finance links and audit trails keep working, but every identifier and every free-text field that can name
-- the patient is cleared. Clinical records mirrored from Unite (visits, prescriptions, follow-ups, feedback,
-- chronic conditions) are NOT altered: they are medical records with their own legal retention, and the
-- clinic's data-protection decision on them is recorded as an open question (docs/12_PHASE_15_NOTES.md).

-- ---------------------------------------------------------------------------
-- privacy_requests
-- ---------------------------------------------------------------------------
create table public.privacy_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  kind text not null check (kind in ('export', 'erasure')),
  contact_id uuid not null references public.contacts (id) on delete restrict,
  status text not null default 'pending' check (status in ('pending', 'approved', 'completed', 'rejected', 'cancelled')),
  reason text not null check (char_length(reason) between 5 and 1000),
  requested_by uuid references auth.users (id) on delete set null,
  requested_at timestamptz not null default now(),
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  decision_note text check (decision_note is null or char_length(decision_note) <= 1000),
  completed_at timestamptz,
  result jsonb not null default '{}'::jsonb check (jsonb_typeof(result) = 'object'),   -- counts only, never data
  -- Two-person confirmation: whoever decides cannot be whoever asked.
  constraint privacy_requests_two_person check (decided_by is null or requested_by is null or decided_by <> requested_by)
);
create index privacy_requests_org_idx on public.privacy_requests (org_id, requested_at desc);
create index privacy_requests_contact_idx on public.privacy_requests (contact_id);
create trigger privacy_requests_contact_org_check before insert or update of contact_id on public.privacy_requests
  for each row execute function app.check_parent_org('contacts', 'contact_id');

alter table public.privacy_requests enable row level security;
create policy privacy_requests_select on public.privacy_requests for select to authenticated
  using (app.has_perm(org_id, 'privacy.manage'));

-- ---------------------------------------------------------------------------
-- erase_contact
-- ---------------------------------------------------------------------------
create or replace function public.erase_contact(p_org uuid, p_contact uuid, p_actor uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact public.contacts;
  v_conv uuid[];
  v_enq uuid[];
  v_appt uuid[];
  v_task uuid[];
  n integer;
  r jsonb := '{}'::jsonb;
begin
  select * into v_contact from public.contacts where id = p_contact and org_id = p_org for update;
  if not found then
    raise exception 'contact not found in this organisation' using errcode = 'no_data_found';
  end if;
  if v_contact.erased_at is not null then
    raise exception 'contact is already erased' using errcode = 'check_violation';
  end if;

  select coalesce(array_agg(id), '{}') into v_conv from public.conversations where org_id = p_org and contact_id = p_contact;
  select coalesce(array_agg(id), '{}') into v_enq from public.enquiries where org_id = p_org and contact_id = p_contact;
  select coalesce(array_agg(id), '{}') into v_appt from public.appointments where org_id = p_org and contact_id = p_contact;
  select coalesce(array_agg(id), '{}') into v_task from public.tasks where org_id = p_org and contact_id = p_contact;

  -- Messages: keep the row (counts, delivery stats) but drop everything a person wrote or sent.
  update public.messages
     set body = null, payload = '{}'::jsonb, media_path = null, media_mime = null, media_filename = null,
         media_meta_id = null, error_message = null
   where org_id = p_org and conversation_id = any (v_conv);
  get diagnostics n = row_count; r := r || jsonb_build_object('messages_scrubbed', n);

  update public.conversations
     set summary = null, last_message_preview = null, ad_referral = null, ai_tags = '{}'
   where org_id = p_org and id = any (v_conv);

  delete from public.mentions where org_id = p_org and (contact_id = p_contact or conversation_id = any (v_conv));
  delete from public.timeline_events
   where org_id = p_org and (contact_id = p_contact or enquiry_id = any (v_enq));
  get diagnostics n = row_count; r := r || jsonb_build_object('timeline_events_deleted', n);

  delete from public.contact_phones where org_id = p_org and contact_id = p_contact;
  get diagnostics n = row_count; r := r || jsonb_build_object('phones_deleted', n);
  delete from public.contact_tags where contact_id = p_contact;
  delete from public.segment_members where contact_id = p_contact;

  update public.appointments set notes = null, custom = '{}'::jsonb where org_id = p_org and id = any (v_appt);
  update public.enquiries
     set title = 'Erased enquiry', custom = '{}'::jsonb, lost_reason = null
   where org_id = p_org and id = any (v_enq);
  update public.tasks set subject = 'Erased task', notes = null where org_id = p_org and id = any (v_task);
  update public.flow_runs set context = '{}'::jsonb, waiting_for = null, error = null
   where org_id = p_org and contact_id = p_contact;
  update public.campaign_recipients set vars = '{}'::jsonb, csv_data = '{}'::jsonb, error_message = null
   where org_id = p_org and contact_id = p_contact;
  update public.recall_sends set notes = null, sent_to_phone_e164 = null where org_id = p_org and contact_id = p_contact;
  -- Unite patients that were matched to this contact carry the patient's details in the review item.
  update public.sync_reviews set incoming = '{}'::jsonb, candidates = '[]'::jsonb
   where org_id = p_org and resolved_contact_id = p_contact;

  -- The field-level history of the patient's appointments, enquiries and tasks repeats those values.
  perform set_config('app.history_purge', 'on', true);
  delete from public.record_history
   where org_id = p_org and (
     (table_name = 'appointments' and record_id = any (v_appt)) or
     (table_name = 'enquiries' and record_id = any (v_enq)) or
     (table_name = 'tasks' and record_id = any (v_task))
   );
  get diagnostics n = row_count; r := r || jsonb_build_object('history_rows_deleted', n);

  update public.contacts
     set first_name = 'Erased', last_name = 'patient', phone_e164 = null, wa_bsuid = null, email = null,
         gender = null, nationality = null, country = null, language = null, dob = null, label = null,
         owner_id = null, assignee_id = null, external_id = null, custom = '{}'::jsonb,
         wa_profile_name = null, promotions_opt_in = false, promotions_consent = null,
         stop_marketing = true,                                    -- an erased person is never messaged again
         clinical_messaging_consent = false,
         merged_into_id = null, deleted_at = coalesce(deleted_at, now()), erased_at = now()
   where id = p_contact;

  -- Counts of what is deliberately left (clinical records), so the reviewer sees it in the result.
  r := r || jsonb_build_object(
    'retained_visits', (select count(*) from public.visits where org_id = p_org and contact_id = p_contact),
    'retained_prescriptions', (select count(*) from public.prescriptions where org_id = p_org and contact_id = p_contact),
    'retained_followups', (select count(*) from public.clinical_followups where org_id = p_org and contact_id = p_contact),
    'retained_feedback', (select count(*) from public.clinical_feedback where org_id = p_org and contact_id = p_contact),
    'conversations', coalesce(array_length(v_conv, 1), 0),
    'appointments', coalesce(array_length(v_appt, 1), 0),
    'enquiries', coalesce(array_length(v_enq, 1), 0),
    'tasks', coalesce(array_length(v_task, 1), 0)
  );

  insert into public.audit_log (org_id, user_id, action, entity, entity_id, diff)
  values (p_org, p_actor, 'contact.erased', 'contact', p_contact::text, r);
  return r;
end;
$$;
revoke all on function public.erase_contact(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.erase_contact(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- offboard_member
-- ---------------------------------------------------------------------------
create or replace function public.offboard_member(
  p_org uuid,
  p_membership uuid,
  p_actor uuid,
  p_reassign_to uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_m public.memberships;
  v_is_admin boolean;
  v_admins integer;
  v_keys integer;
  v_conv integer;
  v_tasks integer;
  v_sessions integer;
  v_teams integer;
  v_result jsonb;
begin
  select * into v_m from public.memberships where id = p_membership and org_id = p_org for update;
  if not found then
    raise exception 'member not found' using errcode = 'no_data_found';
  end if;
  if v_m.user_id = p_actor then
    raise exception 'you cannot off-board yourself' using errcode = 'check_violation';
  end if;
  if v_m.status = 'suspended' then
    raise exception 'member is already suspended' using errcode = 'check_violation';
  end if;

  select exists (select 1 from public.roles r where r.id = v_m.role_id and r.permissions ? '*') into v_is_admin;
  if v_is_admin then
    select count(*) into v_admins
    from public.memberships m join public.roles r on r.id = m.role_id
    where m.org_id = p_org and m.status = 'active' and r.permissions ? '*';
    if v_admins <= 1 then
      raise exception 'this is the last administrator' using errcode = 'check_violation';
    end if;
  end if;

  if p_reassign_to is not null then
    if p_reassign_to = v_m.user_id then
      raise exception 'hand-over target must be someone else' using errcode = 'check_violation';
    end if;
    if not exists (select 1 from public.memberships m where m.org_id = p_org and m.user_id = p_reassign_to and m.status = 'active') then
      raise exception 'hand-over target is not an active member of this workspace' using errcode = 'check_violation';
    end if;
  end if;

  update public.memberships set status = 'suspended', presence = 'offline' where id = p_membership;

  update public.api_keys set revoked_at = now()
   where org_id = p_org and created_by = v_m.user_id and revoked_at is null;
  get diagnostics v_keys = row_count;

  update public.conversations set assignee_user_id = p_reassign_to
   where org_id = p_org and assignee_user_id = v_m.user_id and status <> 'closed';
  get diagnostics v_conv = row_count;

  update public.tasks set assignee_id = p_reassign_to
   where org_id = p_org and assignee_id = v_m.user_id and not done;
  get diagnostics v_tasks = row_count;

  -- Out of every team, so round-robin assignment cannot pick them while suspended.
  delete from public.team_members where org_id = p_org and user_id = v_m.user_id;
  get diagnostics v_teams = row_count;

  update public.user_sessions set revoked_at = now(), revoked_reason = 'offboarded'
   where org_id = p_org and user_id = v_m.user_id and revoked_at is null;
  get diagnostics v_sessions = row_count;

  v_result := jsonb_build_object(
    'user_id', v_m.user_id, 'api_keys_revoked', v_keys, 'conversations_reassigned', v_conv,
    'tasks_reassigned', v_tasks, 'teams_left', v_teams, 'sessions_marked_revoked', v_sessions,
    'reassigned_to', p_reassign_to
  );
  insert into public.audit_log (org_id, user_id, action, entity, entity_id, diff)
  values (p_org, p_actor, 'member.offboarded', 'membership', p_membership::text, v_result);
  return v_result;
end;
$$;
revoke all on function public.offboard_member(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.offboard_member(uuid, uuid, uuid, uuid) to service_role;
