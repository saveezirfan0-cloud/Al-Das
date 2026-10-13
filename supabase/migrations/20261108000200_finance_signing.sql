-- Phase 22C: digital signatures on approval certificates and close packs (docs/22_PHASE_22C_NOTES.md).
--
--   * fin_signing_certificates  a person's own soft certificate (.p12), AES-256-GCM encrypted by the app; subject,
--                               issuer, serial, fingerprint and validity in clear. Service role only (no policy): the
--                               owner manages it through server actions; the PIN is never stored.
--   * fin_approval_signatures   a detached CMS signature over the canonical approval statement of one approval step
--                               (voucher verify / department / CEO, close sign-off for Finance / CEO). Append-only.
--                               Readable by whoever can read the document (the voucher's or the close's own policy).
--   * fin_sealed_documents      the final approval certificate / signed close pack PDF with the organisation seal
--                               (PAdES), stored once per document and bound hash so every download is the same bytes.
--                               Service role only; append-only.
--   * fin_voucher_act_signed / fin_close_sign_signed: the existing step (fin_voucher_act, fin_close_sign_*) and the
--     signature in ONE transaction, so a signature is never stored without its approval or the other way round.
--
-- Independent of the accounting slice (22A): touches only Phase 18 / 20D objects.

-- ---------------------------------------------------------------------------
-- 1. Personal certificates
-- ---------------------------------------------------------------------------
create table public.fin_signing_certificates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  -- the .p12 bytes, base64, encrypted by lib/crypto.ts (v1:<iv>:<tag>:<ciphertext>); still protected by the owner's PIN
  -- inside. Dropped (null) when the certificate is revoked.
  p12_enc text check (p12_enc ~ '^v1:' and char_length(p12_enc) <= 200000),
  subject text not null check (char_length(subject) between 1 and 1000),
  subject_cn text check (subject_cn is null or char_length(subject_cn) <= 300),
  issuer text not null check (char_length(issuer) between 1 and 1000),
  issuer_cn text check (issuer_cn is null or char_length(issuer_cn) <= 300),
  serial_hex text not null check (serial_hex ~ '^[0-9A-F]{1,128}$'),
  fingerprint_sha256 text not null check (fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
  valid_from timestamptz not null,
  valid_to timestamptz not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint fin_signing_certificates_validity check (valid_to > valid_from),
  constraint fin_signing_certificates_key_while_active check ((revoked_at is null) = (p12_enc is not null))
);
-- one active certificate per person and organisation
create unique index fin_signing_certificates_active_uq on public.fin_signing_certificates (org_id, user_id)
  where revoked_at is null;
create index fin_signing_certificates_user_idx on public.fin_signing_certificates (org_id, user_id, created_at desc);
comment on table public.fin_signing_certificates is
  'Phase 22C: a person''s own soft signing certificate (.p12, encrypted). Service role only; the PIN is never stored.';

-- A certificate row never changes except to be revoked (and its key material is then dropped).
create or replace function app.fin_signing_certificates_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.orgs o where o.id = old.org_id)
       and exists (select 1 from public.profiles p where p.id = old.user_id) then
      raise exception 'signing certificates are revoked, never deleted' using errcode = '42501';
    end if;
    return old;
  end if;
  if old.revoked_at is not null then
    raise exception 'a revoked certificate cannot change' using errcode = '42501';
  end if;
  if new.revoked_at is null or new.p12_enc is not null
     or (to_jsonb(new) - 'revoked_at' - 'p12_enc') is distinct from (to_jsonb(old) - 'revoked_at' - 'p12_enc') then
    raise exception 'a signing certificate can only be revoked' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function app.fin_signing_certificates_guard() from public, anon, authenticated;
create trigger fin_signing_certificates_guard before update or delete on public.fin_signing_certificates
  for each row execute function app.fin_signing_certificates_guard();

-- ---------------------------------------------------------------------------
-- 2. Personal signatures per approval step
-- ---------------------------------------------------------------------------
create table public.fin_approval_signatures (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  doc_kind text not null check (doc_kind in ('payment_voucher', 'close_pack')),
  doc_id uuid not null,
  step text not null check (step in ('check', 'approve_dept', 'approve_ceo', 'finance', 'ceo')),
  user_id uuid references public.profiles (id) on delete set null,
  certificate_id uuid references public.fin_signing_certificates (id) on delete set null,
  -- the canonical approval statement (ids, step, bound sha256, remarks sha256, time; no free text) and its sha256
  statement text not null check (char_length(statement) <= 4000),
  statement_sha256 text not null check (statement_sha256 ~ '^[0-9a-f]{64}$'),
  bound_sha256 text not null check (bound_sha256 ~ '^[0-9a-f]{64}$'),
  cms bytea not null check (octet_length(cms) between 64 and 32768),
  cert_subject text not null,
  cert_subject_cn text,
  cert_issuer text not null,
  cert_issuer_cn text,
  cert_serial text not null,
  cert_fingerprint text not null check (cert_fingerprint ~ '^[0-9a-f]{64}$'),
  cert_valid_from timestamptz not null,
  cert_valid_to timestamptz not null,
  -- the transaction time of the step itself (equal to checked_at / ceo_approved_at / finance_signed_at ...)
  step_at timestamptz not null default now(),
  constraint fin_approval_signatures_step_kind check (
    (doc_kind = 'payment_voucher' and step in ('check', 'approve_dept', 'approve_ceo'))
    or (doc_kind = 'close_pack' and step in ('finance', 'ceo')))
);
create index fin_approval_signatures_doc_idx on public.fin_approval_signatures (org_id, doc_kind, doc_id, step_at);
comment on table public.fin_approval_signatures is
  'Phase 22C: detached CMS signatures by a person''s own certificate over the canonical approval statement of one step. Append-only.';

create or replace function app.fin_approval_signatures_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.orgs o where o.id = old.org_id) then
      raise exception 'approval signatures are append-only' using errcode = '42501';
    end if;
    return old;
  end if;
  -- only the foreign keys being nulled (a member removed, a certificate row gone)
  if (to_jsonb(new) - 'user_id' - 'certificate_id') is not distinct from (to_jsonb(old) - 'user_id' - 'certificate_id')
     and (new.user_id is null or new.user_id = old.user_id)
     and (new.certificate_id is null or new.certificate_id = old.certificate_id) then
    return new;
  end if;
  raise exception 'approval signatures are append-only' using errcode = '42501';
end;
$$;
revoke all on function app.fin_approval_signatures_append_only() from public, anon, authenticated;
create trigger fin_approval_signatures_append_only before update or delete on public.fin_approval_signatures
  for each row execute function app.fin_approval_signatures_append_only();

-- ---------------------------------------------------------------------------
-- 3. Sealed PDFs (organisation seal)
-- ---------------------------------------------------------------------------
create table public.fin_sealed_documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  doc_kind text not null check (doc_kind in ('voucher_certificate', 'close_pack')),
  doc_id uuid not null,
  -- the voucher's approved content sha256 / the close pack's snapshot sha256 this PDF was made for
  bound_sha256 text not null check (bound_sha256 ~ '^[0-9a-f]{64}$'),
  pdf bytea not null check (octet_length(pdf) between 100 and 10485760),
  pdf_sha256 text generated always as (encode(sha256(pdf), 'hex')) stored,
  seal_subject text not null,
  seal_fingerprint text not null check (seal_fingerprint ~ '^[0-9a-f]{64}$'),
  sealed_at timestamptz not null default now(),
  sealed_by uuid references public.profiles (id) on delete set null,
  unique (org_id, doc_kind, doc_id, bound_sha256)
);
comment on table public.fin_sealed_documents is
  'Phase 22C: the sealed (PAdES) approval certificate or close pack, kept so every download returns the same signed bytes. Service role only; append-only.';

create or replace function app.fin_sealed_documents_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.orgs o where o.id = old.org_id) then
      raise exception 'sealed documents are kept' using errcode = '42501';
    end if;
    return old;
  end if;
  if (to_jsonb(new) - 'sealed_by') is not distinct from (to_jsonb(old) - 'sealed_by') and new.sealed_by is null then
    return new;
  end if;
  raise exception 'sealed documents are kept' using errcode = '42501';
end;
$$;
revoke all on function app.fin_sealed_documents_append_only() from public, anon, authenticated;
create trigger fin_sealed_documents_append_only before update or delete on public.fin_sealed_documents
  for each row execute function app.fin_sealed_documents_append_only();

-- ---------------------------------------------------------------------------
-- 4. Row level security
-- ---------------------------------------------------------------------------
alter table public.fin_signing_certificates enable row level security;   -- no policy: service role only
alter table public.fin_sealed_documents enable row level security;       -- no policy: service role only
alter table public.fin_approval_signatures enable row level security;

-- A signature is visible exactly when its document is: the sub-selects run under the reader's own row level security
-- (fin_payment_vouchers_select narrows department heads and special categories; fin_period_closes_select needs a close key).
create policy fin_approval_signatures_select on public.fin_approval_signatures for select to authenticated
  using (
    (doc_kind = 'payment_voucher' and exists (
      select 1 from public.fin_payment_vouchers v
      where v.id = fin_approval_signatures.doc_id and v.org_id = fin_approval_signatures.org_id))
    or (doc_kind = 'close_pack' and exists (
      select 1 from public.fin_period_closes c
      where c.id = fin_approval_signatures.doc_id and c.org_id = fin_approval_signatures.org_id))
  );

-- ---------------------------------------------------------------------------
-- 5. Storing a signature with its step
-- ---------------------------------------------------------------------------
-- Checks the signed statement against the step it accompanies (document, org, step, signer, bound hash, remarks hash,
-- freshness) and the signer's own active certificate, then stores it. The CMS itself is verified by the server before
-- this is called (lib/signing/verify.ts); SQL cannot check RSA signatures.
create or replace function app.fin_store_approval_signature(
  p_org_id uuid, p_doc_kind text, p_doc_id uuid, p_step text, p_user_id uuid, p_bound_sha256 text, p_remarks text,
  p_signature jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_text text := p_signature ->> 'statement';
  v_st jsonb;
  v_remarks text := nullif(btrim(coalesce(p_remarks, '')), '');
  v_signed_at timestamptz;
  v_cert public.fin_signing_certificates;
  v_cms bytea;
  v_id uuid;
begin
  if v_text is null or char_length(v_text) > 4000 then
    raise exception 'The signature is missing its statement.' using errcode = 'check_violation', hint = 'signature_invalid';
  end if;
  begin
    v_st := v_text::jsonb;
    v_signed_at := (v_st ->> 'signed_at')::timestamptz;
    v_cms := decode(p_signature ->> 'cms', 'base64');
  exception when others then
    raise exception 'The signature cannot be read.' using errcode = 'check_violation', hint = 'signature_invalid';
  end;
  if v_st ->> 'type' is distinct from 'pulse.approval-statement' or v_st ->> 'v' is distinct from '1'
     or v_st ->> 'doc_type' is distinct from p_doc_kind or v_st ->> 'doc_id' is distinct from p_doc_id::text
     or v_st ->> 'org_id' is distinct from p_org_id::text or v_st ->> 'step' is distinct from p_step
     or v_st ->> 'signer_id' is distinct from p_user_id::text or v_st ->> 'bound_sha256' is distinct from p_bound_sha256
     or (v_st ->> 'remarks_sha256') is distinct from
        (case when v_remarks is null then null else encode(sha256(convert_to(v_remarks, 'UTF8')), 'hex') end) then
    raise exception 'The signed statement does not match this step.' using errcode = 'check_violation', hint = 'signature_invalid';
  end if;
  if v_signed_at is null or abs(extract(epoch from (now() - v_signed_at))) > 600 then
    raise exception 'The signature is too old; sign again.' using errcode = 'check_violation', hint = 'signature_stale';
  end if;
  if v_cms is null or octet_length(v_cms) < 64 or octet_length(v_cms) > 32768 then
    raise exception 'The signature cannot be read.' using errcode = 'check_violation', hint = 'signature_invalid';
  end if;
  select * into v_cert from public.fin_signing_certificates c
   where c.id = nullif(p_signature ->> 'certificate_id', '')::uuid
     and c.org_id = p_org_id and c.user_id = p_user_id and c.revoked_at is null;
  if not found or v_cert.fingerprint_sha256 is distinct from p_signature ->> 'fingerprint' then
    raise exception 'Your signing certificate was revoked or replaced.' using errcode = 'check_violation', hint = 'certificate_revoked';
  end if;
  if now() < v_cert.valid_from or now() > v_cert.valid_to then
    raise exception 'Your signing certificate is not valid now.' using errcode = 'check_violation', hint = 'certificate_expired';
  end if;
  insert into public.fin_approval_signatures (
    org_id, doc_kind, doc_id, step, user_id, certificate_id, statement, statement_sha256, bound_sha256, cms,
    cert_subject, cert_subject_cn, cert_issuer, cert_issuer_cn, cert_serial, cert_fingerprint, cert_valid_from, cert_valid_to
  ) values (
    p_org_id, p_doc_kind, p_doc_id, p_step, p_user_id, v_cert.id, v_text, encode(sha256(convert_to(v_text, 'UTF8')), 'hex'),
    p_bound_sha256, v_cms, v_cert.subject, v_cert.subject_cn, v_cert.issuer, v_cert.issuer_cn, v_cert.serial_hex,
    v_cert.fingerprint_sha256, v_cert.valid_from, v_cert.valid_to
  ) returning id into v_id;
  return v_id;
end;
$$;
revoke all on function app.fin_store_approval_signature(uuid, text, uuid, text, uuid, text, text, jsonb)
  from public, anon, authenticated;

-- A voucher verify / department / CEO step with the person's signature, atomically.
create or replace function public.fin_voucher_act_signed(
  p_org_id uuid, p_voucher_id uuid, p_user_id uuid, p_action text, p_hash text, p_remarks text, p_signature jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_sig uuid;
begin
  if p_action not in ('check', 'approve_dept', 'approve_ceo') then
    raise exception 'Only verification and approval steps can be signed.' using errcode = 'check_violation', hint = 'signature_step';
  end if;
  v_result := public.fin_voucher_act(p_org_id, p_voucher_id, p_user_id, p_action, p_hash, p_remarks, null);
  v_sig := app.fin_store_approval_signature(p_org_id, 'payment_voucher', p_voucher_id, p_action, p_user_id, p_hash,
                                            p_remarks, p_signature);
  return v_result || jsonb_build_object('signature_id', v_sig);
end;
$$;
revoke all on function public.fin_voucher_act_signed(uuid, uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.fin_voucher_act_signed(uuid, uuid, uuid, text, text, text, jsonb) to service_role;

-- A month-end close sign-off (Finance or CEO) with the person's signature, atomically.
create or replace function public.fin_close_sign_signed(
  p_org_id uuid, p_close_id uuid, p_user_id uuid, p_step text, p_hash text, p_note text, p_signature jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_step = 'finance' then
    perform public.fin_close_sign_finance(p_org_id, p_close_id, p_user_id, p_hash, p_note);
  elsif p_step = 'ceo' then
    perform public.fin_close_sign_ceo(p_org_id, p_close_id, p_user_id, p_hash, p_note);
  else
    raise exception 'Unknown sign-off.' using errcode = 'check_violation', hint = 'signature_step';
  end if;
  return app.fin_store_approval_signature(p_org_id, 'close_pack', p_close_id, p_step, p_user_id, p_hash, p_note, p_signature);
end;
$$;
revoke all on function public.fin_close_sign_signed(uuid, uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.fin_close_sign_signed(uuid, uuid, uuid, text, text, text, jsonb) to service_role;
