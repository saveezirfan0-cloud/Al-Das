-- Phase 6: shared RLS helpers used by the appointment, Unite and clinical tables.
--   app.has_perm_wild  honours the prefix wildcards lib/auth/can.ts understands
--                      ('*', 'portal.*', 'portal.*.read'); app.has_perm is exact-match only (OQ-47).
--   app.add_tenant_rls enables RLS with per-operation policies in the Phase 1 style.
-- Promoted from supabase/drafts/0100_clinical_reference.sql.

-- ---------------------------------------------------------------------------
-- app.has_perm_wild — like app.has_perm (Phase 1) but honours the prefix wildcards that
-- lib/auth/can.ts already understands: '*', 'portal.*' (any portal object, read or write) and
-- 'portal.*.read' (read on any object). Phase 1's SQL has_perm matches exact keys only (OQ-47).
-- ---------------------------------------------------------------------------
create or replace function app.has_perm_wild(p_org_id uuid, p_perm text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    join public.roles r on r.id = m.role_id
    cross join lateral jsonb_array_elements_text(r.permissions) as perm(key)
    where m.org_id = p_org_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and (
        perm.key = '*'
        or perm.key = p_perm
        -- 'portal.*'  matches 'portal.<anything>' (one or more segments)
        or (perm.key like '%.*' and p_perm like replace(perm.key, '.*', '.%'))
        -- 'portal.*.read' matches 'portal.<one segment>.read'
        or (perm.key like '%.*.%' and p_perm ~ ('^' || replace(replace(perm.key, '.', '\.'), '*', '[^.]+') || '$'))
      )
  );
$$;
grant execute on function app.has_perm_wild(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Shared helper: tenant RLS in the Phase 1 style (per-operation policies, `to authenticated`).
--   select  → any active org member
--   writes  → app.has_perm_wild(org_id, p_write_perm) when a permission key is given;
--             otherwise no write policy (server-side / service role only, like the jobs tables)
-- Also installs the updated_at trigger when the table has that column.
-- ---------------------------------------------------------------------------
create or replace function app.add_tenant_rls(p_table text, p_write_perm text default null)
returns void
language plpgsql
set search_path = ''
as $$
begin
  execute format('alter table public.%I enable row level security', p_table);
  execute format('drop policy if exists %I on public.%I', p_table || '_select', p_table);
  execute format('create policy %I on public.%I for select to authenticated using (app.is_org_member(org_id))',
                 p_table || '_select', p_table);
  execute format('drop policy if exists %I on public.%I', p_table || '_insert', p_table);
  execute format('drop policy if exists %I on public.%I', p_table || '_update', p_table);
  execute format('drop policy if exists %I on public.%I', p_table || '_delete', p_table);
  if p_write_perm is not null then
    execute format('create policy %I on public.%I for insert to authenticated with check (app.has_perm_wild(org_id, %L))',
                   p_table || '_insert', p_table, p_write_perm);
    execute format('create policy %I on public.%I for update to authenticated using (app.has_perm_wild(org_id, %L)) with check (app.has_perm_wild(org_id, %L))',
                   p_table || '_update', p_table, p_write_perm, p_write_perm);
    execute format('create policy %I on public.%I for delete to authenticated using (app.has_perm_wild(org_id, %L))',
                   p_table || '_delete', p_table, p_write_perm);
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = p_table and column_name = 'updated_at') then
    execute format('drop trigger if exists %I on public.%I', p_table || '_set_updated_at', p_table);
    execute format('create trigger %I before update on public.%I for each row execute function app.set_updated_at()',
                   p_table || '_set_updated_at', p_table);
  end if;
end;
$$;

