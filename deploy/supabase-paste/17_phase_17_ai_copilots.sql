-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- Run the files in numeric order. A failed file rolls back as a whole, so it is safe to retry.
-- Phase 17 (AI copilots for flows and campaigns). Needs the earlier files first, including
-- 13_phase_13_notifications_speed.sql (conversations, flows, ai_usage) and 18_phase_18_finance_upgrades.sql (it extends the same ai_usage constraint).
-- Check the project name in the Supabase header first: this is for the Pulse project only.
-- Adds the flows.ai, campaigns.ai and ai.insights.view permissions (granted to the existing Manager and Marketing roles), a database
-- guard that keeps an AI-drafted flow from becoming active until a person reviews it, the conversation_ai_tagged flow trigger, the tables
-- for message labels (no message text), suggestion outcomes and the weekly reply-quality report, ai_add_conversation_tags(), the
-- ai_insights queue and the schedules pulse:ai_insights (every 30 seconds) and pulse:ai_quality_weekly (Mondays 04:30 UTC).
-- Nothing here calls an AI provider or stores prompts, replies or patient messages. AI stays OFF until an administrator turns it on
-- (Settings, AI & knowledge base); AI labelling of messages and AI tags starting flows have their own switches and are OFF by default
-- (see docs/17_PHASE_17_NOTES.md and OQ-57 / OQ-61).

-- ======================================================================
-- 20261017000100_ai_copilots_foundation.sql
-- ======================================================================
-- Phase 17 (1/3): AI copilots, foundation.
--
--   * new permissions flows.ai, campaigns.ai, ai.insights.view are granted to the existing system roles (idempotent;
--     new orgs get them from lib/auth/permissions.ts)
--   * ai_usage accepts the new copilot features and records whether a suggested reply was grounded in the knowledge base
--     (a flag, never content)
--   * flows: an AI-drafted flow is created with ai_review_required = true and CANNOT become active until a person clears it
--     (a database trigger, so no code path, role or script can publish or resume an unreviewed AI draft by accident)
--   * flows.trigger_type accepts 'conversation_ai_tagged' (an AI tag starting a flow; off unless the clinical lead has signed
--     it, see lib/ai/copilot/settings.ts and OQ-61)
--
-- Nothing here stores prompt, completion, patient message or draft text.

-- ---------------------------------------------------------------------------
-- Permissions for existing system roles
-- ---------------------------------------------------------------------------
do $$
declare
  g record;
begin
  for g in
    select * from (values
      ('Manager', 'flows.ai'), ('Manager', 'campaigns.ai'), ('Manager', 'ai.insights.view'),
      ('Marketing', 'flows.ai'), ('Marketing', 'campaigns.ai')
    ) as t (role_name, perm)
  loop
    update public.roles r
       set permissions = r.permissions || to_jsonb(g.perm)
     where r.is_system and r.name = g.role_name and not (r.permissions ? g.perm);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- ai_usage: new features, grounded flag
-- ---------------------------------------------------------------------------
alter table public.ai_usage add column if not exists grounded boolean;
comment on column public.ai_usage.grounded is
  'suggest_reply only: true when knowledge-base passages were found for the suggestion, false when none were. A flag, never content.';

do $$
declare
  c record;
  v_list text[];
  v_new text;
begin
  for c in
    select con.conname, pg_get_constraintdef(con.oid) as def
    from pg_constraint con
    where con.conrelid = 'public.ai_usage'::regclass and con.contype = 'c' and pg_get_constraintdef(con.oid) like '%feature%'
  loop
    select array_agg(distinct m[1]) into v_list from regexp_matches(c.def, '''([a-z_]+)''', 'g') as m;
    execute format('alter table public.ai_usage drop constraint %I', c.conname);
  end loop;
  v_list := coalesce(v_list, array['summarize', 'ask', 'suggest_reply', 'rewrite', 'appeal_draft']);
  foreach v_new in array array['flow_copilot', 'campaign_audience', 'campaign_copy', 'intent'] loop
    if not (v_new = any (v_list)) then
      v_list := array_append(v_list, v_new);
    end if;
  end loop;
  execute format('alter table public.ai_usage add constraint ai_usage_feature_check check (feature in (%s))',
    (select string_agg(quote_literal(x), ', ' order by x) from unnest(v_list) as x));
end $$;

-- ---------------------------------------------------------------------------
-- flows: AI drafts need a person's review before they can run
-- ---------------------------------------------------------------------------
alter table public.flows
  add column if not exists ai_review_required boolean not null default false,
  add column if not exists ai_drafted_at timestamptz,
  add column if not exists ai_reviewed_by uuid references public.profiles (id) on delete set null,
  add column if not exists ai_reviewed_at timestamptz;
comment on column public.flows.ai_review_required is
  'true on a flow drafted by the Flow Copilot until a person with flows.manage marks it reviewed. While true the flow cannot be active.';

create or replace function app.flows_ai_review_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.ai_review_required and new.status = 'active' then
    raise exception 'An AI-drafted flow must be reviewed by a person before it can be published or resumed'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger flows_ai_review_guard before insert or update on public.flows
  for each row execute function app.flows_ai_review_guard();

do $$
declare
  c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'public.flows'::regclass and con.contype = 'c' and pg_get_constraintdef(con.oid) like '%trigger_type%'
  loop
    execute format('alter table public.flows drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.flows add constraint flows_trigger_type_check check (trigger_type in (
  'conversation_opened', 'conversation_closed', 'conversation_waiting', 'template_button',
  'shortcut', 'enquiry_added', 'enquiry_stage_updated', 'enquiry_status_updated',
  'webhook', 'recurring', 'appointment_created', 'appointment_updated', 'appointment_status_changed',
  'conversation_ai_tagged'));

-- ======================================================================
-- 20261017000200_ai_intents_insights.sql
-- ======================================================================
-- Phase 17 (2/3): intent detection results, suggestion outcomes and the weekly reply-quality report.
--
--   ai_message_intents      what an inbound message was labelled (booking, price, complaint, report_request, emergency) and, from
--                           a closed list, what it was about. One row per message and source ('keyword' for the deterministic
--                           emergency fast path, 'model' for the AI label). The unique key makes retries idempotent, and is
--                           what stops an emergency being announced twice. NO message text is stored, only labels.
--   ai_suggestion_outcomes  whether a staff member sent an AI suggested reply as it was, edited it, or wrote their own (a
--                           verdict and a similarity percentage; neither text is stored)
--   ai_quality_reports      one row per organisation and week: counts and knowledge-gap topics with conversation ids
--
-- Staff read through RLS; every write is server code (job or server action after can()) using the service role, so there
-- are SELECT policies only. conversations.ai_tags is changed only through ai_add_conversation_tags().

-- ---------------------------------------------------------------------------
-- ai_message_intents
-- ---------------------------------------------------------------------------
create table public.ai_message_intents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  message_id uuid not null references public.messages (id) on delete cascade,
  source text not null check (source in ('keyword', 'model')),
  intents text[] not null default '{}' check (cardinality(intents) <= 5),
  topic text check (topic is null or topic in (
    'opening_hours', 'location', 'price', 'insurance', 'services', 'doctors', 'preparation', 'results', 'booking', 'other')),
  -- keyword path only: ids of the wording patterns that matched, never the wording
  signals text[] not null default '{}' check (cardinality(signals) <= 20),
  -- emergency only: set once the people who must look have been told. A retry that finds it set does nothing; one that
  -- finds it empty tells them (at-least-once: a crash between the two steps may notify twice, never zero times).
  escalated_at timestamptz,
  created_at timestamptz not null default now(),
  unique (message_id, source)
);
create index ai_message_intents_org_idx on public.ai_message_intents (org_id, created_at desc);
create index ai_message_intents_conversation_idx on public.ai_message_intents (conversation_id, created_at desc);
create trigger ai_message_intents_conversation_org_check before insert or update on public.ai_message_intents
  for each row execute function app.check_parent_org('conversations', 'conversation_id');
create trigger ai_message_intents_message_org_check before insert or update on public.ai_message_intents
  for each row execute function app.check_parent_org('messages', 'message_id');

alter table public.ai_message_intents enable row level security;
create policy ai_message_intents_select on public.ai_message_intents for select to authenticated
  using (exists (
    select 1 from public.conversations c
    where c.id = ai_message_intents.conversation_id
      and app.can_view_conversation(c.org_id, c.assignee_user_id, c.assignee_team_id)
  ));

-- ---------------------------------------------------------------------------
-- ai_suggestion_outcomes
-- ---------------------------------------------------------------------------
create table public.ai_suggestion_outcomes (
  ai_usage_id uuid primary key references public.ai_usage (id) on delete cascade,
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete set null,
  conversation_id uuid references public.conversations (id) on delete set null,
  outcome text not null check (outcome in ('accepted', 'edited', 'rejected')),
  similarity smallint not null check (similarity between 0 and 100),
  created_at timestamptz not null default now()
);
create index ai_suggestion_outcomes_org_idx on public.ai_suggestion_outcomes (org_id, created_at desc);
create trigger ai_suggestion_outcomes_conversation_org_check before insert or update on public.ai_suggestion_outcomes
  for each row execute function app.check_parent_org('conversations', 'conversation_id');

alter table public.ai_suggestion_outcomes enable row level security;
create policy ai_suggestion_outcomes_select on public.ai_suggestion_outcomes for select to authenticated
  using (app.is_org_member(org_id) and (app.has_perm(org_id, 'ai.insights.view') or app.has_perm(org_id, 'reports.view')));

-- ---------------------------------------------------------------------------
-- ai_quality_reports
-- ---------------------------------------------------------------------------
create table public.ai_quality_reports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  week_start date not null,
  week_end date not null,
  stats jsonb not null check (jsonb_typeof(stats) = 'object'),
  -- [{ "topic": "price", "count": 4, "conversation_ids": ["…"] }] : closed topics and ids, no text
  gaps jsonb not null default '[]'::jsonb check (jsonb_typeof(gaps) = 'array'),
  created_at timestamptz not null default now(),
  unique (org_id, week_start),
  check (week_end > week_start)
);
create index ai_quality_reports_org_idx on public.ai_quality_reports (org_id, week_start desc);

alter table public.ai_quality_reports enable row level security;
create policy ai_quality_reports_select on public.ai_quality_reports for select to authenticated
  using (app.is_org_member(org_id) and app.has_perm(org_id, 'ai.insights.view'));

-- ---------------------------------------------------------------------------
-- conversations.ai_tags: add tags atomically, report which were new
-- ---------------------------------------------------------------------------
create or replace function public.ai_add_conversation_tags(p_org uuid, p_conversation uuid, p_tags text[])
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before text[];
  v_after text[];
begin
  select c.ai_tags into v_before
    from public.conversations c
   where c.id = p_conversation and c.org_id = p_org
   for update;
  if not found then
    return '{}';
  end if;
  select coalesce(array_agg(distinct t order by t), '{}') into v_after
    from unnest(v_before || coalesce(p_tags, '{}')) as t
   where t is not null and t <> '';
  if v_after is distinct from v_before then
    update public.conversations set ai_tags = v_after where id = p_conversation and org_id = p_org;
  end if;
  return array(
    select t from unnest(coalesce(p_tags, '{}')) as t where t is not null and t <> ''
    except select unnest(v_before)
  );
end;
$$;
revoke all on function public.ai_add_conversation_tags(uuid, uuid, text[]) from public, anon, authenticated;
grant execute on function public.ai_add_conversation_tags(uuid, uuid, text[]) to service_role;

-- ---------------------------------------------------------------------------
-- Erasing a patient removes the labels that were derived from their messages
-- ---------------------------------------------------------------------------
create or replace function app.ai_intents_erase()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.ai_message_intents
   where org_id = new.org_id
     and conversation_id in (select c.id from public.conversations c where c.org_id = new.org_id and c.contact_id = new.id);
  return new;
end;
$$;
create trigger contacts_ai_intents_erase after update of erased_at on public.contacts
  for each row when (old.erased_at is null and new.erased_at is not null)
  execute function app.ai_intents_erase();

-- ======================================================================
-- 20261017000300_ai_jobs.sql
-- ======================================================================
-- Phase 17 (3/3): queue and schedules for the AI copilots.
--   ai_insights queue        intent detection jobs ({ type: 'intent', message_id }) queued when an inbound message arrives
--   ai_quality_weekly task   Mondays 04:30 UTC: builds last week's reply-quality report per organisation
-- Queue names must stay in sync with lib/jobs/queues.ts.

select pgmq.create('ai_insights');

select cron.schedule('pulse:ai_insights',       '30 seconds', $$select app.ping_jobs('ai_insights')$$);
select cron.schedule('pulse:ai_quality_weekly', '30 4 * * 1', $$select app.ping_jobs('ai_quality_weekly')$$);
