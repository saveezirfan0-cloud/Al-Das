-- Phase 16 (2/4): patient documents.
--
--   patient_documents             a patient's referral letters, lab reports, insurance cards and consent forms.
--                                 Bytes live in the private `patient-documents` bucket at
--                                 <org>/<contact>/<document>.<ext>; the title typed by staff stays in this row.
--   document_retention_policies   how long each category is kept, and whether the nightly job may delete (off by default)
--
-- Permissions documents.view / documents.manage are NOT inherited from contacts.* (granted to existing roles in
-- migration 1/4). The SELECT policy needs documents.view; writes are server-only (service role after can()), so
-- every upload, edit and delete is audited by the server action. Who opened a file goes to record_access_log.
-- Orphaned uploads (status 'pending') and expiring cards are handled by the daily documents_maintenance task.

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_tables where schemaname = 'storage' and tablename = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'patient-documents', 'patient-documents', false, 26214400,
      array[
        'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      ]
    )
    on conflict (id) do nothing;
  end if;
end $$;

create table public.patient_documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  category text not null check (category in ('referral', 'lab_report', 'insurance_card', 'consent', 'other')),
  title text not null check (char_length(title) between 1 and 120),
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0),
  storage_path text not null unique,
  status text not null default 'pending' check (status in ('pending', 'ready')),
  scan_status text not null default 'unscanned' check (scan_status in ('unscanned', 'clean', 'infected', 'error')),
  scanned_at timestamptz,
  scan_engine text,
  expires_on date,
  -- set when the "expiring soon" reminder was raised, so a retry never reminds twice
  expiry_notified_at timestamptz,
  uploaded_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index patient_documents_contact_idx on public.patient_documents (org_id, contact_id, created_at desc);
create index patient_documents_org_cat_idx on public.patient_documents (org_id, category) where status = 'ready';
create index patient_documents_pending_idx on public.patient_documents (created_at) where status = 'pending';
create index patient_documents_expiry_idx on public.patient_documents (org_id, expires_on)
  where status = 'ready' and expiry_notified_at is null and expires_on is not null;
create trigger patient_documents_set_updated_at before update on public.patient_documents
  for each row execute function app.set_updated_at();
create trigger patient_documents_contact_org_check before insert or update on public.patient_documents
  for each row execute function app.check_parent_org('contacts', 'contact_id');

-- When two patient records are merged the documents follow the surviving record. (A trigger rather than a
-- change to merge_contacts, so a later rewrite of that function cannot forget it.) The storage path keeps the
-- original contact id; the server only ever compares the org and the document id.
create or replace function app.move_documents_on_merge()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.merged_into_id is not null and new.merged_into_id is distinct from old.merged_into_id then
    update public.patient_documents set contact_id = new.merged_into_id
     where org_id = new.org_id and contact_id = new.id;
  end if;
  return new;
end;
$$;
create trigger contacts_move_documents_on_merge after update of merged_into_id on public.contacts
  for each row execute function app.move_documents_on_merge();

create table public.document_retention_policies (
  org_id uuid not null references public.orgs (id) on delete cascade,
  category text not null check (category in ('referral', 'lab_report', 'insurance_card', 'consent', 'other')),
  -- null = keep for ever. The clock starts at upload, or at the expiry date when that is later.
  retain_days integer check (retain_days is null or retain_days between 30 and 36500),
  -- off: documents past retention are only listed for review. on: the nightly task deletes them.
  auto_delete boolean not null default false,
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (org_id, category),
  check (not auto_delete or retain_days is not null)
);

alter table public.patient_documents enable row level security;
alter table public.document_retention_policies enable row level security;

create policy patient_documents_select on public.patient_documents for select to authenticated
  using (app.has_perm(org_id, 'documents.view'));
create policy document_retention_policies_select on public.document_retention_policies for select to authenticated
  using (app.has_perm(org_id, 'documents.manage') or app.has_perm(org_id, 'settings.manage'));

-- Daily upkeep: expiry reminders, abandoned uploads, retention (runs in the app so it can use Storage and notify).
select cron.schedule('pulse:documents_maintenance', '40 3 * * *', $$select app.ping_jobs('documents_maintenance')$$);
