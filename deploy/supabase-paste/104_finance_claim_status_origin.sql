-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Needs every earlier file first, up to and including 98_tally_company_per_entity.sql (and any 99-103 present).

-- Follow-ups 3 and 4 of docs/47_W3_W5_INSURANCE_NOTES.md (notes: docs/48_FOLLOWUPS_CLAIM_STATUS_NOTES.md).
--
-- 1. fin_ref_finance_settings.diligence_remitted_nets_takebacks: does the Diligence "Remitted" figure already deduct
--    payments the insurer took back? null = not confirmed yet (Hardik). While null the claims page uses the proposed
--    treatment (Remitted is gross: Pulse deducts the negative advice lines itself) and says so. Written only by the
--    workflow settings server action with the service role after can() (it is NOT in app.fin_settings_user_columns(),
--    so a browser write cannot change it).
--
-- 2. fin_ref_denial_codes.origin / avoidable: where a rejection came from and whether the clinic could have prevented
--    it, per code (data, edited in Finance workflow settings). null = not classified: shown as "Not classified", never
--    as "not avoidable". Existing rows are seeded once from the PROPOSED table by category (docs/47 W3f, to be confirmed
--    in the insurance case sessions); a code family's row covers its codes through the usual lookup (exact, then family).
--    The starter placeholder rows a new organisation gets from seed_finance_reference() take the same proposal through
--    a BEFORE INSERT trigger (so the seed function is not redefined here); any other new code stays not classified
--    until Finance picks a value.

alter table public.fin_ref_finance_settings
  add column if not exists diligence_remitted_nets_takebacks boolean;
comment on column public.fin_ref_finance_settings.diligence_remitted_nets_takebacks is
  'Does Diligence Remitted already deduct payments taken back? null = unconfirmed (Pulse deducts negative advice lines itself).';

alter table public.fin_ref_denial_codes
  add column if not exists origin text
    check (origin is null or origin in ('front_desk', 'clinical', 'billing', 'payer')),
  add column if not exists avoidable boolean;
comment on column public.fin_ref_denial_codes.origin is
  'Where the rejection came from: front_desk, clinical, billing or payer. null = not classified.';
comment on column public.fin_ref_denial_codes.avoidable is
  'Could the clinic have prevented it? null = not classified (never read as not avoidable).';

-- The proposed mapping by category (docs/47 W3f). pricing: the payer's side, avoidable not known; other: not classified.
create or replace function app.fin_denial_origin_proposal(p_category text, out origin text, out avoidable boolean)
language sql
immutable
set search_path = ''
as $$
  select case p_category
           when 'authorization' then 'front_desk'
           when 'eligibility' then 'front_desk'
           when 'medical_necessity' then 'clinical'
           when 'coding' then 'billing'
           when 'documentation' then 'clinical'
           when 'duplicate' then 'billing'
           when 'timely_filing' then 'billing'
           when 'pricing' then 'payer'
           else null
         end,
         case p_category
           when 'authorization' then true
           when 'eligibility' then true
           when 'medical_necessity' then false
           when 'coding' then true
           when 'documentation' then true
           when 'duplicate' then true
           when 'timely_filing' then true
           else null
         end;
$$;
revoke all on function app.fin_denial_origin_proposal(text) from public, anon;
grant execute on function app.fin_denial_origin_proposal(text) to authenticated, service_role;

-- One-off seed of every existing row that is still unclassified.
update public.fin_ref_denial_codes t
   set (origin, avoidable) = (select p.origin, p.avoidable from app.fin_denial_origin_proposal(t.category) p)
 where t.origin is null and t.avoidable is null and t.category <> 'other';

-- New organisations: the starter placeholder rows take the proposal. Rows Finance adds keep what Finance chose.
create or replace function app.fin_ref_denial_codes_origin_seed()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  p record;
begin
  if new.is_placeholder and new.origin is null and new.avoidable is null then
    select * into p from app.fin_denial_origin_proposal(new.category);
    new.origin := p.origin;
    new.avoidable := p.avoidable;
  end if;
  return new;
end;
$$;
revoke all on function app.fin_ref_denial_codes_origin_seed() from public, anon, authenticated;

drop trigger if exists fin_ref_denial_codes_origin_seed on public.fin_ref_denial_codes;
create trigger fin_ref_denial_codes_origin_seed before insert on public.fin_ref_denial_codes
  for each row execute function app.fin_ref_denial_codes_origin_seed();
