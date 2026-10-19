-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Needs every earlier file first, up to and including 101 (the files after 98_tally_company_per_entity.sql).

-- W3 follow-ups 1 and 2 (docs/47_W3_W5_INSURANCE_NOTES.md, docs/48_FOLLOWUPS_DEPOSITS_NOTES.md).
--
--   1. One bank deposit = several insurer payment references. The monthly bank run (20C) offers one insurance item per
--      payment REFERENCE (a remittance file holding several references is split, from its committed lines), and for a
--      credit no single item fits, lib/finance/deposit-groups.ts proposes a GROUP of payments (matchDeposit). A group is
--      only ever a proposal; a person accepts it through the existing decision path, which stores ONE fin_bank_matches
--      row whose expected key names the members (`insg|<key>+<key>...`), so the key column is widened.
--      The search bounds are data: fin_ref_finance_settings.bank_deposit_max_parts / bank_deposit_max_pool.
--   2. paid_before: ins_claims_for_remittance returns, per claim, what earlier COMMITTED advice already paid on it
--      (take-backs netted, never below 0), leaving out the file being previewed or committed. A completing payment is
--      then not "short" and a second full payment is "overpaid".
--
-- No new table, no new permission. Sums and counts only; no names, no member or patient fields.

-- ---------------------------------------------------------------------------
-- 1a. Settings: how many payments one deposit may be a total of, and how many are searched at most
-- ---------------------------------------------------------------------------
alter table public.fin_ref_finance_settings
  add column bank_deposit_max_parts integer not null default 5 check (bank_deposit_max_parts between 1 and 10),
  add column bank_deposit_max_pool integer not null default 40 check (bank_deposit_max_pool between 2 and 60);

-- ---------------------------------------------------------------------------
-- 1b. A group's expected key lists its members (at most 10 keys of about 50 characters)
-- ---------------------------------------------------------------------------
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.fin_bank_matches'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%expected_key%' and pg_get_constraintdef(oid) like '%char_length%'
  loop
    execute format('alter table public.fin_bank_matches drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.fin_bank_matches
  add constraint fin_bank_matches_expected_key_check check (char_length(expected_key) between 1 and 1000);

-- ---------------------------------------------------------------------------
-- 1c. Committed advice lines summed per batch, payment reference and payer (the bank loader splits files by these)
-- ---------------------------------------------------------------------------
create or replace function public.fin_bank_insurance_payments(p_org_id uuid, p_since timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'batch_id', g.batch_id, 'ref', g.ref, 'payer_id', g.payer_id, 'paid_on', g.paid_on,
           'amount', g.amount, 'lines', g.lines)
         order by g.batch_id, g.ref_key, g.payer_key), '[]'::jsonb)
  from (
    select l.batch_id,
           upper(btrim(coalesce(l.remittance_ref, ''))) as ref_key,
           upper(btrim(coalesce(nullif(btrim(l.payer_id), ''), b.payer_id, ''))) as payer_key,
           min(nullif(btrim(l.remittance_ref), '')) as ref,
           min(coalesce(nullif(btrim(l.payer_id), ''), b.payer_id)) as payer_id,
           max(l.paid_on) as paid_on,
           sum(l.paid_amount) as amount,
           count(*) as lines
    from public.ins_remittance_lines l
    join public.ins_remittance_batches b on b.id = l.batch_id and b.org_id = l.org_id
    where l.org_id = p_org_id and b.created_at >= p_since
    group by l.batch_id,
             upper(btrim(coalesce(l.remittance_ref, ''))),
             upper(btrim(coalesce(nullif(btrim(l.payer_id), ''), b.payer_id, '')))
  ) g;
$$;
revoke all on function public.fin_bank_insurance_payments(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.fin_bank_insurance_payments(uuid, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- 2. ins_claims_for_remittance with paid_before. Starts from its last definition (20261016000400, also in
--    deploy/supabase-paste/18_phase_18_finance_upgrades.sql) and keeps every field and both lookups. The 3-argument
--    version is dropped so a call with three named arguments is not ambiguous; the new argument defaults to null.
-- ---------------------------------------------------------------------------
drop function if exists public.ins_claims_for_remittance(uuid, text[], text[]);

create or replace function public.ins_claims_for_remittance(
  p_org_id uuid, p_numbers text[], p_invoice_keys text[], p_exclude_file_id uuid default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'claim_activity_number', c.claim_activity_number, 'invoice_no', c.invoice_no, 'cpt_code', c.cpt_code,
    'payer_id', c.payer_id, 'quantity', c.quantity, 'net', c.net, 'transaction_date', c.transaction_date,
    'activity_start_date', c.activity_start_date, 'paid_before', pb.paid)), '[]'::jsonb)
  from public.ins_claim_activities c
  cross join lateral (
    select case when count(l.id) = 0 then null else greatest(sum(l.paid_amount), 0) end as paid
    from public.ins_remittance_lines l
    join public.ins_remittance_batches b on b.id = l.batch_id and b.org_id = l.org_id
    where l.org_id = c.org_id and l.claim_activity_id = c.id
      and (p_exclude_file_id is null or b.file_id is distinct from p_exclude_file_id)
  ) pb
  where c.org_id = p_org_id
    and (upper(btrim(c.claim_activity_number)) = any (select upper(btrim(x)) from unnest(coalesce(p_numbers, '{}')) as x)
         or upper(regexp_replace(coalesce(c.invoice_no, ''), '\s+', '', 'g')) = any (coalesce(p_invoice_keys, '{}')));
$$;
revoke all on function public.ins_claims_for_remittance(uuid, text[], text[], uuid) from public, anon, authenticated;
grant execute on function public.ins_claims_for_remittance(uuid, text[], text[], uuid) to service_role;
