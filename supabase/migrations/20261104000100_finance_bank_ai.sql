-- Phase 20H: the AI reviewer for bank reconciliation (docs/20_FINANCE_CONTROL_PLAN.md slice 20H, docs/20_PHASE_20H_NOTES.md).
--
--   * finance.bank.ai (Finance, Finance Manager): ask the AI to review an open reconciliation and accept or reject its
--     suggestions. Always together with finance.bank.manage; the AI master switch, limits and key still apply.
--   * ai_usage accepts the feature 'bank_review' (tokens and outcome only, as every AI feature)
--   * fin_bank_ai_reviews: one row per review of a run: status ok (the checks passed) or rejected (with the checker's
--     reasons), the model, the AI's draft summary, counts. Never the prompt or the raw reply.
--   * fin_bank_ai_suggestions: per open item at most one suggestion: a bank line from that item's deterministic shortlist
--     (or none), a reason code and a confidence from closed lists, and the person's decision (pending -> accepted or
--     rejected, once). Accepting a pair is done by the same server code as accepting a 20C proposal, so every 20C rule,
--     audit and lock applies; this table only records the decision.
--
-- Staff read through RLS with the bank permissions (select only); every write is a server action using the service role
-- after can(), audited. New reviews and decisions are refused unless the run is open and its month is not locked (the
-- 20C decision guard).

-- ---------------------------------------------------------------------------
-- 1. Permissions for existing system roles (new orgs get them from lib/auth/permissions.ts)
-- ---------------------------------------------------------------------------
do $$
declare
  g record;
begin
  for g in
    select * from (values
      ('Finance', 'finance.bank.ai'),
      ('Finance Manager', 'finance.bank.ai')
    ) as t (role_name, perm)
  loop
    update public.roles r
       set permissions = r.permissions || to_jsonb(g.perm)
     where r.is_system and r.name = g.role_name and not (r.permissions ? g.perm);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. ai_usage: the new feature (the constraint is rebuilt from whatever it already allows)
-- ---------------------------------------------------------------------------
do $$
declare
  c record;
  v_list text[];
begin
  for c in
    select con.conname, pg_get_constraintdef(con.oid) as def
    from pg_constraint con
    where con.conrelid = 'public.ai_usage'::regclass and con.contype = 'c' and pg_get_constraintdef(con.oid) like '%feature%'
  loop
    select array_agg(distinct m[1]) into v_list from regexp_matches(c.def, '''([a-z_]+)''', 'g') as m;
    execute format('alter table public.ai_usage drop constraint %I', c.conname);
  end loop;
  v_list := coalesce(v_list, array['summarize', 'ask', 'suggest_reply', 'rewrite', 'appeal_draft',
                                   'flow_copilot', 'campaign_audience', 'campaign_copy', 'intent']);
  if not ('bank_review' = any (v_list)) then
    v_list := array_append(v_list, 'bank_review');
  end if;
  execute format('alter table public.ai_usage add constraint ai_usage_feature_check check (feature in (%s))',
    (select string_agg(quote_literal(x), ', ' order by x) from unnest(v_list) as x));
end $$;

-- ---------------------------------------------------------------------------
-- 3. Reviews and suggestions
-- ---------------------------------------------------------------------------
create table public.fin_bank_ai_reviews (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  rec_id uuid not null references public.fin_bank_recs (id) on delete cascade,
  status text not null check (status in ('ok', 'rejected')),
  model text not null check (char_length(model) between 1 and 100),
  summary text check (summary is null or char_length(summary) <= 800),      -- the AI's draft narrative (ids, amounts, dates)
  reject_reason text check (reject_reason is null or char_length(reject_reason) <= 1000),  -- the checker's own words
  item_count integer not null default 0 check (item_count >= 0),
  suggestion_count integer not null default 0 check (suggestion_count >= 0),
  repaired boolean not null default false,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  check ((status = 'ok') = (summary is not null)),
  check (status = 'ok' or (reject_reason is not null and suggestion_count = 0))
);
create index fin_bank_ai_reviews_rec_idx on public.fin_bank_ai_reviews (rec_id, created_at desc);
create trigger fin_bank_ai_reviews_rec_org_check before insert or update of rec_id, org_id on public.fin_bank_ai_reviews
  for each row execute function app.check_parent_org('fin_bank_recs', 'rec_id');

create table public.fin_bank_ai_suggestions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  rec_id uuid not null references public.fin_bank_recs (id) on delete cascade,
  review_id uuid not null references public.fin_bank_ai_reviews (id) on delete cascade,
  item_key text not null check (char_length(item_key) between 1 and 160),   -- an expected item key or bank|<line id>
  candidate_line_id uuid references public.fin_bank_lines (id) on delete cascade,
  reason_code text not null check (reason_code in (
    'amount_and_date', 'fee_deducted', 'split_settlement', 'timing_weekend', 'reference_match',
    'no_match_likely_missing', 'needs_person')),
  confidence text not null check (confidence in ('low', 'medium', 'high')),
  decision text not null default 'pending' check (decision in ('pending', 'accepted', 'rejected')),
  decided_by uuid references public.profiles (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (review_id, item_key),
  check ((decision = 'pending') = (decided_at is null)),
  check (candidate_line_id is not null or reason_code not in ('amount_and_date', 'reference_match')),
  check (candidate_line_id is null or reason_code <> 'no_match_likely_missing')
);
create index fin_bank_ai_suggestions_rec_idx on public.fin_bank_ai_suggestions (rec_id);
create index fin_bank_ai_suggestions_review_idx on public.fin_bank_ai_suggestions (review_id);
create trigger fin_bank_ai_suggestions_rec_org_check before insert or update of rec_id, org_id on public.fin_bank_ai_suggestions
  for each row execute function app.check_parent_org('fin_bank_recs', 'rec_id');
create trigger fin_bank_ai_suggestions_review_org_check before insert or update of review_id, org_id on public.fin_bank_ai_suggestions
  for each row execute function app.check_parent_org('fin_bank_ai_reviews', 'review_id');
create trigger fin_bank_ai_suggestions_line_org_check before insert or update of candidate_line_id, org_id on public.fin_bank_ai_suggestions
  for each row execute function app.check_parent_org('fin_bank_lines', 'candidate_line_id');

-- ---------------------------------------------------------------------------
-- 4. Guards (every role, including the service role)
-- ---------------------------------------------------------------------------
-- A suggestion and its review belong to the same run; what the AI said never changes; the decision moves from pending
-- to accepted or rejected once (the FK action that nulls a deleted user's id is allowed).
create or replace function app.fin_bank_ai_suggestion_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.review_id is null or new.rec_id is null then
      return new;   -- incomplete row (the security probe): RLS and NOT NULL answer
    end if;
    if not exists (select 1 from public.fin_bank_ai_reviews v
                   where v.id = new.review_id and v.rec_id = new.rec_id and v.status = 'ok') then
      raise exception 'a suggestion belongs to an accepted review of the same reconciliation' using errcode = 'check_violation';
    end if;
    if new.decision <> 'pending' then
      raise exception 'a suggestion starts pending' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - 'decision' - 'decided_by' - 'decided_at')
     is distinct from (to_jsonb(old) - 'decision' - 'decided_by' - 'decided_at') then
    raise exception 'an AI suggestion cannot be edited' using errcode = 'check_violation';
  end if;
  if (new.decision, new.decided_at) is distinct from (old.decision, old.decided_at) then
    if old.decision <> 'pending' or new.decision = 'pending' then
      raise exception 'a suggestion is decided once' using errcode = 'check_violation';
    end if;
  elsif new.decided_by is distinct from old.decided_by and new.decided_by is not null then
    raise exception 'a suggestion is decided once' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function app.fin_bank_ai_suggestion_guard() from public, anon, authenticated;
create trigger fin_bank_ai_suggestions_guard before insert or update on public.fin_bank_ai_suggestions
  for each row execute function app.fin_bank_ai_suggestion_guard();

-- Reviews and decisions only while the run is open and its month is not locked (the 20C guard, unchanged).
create trigger fin_bank_ai_reviews_open_guard before insert on public.fin_bank_ai_reviews
  for each row execute function app.fin_bank_decision_guard();
create trigger fin_bank_ai_suggestions_open_guard before insert or update of decision on public.fin_bank_ai_suggestions
  for each row execute function app.fin_bank_decision_guard();

-- ---------------------------------------------------------------------------
-- 5. RLS: staff with a bank permission read their org's rows; nobody writes directly (server actions, service role)
-- ---------------------------------------------------------------------------
alter table public.fin_bank_ai_reviews enable row level security;
alter table public.fin_bank_ai_suggestions enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['fin_bank_ai_reviews', 'fin_bank_ai_suggestions']
  loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (app.has_perm(org_id, %L) or app.has_perm(org_id, %L) or app.has_perm(org_id, %L))',
      t || '_select', t, 'finance.bank.view', 'finance.bank.manage', 'finance.bank.signoff');
  end loop;
end $$;
