-- Sanoflow parity G11 (docs/28_PHASE_20F_INBOX_EXTRAS_NOTES.md): move a WhatsApp chat to a NEW contact.
--
-- A WhatsApp chat belongs to the number (phone / BSUID), so "unlink this chat from the contact" means: the person
-- writing is not the contact the chat is filed under (a shared phone, a mis-matched import). One transaction:
--   1. a new contact is created with the name staff typed and takes over the WhatsApp identity (phone_e164,
--      wa_bsuid, wa_profile_name); opt-outs travel with the number (stop_marketing, SMS opt-out, no review requests);
--      promotions_opt_in is NOT copied (consent is never invented);
--   2. this conversation and every other LIVE WhatsApp conversation of the old contact move to the new contact
--      (replies go to the number, so they must follow it); closed ones stay as the old contact's history;
--      messages are never touched: they follow their conversation;
--   3. optionally the old contact becomes a household dependant of the new one (Phase 14), so its appointment
--      messages still reach the shared phone and name the patient;
--   4. both contacts get a timeline event (ids only).
-- Refused when the old contact has household links (move or remove them first), when the conversation is not on a
-- WhatsApp number, when there is no WhatsApp identity to move, or when the latest inbound sender of the chat is not
-- the old contact's main phone / BSUID (a chat on an alternate number would hand the main number to the wrong
-- person). Service role only, called after can().

create or replace function public.unlink_conversation_contact(
  p_org_id uuid,
  p_conversation_id uuid,
  p_first_name text,
  p_last_name text,
  p_keep_household boolean,
  p_relationship text,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  conv public.conversations;
  ch_type text;
  old public.contacts;
  new_id uuid;
  moved uuid[];
  v_contact_id uuid;
  v_from text;
begin
  if coalesce(btrim(p_first_name), '') = '' and coalesce(btrim(p_last_name), '') = '' then
    raise exception 'the new contact needs a name' using errcode = 'check_violation';
  end if;
  if p_keep_household and coalesce(p_relationship, '') not in ('child', 'parent', 'spouse', 'other') then
    raise exception 'unknown relationship' using errcode = 'check_violation';
  end if;

  -- Lock order as merge_contacts: the contact first (its id from a plain read), then the conversation.
  select c.contact_id into v_contact_id from public.conversations c
   where c.id = p_conversation_id and c.org_id = p_org_id;
  if v_contact_id is null then
    raise exception 'conversation not found' using errcode = 'no_data_found';
  end if;
  select * into old from public.contacts
   where id = v_contact_id and org_id = p_org_id and deleted_at is null
   for update;
  if old.id is null then
    raise exception 'contact not found' using errcode = 'no_data_found';
  end if;
  select * into conv from public.conversations
   where id = p_conversation_id and org_id = p_org_id
   for update;
  if conv.id is null or conv.contact_id is distinct from old.id then
    raise exception 'conversation not found' using errcode = 'no_data_found';
  end if;
  select ch.type into ch_type from public.channels ch where ch.id = conv.channel_id and ch.org_id = p_org_id;
  if ch_type is distinct from 'whatsapp' then
    raise exception 'only WhatsApp chats can be moved to a new contact' using errcode = 'check_violation';
  end if;

  if old.phone_e164 is null and old.wa_bsuid is null then
    raise exception 'the contact has no WhatsApp number to move' using errcode = 'check_violation';
  end if;
  -- The person writing must be on the contact's MAIN identity (not an alternate number from contact_phones),
  -- because that is what the new contact takes over. Meta's `from` of the latest inbound message: phone digits,
  -- or the BSUID for username users.
  select m.payload ->> 'from' into v_from from public.messages m
   where m.conversation_id = conv.id and m.direction = 'in'
   order by m.at desc limit 1;
  if coalesce(v_from, '') = '' then
    raise exception 'nobody has written in this chat yet' using errcode = 'check_violation';
  end if;
  if not ((old.wa_bsuid is not null and v_from = old.wa_bsuid)
          or (old.phone_e164 is not null and '+' || v_from = old.phone_e164)) then
    raise exception 'the chat runs on a different number from the contact''s main number' using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from public.household_links h
     where h.org_id = p_org_id and (h.guardian_contact_id = old.id or h.dependant_contact_id = old.id)
  ) then
    raise exception 'the contact has family links: remove them first' using errcode = 'check_violation';
  end if;

  -- Free the unique identifiers before the new contact takes them.
  update public.contacts set phone_e164 = null, wa_bsuid = null, wa_profile_name = null where id = old.id;
  -- An alternate-phone row with the same number would keep matching inbound messages to the old contact.
  if old.phone_e164 is not null then
    delete from public.contact_phones where contact_id = old.id and phone_e164 = old.phone_e164;
  end if;

  insert into public.contacts (
    org_id, first_name, last_name, phone_e164, wa_bsuid, wa_profile_name, language, source,
    promotions_opt_in, stop_marketing, sms_opt_out_at, no_review_requests_at, created_by, last_interaction_at
  ) values (
    p_org_id, coalesce(btrim(p_first_name), ''), coalesce(btrim(p_last_name), ''), old.phone_e164, old.wa_bsuid,
    old.wa_profile_name, old.language, 'inbox',
    false, old.stop_marketing, old.sms_opt_out_at, old.no_review_requests_at, p_user_id, conv.last_message_at
  ) returning id into new_id;

  with m as (
    update public.conversations c set contact_id = new_id
     where c.org_id = p_org_id and c.contact_id = old.id
       and (c.id = conv.id or (c.status <> 'closed' and exists (
         select 1 from public.channels ch where ch.id = c.channel_id and ch.type = 'whatsapp')))
    returning c.id
  )
  select coalesce(array_agg(id), '{}') into moved from m;

  if p_keep_household then
    insert into public.household_links (org_id, guardian_contact_id, dependant_contact_id, relationship,
                                        reminders_to_guardian, created_by)
    values (p_org_id, new_id, old.id, p_relationship, true, p_user_id);
  end if;

  insert into public.timeline_events (org_id, contact_id, type, actor_type, actor_id, payload)
  values
    (p_org_id, old.id, 'conversation.moved_out', case when p_user_id is null then 'system' else 'user' end, p_user_id,
     jsonb_build_object('to_contact_id', new_id, 'conversations', cardinality(moved))),
    (p_org_id, new_id, 'conversation.moved_in', case when p_user_id is null then 'system' else 'user' end, p_user_id,
     jsonb_build_object('from_contact_id', old.id, 'conversations', cardinality(moved)));

  return jsonb_build_object('contact_id', new_id, 'old_contact_id', old.id, 'conversation_ids', to_jsonb(moved));
end;
$$;
revoke all on function public.unlink_conversation_contact(uuid, uuid, text, text, boolean, text, uuid)
  from public, anon, authenticated;
grant execute on function public.unlink_conversation_contact(uuid, uuid, text, text, boolean, text, uuid)
  to service_role;
