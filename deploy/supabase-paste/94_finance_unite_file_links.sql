-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Saved Unite export as raw batches, and the invoice link view.
-- Needs every earlier file first, up to and including 93_finance_controls.sql.
-- Check the project name in the Supabase header first: this is for the Pulse project only.

-- ======================================================================
-- 20261221000100_finance_unite_file_batches_links.sql
-- ======================================================================
-- Slice A (docs/46 section 1): the saved Unite export as a raw batch, and a link view from invoices to patients and
-- appointments.
--
-- 1. fin_raw_unite_batches gets the origin of a batch. A saved pull from the Unite Finance API (deliver-once, so the
--    file is the only copy) is stored as raw batches with source = 'file' BEFORE anything is processed. Idempotent per
--    org and payload hash. The table keeps RLS with no policies (service role only).
-- 2. v_fin_invoice_links (security_invoker): per invoice, the patient contact and the Unite appointment row it points
--    to. Nothing is copied into fin_invoices; the link is derived at read time.

alter table public.fin_raw_unite_batches
  add column if not exists source text not null default 'api' check (source in ('api', 'file')),
  add column if not exists file_name text check (file_name is null or char_length(file_name) <= 200),
  add column if not exists uploaded_by uuid references public.profiles (id) on delete set null;

create unique index if not exists fin_raw_unite_batches_file_sha_uidx
  on public.fin_raw_unite_batches (org_id, payload_sha256)
  where source = 'file';

-- Lookup support for the link view (contacts_org_external_uidx exists but only for undeleted rows; a merged contact
-- is soft-deleted, so the view needs the plain index too). appointments_org_external_uidx is (org_id, source, external_id).
create index if not exists contacts_org_external_any_idx
  on public.contacts (org_id, external_id) where external_id is not null;

-- link_state, in priority order:
--   1. 'no_patient'     PIN blank, or no live contact carries it (a merged contact resolves to its survivor; a deleted
--                       or erased one does not count). Wins over everything below.
--   2. 'direct'         the invoice has no appointment id (issued without an appointment) and the patient is known.
--   3. 'no_appointment' the invoice names an appointment id but no Unite appointment row has it.
--   4. 'linked'         patient and appointment both found.
-- merge_contacts re-points earlier merges (update contacts set merged_into_id = primary where merged_into_id = secondary),
-- so merged_into_id is always one hop from the survivor.
-- security_invoker: the caller needs finance.invoices.view (fin_invoices RLS); contacts and appointments are read under
-- the caller's own RLS too, so someone who cannot see them gets no_patient / no_appointment, never an id.
create or replace view public.v_fin_invoice_links with (security_invoker = true) as
select i.id as invoice_id, i.org_id, i.inv_display_number, i.patient_pin,
       c.id as contact_id,
       a.id as appointment_row_id,
       case
         when c.id is null then 'no_patient'
         when nullif(btrim(coalesce(i.appointment_id, '')), '') is null then 'direct'
         when a.id is null then 'no_appointment'
         else 'linked'
       end as link_state
from public.fin_invoices i
left join lateral (
  select s.id
  from public.contacts m
  join public.contacts s on s.id = coalesce(m.merged_into_id, m.id)
  where nullif(btrim(coalesce(i.patient_pin, '')), '') is not null
    and m.org_id = i.org_id and m.external_id = i.patient_pin
    and s.org_id = i.org_id and s.deleted_at is null
  order by (m.merged_into_id is null) desc, m.created_at
  limit 1
) c on true
left join lateral (
  select ap.id
  from public.appointments ap
  where nullif(btrim(coalesce(i.appointment_id, '')), '') is not null
    and ap.org_id = i.org_id and ap.source = 'unite' and ap.external_id = i.appointment_id
  limit 1
) a on true
where i.org_id in (select o.org_id from app.user_org_ids() as o(org_id) where app.has_perm(o.org_id, 'finance.invoices.view'));

revoke all on public.v_fin_invoice_links from anon;
grant select on public.v_fin_invoice_links to authenticated, service_role;

-- A saved file is not a capture run: "has the backlog been drained" looks at API batches only (it would otherwise read
-- the file's empty balance as "not drained"). Same function as 20261009000990 with one added condition.
create or replace function public.fin_rules_context(p_org_id uuid)
returns table (claims_fresh boolean, capture_drained boolean, appointments_from date)
language sql
stable
security definer
set search_path = ''
as $$
  select
    exists (
      select 1 from public.fin_raw_diligence_files f
      where f.org_id = p_org_id and f.status = 'committed' and f.committed_at > now() - interval '14 days'
    ),
    coalesce((
      select b.balance_in_range is not null and b.balance_in_range <= 0 and b.process_status = 'processed'
      from public.fin_raw_unite_batches b
      where b.org_id = p_org_id and b.source = 'api'
      order by b.requested_at desc
      limit 1
    ), false),
    (select min(a.starts_at)::date from public.appointments a where a.org_id = p_org_id and a.source = 'unite');
$$;
