-- Phase 19b (4/5): e-signature for consent forms.
--
--   esign_requests   one row per request sent to the e-signature provider: which patient, which source document (a patient document or a
--                    library file), the provider's request id, a forward-only status and, once signed, the stored copy (a normal
--                    patient document of category 'consent'). The signer's e-mail is NOT stored, only a masked hint ("s***@x.com"); the
--                    request carries no clinical information. Documents must be switched on (Settings, Patient documents) to use it.
--
-- Status moves forward only (enforced here and in lib/integrations/esign/state.ts):
--   creating -> pending | failed;  pending -> signed | declined | expired | cancelled;  everything else is final.

create table public.esign_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  requested_by uuid references public.profiles (id) on delete set null,
  provider text not null default 'dropbox_sign' check (provider in ('dropbox_sign')),
  provider_request_id text check (provider_request_id is null or char_length(provider_request_id) <= 120),
  source_kind text not null check (source_kind in ('patient_document', 'library_asset')),
  source_document_id uuid references public.patient_documents (id) on delete set null,
  source_asset_id uuid references public.media_assets (id) on delete set null,
  status text not null default 'creating' check (status in ('creating', 'pending', 'signed', 'declined', 'expired', 'cancelled', 'failed')),
  error_code text check (error_code is null or char_length(error_code) <= 40),
  signer_hint text check (signer_hint is null or char_length(signer_hint) <= 80),
  signed_document_id uuid references public.patient_documents (id) on delete set null,
  test_mode boolean not null default true,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  check (
    (source_kind = 'patient_document' and source_asset_id is null)
    or (source_kind = 'library_asset' and source_document_id is null)
  )
);
create unique index esign_requests_provider_ref_uidx on public.esign_requests (provider, provider_request_id)
  where provider_request_id is not null;
create index esign_requests_contact_idx on public.esign_requests (org_id, contact_id, created_at desc);
create index esign_requests_open_idx on public.esign_requests (org_id, expires_at) where status in ('creating', 'pending');

create trigger esign_requests_set_updated_at before update on public.esign_requests
  for each row execute function app.set_updated_at();
create trigger esign_requests_contact_org_check before insert or update of contact_id, org_id on public.esign_requests
  for each row execute function app.check_parent_org('contacts', 'contact_id');
create trigger esign_requests_source_doc_org_check before insert or update of source_document_id, org_id on public.esign_requests
  for each row execute function app.check_parent_org('patient_documents', 'source_document_id');
create trigger esign_requests_source_asset_org_check before insert or update of source_asset_id, org_id on public.esign_requests
  for each row execute function app.check_parent_org('media_assets', 'source_asset_id');
create trigger esign_requests_signed_doc_org_check before insert or update of signed_document_id, org_id on public.esign_requests
  for each row execute function app.check_parent_org('patient_documents', 'signed_document_id');

create or replace function app.esign_status_forward_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = old.status then
    return new;
  end if;
  if not (
    (old.status = 'creating' and new.status in ('pending', 'failed'))
    or (old.status = 'pending' and new.status in ('signed', 'declined', 'expired', 'cancelled'))
  ) then
    raise exception 'esign request cannot move from % to %', old.status, new.status using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger esign_requests_forward_only before update of status on public.esign_requests
  for each row execute function app.esign_status_forward_only();

alter table public.esign_requests enable row level security;
create policy esign_requests_select on public.esign_requests for select to authenticated
  using (app.has_perm(org_id, 'documents.view'));
-- writes: server actions (service role after can('documents.manage')) and the signed-request webhook
