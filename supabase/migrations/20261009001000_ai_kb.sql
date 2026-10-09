-- Phase 10 / 1: AI assist + knowledge base (pgvector).
--
--   kb_groups / kb_sources / kb_chunks   knowledge base (URL + file sources, scoped by group)
--   ai_usage                              one row per AI call: tokens + latency only, NEVER content
--   kb_feedback                           thumbs up/down from the inbox AI panel (no draft text stored)
--
-- Embeddings are 1024-d (Voyage voyage-3 by default). All writes happen server-side after
-- can() checks, through the service role; members with kb.manage / reports.view can read.

create extension if not exists vector with schema public;

-- ---------------------------------------------------------------------------
-- Knowledge base
-- ---------------------------------------------------------------------------

create table public.kb_groups (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);
create trigger kb_groups_set_updated_at before update on public.kb_groups for each row execute function app.set_updated_at();

create table public.kb_sources (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  group_id uuid references public.kb_groups (id) on delete set null,
  kind text not null check (kind in ('url', 'file')),
  name text not null check (length(btrim(name)) between 1 and 200),
  url text,                                          -- kind = url (https only, enforced in lib/ai/ingest/fetch-url.ts)
  storage_path text,                                 -- kind = file: <org_id>/<source_id>/<filename> in the kb-files bucket
  mime_type text,
  status text not null default 'pending' check (status in ('pending', 'processing', 'ready', 'failed')),
  error text,                                        -- short reason, never document text
  content_hash text,                                 -- sha256 of the extracted text: unchanged content is not re-embedded
  chunk_count integer not null default 0 check (chunk_count >= 0),
  last_ingested_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind = 'url' and url is not null) or (kind = 'file' and storage_path is not null))
);
create index kb_sources_org_idx on public.kb_sources (org_id, status);
create index kb_sources_group_idx on public.kb_sources (group_id);
create trigger kb_sources_set_updated_at before update on public.kb_sources for each row execute function app.set_updated_at();
create trigger kb_sources_group_org_check before insert or update on public.kb_sources
  for each row execute function app.check_parent_org('kb_groups', 'group_id');

create table public.kb_chunks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  source_id uuid not null references public.kb_sources (id) on delete cascade,
  ord integer not null check (ord >= 0),
  content text not null,
  embedding vector(1024) not null,
  created_at timestamptz not null default now(),
  unique (source_id, ord)
);
create index kb_chunks_org_idx on public.kb_chunks (org_id);
create index kb_chunks_embedding_idx on public.kb_chunks using hnsw (embedding vector_cosine_ops);
create trigger kb_chunks_source_org_check before insert or update on public.kb_chunks
  for each row execute function app.check_parent_org('kb_sources', 'source_id');

alter table public.kb_groups enable row level security;
alter table public.kb_sources enable row level security;
alter table public.kb_chunks enable row level security;

create policy kb_groups_select on public.kb_groups for select to authenticated
  using (app.is_org_member(org_id) and app.has_perm(org_id, 'kb.manage'));
create policy kb_sources_select on public.kb_sources for select to authenticated
  using (app.is_org_member(org_id) and app.has_perm(org_id, 'kb.manage'));
create policy kb_chunks_select on public.kb_chunks for select to authenticated
  using (app.is_org_member(org_id) and app.has_perm(org_id, 'kb.manage'));
-- Writes: server actions / the kb_ingest handler, service role only.

-- Similarity search, scoped to one org (and optionally to source groups). Only ready sources match.
-- similarity = 1 - cosine distance. Service role only; callers pass the org from a verified member.
create or replace function public.kb_match(
  p_org_id uuid,
  p_embedding vector(1024),
  p_group_ids uuid[] default null,
  p_limit integer default 5
)
returns table (chunk_id uuid, source_id uuid, source_name text, content text, similarity double precision)
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  select ch.id, ch.source_id, s.name, ch.content, (1 - (ch.embedding <=> p_embedding))::double precision
  from public.kb_chunks ch
  join public.kb_sources s on s.id = ch.source_id
  where ch.org_id = p_org_id
    and s.org_id = p_org_id
    and s.status = 'ready'
    and (p_group_ids is null or s.group_id = any (p_group_ids))
  order by ch.embedding <=> p_embedding
  limit greatest(1, least(coalesce(p_limit, 5), 20));
$$;
revoke all on function public.kb_match(uuid, vector, uuid[], integer) from public, anon, authenticated;
grant execute on function public.kb_match(uuid, vector, uuid[], integer) to service_role;

-- Atomically swap a source's chunks (delete + insert in one transaction) and mark it ready.
-- p_chunks: [{"ord":0,"content":"...","embedding":[...1024 floats...]}, ...]
create or replace function public.kb_replace_chunks(
  p_org_id uuid,
  p_source_id uuid,
  p_chunks jsonb,
  p_content_hash text
)
returns integer
language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_count integer;
begin
  if not exists (select 1 from public.kb_sources where id = p_source_id and org_id = p_org_id) then
    raise exception 'kb source % not found in org %', p_source_id, p_org_id using errcode = 'no_data_found';
  end if;

  delete from public.kb_chunks where source_id = p_source_id;

  insert into public.kb_chunks (org_id, source_id, ord, content, embedding)
  select p_org_id, p_source_id, (e ->> 'ord')::integer, e ->> 'content', (e ->> 'embedding')::vector(1024)
  from jsonb_array_elements(p_chunks) as e;
  get diagnostics v_count = row_count;

  update public.kb_sources
     set status = 'ready', error = null, content_hash = p_content_hash,
         chunk_count = v_count, last_ingested_at = now()
   where id = p_source_id;
  return v_count;
end;
$$;
revoke all on function public.kb_replace_chunks(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.kb_replace_chunks(uuid, uuid, jsonb, text) to service_role;

-- ---------------------------------------------------------------------------
-- AI usage + feedback. No prompt, draft or conversation text is ever stored here.
-- ---------------------------------------------------------------------------

create table public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete set null,
  conversation_id uuid references public.conversations (id) on delete set null,
  feature text not null check (feature in ('summarize', 'ask', 'suggest_reply', 'rewrite')),
  model text not null,
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  latency_ms integer not null default 0 check (latency_ms >= 0),
  status text not null default 'ok' check (status in ('ok', 'error', 'refused', 'needs_review')),
  created_at timestamptz not null default now()
);
create index ai_usage_org_idx on public.ai_usage (org_id, created_at desc);
create index ai_usage_user_idx on public.ai_usage (user_id, created_at desc);
create trigger ai_usage_conversation_org_check before insert or update on public.ai_usage
  for each row execute function app.check_parent_org('conversations', 'conversation_id');

create table public.kb_feedback (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete set null,
  conversation_id uuid references public.conversations (id) on delete set null,
  ai_usage_id uuid references public.ai_usage (id) on delete set null,
  feature text not null check (feature in ('summarize', 'ask', 'suggest_reply', 'rewrite')),
  positive boolean not null,
  note text check (note is null or length(note) <= 500),
  chunk_ids uuid[] not null default '{}',            -- KB chunks that grounded a suggested reply
  created_at timestamptz not null default now()
);
create index kb_feedback_org_idx on public.kb_feedback (org_id, created_at desc);
create trigger kb_feedback_conversation_org_check before insert or update on public.kb_feedback
  for each row execute function app.check_parent_org('conversations', 'conversation_id');

alter table public.ai_usage enable row level security;
alter table public.kb_feedback enable row level security;

create policy ai_usage_select on public.ai_usage for select to authenticated
  using (app.is_org_member(org_id) and app.has_perm(org_id, 'reports.view'));
create policy kb_feedback_select on public.kb_feedback for select to authenticated
  using (app.is_org_member(org_id) and (app.has_perm(org_id, 'kb.manage') or app.has_perm(org_id, 'reports.view')));
-- Inserts are server-side only (the AI server actions run can() first).

-- ---------------------------------------------------------------------------
-- Storage: private bucket for uploaded KB files (service role only).
-- Paths: <org_id>/<source_id>/<filename>. Guarded so the migration also applies on a plain Postgres.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_tables where schemaname = 'storage' and tablename = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('kb-files', 'kb-files', false, 20971520)
    on conflict (id) do nothing;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- New permissions for existing orgs. New orgs get them from lib/auth/permissions.ts SYSTEM_ROLES.
-- Idempotent: only appends a key a system role does not already hold.
-- ---------------------------------------------------------------------------

update public.roles r
   set permissions = r.permissions || to_jsonb(p.perm)
  from (values
    ('Manager', 'reports.export'), ('Manager', 'ai.use'), ('Manager', 'kb.manage'),
    ('Agent', 'ai.use'), ('Receptionist', 'ai.use')
  ) as p (role_name, perm)
 where r.is_system
   and r.name = p.role_name
   and not (r.permissions ? p.perm);
