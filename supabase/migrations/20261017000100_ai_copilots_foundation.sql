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
