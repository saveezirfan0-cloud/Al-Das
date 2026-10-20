-- Sanoflow transport (owner decision 20 Oct 2026, OQ-182, docs/50_SANOFLOW_SENDING_NOTES.md).
--
-- Sanoflow keeps the clinic's WhatsApp numbers. Pulse's native automations (reminders, recall, flows, campaigns) send their
-- approved templates through Sanoflow's API, the way Make does today, instead of through the Meta Cloud API.
--
--   channels.transport          'meta' (default, unchanged) or 'sanoflow'. A Sanoflow number is a WhatsApp channel with no
--                               Meta ids: waba_id 'sanoflow', phone_number_id 'sanoflow:<uuid>'. Pulse never builds a Meta
--                               client for it (clientForChannel refuses) and the outbound job sends its templates through
--                               lib/integrations/sanoflow/ only while the `sanoflow` integration is switched on.
--   wa_templates.sanoflow_template_id
--                               Sanoflow's own template number (e.g. 11885 for the appointment reminder). A template without
--                               one is never sent through Sanoflow.

alter table public.channels
  add column if not exists transport text not null default 'meta';

alter table public.channels drop constraint if exists channels_transport_check;
alter table public.channels add constraint channels_transport_check
  check (transport in ('meta', 'sanoflow'));

-- Only a WhatsApp number can send through Sanoflow, and it carries no Meta ids (so no Meta call can be pointed at it).
alter table public.channels drop constraint if exists channels_sanoflow_ref_check;
alter table public.channels add constraint channels_sanoflow_ref_check
  check (
    transport = 'meta'
    or (type = 'whatsapp' and waba_id = 'sanoflow' and phone_number_id like 'sanoflow:%')
  );

-- A Meta number keeps its Meta ids: nothing may relabel one as a Sanoflow number in place (it would orphan its templates).
create or replace function app.channels_transport_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.transport is distinct from old.transport then
    raise exception 'a channel''s transport cannot change; add a new number instead'
      using errcode = '23514', hint = 'channel_transport_fixed';
  end if;
  return new;
end $$;

drop trigger if exists channels_transport_guard on public.channels;
create trigger channels_transport_guard before update of transport on public.channels
  for each row execute function app.channels_transport_guard();

alter table public.wa_templates
  add column if not exists sanoflow_template_id bigint;

alter table public.wa_templates drop constraint if exists wa_templates_sanoflow_id_check;
alter table public.wa_templates add constraint wa_templates_sanoflow_id_check
  check (sanoflow_template_id is null or sanoflow_template_id > 0);

create index if not exists channels_transport_idx on public.channels (org_id, transport) where transport <> 'meta';
