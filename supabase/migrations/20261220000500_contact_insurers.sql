-- Insurer filter for segments (docs/45 P5 follow-up).
--
-- There was no reliable insurer on a contact: the Airtable "Insurance Plan" select holds only Mednet and AXA, so most
-- patients have none. The reliable source is the insurance claim itself: a Diligence claim activity matched to a Unite
-- invoice (fin_invoices.patient_pin = contacts.external_id) carries the payer id. This view lists, per contact, the
-- payers that have a matched claim with them.
--
--   * Service role only. The segment compiler reads it through the contacts_* functions after the app has checked
--     finance.claims.view (the field is hidden from anyone without it) and clinical-style care-only use applies:
--     a claim means the patient received care, so the field never builds a marketing audience.
--   * security_invoker, as every view in this schema: the caller's RLS decides, and only the service role is granted.
--   * Ids only: the payer id, the contact id, no amounts, no names.

create or replace view public.v_contact_insurers with (security_invoker = true) as
select distinct c.org_id, c.id as contact_id, a.payer_id
from public.contacts c
join public.fin_invoices i
  on i.org_id = c.org_id and i.patient_pin = c.external_id and not i.is_deleted
join public.ins_claim_activities a
  on a.org_id = c.org_id and a.matched_invoice_id = i.id and a.match_status = 'matched'
where c.deleted_at is null
  and c.external_id is not null and btrim(c.external_id) <> ''
  and a.payer_id is not null and btrim(a.payer_id) <> '';

revoke all on public.v_contact_insurers from public, anon, authenticated;
grant select on public.v_contact_insurers to service_role;
