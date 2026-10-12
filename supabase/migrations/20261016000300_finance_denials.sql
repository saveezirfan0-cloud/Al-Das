-- Phase 18 (3/7): denial management.
--
--   ins_denial_cases    one case per denied claim activity: reason code (taxonomy in fin_ref_denial_codes), owner,
--                       resubmission deadline, status
--   ins_denial_notes    working notes on a case (append-only in practice; no update or delete policy)
--   ins_appeal_drafts   appeal letters: always a DRAFT, never sent from Pulse. Built from claim ids, reason codes and
--                       amounts only (no names), either by the AI (kind 'ai') or from a fixed template (kind 'template')
--   fin_sync_denial_cases()  opens / refreshes / closes cases from the Diligence claims; idempotent
--
-- The case row copies the identifiers a screen needs (claim number, invoice number, CPT, clinician id, payer id, net)
-- so the queue does not depend on the claims permission. Nothing here holds a patient name.


create table public.ins_denial_cases (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  claim_activity_id uuid not null references public.ins_claim_activities (id) on delete cascade,
  claim_number text not null,
  invoice_no text,
  cpt_code text,
  clinician_id text,
  payer_id text,
  claim_net numeric(14, 2),
  rejected_amount numeric(14, 2) not null default 0,
  reason_code text,
  category text not null default 'other'
    check (category in ('authorization', 'eligibility', 'medical_necessity', 'coding', 'documentation', 'duplicate', 'timely_filing', 'pricing', 'other')),
  appealable boolean not null default true,
  owner_role text not null default 'insurance' check (owner_role in ('insurance', 'billing', 'finance', 'admin')),
  owner_user_id uuid references public.profiles (id) on delete set null,
  status text not null default 'open'
    check (status in ('open', 'in_progress', 'appealed', 'resubmitted', 'won', 'lost', 'written_off', 'recovered', 'cancelled')),
  denied_on date not null,
  deadline_on date not null,
  deadline_notified_at timestamptz,                  -- atomic claim: the "deadline approaching" reminder is raised once
  task_id uuid references public.tasks (id) on delete set null,
  resolution text check (resolution is null or char_length(resolution) <= 200),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles (id) on delete set null,
  opened_by uuid references public.profiles (id) on delete set null,   -- null = opened by the nightly sync
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, claim_activity_id, denied_on),
  check (status in ('open', 'in_progress', 'appealed', 'resubmitted') or resolved_at is not null),
  check (deadline_on >= denied_on)
);
-- at most one live case per claim activity
create unique index ins_denial_cases_active_uidx on public.ins_denial_cases (org_id, claim_activity_id)
  where status in ('open', 'in_progress', 'appealed', 'resubmitted');
create index ins_denial_cases_queue_idx on public.ins_denial_cases (org_id, status, deadline_on);
create index ins_denial_cases_owner_idx on public.ins_denial_cases (org_id, owner_user_id)
  where status in ('open', 'in_progress', 'appealed', 'resubmitted');
create index ins_denial_cases_payer_idx on public.ins_denial_cases (org_id, payer_id, reason_code);

create table public.ins_denial_notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  case_id uuid not null references public.ins_denial_cases (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete set null,
  note text not null check (btrim(note) <> '' and char_length(note) <= 2000),
  created_at timestamptz not null default now()
);
create index ins_denial_notes_case_idx on public.ins_denial_notes (case_id, created_at);

create table public.ins_appeal_drafts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  case_id uuid not null references public.ins_denial_cases (id) on delete cascade,
  kind text not null check (kind in ('ai', 'template')),
  language text not null default 'en' check (language in ('en', 'ar')),
  body text not null check (btrim(body) <> '' and char_length(body) <= 12000),
  model text,                                        -- the model that wrote an 'ai' draft
  flags text[] not null default '{}',                -- why a human must read it carefully
  status text not null default 'draft' check (status in ('draft', 'discarded', 'marked_sent')),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  marked_sent_by uuid references public.profiles (id) on delete set null,
  marked_sent_at timestamptz,
  check (status <> 'marked_sent' or marked_sent_at is not null)
);
create index ins_appeal_drafts_case_idx on public.ins_appeal_drafts (case_id, created_at desc);

create trigger ins_denial_cases_set_updated_at before update on public.ins_denial_cases
  for each row execute function app.set_updated_at();
create trigger ins_denial_cases_claim_org_check before insert or update of claim_activity_id, org_id on public.ins_denial_cases
  for each row execute function app.check_parent_org('ins_claim_activities', 'claim_activity_id');
create trigger ins_denial_cases_task_org_check before insert or update of task_id, org_id on public.ins_denial_cases
  for each row execute function app.check_parent_org('tasks', 'task_id');
create trigger ins_denial_notes_case_org_check before insert or update of case_id, org_id on public.ins_denial_notes
  for each row execute function app.check_parent_org('ins_denial_cases', 'case_id');
create trigger ins_appeal_drafts_case_org_check before insert or update of case_id, org_id on public.ins_appeal_drafts
  for each row execute function app.check_parent_org('ins_denial_cases', 'case_id');

alter table public.ins_denial_cases enable row level security;
alter table public.ins_denial_notes enable row level security;
alter table public.ins_appeal_drafts enable row level security;

create policy ins_denial_cases_select on public.ins_denial_cases for select to authenticated
  using (app.has_perm(org_id, 'finance.denials.manage'));
create policy ins_denial_notes_select on public.ins_denial_notes for select to authenticated
  using (app.has_perm(org_id, 'finance.denials.manage'));
create policy ins_appeal_drafts_select on public.ins_appeal_drafts for select to authenticated
  using (app.has_perm(org_id, 'finance.denials.manage'));

-- ---------------------------------------------------------------------------
-- fin_sync_denial_cases(org): service role only. Idempotent. Reads every threshold from reference tables.
--   1. active cases whose claim no longer shows a rejected amount become 'recovered'
--   2. active cases take the claim's current rejected / net amounts
--   3. claims with a rejected amount and no live case open one (denied_on = last remittance date, else first,
--      else the claim's transaction date); the deadline is denied_on + the code's resubmit_days (exact code, then
--      its family, then the org default). Nothing opens before denial_cases_start_date.
-- ---------------------------------------------------------------------------
create or replace function public.fin_sync_denial_cases(p_org_id uuid, p_limit integer default 1000)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_start date;
  v_default integer;
  v_opened integer := 0;
  v_recovered integer := 0;
  v_refreshed integer := 0;
begin
  select s.denial_cases_start_date, s.denial_default_resubmit_days
    into v_start, v_default
    from public.fin_ref_finance_settings s where s.org_id = p_org_id;
  if v_start is null then
    return jsonb_build_object('skipped', 'not_enabled', 'opened', 0, 'recovered', 0, 'refreshed', 0);
  end if;

  update public.ins_denial_cases d
     set status = 'recovered', resolved_at = now(), resolution = 'The claim no longer shows a rejected amount'
    from public.ins_claim_activities c
   where d.org_id = p_org_id and c.id = d.claim_activity_id
     and d.status in ('open', 'in_progress', 'appealed', 'resubmitted')
     and coalesce(c.rejected, 0) = 0;
  get diagnostics v_recovered = row_count;

  update public.ins_denial_cases d
     set rejected_amount = c.rejected, claim_net = c.net
    from public.ins_claim_activities c
   where d.org_id = p_org_id and c.id = d.claim_activity_id
     and d.status in ('open', 'in_progress', 'appealed', 'resubmitted')
     and (d.rejected_amount is distinct from c.rejected or d.claim_net is distinct from c.net);
  get diagnostics v_refreshed = row_count;

  with cand as (
    select c.id as claim_id, c.claim_activity_number, c.invoice_no, c.cpt_code, c.clinician_id, c.payer_id, c.net, c.rejected,
           c.last_denial_code,
           coalesce(c.last_remittance_date, c.first_remittance_date, c.transaction_date) as denied_on
    from public.ins_claim_activities c
    where c.org_id = p_org_id and coalesce(c.rejected, 0) > 0
      and coalesce(c.last_remittance_date, c.first_remittance_date, c.transaction_date) >= v_start
      and not exists (
        select 1 from public.ins_denial_cases d
        where d.org_id = c.org_id and d.claim_activity_id = c.id
          and (d.status in ('open', 'in_progress', 'appealed', 'resubmitted')
               or d.denied_on = coalesce(c.last_remittance_date, c.first_remittance_date, c.transaction_date))
      )
    order by coalesce(c.last_remittance_date, c.first_remittance_date, c.transaction_date), c.id
    limit greatest(p_limit, 1)
  ), tax as (
    select cand.*, t.category, t.default_owner_role, t.appealable, t.resubmit_days
    from cand
    left join lateral (
      select t.* from public.fin_ref_denial_codes t
      where t.org_id = p_org_id and t.active and cand.last_denial_code is not null
        and ((not t.is_family and upper(t.code) = upper(cand.last_denial_code))
          or (t.is_family and upper(t.code) = upper(substring(cand.last_denial_code from '^[A-Za-z]+'))))
      order by t.is_family
      limit 1
    ) t on true
  )
  insert into public.ins_denial_cases (org_id, claim_activity_id, claim_number, invoice_no, cpt_code, clinician_id, payer_id,
                                       claim_net, rejected_amount, reason_code, category, appealable, owner_role, denied_on, deadline_on)
  select p_org_id, claim_id, claim_activity_number, invoice_no, cpt_code, clinician_id, payer_id,
         net, rejected, last_denial_code, coalesce(category, 'other'), coalesce(appealable, true),
         coalesce(default_owner_role, 'insurance'), denied_on, denied_on + coalesce(resubmit_days, v_default)
  from tax
  on conflict do nothing;
  get diagnostics v_opened = row_count;

  return jsonb_build_object('opened', v_opened, 'recovered', v_recovered, 'refreshed', v_refreshed);
end;
$$;
revoke all on function public.fin_sync_denial_cases(uuid, integer) from public, anon, authenticated;
grant execute on function public.fin_sync_denial_cases(uuid, integer) to service_role;

select app.enable_record_history('ins_denial_cases', 'deadline_notified_at');
