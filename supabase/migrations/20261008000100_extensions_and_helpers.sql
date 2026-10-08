-- Phase 1 / 1: extensions and shared helpers.
-- Heavy extensions (pgmq, pg_cron, pg_net, vector) are enabled in their own migrations.

create extension if not exists pgcrypto;
create extension if not exists "uuid-ossp";
create extension if not exists pg_trgm;

-- Internal helpers live in `app` (not exposed through the API). RPCs meant for
-- supabase-js live in `public`.
create schema if not exists app;
grant usage on schema app to anon, authenticated, service_role;

create or replace function app.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- The user id of the caller (null for the service role or outside a request).
create or replace function app.current_user_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select auth.uid();
$$;
