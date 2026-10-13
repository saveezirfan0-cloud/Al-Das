-- Paste into Supabase > SQL Editor > New query, then Run. Needs 32_finance_manager_sync.sql applied first.
-- The migration-history line is included at the bottom of this file.

-- Phase 20B: finance intake (docs/20_FINANCE_CONTROL_PLAN.md, slice 20B; docs/20_PHASE_20B_NOTES.md).
--
-- Supplier invoices, bank statements and processor reports reach Pulse two ways: e-mailed to the accounts mailbox (the
-- `finance_mailbox` integration keeps attachments from allow-listed senders, nothing else of the message) or dropped on
-- the Finance inbox page. Either way each file is one fin_documents row (20D) that waits in the inbox until someone
-- makes it a supplier invoice, labels it or discards it. Patient-identifying reports (Diligence, remittance, lab) never
-- come here: their own pages parse them and delete the original at once.
--
--   * finance.inbox.manage (Finance, Finance Manager)
--   * fin_documents: inbox_at (the file came in through the inbox), routed_at (first linked to a supplier invoice or a
--     voucher), sender_domain (e-mail only: the domain of the sender's address, never the address, name, subject or
--     body); kinds 'processor_report' and 'unclassified' (what an inbox file is until someone labels it)
--   * a trigger marks a document routed when a supplier invoice or a voucher first links it, and refuses a link to a
--     document that is not ready (one being discarded)
--   * a select policy for inbox documents (finance.inbox.manage), next to the 20D payables policy
--   * the finance-documents bucket accepts CSV (bank statements)

-- ---------------------------------------------------------------------------
-- 1. Permission for existing system roles (new orgs get it from lib/auth/permissions.ts)
-- ---------------------------------------------------------------------------
do $$
declare
  g record;
begin
  for g in
    select * from (values
      ('Finance', 'finance.inbox.manage'),
      ('Finance Manager', 'finance.inbox.manage')
    ) as t (role_name, perm)
  loop
    update public.roles r
       set permissions = r.permissions || to_jsonb(g.perm)
     where r.is_system and r.name = g.role_name and not (r.permissions ? g.perm);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. fin_documents: the inbox
-- ---------------------------------------------------------------------------
alter table public.fin_documents drop constraint fin_documents_kind_check;
alter table public.fin_documents add constraint fin_documents_kind_check
  check (kind in ('supplier_invoice', 'voucher_backup', 'bank_statement', 'processor_report', 'other', 'unclassified'));

alter table public.fin_documents
  add column inbox_at timestamptz,
  add column routed_at timestamptz,
  add column sender_domain text,
  add constraint fin_documents_sender_domain_check
    check (sender_domain is null or (source = 'email' and sender_domain ~ '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$'));

comment on column public.fin_documents.inbox_at is
  'When the file arrived through the Finance inbox (e-mail or the drop zone); null for files attached directly in 20D.';
comment on column public.fin_documents.routed_at is
  'When a supplier invoice or a voucher first linked the document (set by trigger). Inbox = inbox_at set, routed_at null.';
comment on column public.fin_documents.sender_domain is
  'E-mail only: the domain of the sender''s address. No address, name, subject, body or file name is stored.';

create index fin_documents_inbox_idx on public.fin_documents (org_id, inbox_at desc)
  where inbox_at is not null and routed_at is null;

-- Inbox managers read inbox documents (the 20D policy already lets payables and voucher staff read every document).
create policy fin_documents_inbox_select on public.fin_documents for select to authenticated
  using (inbox_at is not null and app.has_perm(org_id, 'finance.inbox.manage'));

-- ---------------------------------------------------------------------------
-- 3. Routing: the first link to a supplier invoice or a voucher takes the document out of the inbox
-- ---------------------------------------------------------------------------
-- tg_argv[0] is the kind an unlabelled ('unclassified') document becomes. A link to a document that is not ready (still
-- uploading, or being discarded) is refused, so a discard and a link can never both succeed.
create or replace function app.fin_document_route()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.document_id is null or (tg_op = 'UPDATE' and new.document_id is not distinct from old.document_id) then
    return null;
  end if;
  update public.fin_documents d
     set routed_at = now(),
         kind = case when d.kind = 'unclassified' then tg_argv[0] else d.kind end
   where d.id = new.document_id and d.routed_at is null and d.status = 'ready';
  if not found and exists (select 1 from public.fin_documents d where d.id = new.document_id and d.status <> 'ready') then
    raise exception 'That document is not available.' using errcode = 'check_violation', hint = 'document_unavailable';
  end if;
  return null;
end;
$$;
revoke all on function app.fin_document_route() from public, anon, authenticated;

create trigger fin_supplier_invoices_route_document
  after insert or update of document_id on public.fin_supplier_invoices
  for each row execute function app.fin_document_route('supplier_invoice');
create trigger fin_voucher_documents_route_document
  after insert or update of document_id on public.fin_voucher_documents
  for each row execute function app.fin_document_route('voucher_backup');

-- Documents linked before this migration are not in the inbox (they have no inbox_at); mark them routed for the record.
update public.fin_documents d set routed_at = d.created_at
 where d.routed_at is null
   and (exists (select 1 from public.fin_supplier_invoices si where si.document_id = d.id)
        or exists (select 1 from public.fin_voucher_documents vd where vd.document_id = d.id));

-- ---------------------------------------------------------------------------
-- 4. Storage: bank statements arrive as CSV
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_tables where schemaname = 'storage' and tablename = 'buckets') then
    update storage.buckets
       set allowed_mime_types = allowed_mime_types || array['text/csv']
     where id = 'finance-documents' and allowed_mime_types is not null and not ('text/csv' = any (allowed_mime_types));
  end if;
end $$;

insert into supabase_migrations.schema_migrations (version, name) values ('20261103000100', 'finance_intake') on conflict (version) do nothing;
