-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Needs every earlier file first, up to and including 96_finance_appointment_billing.sql.

-- W4 (clinic plan of 16 Oct 2026): parallel-run comparison. For each area (revenue, collections, bank, insurance
-- receivable, labs) the manual figure Finance produces today is typed in for a month and set beside Pulse's figure; the
-- decision to rely on Pulse is recorded per area. Nothing here posts to the books or reads patient data.
--
--   * finance.parallel_run.manage (Finance Manager; Admin through '*'): enter or correct manual figures, set the
--     tolerance and record the decision. Not in the Finance preset, and never held by Revenue & Collections or Costs &
--     Expenses (reporting separation).
--   * fin_parallel_figures: one manual amount per org, area and calendar month (amount, a short note, who and when).
--   * fin_parallel_decisions: one row per org and area, only once a decision was recorded ('running' again after a
--     reversal, or 'switched'). No row = not started. Who and when are kept.
--   * fin_ref_finance_settings.parallel_tolerance: "agrees" means the difference is within this many dirhams (data).
--
-- Both tables are read through RLS by holders of the area's own report key; every write is a server
-- action (service role after can(), audited).

-- 1. Permission for the existing Finance Manager role (new orgs get it from lib/auth/permissions.ts) ------------------
update public.roles r
   set permissions = r.permissions || to_jsonb('finance.parallel_run.manage'::text)
 where r.is_system and r.name = 'Finance Manager' and not (r.permissions ? 'finance.parallel_run.manage');

-- 2. Tolerance ----------------------------------------------------------------------------------------------------------
alter table public.fin_ref_finance_settings
  add column parallel_tolerance numeric(12, 3) not null default 1.000
    check (parallel_tolerance >= 0 and parallel_tolerance <= 10000);

-- 3. Manual figures -----------------------------------------------------------------------------------------------------
create table public.fin_parallel_figures (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  area text not null check (area in ('revenue', 'collections', 'bank', 'insurance', 'labs')),
  month date not null check (month = date_trunc('month', month)::date),
  manual_amount numeric(14, 3) not null check (abs(manual_amount) < 1e10),
  -- why the two differ, in words; never a patient's name
  note text check (note is null or char_length(note) <= 500),
  entered_by uuid references public.profiles (id) on delete set null,
  entered_at timestamptz not null default now(),
  unique (org_id, area, month)
);

-- 4. Decisions ----------------------------------------------------------------------------------------------------------
create table public.fin_parallel_decisions (
  org_id uuid not null references public.orgs (id) on delete cascade,
  area text not null check (area in ('revenue', 'collections', 'bank', 'insurance', 'labs')),
  status text not null check (status in ('running', 'switched')),
  note text check (note is null or char_length(note) <= 500),
  decided_by uuid references public.profiles (id) on delete set null,
  decided_at timestamptz not null default now(),
  primary key (org_id, area)
);

-- 5. RLS: select only; the area's own report key -----------------------------------------------------
alter table public.fin_parallel_figures enable row level security;
alter table public.fin_parallel_decisions enable row level security;

create policy fin_parallel_figures_select on public.fin_parallel_figures for select to authenticated
  using (app.has_perm(org_id, case area
         when 'revenue' then 'finance.revenue.view'
         when 'collections' then 'finance.revenue.view'
         when 'bank' then 'finance.bank.view'
         when 'insurance' then 'finance.claims.view'
         else 'finance.labs.view' end));

create policy fin_parallel_decisions_select on public.fin_parallel_decisions for select to authenticated
  using (app.has_perm(org_id, case area
         when 'revenue' then 'finance.revenue.view'
         when 'collections' then 'finance.revenue.view'
         when 'bank' then 'finance.bank.view'
         when 'insurance' then 'finance.claims.view'
         else 'finance.labs.view' end));
