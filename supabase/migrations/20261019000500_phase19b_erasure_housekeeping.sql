-- Phase 19b (5/5): erasure and housekeeping for the 19b tables.
--
-- public.erase_contact() is replaced with the Phase 16 body plus Phase 19b steps, so erasing a patient also removes
--   * their Google review requests (review_requests, as patient and as the person who was messaged)
--   * their ad clicks (ad_attributions; the Conversions API event rows go with them)
--   * their e-signature requests (esign_requests; the signed copies are patient documents, which are already deleted above)
--   * their video rooms: the link is revoked and its encrypted token wiped; a durable job deletes the room at the provider
-- Files are removed by the server action BEFORE this function runs (unchanged). The e-signature provider keeps its own copy of anything
-- it was sent, under its own terms: the privacy action withdraws requests that are still waiting, and the clinic's agreement with the
-- provider has to cover the rest (docs/19_PHASE_19B_NOTES.md).
--
-- pulse:housekeeping_19b (daily 03:55 UTC) keeps the tables small: review requests and ad clicks 400 days, Conversions API event rows
-- 90 days, ended video rooms 30 days, and waiting e-signature requests a day past their expiry are closed as expired.

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

  -- Phase 16: the patient's uploaded documents (referrals, lab reports, insurance cards, consent forms).
  delete from public.patient_documents where org_id = p_org and contact_id = p_contact;
  get diagnostics n = row_count; r := r || jsonb_build_object('documents_deleted', n);

  -- Phase 19b: review requests, ad clicks, e-signature requests and video rooms.
  delete from public.review_requests
   where org_id = p_org and (contact_id = p_contact or recipient_contact_id = p_contact or appointment_id = any (v_appt));
  get diagnostics n = row_count; r := r || jsonb_build_object('review_requests_deleted', n);
  delete from public.ad_attributions where org_id = p_org and contact_id = p_contact;
  get diagnostics n = row_count; r := r || jsonb_build_object('ad_clicks_deleted', n);
  delete from public.esign_requests where org_id = p_org and contact_id = p_contact;
  get diagnostics n = row_count; r := r || jsonb_build_object('esign_requests_deleted', n);
  insert into public.scheduled_jobs (kind, org_id, run_at, payload, dedupe_key)
  select 'telehealth.cleanup', t.org_id, now(), jsonb_build_object('room_id', t.id), 'telehealth-cleanup:' || t.id::text
    from public.telehealth_rooms t
   where t.org_id = p_org and t.appointment_id = any (v_appt) and t.provider <> 'static' and t.room_ref is not null and t.provider_deleted_at is null
  on conflict do nothing;
  update public.telehealth_rooms
     set status = 'revoked', revoked_reason = coalesce(revoked_reason, 'erased'), revoked_at = coalesce(revoked_at, now()), token_enc = ''
   where org_id = p_org and appointment_id = any (v_appt);
  get diagnostics n = row_count; r := r || jsonb_build_object('video_rooms_revoked', n);

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

select cron.schedule('pulse:housekeeping_19b', '55 3 * * *', $$
  delete from public.review_requests where created_at < now() - interval '400 days';
  delete from public.capi_events where created_at < now() - interval '90 days';
  delete from public.ad_attributions where clicked_at < now() - interval '400 days';
  delete from public.telehealth_rooms
   where (status = 'revoked' and revoked_at < now() - interval '30 days'
          and (provider = 'static' or room_ref is null or provider_deleted_at is not null))
      or (status = 'active' and expires_at < now() - interval '30 days');
  update public.esign_requests set status = 'expired', completed_at = now()
   where status = 'pending' and expires_at < now() - interval '1 day';
$$);
