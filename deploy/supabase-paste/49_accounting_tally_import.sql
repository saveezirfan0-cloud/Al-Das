-- Paste into Supabase > SQL Editor > New query, then Run. Needs 43_chronic_alignment.sql applied first (and 41).
-- The migration-history line is included at the bottom of this file.

-- Phase 22I: the Tally import (masters, opening balances, the full voucher history), the reconciliation against Tally's
-- trial balance, and the year-end close (docs/22_ACCOUNTING_PLAN.md, slice 22I; notes in docs/22_PHASE_22I_NOTES.md).
--
--   * acc_tally_imports: one row per upload (sha256 of each file, sizes, the dry-run report, the result). The original
--     files are never kept. acc_tally_staged: the sanitised rows waiting for the commit (names, amounts, dates, codes,
--     redacted narrations), service role only, deleted when the commit finishes. acc_tally_reconciliations: Pulse's
--     trial balance against an uploaded Tally trial balance, per ledger.
--   * The commit is idempotent: masters by Tally GUID (else the exact name the dry run offered to link), vouchers through
--     acc_post_from_source(.., 'tally_import', GUID, ALTERID, ..) so an altered voucher (higher ALTERID) is reversed and
--     posted again, opening balances as one 'opening' journal per entity (by content: an unchanged opening is not posted
--     twice).
--   * Year-end close per entity and fiscal year: all 12 months closed, no drafts, earlier years closed; the closing
--     journal (source 'year_end', in the year's adjustment period) moves every income and expense balance to the
--     retained earnings account; the year is then closed and refuses every posting (trigger, every role). Re-opening
--     reverses the closing journal. acc_trial_balance needs no change: once a year is closed its income and expenses net
--     to zero, so the "earlier_years_pl" line drops that year by itself.
--
-- Every state change is a SECURITY DEFINER function (search_path = '', service role only, jsonb results) that checks the
-- person's permission again (accounting.import; accounting.periods.manage for periods and the year-end). Errors carry a
-- stable code in the HINT (lib/accounting/errors.ts).

-- ---------------------------------------------------------------------------
-- 1. 'year_end' joins the journal source kinds (whatever list the table holds now, plus this one)
-- ---------------------------------------------------------------------------
do $$
declare
  c record;
  v_list text[];
begin
  for c in
    select con.conname, pg_get_constraintdef(con.oid) as def
    from pg_constraint con
    where con.conrelid = 'public.acc_journals'::regclass and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%source_kind%' and pg_get_constraintdef(con.oid) like '%tally_import%'
  loop
    select array_agg(distinct m[1]) into v_list from regexp_matches(c.def, '''([a-z_]+)''', 'g') as m;
    execute format('alter table public.acc_journals drop constraint %I', c.conname);
  end loop;
  if not ('year_end' = any (v_list)) then
    v_list := array_append(v_list, 'year_end');
  end if;
  execute format('alter table public.acc_journals add constraint acc_journals_source_kind_check check (source_kind is null or source_kind in (%s))',
    (select string_agg(quote_literal(x), ', ' order by x) from unnest(v_list) as x));
end $$;

-- ---------------------------------------------------------------------------
-- 2. A closed fiscal year refuses every posting (except the reversal of its own closing journal, inside the re-open)
-- ---------------------------------------------------------------------------
alter table public.acc_fiscal_years
  add column closed_by uuid references public.profiles (id) on delete set null,
  add column closed_at timestamptz,
  add column closing_journal_id uuid references public.acc_journals (id);
alter table public.acc_fiscal_years
  add constraint acc_fiscal_years_closed_check check (status = 'open' or closed_at is not null);

create or replace function app.acc_year_closed_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'draft' and new.status = 'posted' and new.fiscal_year_id is not null
     and exists (select 1 from public.acc_fiscal_years f where f.id = new.fiscal_year_id and f.status = 'closed')
     and coalesce(current_setting('app.acc_year_ctx', true), '') <> 'reopen:' || new.fiscal_year_id::text then
    raise exception 'The fiscal year of this date is closed.' using errcode = 'check_violation', hint = 'year_closed';
  end if;
  return new;
end;
$$;
revoke all on function app.acc_year_closed_guard() from public, anon, authenticated;
create trigger acc_journals_year_guard before update on public.acc_journals
  for each row execute function app.acc_year_closed_guard();

-- ---------------------------------------------------------------------------
-- 3. Tables
-- ---------------------------------------------------------------------------
create table public.acc_tally_imports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  entity_id uuid not null references public.acc_entities (id),
  status text not null default 'staged' check (status in ('staged', 'committing', 'committed', 'discarded')),
  -- the files are never kept: their sha256 (one per uploaded file) and total size only
  file_sha256 text[] not null check (cardinality(file_sha256) between 1 and 4),
  file_bytes bigint not null default 0 check (file_bytes >= 0),
  forced boolean not null default false,
  company text check (company is null or char_length(company) <= 120),
  -- the dry run: counts, the group mapping, the opening trial balance, vouchers per month and type, refusals (codes)
  report jsonb not null default '{}'::jsonb,
  opening_date date,
  first_date date,
  last_date date,
  -- the commit: counts per kind and outcome, refusals (GUID, date, number, type, code)
  result jsonb not null default '{}'::jsonb,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  committed_by uuid references public.profiles (id) on delete set null,
  committed_at timestamptz,
  reconciled_by uuid references public.profiles (id) on delete set null,
  reconciled_at timestamptz,
  periods_locked_at timestamptz,
  updated_at timestamptz not null default now(),
  check (status <> 'committed' or committed_at is not null)
);
create index acc_tally_imports_org_idx on public.acc_tally_imports (org_id, created_at desc);
create index acc_tally_imports_sha_idx on public.acc_tally_imports using gin (file_sha256);
create trigger acc_tally_imports_set_updated_at before update on public.acc_tally_imports
  for each row execute function app.set_updated_at();
create trigger acc_tally_imports_entity_org_check before insert or update on public.acc_tally_imports
  for each row execute function app.check_parent_org('acc_entities', 'entity_id');

create table public.acc_tally_staged (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs (id) on delete cascade,
  import_id uuid not null references public.acc_tally_imports (id) on delete cascade,
  seq integer not null check (seq >= 1),
  kind text not null check (kind in ('group', 'cost_centre', 'ledger', 'voucher')),
  guid text check (guid is null or char_length(guid) between 1 and 100),
  alter_id bigint check (alter_id is null or alter_id >= 0),
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'done', 'unchanged', 'older', 'refused')),
  result_code text check (result_code is null or char_length(result_code) <= 40),
  journal_id uuid references public.acc_journals (id),
  unique (import_id, kind, seq)
);
create index acc_tally_staged_work_idx on public.acc_tally_staged (import_id, kind, status, seq);
create trigger acc_tally_staged_import_org_check before insert or update on public.acc_tally_staged
  for each row execute function app.check_parent_org('acc_tally_imports', 'import_id');

create table public.acc_tally_reconciliations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  entity_id uuid not null references public.acc_entities (id),
  import_id uuid references public.acc_tally_imports (id) on delete set null,
  as_at date not null,
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  compared integer not null check (compared >= 0),
  differences integer not null check (differences >= 0),
  total_difference numeric(16, 2) not null default 0,
  reconciled boolean not null,
  -- the ledgers that differ: code, name, Pulse, Tally, difference (amounts and ledger names only)
  rows jsonb not null default '[]'::jsonb,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  check (reconciled = (differences = 0))
);
create index acc_tally_reconciliations_org_idx on public.acc_tally_reconciliations (org_id, created_at desc);
create trigger acc_tally_reconciliations_entity_org_check before insert or update on public.acc_tally_reconciliations
  for each row execute function app.check_parent_org('acc_entities', 'entity_id');
create trigger acc_tally_reconciliations_import_org_check before insert or update on public.acc_tally_reconciliations
  for each row execute function app.check_parent_org('acc_tally_imports', 'import_id');

alter table public.acc_tally_imports enable row level security;
alter table public.acc_tally_staged enable row level security;          -- service role only: no policy
alter table public.acc_tally_reconciliations enable row level security;
create policy acc_tally_imports_select on public.acc_tally_imports for select to authenticated
  using (app.has_perm(org_id, 'accounting.import'));
create policy acc_tally_reconciliations_select on public.acc_tally_reconciliations for select to authenticated
  using (app.has_perm(org_id, 'accounting.import'));

-- The short-lived upload (deleted right after it is read). No member policies: only the service role touches it.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_tables where schemaname = 'storage' and tablename = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('accounting-imports', 'accounting-imports', false, 209715200)
    on conflict (id) do nothing;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Helpers
-- ---------------------------------------------------------------------------
-- A code for an imported account or cost centre: the prefix and the first characters of the md5 of its GUID (or name),
-- longer when taken.
create or replace function app.acc_tally_code(p_org_id uuid, p_prefix text, p_key text, p_cost_centre boolean)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_hash text := upper(md5(coalesce(p_key, '')));
  v_code text;
begin
  for n in 8..16 by 4 loop
    v_code := p_prefix || substr(v_hash, 1, n);
    if (p_cost_centre and not exists (select 1 from public.acc_cost_centres c where c.org_id = p_org_id and c.code = v_code))
       or (not p_cost_centre and not exists (select 1 from public.acc_accounts a where a.org_id = p_org_id and a.code = v_code)) then
      return v_code;
    end if;
  end loop;
  raise exception 'No free code.' using errcode = 'check_violation', hint = 'invalid';
end;
$$;
revoke all on function app.acc_tally_code(uuid, text, text, boolean) from public, anon, authenticated;

-- A group by its Tally GUID, else by name, else a system group by its Tally name.
create or replace function app.acc_tally_group_id(p_org_id uuid, p_guid text, p_name text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select a.id from public.acc_accounts a where a.org_id = p_org_id and a.is_group and p_guid is not null and a.tally_guid = p_guid),
    (select a.id from public.acc_accounts a where a.org_id = p_org_id and a.is_group and lower(btrim(a.name)) = lower(btrim(p_name))),
    (select a.id from public.acc_accounts a where a.org_id = p_org_id and a.is_group and a.is_system
       and lower(a.tally_group) = lower(btrim(p_name)) order by a.code limit 1));
$$;
revoke all on function app.acc_tally_group_id(uuid, text, text) from public, anon, authenticated;

-- A ledger by its Tally GUID, else by name.
create or replace function app.acc_tally_ledger_id(p_org_id uuid, p_guid text, p_name text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select a.id from public.acc_accounts a where a.org_id = p_org_id and not a.is_group and p_guid is not null and a.tally_guid = p_guid),
    (select a.id from public.acc_accounts a where a.org_id = p_org_id and not a.is_group and lower(btrim(a.name)) = lower(btrim(p_name))));
$$;
revoke all on function app.acc_tally_ledger_id(uuid, text, text) from public, anon, authenticated;

create or replace function app.acc_tally_import_for_update(p_org_id uuid, p_import_id uuid, p_user_id uuid, p_statuses text[])
returns public.acc_tally_imports
language plpgsql
security definer
set search_path = ''
as $$
declare
  imp public.acc_tally_imports;
begin
  if not app.user_has_perm(p_org_id, p_user_id, 'accounting.import') then
    raise exception 'You cannot import into Accounting.' using errcode = 'check_violation', hint = 'not_permitted';
  end if;
  select * into imp from public.acc_tally_imports where id = p_import_id and org_id = p_org_id for update;
  if not found then
    raise exception 'Import not found.' using errcode = 'no_data_found', hint = 'not_found';
  end if;
  if not (imp.status = any (p_statuses)) then
    raise exception 'That is not possible in the import''s current state.' using errcode = 'check_violation', hint = 'wrong_status';
  end if;
  -- one Tally commit at a time per organisation
  perform pg_advisory_xact_lock(hashtextextended('acc_tally|' || p_org_id::text, 22));
  return imp;
end;
$$;
revoke all on function app.acc_tally_import_for_update(uuid, uuid, uuid, text[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Commit step 1: masters (groups, cost centres, ledgers), in the staged order (parents first). Idempotent.
-- ---------------------------------------------------------------------------
create or replace function public.acc_tally_apply_masters(p_org_id uuid, p_import_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  imp public.acc_tally_imports;
  r record;
  a public.acc_accounts;
  v_parent public.acc_accounts;
  v_parent_id uuid;
  v_status text;
  v_hint text;
  v_name text;
  v_done integer := 0;
  v_unchanged integer := 0;
  v_refused integer := 0;
begin
  imp := app.acc_tally_import_for_update(p_org_id, p_import_id, p_user_id, array['staged', 'committing']);
  for r in
    select s.id, s.kind, s.guid, s.alter_id, s.payload from public.acc_tally_staged s
    where s.import_id = imp.id and s.kind in ('group', 'cost_centre', 'ledger') and s.status = 'pending'
    order by s.seq
  loop
    begin
      v_status := 'done';
      v_name := btrim(r.payload ->> 'name');
      a := null;
      if r.kind = 'cost_centre' then
        if exists (select 1 from public.acc_cost_centres c where c.org_id = p_org_id and lower(btrim(c.name)) = lower(v_name)) then
          v_status := 'unchanged';
        else
          insert into public.acc_cost_centres (org_id, code, name)
          values (p_org_id, app.acc_tally_code(p_org_id, 'T', v_name, true), v_name);
        end if;
      else
        if r.guid is not null then
          select * into a from public.acc_accounts where org_id = p_org_id and tally_guid = r.guid;
        end if;
        if a.id is not null then
          if a.is_group <> (r.kind = 'group') then
            raise exception 'A group and a ledger share this GUID.' using errcode = 'check_violation', hint = 'name_clash';
          end if;
          if coalesce(r.alter_id, 0) > coalesce(a.tally_alter_id, -1) then
            update public.acc_accounts
               set tally_alter_id = r.alter_id,
                   name = case when a.is_system or r.payload ? 'special' then a.name else v_name end
             where id = a.id;
          else
            v_status := 'unchanged';
          end if;
        elsif r.payload ? 'system_code' then
          update public.acc_accounts
             set tally_guid = coalesce(tally_guid, r.guid), tally_alter_id = coalesce(r.alter_id, tally_alter_id)
           where org_id = p_org_id and code = r.payload ->> 'system_code' and is_group and is_system;
          if not found then
            raise exception 'The predefined group is missing.' using errcode = 'check_violation', hint = 'parent_unknown';
          end if;
        elsif r.payload ? 'link_id' then
          update public.acc_accounts
             set tally_guid = coalesce(r.guid, tally_guid), tally_alter_id = coalesce(r.alter_id, tally_alter_id)
           where id = (r.payload ->> 'link_id')::uuid and org_id = p_org_id and is_group = (r.kind = 'group')
             and (tally_guid is null or tally_guid = r.guid or r.guid is null);
          if not found then
            raise exception 'The account to link changed since the dry run.' using errcode = 'check_violation', hint = 'link_changed';
          end if;
        else
          v_parent_id := null;
          if r.payload ->> 'parent' is not null then
            v_parent_id := app.acc_tally_group_id(p_org_id, r.payload ->> 'parent_guid', r.payload ->> 'parent');
            if v_parent_id is null then
              raise exception 'The parent group was not found.' using errcode = 'check_violation', hint = 'parent_unknown';
            end if;
            select * into v_parent from public.acc_accounts where id = v_parent_id;
          elsif r.kind = 'ledger' then
            raise exception 'A ledger needs a group.' using errcode = 'check_violation', hint = 'parent_unknown';
          end if;
          insert into public.acc_accounts (org_id, parent_id, is_group, code, name, nature, tally_group, affects_gross_profit,
                                           tally_guid, tally_alter_id, created_by, description)
          values (p_org_id, v_parent_id, r.kind = 'group',
                  app.acc_tally_code(p_org_id, case when r.kind = 'group' then 'TG-' else 'T-' end, coalesce(r.guid, v_name), false),
                  v_name,
                  case when v_parent_id is null then r.payload ->> 'nature' else v_parent.nature end,
                  case when v_parent_id is null then v_name end,
                  coalesce((r.payload ->> 'gross')::boolean, false),
                  r.guid, r.alter_id, p_user_id, 'Imported from Tally');
        end if;
      end if;
      update public.acc_tally_staged set status = v_status, result_code = null where id = r.id;
      if v_status = 'done' then v_done := v_done + 1; else v_unchanged := v_unchanged + 1; end if;
    exception when others then
      get stacked diagnostics v_hint = pg_exception_hint;
      update public.acc_tally_staged
         set status = 'refused',
             result_code = coalesce(nullif(v_hint, ''), case sqlstate when '23505' then 'name_clash' else 'error' end)
       where id = r.id;
      v_refused := v_refused + 1;
    end;
  end loop;
  update public.acc_tally_imports set status = 'committing' where id = imp.id;
  return jsonb_build_object('done', v_done, 'unchanged', v_unchanged, 'refused', v_refused);
end;
$$;
revoke all on function public.acc_tally_apply_masters(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.acc_tally_apply_masters(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Commit step 2: the opening balances as ONE 'opening' journal per entity (source 'tally-opening:<entity>:1'), dated
--    p_date. Idempotent by content: when the live opening journal already holds exactly these lines on this date, nothing
--    is posted; otherwise the next version replaces it (acc_post_from_source reverses the old one). More than 450 lines
--    are split into several journals, each balanced through "Opening balance difference" (9100), which nets to zero.
-- ---------------------------------------------------------------------------
create or replace function public.acc_tally_post_opening(p_org_id uuid, p_import_id uuid, p_user_id uuid, p_date date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  imp public.acc_tally_imports;
  r record;
  v_lines jsonb := '[]'::jsonb;
  v_account uuid;
  v_amount numeric;
  v_total numeric := 0;
  v_n integer;
  v_chunks integer;
  v_chunk jsonb;
  v_sum numeric;
  v_diff uuid;
  v_source text;
  v_live public.acc_journals;
  v_existing jsonb;
  v_version integer;
  v_posted integer := 0;
  v_unchanged integer := 0;
  v_res jsonb;
  v_numbers jsonb := '[]'::jsonb;
begin
  imp := app.acc_tally_import_for_update(p_org_id, p_import_id, p_user_id, array['committing']);
  if p_date is null then
    raise exception 'Choose the opening date.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  for r in
    select s.guid, s.payload, (s.payload ->> 'opening')::numeric as opening from public.acc_tally_staged s
    where s.import_id = imp.id and s.kind = 'ledger' and coalesce((s.payload ->> 'opening')::numeric, 0) <> 0
  loop
    v_account := coalesce(
      (select a.id from public.acc_accounts a where a.org_id = p_org_id and not a.is_group
        and a.id = nullif(r.payload ->> 'link_id', '')::uuid),
      app.acc_tally_ledger_id(p_org_id, r.guid, r.payload ->> 'name'));
    if v_account is null then
      raise exception 'A ledger with an opening balance is not in the chart.' using errcode = 'check_violation', hint = 'opening_ledger_unknown';
    end if;
    v_lines := v_lines || jsonb_build_object('account_id', v_account,
                                             'debit', greatest(r.opening, 0), 'credit', greatest(-r.opening, 0),
                                             'sort', (select a.code from public.acc_accounts a where a.id = v_account));
    v_total := v_total + r.opening;
  end loop;
  if v_total <> 0 then
    raise exception 'The opening balances do not net to zero.' using errcode = 'check_violation', hint = 'opening_unbalanced';
  end if;
  v_n := jsonb_array_length(v_lines);
  if v_n = 0 then
    update public.acc_tally_imports set opening_date = null where id = imp.id;
    return jsonb_build_object('posted', 0, 'unchanged', 0, 'lines', 0);
  end if;
  select coalesce(jsonb_agg(x - 'sort' order by x ->> 'sort', x ->> 'account_id'), '[]'::jsonb) into v_lines
  from jsonb_array_elements(v_lines) as x;
  v_chunks := case when v_n <= 450 then 1 else ceil(v_n / 400.0)::integer end;
  if v_chunks > 1 then
    select a.id into v_diff from public.acc_accounts a where a.org_id = p_org_id and a.code = '9100' and not a.is_group and a.is_active;
    if v_diff is null then
      raise exception 'Too many opening balances for one journal and no "Opening balance difference" ledger (9100).'
        using errcode = 'check_violation', hint = 'too_many_lines';
    end if;
  end if;
  for i in 1..v_chunks loop
    select jsonb_agg(x order by o) into v_chunk
    from jsonb_array_elements(v_lines) with ordinality as t (x, o)
    where v_chunks = 1 or (o > (i - 1) * 400 and o <= i * 400);
    if v_chunks > 1 then
      select coalesce(sum((x ->> 'debit')::numeric - (x ->> 'credit')::numeric), 0) into v_sum from jsonb_array_elements(v_chunk) x;
      if v_sum <> 0 then
        v_chunk := v_chunk || jsonb_build_object('account_id', v_diff, 'debit', greatest(-v_sum, 0), 'credit', greatest(v_sum, 0));
      end if;
    end if;
    v_source := 'tally-opening:' || imp.entity_id::text || ':' || i::text;
    select * into v_live from public.acc_journals
     where org_id = p_org_id and source_kind = 'opening' and source_id = v_source and status = 'posted';
    if v_live.id is not null and v_live.journal_date = p_date then
      select jsonb_agg(jsonb_build_object('account_id', l.account_id, 'debit', l.debit, 'credit', l.credit) order by l.line_no)
        into v_existing from public.acc_journal_lines l where l.journal_id = v_live.id;
      if v_existing = v_chunk then
        v_unchanged := v_unchanged + 1;
        v_numbers := v_numbers || to_jsonb(v_live.number);
        continue;
      end if;
    end if;
    select coalesce(max(j.source_version), 0) + 1 into v_version from public.acc_journals j
     where j.org_id = p_org_id and j.source_kind = 'opening' and j.source_id = v_source;
    v_res := public.acc_post_from_source(p_org_id, imp.entity_id, 'opening', v_source, v_version, p_date, 'opening',
                                         'Opening balances from Tally' || case when v_chunks > 1 then ' (part ' || i || ' of ' || v_chunks || ')' else '' end,
                                         v_chunk);
    v_posted := v_posted + 1;
    v_numbers := v_numbers || to_jsonb(v_res ->> 'number');
  end loop;
  -- parts left over from an earlier, longer opening are reversed
  for r in
    select j.id from public.acc_journals j
    where j.org_id = p_org_id and j.source_kind = 'opening' and j.status = 'posted'
      and j.source_id like 'tally-opening:' || imp.entity_id::text || ':%'
      and split_part(j.source_id, ':', 3)::integer > v_chunks
  loop
    perform app.acc_reverse_internal(p_org_id, r.id, null, greatest(p_date, (select x.journal_date from public.acc_journals x where x.id = r.id)),
                                     'replaced by a later Tally import');
  end loop;
  update public.acc_tally_imports set opening_date = p_date where id = imp.id;
  return jsonb_build_object('posted', v_posted, 'unchanged', v_unchanged, 'lines', v_n, 'numbers', v_numbers);
end;
$$;
revoke all on function public.acc_tally_post_opening(uuid, uuid, uuid, date) from public, anon, authenticated;
grant execute on function public.acc_tally_post_opening(uuid, uuid, uuid, date) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Commit step 3: the vouchers, a batch at a time (oldest first). Each one succeeds or is refused on its own.
--    acc_post_from_source makes it idempotent: the same GUID and ALTERID is "unchanged"; a higher ALTERID reverses the
--    live journal and posts again; a lower one is "older" (skipped).
-- ---------------------------------------------------------------------------
create or replace function public.acc_tally_post_vouchers(p_org_id uuid, p_import_id uuid, p_user_id uuid, p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  imp public.acc_tally_imports;
  r record;
  l jsonb;
  v_lines jsonb;
  v_account uuid;
  v_cc uuid;
  v_res jsonb;
  v_hint text;
  v_done integer := 0;
  v_unchanged integer := 0;
  v_older integer := 0;
  v_refused integer := 0;
begin
  imp := app.acc_tally_import_for_update(p_org_id, p_import_id, p_user_id, array['committing']);
  for r in
    select s.id, s.guid, s.alter_id, s.payload from public.acc_tally_staged s
    where s.import_id = imp.id and s.kind = 'voucher' and s.status = 'pending'
    order by s.payload ->> 'date', s.seq
    limit least(greatest(coalesce(p_limit, 200), 1), 2000)
  loop
    begin
      if r.guid is null or coalesce(r.alter_id, 0) > 2147483647 then
        raise exception 'The voucher has no usable GUID or ALTERID.' using errcode = 'check_violation', hint = 'invalid';
      end if;
      v_lines := '[]'::jsonb;
      for l in select x from jsonb_array_elements(r.payload -> 'lines') as x loop
        v_account := app.acc_tally_ledger_id(p_org_id, l ->> 'ledger_guid', l ->> 'ledger');
        if v_account is null then
          raise exception 'A ledger is not in the chart.' using errcode = 'check_violation', hint = 'ledger_unknown';
        end if;
        v_cc := null;
        if l ? 'cost_centre' then
          select c.id into v_cc from public.acc_cost_centres c
           where c.org_id = p_org_id and lower(btrim(c.name)) = lower(btrim(l ->> 'cost_centre'));
          if v_cc is null then
            raise exception 'A cost centre is not in Pulse.' using errcode = 'check_violation', hint = 'cost_centre';
          end if;
        end if;
        v_lines := v_lines || jsonb_strip_nulls(jsonb_build_object(
          'account_id', v_account, 'debit', l -> 'debit', 'credit', l -> 'credit', 'description', l ->> 'description',
          'cost_centre_id', v_cc, 'currency', l ->> 'currency', 'fx_rate', l -> 'fx_rate', 'amount_fx', l -> 'amount_fx'));
      end loop;
      v_res := public.acc_post_from_source(p_org_id, imp.entity_id, 'tally_import', r.guid, greatest(coalesce(r.alter_id, 1), 1)::integer,
                                           (r.payload ->> 'date')::date, r.payload ->> 'type', r.payload ->> 'narration', v_lines);
      if (v_res ->> 'created')::boolean then
        update public.acc_tally_staged set status = 'done', journal_id = (v_res ->> 'id')::uuid, result_code = null where id = r.id;
        v_done := v_done + 1;
      else
        update public.acc_tally_staged set status = 'unchanged', journal_id = (v_res ->> 'id')::uuid, result_code = null where id = r.id;
        v_unchanged := v_unchanged + 1;
      end if;
    exception when others then
      get stacked diagnostics v_hint = pg_exception_hint;
      if v_hint = 'stale_version' then
        update public.acc_tally_staged set status = 'older', result_code = v_hint where id = r.id;
        v_older := v_older + 1;
      else
        update public.acc_tally_staged set status = 'refused', result_code = coalesce(nullif(v_hint, ''), 'error') where id = r.id;
        v_refused := v_refused + 1;
      end if;
    end;
  end loop;
  return jsonb_build_object('done', v_done, 'unchanged', v_unchanged, 'older', v_older, 'refused', v_refused,
    'remaining', (select count(*) from public.acc_tally_staged s where s.import_id = imp.id and s.kind = 'voucher' and s.status = 'pending'));
end;
$$;
revoke all on function public.acc_tally_post_vouchers(uuid, uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.acc_tally_post_vouchers(uuid, uuid, uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 8. Commit step 4: the summary is kept on the import, the staged rows are deleted.
-- ---------------------------------------------------------------------------
create or replace function public.acc_tally_finish(p_org_id uuid, p_import_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  imp public.acc_tally_imports;
  v_result jsonb;
begin
  imp := app.acc_tally_import_for_update(p_org_id, p_import_id, p_user_id, array['committing']);
  if exists (select 1 from public.acc_tally_staged s where s.import_id = imp.id and s.status = 'pending') then
    raise exception 'Some rows are still waiting to be posted.' using errcode = 'check_violation', hint = 'import_pending';
  end if;
  select jsonb_build_object(
    'counts', coalesce((select jsonb_object_agg(k, n) from (
        select s.kind || '.' || s.status as k, count(*) as n from public.acc_tally_staged s where s.import_id = imp.id group by 1) c), '{}'::jsonb),
    'refused', coalesce((select jsonb_agg(jsonb_build_object(
        'kind', s.kind, 'guid', s.guid, 'name', case when s.kind <> 'voucher' then left(s.payload ->> 'name', 120) end,
        'date', s.payload ->> 'date', 'number', s.payload ->> 'number', 'type', s.payload ->> 'type_name', 'code', s.result_code)
        order by s.kind, s.seq)
      from (select * from public.acc_tally_staged x where x.import_id = imp.id and x.status = 'refused' order by x.kind, x.seq limit 500) s),
      '[]'::jsonb),
    'first_journal_date', (select min(j.journal_date) from public.acc_tally_staged s join public.acc_journals j on j.id = s.journal_id where s.import_id = imp.id),
    'last_journal_date', (select max(j.journal_date) from public.acc_tally_staged s join public.acc_journals j on j.id = s.journal_id where s.import_id = imp.id))
  into v_result;
  delete from public.acc_tally_staged where import_id = imp.id;
  update public.acc_tally_imports
     set status = 'committed', committed_by = p_user_id, committed_at = now(), result = v_result
   where id = imp.id;
  return v_result;
end;
$$;
revoke all on function public.acc_tally_finish(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.acc_tally_finish(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 9. Reconciliation: Pulse's trial balance at p_as_at against Tally's (p_rows: [{name, debit, credit}], from the
--    uploaded Excel / CSV). Per ledger by name; Tally's "Profit & Loss A/c" is compared with the retained earnings
--    account plus earlier years' profit not yet closed (that is what Tally shows on it). Rows naming a group are
--    ignored (Tally's group subtotals). Zero differences mark the import reconciled.
-- ---------------------------------------------------------------------------
create or replace function public.acc_tally_reconcile(
  p_org_id uuid, p_entity_id uuid, p_import_id uuid, p_user_id uuid, p_as_at date, p_file_sha256 text, p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entity uuid := p_entity_id;
  v_tb jsonb;
  v_earlier numeric;
  v_re uuid;
  v_rows jsonb;
  v_compared integer;
  v_diffs integer;
  v_total numeric;
  v_groups integer;
  v_id uuid;
begin
  if not app.user_has_perm(p_org_id, p_user_id, 'accounting.import') then
    raise exception 'You cannot reconcile imports.' using errcode = 'check_violation', hint = 'not_permitted';
  end if;
  if p_as_at is null or p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 20000
     or p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'The trial balance or its date is missing.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  if v_entity is null then
    select e.id into v_entity from public.acc_entities e where e.org_id = p_org_id and e.is_default;
  end if;
  if p_import_id is not null and not exists (
    select 1 from public.acc_tally_imports i where i.id = p_import_id and i.org_id = p_org_id and i.status = 'committed') then
    raise exception 'Import not found or not committed.' using errcode = 'check_violation', hint = 'wrong_status';
  end if;
  v_tb := public.acc_trial_balance(p_org_id, v_entity, p_as_at, p_as_at);
  v_earlier := coalesce((v_tb ->> 'earlier_years_pl')::numeric, 0);
  select a.id into v_re from public.acc_accounts a
   where a.org_id = p_org_id and a.control = 'retained_earnings' and not a.is_group order by a.code limit 1;

  with pulse_raw as (
    select (x ->> 'account_id')::uuid as id, (x ->> 'closing')::numeric as closing from jsonb_array_elements(v_tb -> 'rows') x
    union all
    select v_re, v_earlier where v_re is not null and v_earlier <> 0
  ), pulse as (
    select p.id, sum(p.closing) as closing from pulse_raw p join public.acc_accounts a on a.id = p.id and not a.is_group
    group by p.id
  ), tally_raw as (
    select btrim(x ->> 'name') as name,
           coalesce(nullif(x ->> 'debit', '')::numeric, 0) - coalesce(nullif(x ->> 'credit', '')::numeric, 0) as bal
    from jsonb_array_elements(p_rows) x
    where nullif(btrim(x ->> 'name'), '') is not null
  ), tally as (
    select t.name, t.bal,
           case when lower(t.name) = 'profit & loss a/c' then v_re
                else (select a.id from public.acc_accounts a where a.org_id = p_org_id and not a.is_group
                        and lower(btrim(a.name)) = lower(t.name)) end as account_id,
           exists (select 1 from public.acc_accounts a where a.org_id = p_org_id and a.is_group
                     and lower(btrim(a.name)) = lower(t.name)) as is_group_row
    from tally_raw t
  ), tally_led as (
    select account_id, min(name) as name, sum(bal) as bal from tally where not (is_group_row and account_id is null)
    group by account_id, case when account_id is null then lower(name) end
  ), cmp as (
    select coalesce(t.account_id, p.id) as account_id, t.name as tally_name,
           coalesce(p.closing, 0) as pulse, coalesce(t.bal, 0) as tally
    from tally_led t
    full join pulse p on p.id = t.account_id
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'account_id', c.account_id, 'code', a.code, 'name', coalesce(a.name, c.tally_name), 'tally_name', c.tally_name,
      'pulse', c.pulse, 'tally', c.tally, 'difference', c.pulse - c.tally) order by a.code nulls last, c.tally_name)
      filter (where c.pulse <> c.tally), '[]'::jsonb),
    count(*),
    count(*) filter (where c.pulse <> c.tally),
    coalesce(sum(abs(c.pulse - c.tally)), 0)
  into v_rows, v_compared, v_diffs, v_total
  from cmp c left join public.acc_accounts a on a.id = c.account_id;
  select count(*) into v_groups from jsonb_array_elements(p_rows) x
   where exists (select 1 from public.acc_accounts a where a.org_id = p_org_id and a.is_group
                   and lower(btrim(a.name)) = lower(btrim(x ->> 'name')));

  if jsonb_array_length(v_rows) > 2000 then
    select jsonb_agg(x) into v_rows from (select x from jsonb_array_elements(v_rows) x limit 2000) s;
  end if;
  insert into public.acc_tally_reconciliations (org_id, entity_id, import_id, as_at, file_sha256, compared, differences,
                                                total_difference, reconciled, rows, created_by)
  values (p_org_id, v_entity, p_import_id, p_as_at, p_file_sha256, v_compared, v_diffs, v_total, v_diffs = 0, v_rows, p_user_id)
  returning id into v_id;
  if v_diffs = 0 and p_import_id is not null then
    update public.acc_tally_imports set reconciled_at = now(), reconciled_by = p_user_id where id = p_import_id;
  end if;
  return jsonb_build_object('id', v_id, 'as_at', p_as_at, 'compared', v_compared, 'differences', v_diffs,
                            'total_difference', v_total, 'reconciled', v_diffs = 0, 'group_rows_ignored', v_groups,
                            'rows', v_rows);
end;
$$;
revoke all on function public.acc_tally_reconcile(uuid, uuid, uuid, uuid, date, text, jsonb) from public, anon, authenticated;
grant execute on function public.acc_tally_reconcile(uuid, uuid, uuid, uuid, date, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 10. After a clean reconciliation, the imported months can be closed and locked (accounting.import and
--     accounting.periods.manage). Adjustment periods are left alone (the year-end close posts there).
-- ---------------------------------------------------------------------------
create or replace function public.acc_tally_lock_periods(p_org_id uuid, p_import_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  imp public.acc_tally_imports;
  v_from date;
  v_to date;
  v_month date;
  v_period uuid;
  v_status text;
  v_locked integer := 0;
begin
  imp := app.acc_tally_import_for_update(p_org_id, p_import_id, p_user_id, array['committed']);
  if not app.user_has_perm(p_org_id, p_user_id, 'accounting.periods.manage') then
    raise exception 'You cannot lock periods.' using errcode = 'check_violation', hint = 'not_permitted';
  end if;
  if imp.reconciled_at is null then
    raise exception 'Reconcile the import with Tally''s trial balance first.' using errcode = 'check_violation', hint = 'not_reconciled';
  end if;
  v_from := date_trunc('month', coalesce(imp.opening_date, imp.first_date, imp.last_date))::date;
  v_to := coalesce(imp.last_date, imp.opening_date);
  if v_from is null or v_to is null then
    return jsonb_build_object('locked', 0);
  end if;
  v_month := v_from;
  while v_month <= v_to loop
    v_period := public.acc_ensure_period(p_org_id, imp.entity_id, v_month);
    select p.status into v_status from public.acc_periods p where p.id = v_period;
    if v_status = 'open' then
      perform public.acc_set_period_status(p_org_id, v_period, p_user_id, 'closed');
      v_status := 'closed';
    end if;
    if v_status = 'closed' then
      perform public.acc_set_period_status(p_org_id, v_period, p_user_id, 'locked');
      v_locked := v_locked + 1;
    end if;
    v_month := (v_month + interval '1 month')::date;
  end loop;
  update public.acc_tally_imports set periods_locked_at = now() where id = imp.id;
  return jsonb_build_object('locked', v_locked, 'from', v_from, 'to', v_to);
end;
$$;
revoke all on function public.acc_tally_lock_periods(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.acc_tally_lock_periods(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 11. Year-end close
-- ---------------------------------------------------------------------------
-- What closing the year would do, and what stops it: the 12 months, drafts, earlier open years with income or
-- expenses, the retained earnings account, the adjustment period, and the profit or loss per account.
create or replace function public.acc_year_end_preview(p_org_id uuid, p_fiscal_year_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  fy public.acc_fiscal_years;
  v_months jsonb;
  v_open integer;
  v_drafts integer;
  v_prev integer;
  v_re public.acc_accounts;
  v_adj text;
  v_lines jsonb;
  v_result numeric;
  v_closing public.acc_journals;
  v_problems text[] := array[]::text[];
begin
  select * into fy from public.acc_fiscal_years where id = p_fiscal_year_id and org_id = p_org_id;
  if not found then
    raise exception 'Fiscal year not found.' using errcode = 'no_data_found', hint = 'not_found';
  end if;
  select jsonb_agg(jsonb_build_object('month', to_char(m, 'YYYY-MM'), 'status', coalesce(p.status, 'missing')) order by m),
         count(*) filter (where coalesce(p.status, 'missing') not in ('closed', 'locked'))
    into v_months, v_open
  from generate_series(fy.start_date, fy.end_date, interval '1 month') as g (m)
  left join public.acc_periods p on p.entity_id = fy.entity_id and p.start_date = g.m::date and not p.is_adjustment;
  select count(*) into v_drafts from public.acc_journals j
   where j.org_id = p_org_id and j.entity_id = fy.entity_id and j.status = 'draft'
     and j.journal_date between fy.start_date and fy.end_date;
  select count(*) into v_prev from public.acc_fiscal_years f
   where f.entity_id = fy.entity_id and f.start_date < fy.start_date and f.status = 'open'
     and exists (select 1 from public.acc_journals j join public.acc_journal_lines l on l.journal_id = j.id
                 join public.acc_accounts a on a.id = l.account_id
                 where j.entity_id = f.entity_id and j.status in ('posted', 'reversed') and a.nature in ('income', 'expense')
                   and j.journal_date between f.start_date and f.end_date);
  select * into v_re from public.acc_accounts a
   where a.org_id = p_org_id and a.control = 'retained_earnings' and not a.is_group and a.is_active
     and (a.entity_id is null or a.entity_id = fy.entity_id)
   order by a.code limit 1;
  select p.status into v_adj from public.acc_periods p where p.fiscal_year_id = fy.id and p.is_adjustment;
  with bal as (
    select l.account_id, sum(l.debit - l.credit) as b
    from public.acc_journal_lines l
    join public.acc_journals j on j.id = l.journal_id
    join public.acc_accounts a on a.id = l.account_id
    where j.org_id = p_org_id and j.entity_id = fy.entity_id and j.status in ('posted', 'reversed')
      and j.journal_date between fy.start_date and fy.end_date and a.nature in ('income', 'expense')
    group by l.account_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('account_id', a.id, 'code', a.code, 'name', a.name, 'nature', a.nature,
                                               'balance', b.b) order by a.code) filter (where b.b <> 0), '[]'::jsonb),
         coalesce(sum(b.b), 0)
    into v_lines, v_result
  from bal b join public.acc_accounts a on a.id = b.account_id;
  if fy.closing_journal_id is not null then
    select * into v_closing from public.acc_journals where id = fy.closing_journal_id;
  end if;
  if fy.status = 'closed' then v_problems := array_append(v_problems, 'year_closed'); end if;
  if v_open > 0 then v_problems := array_append(v_problems, 'periods_open'); end if;
  if v_drafts > 0 then v_problems := array_append(v_problems, 'drafts_waiting'); end if;
  if v_prev > 0 then v_problems := array_append(v_problems, 'previous_year_open'); end if;
  if v_re.id is null then v_problems := array_append(v_problems, 'no_retained_earnings'); end if;
  if v_adj = 'locked' then v_problems := array_append(v_problems, 'adjustment_locked'); end if;
  if jsonb_array_length(v_lines) > 498 then v_problems := array_append(v_problems, 'too_many_lines'); end if;
  return jsonb_build_object(
    'fiscal_year', jsonb_build_object('id', fy.id, 'label', fy.label, 'start_date', fy.start_date, 'end_date', fy.end_date,
                                      'status', fy.status, 'closed_at', fy.closed_at, 'closed_by', fy.closed_by,
                                      'entity_id', fy.entity_id),
    'months', v_months, 'open_months', v_open, 'drafts', v_drafts, 'previous_open', v_prev,
    'adjustment_period', v_adj,
    'retained_earnings', case when v_re.id is null then null else jsonb_build_object('id', v_re.id, 'code', v_re.code, 'name', v_re.name) end,
    -- positive = a loss (expenses above income), negative = a profit, as debit minus credit
    'result', v_result, 'lines', v_lines,
    'closing_journal', case when v_closing.id is null then null
                            else jsonb_build_object('id', v_closing.id, 'number', v_closing.number, 'status', v_closing.status) end,
    'problems', to_jsonb(v_problems));
end;
$$;
revoke all on function public.acc_year_end_preview(uuid, uuid) from public, anon, authenticated;
grant execute on function public.acc_year_end_preview(uuid, uuid) to service_role;

-- Creates any missing month of the year and closes every open one (accounting.periods.manage).
create or replace function public.acc_year_end_close_months(p_org_id uuid, p_fiscal_year_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  fy public.acc_fiscal_years;
  v_period uuid;
  v_status text;
  v_closed integer := 0;
begin
  if not app.user_has_perm(p_org_id, p_user_id, 'accounting.periods.manage') then
    raise exception 'You cannot close periods.' using errcode = 'check_violation', hint = 'not_permitted';
  end if;
  select * into fy from public.acc_fiscal_years where id = p_fiscal_year_id and org_id = p_org_id;
  if not found then
    raise exception 'Fiscal year not found.' using errcode = 'no_data_found', hint = 'not_found';
  end if;
  for m in 0..11 loop
    v_period := public.acc_ensure_period(p_org_id, fy.entity_id, (fy.start_date + make_interval(months => m))::date);
    select p.status into v_status from public.acc_periods p where p.id = v_period;
    if v_status = 'open' then
      perform public.acc_set_period_status(p_org_id, v_period, p_user_id, 'closed');
      v_closed := v_closed + 1;
    end if;
  end loop;
  return jsonb_build_object('closed', v_closed);
end;
$$;
revoke all on function public.acc_year_end_close_months(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.acc_year_end_close_months(uuid, uuid, uuid) to service_role;

-- Posts the closing journal (source 'year_end', id = the fiscal year, dated its last day, in its adjustment period):
-- every income and expense balance to zero, the net to retained earnings; then closes the adjustment period and the
-- year. Refused while any problem of the preview stands.
create or replace function public.acc_year_end_close(p_org_id uuid, p_fiscal_year_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  fy public.acc_fiscal_years;
  v_preview jsonb;
  v_problem text;
  v_lines jsonb;
  v_result numeric;
  v_re uuid;
  v_journal uuid;
  v_version integer;
  v_res jsonb := null;
begin
  if not app.user_has_perm(p_org_id, p_user_id, 'accounting.periods.manage') then
    raise exception 'You cannot run the year-end close.' using errcode = 'check_violation', hint = 'not_permitted';
  end if;
  select * into fy from public.acc_fiscal_years where id = p_fiscal_year_id and org_id = p_org_id for update;
  if not found then
    raise exception 'Fiscal year not found.' using errcode = 'no_data_found', hint = 'not_found';
  end if;
  v_preview := public.acc_year_end_preview(p_org_id, fy.id);
  v_problem := v_preview -> 'problems' ->> 0;
  if v_problem is not null then
    raise exception 'The year cannot be closed yet (%).', v_problem using errcode = 'check_violation', hint = v_problem;
  end if;
  v_result := (v_preview ->> 'result')::numeric;
  v_re := (v_preview -> 'retained_earnings' ->> 'id')::uuid;
  if jsonb_array_length(v_preview -> 'lines') > 0 then
    select jsonb_agg(jsonb_build_object('account_id', x ->> 'account_id',
                                        'debit', greatest(-(x ->> 'balance')::numeric, 0),
                                        'credit', greatest((x ->> 'balance')::numeric, 0),
                                        'description', 'Year-end close') order by x ->> 'code')
      into v_lines from jsonb_array_elements(v_preview -> 'lines') x;
    if v_result <> 0 then
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', v_re, 'debit', greatest(v_result, 0), 'credit', greatest(-v_result, 0),
        'description', case when v_result > 0 then 'Loss for the year' else 'Profit for the year' end));
    end if;
    select coalesce(max(j.source_version), 0) + 1 into v_version from public.acc_journals j
     where j.org_id = p_org_id and j.source_kind = 'year_end' and j.source_id = fy.id::text;
    insert into public.acc_journals (org_id, entity_id, voucher_type, journal_date, narration, source_kind, source_id,
                                     source_version, prepared_by, is_adjustment)
    values (p_org_id, fy.entity_id, 'journal', fy.end_date,
            'Year-end close ' || fy.label || ': income and expenses to retained earnings',
            'year_end', fy.id::text, v_version, p_user_id, true)
    returning id into v_journal;
    perform app.acc_write_lines(p_org_id, v_journal, v_lines);
    v_res := app.acc_post_internal(v_journal, p_user_id);
  end if;
  perform app.acc_ensure_adjustment_period(p_org_id, fy.entity_id, fy.end_date);
  update public.acc_periods set status = 'closed', closed_by = p_user_id, closed_at = now()
   where fiscal_year_id = fy.id and is_adjustment and status = 'open';
  update public.acc_fiscal_years
     set status = 'closed', closed_by = p_user_id, closed_at = now(), closing_journal_id = v_journal
   where id = fy.id;
  return jsonb_build_object('fiscal_year_id', fy.id, 'label', fy.label, 'result', v_result,
                            'journal_id', v_journal, 'number', v_res ->> 'number',
                            'lines', coalesce(jsonb_array_length(v_lines), 0));
end;
$$;
revoke all on function public.acc_year_end_close(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.acc_year_end_close(uuid, uuid, uuid) to service_role;

-- Re-opens a closed year by reversing its closing journal (dated the same day, same adjustment period), with a reason.
create or replace function public.acc_year_end_reopen(p_org_id uuid, p_fiscal_year_id uuid, p_user_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  fy public.acc_fiscal_years;
  j public.acc_journals;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_res jsonb := null;
begin
  if not app.user_has_perm(p_org_id, p_user_id, 'accounting.periods.manage') then
    raise exception 'You cannot re-open a year.' using errcode = 'check_violation', hint = 'not_permitted';
  end if;
  select * into fy from public.acc_fiscal_years where id = p_fiscal_year_id and org_id = p_org_id for update;
  if not found then
    raise exception 'Fiscal year not found.' using errcode = 'no_data_found', hint = 'not_found';
  end if;
  if fy.status <> 'closed' then
    raise exception 'The year is not closed.' using errcode = 'check_violation', hint = 'wrong_status';
  end if;
  if v_reason is null or char_length(v_reason) < 3 then
    raise exception 'Say why the year is re-opened.' using errcode = 'check_violation', hint = 'remarks_required';
  end if;
  if exists (select 1 from public.acc_fiscal_years f where f.entity_id = fy.entity_id and f.start_date > fy.start_date
             and f.status = 'closed') then
    raise exception 'Re-open the later year first.' using errcode = 'check_violation', hint = 'later_year_closed';
  end if;
  if fy.closing_journal_id is not null then
    select * into j from public.acc_journals where id = fy.closing_journal_id;
    if j.status = 'posted' then
      perform set_config('app.acc_year_ctx', 'reopen:' || fy.id::text, true);
      v_res := app.acc_reverse_internal(p_org_id, j.id, p_user_id, j.journal_date, left('Year re-opened: ' || v_reason, 200));
      perform set_config('app.acc_year_ctx', '', true);
    end if;
  end if;
  update public.acc_fiscal_years set status = 'open', closed_by = null, closed_at = null, closing_journal_id = null
   where id = fy.id;
  return jsonb_build_object('fiscal_year_id', fy.id, 'label', fy.label, 'reversal_id', v_res ->> 'id',
                            'reversal_number', v_res ->> 'number');
end;
$$;
revoke all on function public.acc_year_end_reopen(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.acc_year_end_reopen(uuid, uuid, uuid, text) to service_role;

insert into supabase_migrations.schema_migrations (version, name) values ('20261109000600', 'accounting_tally_import') on conflict (version) do nothing;
