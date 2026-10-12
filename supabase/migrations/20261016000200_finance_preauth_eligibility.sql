-- Phase 18 (2/7): pre-authorisation tracker and eligibility checks ("ready to bill").
--
--   fin_pre_authorisations   request -> decision -> expiry, linked to an appointment and (when billed) a claim
--   fin_eligibility_checks   the cover check for a patient: payer, validity, and the insurance-card document
--                            (a Phase 16 patient_documents row, referenced by id only)
--   v_fin_billing_readiness  insurance invoices that are not yet ready to bill, with the reasons
--
-- Only the Unite PIN (and the platform contact id) identify a patient: no names, dates of birth, Emirates IDs or
-- member IDs. Writes are server-only (service role after can()); staff read through RLS. record_history is attached
-- so the History tab says who changed what.

-- ---------------------------------------------------------------------------
-- fin_pre_authorisations
-- ---------------------------------------------------------------------------
create table public.fin_pre_authorisations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  patient_pin text check (patient_pin is null or char_length(patient_pin) between 1 and 60),
  contact_id uuid references public.contacts (id) on delete set null,
  payer_id text not null check (char_length(payer_id) between 1 and 60),
  auth_number text check (auth_number is null or char_length(auth_number) between 1 and 80),   -- the payer's reference
  cpt_codes text[] not null default '{}',
  appointment_id uuid references public.appointments (id) on delete set null,
  claim_activity_id uuid references public.ins_claim_activities (id) on delete set null,
  status text not null default 'requested'
    check (status in ('draft', 'requested', 'approved', 'partially_approved', 'denied', 'expired', 'cancelled', 'used')),
  requested_on date,
  requested_by uuid references public.profiles (id) on delete set null,
  decision_on date,
  valid_from date,
  expires_on date,
  approved_amount numeric(14, 2) check (approved_amount is null or approved_amount >= 0),
  approved_units integer check (approved_units is null or approved_units >= 0),
  reference_note text check (reference_note is null or char_length(reference_note) <= 200),   -- never clinical detail
  expiry_task_id uuid references public.tasks (id) on delete set null,
  expiry_notified_at timestamptz,                    -- atomic claim: the expiry reminder is raised once
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (patient_pin is not null or contact_id is not null),
  check (valid_from is null or expires_on is null or expires_on >= valid_from),
  -- an approval is worthless without the payer's reference and an expiry date: fail closed
  check (status not in ('approved', 'partially_approved') or (auth_number is not null and expires_on is not null))
);
create unique index fin_pre_authorisations_auth_uidx on public.fin_pre_authorisations (org_id, payer_id, auth_number)
  where auth_number is not null;
create index fin_pre_authorisations_status_idx on public.fin_pre_authorisations (org_id, status, expires_on);
create index fin_pre_authorisations_pin_idx on public.fin_pre_authorisations (org_id, patient_pin) where patient_pin is not null;
create index fin_pre_authorisations_appt_idx on public.fin_pre_authorisations (appointment_id) where appointment_id is not null;
create index fin_pre_authorisations_claim_idx on public.fin_pre_authorisations (claim_activity_id) where claim_activity_id is not null;
create index fin_pre_authorisations_expiry_idx on public.fin_pre_authorisations (org_id, expires_on)
  where status in ('approved', 'partially_approved') and expiry_notified_at is null;

create trigger fin_pre_authorisations_set_updated_at before update on public.fin_pre_authorisations
  for each row execute function app.set_updated_at();
create trigger fin_pre_auth_contact_org_check before insert or update of contact_id, org_id on public.fin_pre_authorisations
  for each row execute function app.check_parent_org('contacts', 'contact_id');
create trigger fin_pre_auth_appointment_org_check before insert or update of appointment_id, org_id on public.fin_pre_authorisations
  for each row execute function app.check_parent_org('appointments', 'appointment_id');
create trigger fin_pre_auth_claim_org_check before insert or update of claim_activity_id, org_id on public.fin_pre_authorisations
  for each row execute function app.check_parent_org('ins_claim_activities', 'claim_activity_id');
create trigger fin_pre_auth_task_org_check before insert or update of expiry_task_id, org_id on public.fin_pre_authorisations
  for each row execute function app.check_parent_org('tasks', 'expiry_task_id');

-- ---------------------------------------------------------------------------
-- fin_eligibility_checks
-- ---------------------------------------------------------------------------
create table public.fin_eligibility_checks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  patient_pin text check (patient_pin is null or char_length(patient_pin) between 1 and 60),
  contact_id uuid references public.contacts (id) on delete set null,
  appointment_id uuid references public.appointments (id) on delete set null,
  payer_id text not null check (char_length(payer_id) between 1 and 60),
  document_id uuid references public.patient_documents (id) on delete set null,     -- the card: by id only
  status text not null default 'pending' check (status in ('pending', 'verified', 'failed', 'expired')),
  method text not null default 'portal' check (method in ('portal', 'phone', 'card_only', 'other')),
  valid_from date,
  valid_to date,
  checked_on date,
  checked_by uuid references public.profiles (id) on delete set null,
  result_note text check (result_note is null or char_length(result_note) <= 200),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (patient_pin is not null or contact_id is not null),
  check (valid_from is null or valid_to is null or valid_to >= valid_from),
  -- a verified check needs the date it stops covering the patient and the date it was checked
  check (status <> 'verified' or (valid_to is not null and checked_on is not null))
);
create index fin_eligibility_checks_pin_idx on public.fin_eligibility_checks (org_id, patient_pin, checked_on desc) where patient_pin is not null;
create index fin_eligibility_checks_contact_idx on public.fin_eligibility_checks (org_id, contact_id) where contact_id is not null;
create index fin_eligibility_checks_status_idx on public.fin_eligibility_checks (org_id, status, valid_to);
create index fin_eligibility_checks_appt_idx on public.fin_eligibility_checks (appointment_id) where appointment_id is not null;

create trigger fin_eligibility_checks_set_updated_at before update on public.fin_eligibility_checks
  for each row execute function app.set_updated_at();
create trigger fin_elig_contact_org_check before insert or update of contact_id, org_id on public.fin_eligibility_checks
  for each row execute function app.check_parent_org('contacts', 'contact_id');
create trigger fin_elig_appointment_org_check before insert or update of appointment_id, org_id on public.fin_eligibility_checks
  for each row execute function app.check_parent_org('appointments', 'appointment_id');
create trigger fin_elig_document_org_check before insert or update of document_id, org_id on public.fin_eligibility_checks
  for each row execute function app.check_parent_org('patient_documents', 'document_id');

-- ---------------------------------------------------------------------------
-- RLS: select-only for the browser (writes are server actions using the service role after can())
-- ---------------------------------------------------------------------------
alter table public.fin_pre_authorisations enable row level security;
alter table public.fin_eligibility_checks enable row level security;

create policy fin_pre_authorisations_select on public.fin_pre_authorisations for select to authenticated
  using (app.has_perm(org_id, 'finance.preauth.manage'));
create policy fin_eligibility_checks_select on public.fin_eligibility_checks for select to authenticated
  using (app.has_perm(org_id, 'finance.eligibility.manage'));

-- ---------------------------------------------------------------------------
-- Link approved pre-authorisations to the claims that quote their number (idempotent; never overwrites a manual link)
-- ---------------------------------------------------------------------------
create or replace function public.fin_link_preauth_claims(p_org_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  with pick as (
    select distinct on (p.id) p.id as preauth_id, c.id as claim_id
    from public.fin_pre_authorisations p
    join public.ins_claim_activities c
      on c.org_id = p.org_id and c.prior_auth_id = p.auth_number and (c.payer_id is null or c.payer_id = p.payer_id)
    where p.org_id = p_org_id and p.auth_number is not null and p.claim_activity_id is null
      and p.status in ('approved', 'partially_approved', 'used')
    order by p.id, c.transaction_date nulls last, c.id
  )
  update public.fin_pre_authorisations p
     set claim_activity_id = pick.claim_id
    from pick
   where p.id = pick.preauth_id and p.claim_activity_id is null;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.fin_link_preauth_claims(uuid) from public, anon, authenticated;
grant execute on function public.fin_link_preauth_claims(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- v_fin_billing_readiness: insurance invoices that have not been claimed yet and are not ready to bill.
-- One definition of the rules in SQL (mirrored by lib/finance/bill-readiness.ts, which the tests keep in step).
--   no_patient_pin       the invoice carries no PIN, so cover cannot be checked
--   no_eligibility       no eligibility check at all for the patient
--   eligibility_pending  the latest check has not been completed
--   eligibility_failed   the latest check failed
--   eligibility_expired  the latest verified check stopped covering the patient before the service date
--   no_card_on_file      the covering check has no insurance-card document
--   preauth_missing      a line needs a pre-authorisation and none covers the service date
-- Nothing is flagged until fin_ref_finance_settings.ready_start_date is set, nor inside ready_grace_days.
-- ---------------------------------------------------------------------------
create or replace view public.v_fin_billing_readiness with (security_invoker = false) as
with base as (
  select i.org_id, i.id as invoice_id, i.inv_display_number, i.transaction_date, i.branch_code, i.patient_pin,
         i.net, i.total, i.doctor_dha_id
  from public.fin_invoices i
  join public.fin_ref_finance_settings s on s.org_id = i.org_id
  where not i.is_deleted
    and public.fin_is_insurance_type(i.inv_type)
    and i.transaction_date is not null
    and s.ready_start_date is not null
    and i.transaction_date >= s.ready_start_date
    and i.transaction_date <= current_date - s.ready_grace_days
    and app.has_perm(i.org_id, 'finance.eligibility.manage')
    -- not yet claimed: no Diligence claim activity matched to this invoice or quoting its number
    and not exists (select 1 from public.ins_claim_activities c where c.org_id = i.org_id and c.matched_invoice_id = i.id)
    and not exists (
      select 1 from public.ins_claim_activities c
      where c.org_id = i.org_id and upper(regexp_replace(coalesce(c.invoice_no, ''), '\s+', '', 'g')) = i.inv_key
    )
), facts as (
  select b.*,
    exists (
      select 1 from public.fin_eligibility_checks e
      where e.org_id = b.org_id and e.patient_pin = b.patient_pin and e.status = 'verified'
        and (e.valid_from is null or e.valid_from <= b.transaction_date) and e.valid_to >= b.transaction_date
    ) as covered,
    (select e.document_id is null from public.fin_eligibility_checks e
      where e.org_id = b.org_id and e.patient_pin = b.patient_pin and e.status = 'verified'
        and (e.valid_from is null or e.valid_from <= b.transaction_date) and e.valid_to >= b.transaction_date
      order by e.checked_on desc, e.created_at desc limit 1) as card_missing,
    (select e.status from public.fin_eligibility_checks e
      where e.org_id = b.org_id and e.patient_pin = b.patient_pin
      order by e.checked_on desc nulls last, e.created_at desc limit 1) as latest_status,
    exists (
      select 1 from public.fin_invoice_lines l
      join public.fin_ref_services sv on sv.org_id = l.org_id and sv.item_code = l.item_code and sv.requires_preauth
      where l.invoice_id = b.invoice_id and l.is_current
    ) as needs_preauth,
    exists (
      select 1 from public.fin_pre_authorisations p
      where p.org_id = b.org_id and p.patient_pin = b.patient_pin and p.status in ('approved', 'partially_approved', 'used')
        and (p.valid_from is null or p.valid_from <= b.transaction_date) and p.expires_on >= b.transaction_date
    ) as has_preauth
  from base b
), judged as (
  select f.*,
    array_remove(array[
      case when f.patient_pin is null then 'no_patient_pin' end,
      case when f.patient_pin is not null and not f.covered then
        case coalesce(f.latest_status, 'none')
          when 'none' then 'no_eligibility'
          when 'pending' then 'eligibility_pending'
          when 'failed' then 'eligibility_failed'
          else 'eligibility_expired'
        end
      end,
      case when f.covered and coalesce(f.card_missing, false) then 'no_card_on_file' end,
      case when f.needs_preauth and not f.has_preauth then 'preauth_missing' end
    ], null) as reasons
  from facts f
)
select org_id, invoice_id, inv_display_number, transaction_date, branch_code, patient_pin, net, total, doctor_dha_id, reasons
from judged
where cardinality(reasons) > 0;

-- A view's caller needs EXECUTE on every function the view calls. fin_is_insurance_type() is the one pure, side-effect-free
-- definition of "insurance invoice" (F5 revoked it from signed-in users only because nothing needed it then).
grant execute on function public.fin_is_insurance_type(text) to authenticated;

revoke all on public.v_fin_billing_readiness from anon;
grant select on public.v_fin_billing_readiness to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- History tab: who changed what. Replaces app.can_view_record_history with the Phase 18 tables added.
-- ---------------------------------------------------------------------------
create or replace function app.can_view_record_history(p_org_id uuid, p_table text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_table
    when 'appointments' then app.has_perm(p_org_id, 'appointments.view')
    when 'enquiries' then app.has_perm(p_org_id, 'enquiries.view')
    when 'tasks' then app.has_perm(p_org_id, 'tasks.view')
    when 'wa_templates' then app.has_perm(p_org_id, 'templates.manage')
    when 'flows' then app.has_perm(p_org_id, 'flows.manage')
    when 'fin_pre_authorisations' then app.has_perm(p_org_id, 'finance.preauth.manage')
    when 'fin_eligibility_checks' then app.has_perm(p_org_id, 'finance.eligibility.manage')
    when 'ins_denial_cases' then app.has_perm(p_org_id, 'finance.denials.manage')
    when 'fin_period_closes' then app.has_perm(p_org_id, 'finance.close.view')
    else exists (
      select 1 from public.portal_objects po
      where po.org_id = p_org_id and po.table_name = p_table and app.has_perm_wild(p_org_id, po.read_perm)
    )
  end;
$$;
grant execute on function app.can_view_record_history(uuid, text) to authenticated, service_role;

select app.enable_record_history('fin_pre_authorisations', 'expiry_notified_at');
select app.enable_record_history('fin_eligibility_checks');
