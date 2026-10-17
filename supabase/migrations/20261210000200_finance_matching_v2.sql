-- Matching engine v2 (docs/46_FINANCE_RECORDS_AND_MATCHING.md section 3, docs/46_PHASE_46_NOTES.md).
--
-- The monthly bank reconciliation (20C) stays as it is. This adds the open-item side for INSURER money, where a payment
-- reference covers many claims, a deposit can pay several references, one reference can be paid in parts and money
-- arrives months later:
--   * fin_receipts            the receipt register: one row per insurer payment (payment reference, amount, bank receipt)
--   * fin_match_decisions     every decision, accepted (an ALLOCATION of part of a bank credit to part of an item) or
--                             rejected, by a rule or a person, undoable; the history that measures each rule
--   * fin_payer_aliases       narrative words that identify a payer; learned from confirmed matches, used once approved
--   * fin_match_rule_status   which rule may match automatically (off by default; switched on rule by rule)
--   * fin_item_closures       an item left open is closed only by a write-off with a reason, or cancelled
--   * thresholds              fin_ref_finance_settings.match_* (never constants in code)
--
-- An "item" is an insurer payment, keyed `ins|<ref_key>` (ref_key = the payment reference without spaces, punctuation
-- and leading zeros, see fin_ref_key / lib/finance/match-keys.ts). Items are derived from fin_receipts and the
-- remittance batches; they are not stored, only their allocations and closures are. The invariants live HERE (triggers),
-- not only in the UI: a bank credit is never allocated beyond its amount, an item never beyond its total, a closed item
-- takes no more money, and a decision is only ever undone, never edited or deleted.

-- ---------------------------------------------------------------------------
-- 1. Permissions for existing system roles (new orgs get them from lib/auth/permissions.ts)
-- ---------------------------------------------------------------------------
do $$
declare
  g record;
begin
  for g in
    select * from (values
      ('Finance', 'finance.matching.view'),
      ('Finance', 'finance.matching.manage'),
      ('Finance Manager', 'finance.matching.view'),
      ('Finance Manager', 'finance.matching.manage'),
      ('Finance Manager', 'finance.matching.approve'),
      ('Revenue & Collections', 'finance.matching.view'),
      ('Revenue & Collections', 'finance.matching.manage'),
      ('CEO', 'finance.matching.view')
    ) as t (role_name, perm)
  loop
    update public.roles r
       set permissions = r.permissions || to_jsonb(g.perm)
     where r.is_system and r.name = g.role_name and not (r.permissions ? g.perm);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Thresholds
-- ---------------------------------------------------------------------------
alter table public.fin_ref_finance_settings
  add column match_ref_min_length integer not null default 5 check (match_ref_min_length between 3 and 20),
  add column match_set_max_items integer not null default 4 check (match_set_max_items between 1 and 8),
  add column match_item_look_back_days integer not null default 90 check (match_item_look_back_days between 0 and 365),
  add column match_auto_min_precision numeric(5, 2) not null default 99.00 check (match_auto_min_precision between 50 and 100),
  add column match_auto_min_months integer not null default 2 check (match_auto_min_months between 1 and 12),
  add column match_auto_min_decisions integer not null default 20 check (match_auto_min_decisions between 1 and 1000);

-- ---------------------------------------------------------------------------
-- 3. The reference key (one definition; lib/finance/match-keys.ts mirrors it and a test compares them)
-- ---------------------------------------------------------------------------
create or replace function public.fin_ref_key(p_ref text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(regexp_replace(upper(regexp_replace(coalesce(p_ref, ''), '[^A-Za-z0-9]', '', 'g')), '^0+', ''), '');
$$;
grant execute on function public.fin_ref_key(text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. The receipt register
-- ---------------------------------------------------------------------------
alter table public.fin_import_formats drop constraint fin_import_formats_kind_check;
alter table public.fin_import_formats add constraint fin_import_formats_kind_check
  check (kind in ('bank_statement', 'settlement', 'lab_activity', 'provider_invoice', 'receipt_register'));
alter table public.fin_bank_imports drop constraint fin_bank_imports_kind_check;
alter table public.fin_bank_imports add constraint fin_bank_imports_kind_check
  check (kind in ('bank_statement', 'settlement', 'receipt_register'));
drop policy fin_import_formats_select on public.fin_import_formats;
create policy fin_import_formats_select on public.fin_import_formats for select to authenticated
  using (app.has_perm(org_id, 'finance.bank.view') or app.has_perm(org_id, 'finance.bank.manage')
      or app.has_perm(org_id, 'finance.bank.signoff')
      or app.has_perm(org_id, 'finance.labs.view') or app.has_perm(org_id, 'finance.labs.manage')
      or app.has_perm(org_id, 'finance.matching.view') or app.has_perm(org_id, 'finance.matching.manage'));
drop policy fin_bank_imports_select on public.fin_bank_imports;
create policy fin_bank_imports_select on public.fin_bank_imports for select to authenticated
  using (app.has_perm(org_id, 'finance.bank.view') or app.has_perm(org_id, 'finance.bank.manage')
      or app.has_perm(org_id, 'finance.bank.signoff')
      or app.has_perm(org_id, 'finance.matching.view') or app.has_perm(org_id, 'finance.matching.manage'));

create table public.fin_receipts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  import_id uuid not null references public.fin_bank_imports (id) on delete cascade,
  row_no integer not null,
  payment_ref text not null check (char_length(btrim(payment_ref)) between 1 and 80),   -- as written (redacted before storage)
  ref_key text not null check (ref_key ~ '^[A-Z0-9]{1,80}$'),
  payer_key text check (payer_key is null or char_length(payer_key) between 1 and 60),   -- upper-case, trimmed
  amount numeric(14, 2) not null check (amount > 0),
  receipt_date date not null,
  receipt_no text check (receipt_no is null or char_length(receipt_no) <= 60),
  bank_name text check (bank_name is null or char_length(bank_name) <= 60),
  created_at timestamptz not null default now(),
  unique (import_id, row_no),
  unique (org_id, ref_key)                                       -- one row per insurer payment
);
create index fin_receipts_org_date_idx on public.fin_receipts (org_id, receipt_date desc);
create trigger fin_receipts_import_org_check before insert or update of import_id, org_id on public.fin_receipts
  for each row execute function app.check_parent_org('fin_bank_imports', 'import_id');

-- Stores one parsed receipt register atomically. p_rows are the sanitised rows the server parsed (payment_ref, amount,
-- receipt_date, optional payer, receipt_no, bank_name). The same file twice (sha256) is refused. A payment reference
-- already stored with the same amount and date is skipped (month files overlap); with a DIFFERENT amount it refuses the
-- whole file, so a changed figure is never silently kept or overwritten.
create or replace function public.fin_receipts_import(
  p_org_id uuid, p_format_id uuid, p_file_name text, p_sha256 text, p_rows jsonb, p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_conflicts integer;
  v_inserted integer;
  v_dup integer;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 20000 then
    raise exception 'an import holds 1 to 20000 rows' using errcode = 'invalid_parameter_value';
  end if;
  if p_format_id is not null and not exists (
    select 1 from public.fin_import_formats f where f.id = p_format_id and f.org_id = p_org_id and f.kind = 'receipt_register') then
    raise exception 'format not found' using errcode = 'invalid_parameter_value';
  end if;

  create temporary table pg_temp.fin_receipts_in on commit drop as
    select x.n::integer as row_no, left(btrim(x.r ->> 'payment_ref'), 80) as payment_ref,
           public.fin_ref_key(x.r ->> 'payment_ref') as ref_key,
           nullif(upper(left(btrim(coalesce(x.r ->> 'payer', '')), 60)), '') as payer_key,
           (x.r ->> 'amount')::numeric(14, 2) as amount, (x.r ->> 'receipt_date')::date as receipt_date,
           nullif(left(btrim(coalesce(x.r ->> 'receipt_no', '')), 60), '') as receipt_no,
           nullif(left(btrim(coalesce(x.r ->> 'bank_name', '')), 60), '') as bank_name
    from jsonb_array_elements(p_rows) with ordinality as x (r, n);

  if exists (select 1 from pg_temp.fin_receipts_in where ref_key is null or amount is null or amount <= 0 or receipt_date is null) then
    raise exception 'every row needs a payment reference, a positive amount and a date' using errcode = 'check_violation';
  end if;
  -- the same reference twice in one file with different figures
  if exists (select 1 from pg_temp.fin_receipts_in group by ref_key having count(distinct (amount, receipt_date)) > 1) then
    raise exception 'a payment reference appears twice in the file with different figures' using errcode = 'check_violation';
  end if;
  select count(*) into v_conflicts
  from (select distinct ref_key, amount from pg_temp.fin_receipts_in) i
  join public.fin_receipts r on r.org_id = p_org_id and r.ref_key = i.ref_key and r.amount <> i.amount;
  if v_conflicts > 0 then
    raise exception '% payment reference(s) are already stored with a different amount', v_conflicts using errcode = 'check_violation';
  end if;

  insert into public.fin_bank_imports (org_id, kind, format_id, file_name, file_sha256, row_count, sum_credits, first_date, last_date, imported_by)
  select p_org_id, 'receipt_register', p_format_id, left(p_file_name, 200), p_sha256, count(*), coalesce(sum(amount), 0),
         min(receipt_date), max(receipt_date), p_user
  from pg_temp.fin_receipts_in
  returning id into v_id;

  insert into public.fin_receipts (org_id, import_id, row_no, payment_ref, ref_key, payer_key, amount, receipt_date, receipt_no, bank_name)
  select distinct on (i.ref_key) p_org_id, v_id, i.row_no, i.payment_ref, i.ref_key, i.payer_key, i.amount, i.receipt_date, i.receipt_no, i.bank_name
  from pg_temp.fin_receipts_in i
  where not exists (select 1 from public.fin_receipts r where r.org_id = p_org_id and r.ref_key = i.ref_key)
  order by i.ref_key, i.row_no;
  get diagnostics v_inserted = row_count;
  select count(*) into v_dup from (select distinct ref_key from pg_temp.fin_receipts_in) d;

  return jsonb_build_object('import_id', v_id, 'inserted', v_inserted, 'already_stored', v_dup - v_inserted);
end;
$$;
revoke all on function public.fin_receipts_import(uuid, uuid, text, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.fin_receipts_import(uuid, uuid, text, text, jsonb, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Payer aliases
-- ---------------------------------------------------------------------------
create table public.fin_payer_aliases (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  payer_key text not null check (char_length(payer_key) between 1 and 60),
  alias text not null check (char_length(alias) between 3 and 60 and alias = upper(alias)),   -- normalised: see lib/finance/match-keys.ts
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'retired')),
  proposed_by uuid references public.profiles (id) on delete set null,
  proposed_at timestamptz not null default now(),
  decided_by uuid references public.profiles (id) on delete set null,
  decided_at timestamptz,
  unique (org_id, payer_key, alias),
  check ((status = 'proposed') = (decided_at is null))
);
create index fin_payer_aliases_org_idx on public.fin_payer_aliases (org_id, status);

-- ---------------------------------------------------------------------------
-- 6. Decisions (allocations and rejections) and closures
-- ---------------------------------------------------------------------------
create table public.fin_match_decisions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  bank_line_id uuid not null references public.fin_bank_lines (id) on delete restrict,
  item_ref text not null check (item_ref ~ '^ins\|[A-Za-z0-9:_-]{1,90}$'),
  item_total numeric(14, 2) not null check (item_total > 0),   -- the item's total when decided (a receipt does not change)
  amount numeric(14, 2) not null check (amount >= 0),          -- part of the bank credit allocated to the item
  rule text not null check (rule in ('reference', 'payer_sum', 'amount_date', 'manual')),
  score integer not null default 0 check (score between 0 and 100),
  reasons jsonb not null default '[]'::jsonb check (jsonb_typeof(reasons) = 'array'),
  decision text not null check (decision in ('accepted', 'rejected')),
  auto boolean not null default false,
  alias_id uuid references public.fin_payer_aliases (id) on delete set null,   -- the approved alias that recognised the payer
  decided_by uuid references public.profiles (id) on delete set null,
  decided_at timestamptz not null default now(),
  undone_at timestamptz,
  undone_by uuid references public.profiles (id) on delete set null,
  check ((decision = 'accepted') = (amount > 0)),
  check (not auto or decision = 'accepted'),
  check (amount <= item_total)
);
create unique index fin_match_decisions_active_pair_uidx
  on public.fin_match_decisions (org_id, bank_line_id, item_ref, decision) where undone_at is null;
create index fin_match_decisions_line_idx on public.fin_match_decisions (bank_line_id) where undone_at is null;
create index fin_match_decisions_item_idx on public.fin_match_decisions (org_id, item_ref) where undone_at is null;
create index fin_match_decisions_rule_idx on public.fin_match_decisions (org_id, rule, decided_at);
create trigger fin_match_decisions_line_org_check before insert or update of bank_line_id, org_id on public.fin_match_decisions
  for each row execute function app.check_parent_org('fin_bank_lines', 'bank_line_id');
create trigger fin_match_decisions_alias_org_check before insert or update of alias_id, org_id on public.fin_match_decisions
  for each row execute function app.check_parent_org('fin_payer_aliases', 'alias_id');

create table public.fin_item_closures (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  item_ref text not null check (item_ref ~ '^ins\|[A-Za-z0-9:_-]{1,90}$'),
  item_total numeric(14, 2) not null check (item_total > 0),
  kind text not null check (kind in ('write_off', 'cancelled')),
  amount numeric(14, 2) not null check (amount >= 0),          -- written off: the remainder at that moment
  reason_code text not null check (reason_code in ('insurer_short_paid', 'insurer_rejected', 'duplicate_entry', 'entered_in_error', 'other')),
  note text check (note is null or char_length(note) <= 200),
  decided_by uuid references public.profiles (id) on delete set null,
  decided_at timestamptz not null default now(),
  undone_at timestamptz,
  undone_by uuid references public.profiles (id) on delete set null,
  check ((kind = 'write_off') = (amount > 0)),
  check (reason_code <> 'other' or char_length(btrim(coalesce(note, ''))) > 0)
);
create unique index fin_item_closures_active_uidx on public.fin_item_closures (org_id, item_ref) where undone_at is null;

create table public.fin_match_rule_status (
  org_id uuid not null references public.orgs (id) on delete cascade,
  rule text not null check (rule in ('reference', 'payer_sum')),   -- amount_date and manual never match automatically
  auto_enabled boolean not null default false,
  set_by uuid references public.profiles (id) on delete set null,
  set_at timestamptz not null default now(),
  primary key (org_id, rule)
);

-- ---------------------------------------------------------------------------
-- 7. Guards (run for every role, including the service role)
-- ---------------------------------------------------------------------------
create or replace function app.fin_match_decision_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_line_amount numeric;
  v_line_org uuid;
  v_used_line numeric;
  v_used_item numeric;
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.orgs o where o.id = old.org_id) then
      raise exception 'a matching decision cannot be deleted; undo it' using errcode = '42501';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' then
    -- only "undone" may be set, once; the FK action that nulls a deleted user or alias is always allowed
    if (to_jsonb(new) - 'undone_at' - 'undone_by' - 'decided_by' - 'alias_id')
       is distinct from (to_jsonb(old) - 'undone_at' - 'undone_by' - 'decided_by' - 'alias_id') then
      raise exception 'a matching decision cannot be edited; undo it and decide again' using errcode = 'check_violation';
    end if;
    if old.undone_at is not null and new.undone_at is distinct from old.undone_at then
      raise exception 'this decision is already undone' using errcode = 'check_violation';
    end if;
    -- undoing an allocation would change the remainder a write-off was made for
    if old.undone_at is null and new.undone_at is not null and old.decision = 'accepted'
       and exists (select 1 from public.fin_item_closures c
                   where c.org_id = old.org_id and c.item_ref = old.item_ref and c.undone_at is null) then
      raise exception 'the item is closed; reopen it before undoing an allocation' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- INSERT
  if new.undone_at is not null then
    raise exception 'a decision starts active' using errcode = 'check_violation';
  end if;
  if new.decision = 'accepted' then
    select l.amount, l.org_id into v_line_amount, v_line_org from public.fin_bank_lines l where l.id = new.bank_line_id for update;
    if v_line_amount is null or v_line_org is distinct from new.org_id then
      raise exception 'bank line not found' using errcode = 'check_violation';
    end if;
    if v_line_amount <= 0 then
      raise exception 'only a credit can be allocated' using errcode = 'check_violation';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(new.org_id::text || '|' || new.item_ref, 0));
    select coalesce(sum(d.amount), 0) into v_used_line
      from public.fin_match_decisions d where d.bank_line_id = new.bank_line_id and d.decision = 'accepted' and d.undone_at is null;
    if v_used_line + new.amount > v_line_amount then
      raise exception 'the bank credit is already allocated (% of % used)', v_used_line, v_line_amount using errcode = 'check_violation';
    end if;
    select coalesce(sum(d.amount), 0) into v_used_item
      from public.fin_match_decisions d where d.org_id = new.org_id and d.item_ref = new.item_ref and d.decision = 'accepted' and d.undone_at is null;
    if v_used_item + new.amount > new.item_total then
      raise exception 'the item is already paid (% of % used)', v_used_item, new.item_total using errcode = 'check_violation';
    end if;
    if exists (select 1 from public.fin_item_closures c where c.org_id = new.org_id and c.item_ref = new.item_ref and c.undone_at is null) then
      raise exception 'the item is closed; reopen it first' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.fin_match_decision_guard() from public, anon, authenticated;
create trigger fin_match_decisions_guard before insert or update or delete on public.fin_match_decisions
  for each row execute function app.fin_match_decision_guard();

create or replace function app.fin_item_closure_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_used numeric;
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.orgs o where o.id = old.org_id) then
      raise exception 'a closure cannot be deleted; reopen the item' using errcode = '42501';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if (to_jsonb(new) - 'undone_at' - 'undone_by' - 'decided_by') is distinct from (to_jsonb(old) - 'undone_at' - 'undone_by' - 'decided_by') then
      raise exception 'a closure cannot be edited; reopen the item and close it again' using errcode = 'check_violation';
    end if;
    if old.undone_at is not null and new.undone_at is distinct from old.undone_at then
      raise exception 'this closure is already reopened' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if new.undone_at is not null then
    raise exception 'a closure starts active' using errcode = 'check_violation';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(new.org_id::text || '|' || new.item_ref, 0));
  select coalesce(sum(d.amount), 0) into v_used
    from public.fin_match_decisions d where d.org_id = new.org_id and d.item_ref = new.item_ref and d.decision = 'accepted' and d.undone_at is null;
  if new.kind = 'cancelled' and v_used > 0 then
    raise exception 'an item with money allocated cannot be cancelled; undo the allocations first' using errcode = 'check_violation';
  end if;
  if new.kind = 'write_off' and new.amount <> new.item_total - v_used then
    raise exception 'the write-off must be exactly the remainder (% )', new.item_total - v_used using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function app.fin_item_closure_guard() from public, anon, authenticated;
create trigger fin_item_closures_guard before insert or update or delete on public.fin_item_closures
  for each row execute function app.fin_item_closure_guard();

-- A bank line that carries an allocation cannot disappear (the FK is RESTRICT; this gives the clear message first).
-- Nothing else to guard: lines are never edited.

-- ---------------------------------------------------------------------------
-- 8. RLS: staff with a matching permission read their org's rows; nobody writes directly (server actions, service role)
-- ---------------------------------------------------------------------------
alter table public.fin_receipts enable row level security;
alter table public.fin_payer_aliases enable row level security;
alter table public.fin_match_decisions enable row level security;
alter table public.fin_item_closures enable row level security;
alter table public.fin_match_rule_status enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['fin_receipts', 'fin_payer_aliases', 'fin_match_decisions', 'fin_item_closures', 'fin_match_rule_status']
  loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (app.has_perm(org_id, %L) or app.has_perm(org_id, %L) or app.has_perm(org_id, %L))',
      t || '_select', t, 'finance.matching.view', 'finance.matching.manage', 'finance.matching.approve');
  end loop;
end $$;
