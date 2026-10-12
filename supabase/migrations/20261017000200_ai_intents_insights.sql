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
  return array(select unnest(coalesce(p_tags, '{}')) except select unnest(v_before));
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
