-- Phase 22D: the posting engine (docs/22_ACCOUNTING_PLAN.md, slice 22D; notes in docs/22_PHASE_22D_NOTES.md).
--
--   * acc_entities.ledger_start_date: the day Pulse becomes the book of record (OQ-117). Until then Tally is the book of
--     record and the Pulse ledger mirrors it through the Tally import (22I), so EVERY posting dated before the entity's
--     ledger start (or while it is not set) is refused with hint 'before_ledger_start', except source kinds
--     'tally_import' and 'opening' and the reversals of those. Enforced centrally in app.acc_post_internal (manual,
--     source, reversal and automatic-reversal postings all pass there) and early in acc_post_from_source. The date is
--     set by acc_set_ledger_start (accounting.settings.manage); a trigger keeps it from moving earlier, being cleared or
--     moving past a posted Pulse journal once Pulse has posted anything.
--   * acc_posting_rules: data, not code. (kind, key, qualifier) -> account and / or tax code, resolved most specific
--     first by lib/accounting/posting/rules.ts. Seeded onto the 22A default chart, and from the old fin_ref_account_map
--     and fin_ref_tally_ledgers where a value exists (read, never dropped).
--   * acc_posting_settings: the expected-rejection allowance hook (OQ-126, default off), package invoices held (OQ-127),
--     tolerances.
--   * acc_posting_status: one row per sub-ledger item the runner has looked at (posted, waiting with a reason, preview,
--     nothing to post, withdrawn); acc_posting_preview: per item and account, what Pulse WOULD post before the ledger
--     start, so Finance can compare it with the Tally mirror during the parallel run; acc_posting_cursors (service only).
--   * Functions for the runner (lib/jobs/handlers/accounting-post.ts): candidates since a cursor, the sanitised source
--     records (no patient PIN or name, ever), the context (rules, tax codes, known dimensions), and acc_posting_apply,
--     which posts through acc_post_from_source, stores a preview, records the reason an item waits, or reverses the
--     journal of an item that was withdrawn. Never writes a sub-ledger table and never calls Unite.

-- ---------------------------------------------------------------------------
-- 1. Ledger start date
-- ---------------------------------------------------------------------------
alter table public.acc_entities add column ledger_start_date date
  check (ledger_start_date is null or ledger_start_date between date '2000-01-01' and date '2999-12-01');
comment on column public.acc_entities.ledger_start_date is
  'The first day Pulse is the book of record (OQ-117). Before it (or while null) only Tally-import and opening journals post.';

-- May a journal of this kind be posted on this date for this entity? Tally-import and opening journals (and their
-- reversals) always may; everything else only on or after the entity's ledger start.
create or replace function app.acc_ledger_start_ok(p_entity_id uuid, p_date date, p_source_kind text, p_reversal_of uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_start date;
begin
  if p_source_kind in ('tally_import', 'opening') then
    return true;
  end if;
  if p_source_kind = 'reversal' and exists (
    select 1 from public.acc_journals o where o.id = p_reversal_of and o.source_kind in ('tally_import', 'opening')) then
    return true;
  end if;
  select e.ledger_start_date into v_start from public.acc_entities e where e.id = p_entity_id;
  return v_start is not null and p_date >= v_start;
end;
$$;
revoke all on function app.acc_ledger_start_ok(uuid, date, text, uuid) from public, anon, authenticated;

-- Journals that count as "Pulse posted it" (anything but Tally-import and opening journals and their reversals).
create or replace function app.acc_first_pulse_journal(p_entity_id uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select min(j.journal_date)
  from public.acc_journals j
  left join public.acc_journals o on o.id = j.reversal_of
  where j.entity_id = p_entity_id and j.status in ('posted', 'reversed')
    and coalesce(j.source_kind, '') not in ('tally_import', 'opening')
    and not (j.source_kind = 'reversal' and o.source_kind in ('tally_import', 'opening'));
$$;
revoke all on function app.acc_first_pulse_journal(uuid) from public, anon, authenticated;

-- Once Pulse has posted, the ledger start cannot be cleared, moved earlier (Pulse would post a stretch Tally already
-- holds, i.e. twice) or moved past the first Pulse journal (that journal would sit in the Tally stretch). Every role.
create or replace function app.acc_ledger_start_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_first date;
begin
  if new.ledger_start_date is not distinct from old.ledger_start_date then
    return new;
  end if;
  v_first := app.acc_first_pulse_journal(old.id);
  if v_first is null then
    return new;
  end if;
  if new.ledger_start_date is null then
    raise exception 'Pulse has posted journals; the ledger start cannot be cleared.'
      using errcode = 'check_violation', hint = 'ledger_start_in_use';
  end if;
  if old.ledger_start_date is not null and new.ledger_start_date < old.ledger_start_date then
    raise exception 'Pulse has posted journals; the ledger start cannot move earlier (that stretch is in Tally).'
      using errcode = 'check_violation', hint = 'ledger_start_in_use';
  end if;
  if new.ledger_start_date > v_first then
    raise exception 'A Pulse journal is dated % ; the ledger start cannot move past it.', v_first
      using errcode = 'check_violation', hint = 'ledger_start_in_use';
  end if;
  return new;
end;
$$;
revoke all on function app.acc_ledger_start_guard() from public, anon, authenticated;
create trigger acc_entities_ledger_start_guard before update of ledger_start_date on public.acc_entities
  for each row execute function app.acc_ledger_start_guard();

-- The 22A posting function with the ledger-start rule added right after the line validation (everything else unchanged).
create or replace function app.acc_post_internal(p_journal_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  j public.acc_journals;
  p public.acc_periods;
  s public.acc_number_series;
  v_period uuid;
  v_fy_start date;
  v_start_month integer;
  v_number text;
  v_hash text;
  v_total numeric;
begin
  select * into j from public.acc_journals where id = p_journal_id for update;
  if j.status <> 'draft' then
    raise exception 'Only a draft can be posted.' using errcode = 'check_violation', hint = 'wrong_status';
  end if;
  perform app.acc_validate(j.id);
  if not app.acc_ledger_start_ok(j.entity_id, j.journal_date, j.source_kind, j.reversal_of) then
    raise exception 'This journal is dated before the ledger start; until then Tally is the book of record.'
      using errcode = 'check_violation', hint = 'before_ledger_start';
  end if;
  if j.is_adjustment then
    select e.fiscal_year_start_month into v_start_month from public.acc_entities e where e.id = j.entity_id;
    v_fy_start := app.acc_fy_start(v_start_month, j.journal_date);
    if j.journal_date <> (v_fy_start + interval '1 year' - interval '1 day')::date then
      raise exception 'An adjustment journal is dated the last day of the fiscal year.' using errcode = 'check_violation', hint = 'adjustment_date';
    end if;
    if p_user_id is null or not app.user_has_perm(j.org_id, p_user_id, 'accounting.periods.manage') then
      raise exception 'Only someone who manages periods posts to the adjustment period.' using errcode = 'check_violation', hint = 'adjustment_period';
    end if;
    v_period := app.acc_ensure_adjustment_period(j.org_id, j.entity_id, j.journal_date);
  else
    v_period := public.acc_ensure_period(j.org_id, j.entity_id, j.journal_date);
  end if;
  select * into p from public.acc_periods where id = v_period for share;
  if p.status = 'locked' then
    raise exception 'The period of this date is locked.' using errcode = 'check_violation', hint = 'period_locked';
  end if;
  if p.status = 'closed'
     and (p_user_id is null or not app.user_has_perm(j.org_id, p_user_id, 'accounting.periods.manage')) then
    raise exception 'The period of this date is closed.' using errcode = 'check_violation', hint = 'period_closed';
  end if;
  -- the adjustment period is the designed way to adjust a year after its last month was signed off, so the CEO month
  -- lock applies to ordinary periods only
  if not j.is_adjustment and app.fin_month_is_locked(j.org_id, j.journal_date) then
    raise exception 'The month of this date is locked by the CEO sign-off.' using errcode = 'check_violation', hint = 'month_locked';
  end if;

  insert into public.acc_number_series (org_id, entity_id, voucher_type, fiscal_year_id, prefix)
  values (j.org_id, j.entity_id, j.voucher_type, p.fiscal_year_id, app.acc_default_prefix(j.voucher_type))
  on conflict (entity_id, voucher_type, fiscal_year_id) do nothing;
  select * into s from public.acc_number_series
   where entity_id = j.entity_id and voucher_type = j.voucher_type and fiscal_year_id = p.fiscal_year_id
   for update;
  select f.start_date into v_fy_start from public.acc_fiscal_years f where f.id = p.fiscal_year_id;
  v_number := app.acc_format_number(s.prefix, app.acc_fy_code(v_fy_start), s.next_number);
  update public.acc_number_series set next_number = next_number + 1 where id = s.id;

  v_hash := public.acc_journal_compute_hash(j.id);
  select coalesce(sum(l.debit), 0) into v_total from public.acc_journal_lines l where l.journal_id = j.id;
  perform set_config('app.acc_post_ctx', j.id::text, true);
  update public.acc_journals set
    status = 'posted', number = v_number, period_id = p.id, fiscal_year_id = p.fiscal_year_id, posted_at = now(),
    approved_by = p_user_id, sha256 = v_hash, total = v_total
  where id = j.id;
  perform set_config('app.acc_post_ctx', '', true);
  return jsonb_build_object('id', j.id, 'number', v_number, 'status', 'posted', 'sha256', v_hash, 'total', v_total,
                            'journal_date', j.journal_date);
end;
$$;
revoke all on function app.acc_post_internal(uuid, uuid) from public, anon, authenticated;

-- The 22A contract, unchanged except that a posting dated before the ledger start is refused BEFORE anything else
-- happens (so an older version is never reversed for a replacement that cannot post).
create or replace function public.acc_post_from_source(
  p_org_id uuid, p_entity_id uuid, p_source_kind text, p_source_id text, p_source_version integer, p_date date,
  p_voucher_type text, p_narration text, p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entity uuid := p_entity_id;
  v_existing public.acc_journals;
  v_old public.acc_journals;
  v_new uuid;
  v_res jsonb;
  v_narration text := btrim(coalesce(p_narration, ''));
begin
  if p_source_kind is null or p_source_kind = 'reversal' or p_source_kind not in (
    'unite_invoice', 'unite_payment', 'supplier_invoice', 'voucher', 'remittance', 'denial', 'revshare_run', 'lab_charge',
    'cashup', 'settlement', 'bank_line', 'opening', 'tally_import', 'fixed_asset', 'depreciation', 'sales_invoice',
    'receipt', 'payroll') then
    raise exception 'Unknown source kind.' using errcode = 'check_violation', hint = 'source_kind';
  end if;
  if nullif(btrim(coalesce(p_source_id, '')), '') is null or char_length(p_source_id) > 200
     or p_source_version is null or p_source_version < 1 or p_date is null
     or p_voucher_type is null or p_voucher_type not in (
       'journal', 'contra', 'payment', 'receipt', 'sales', 'purchase', 'credit_note', 'debit_note', 'opening')
     or v_narration = '' or char_length(v_narration) > 300 then
    raise exception 'The source, version, date, voucher type and narration are required.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  if v_entity is null then
    select e.id into v_entity from public.acc_entities e where e.org_id = p_org_id and e.is_default;
  end if;
  if not exists (select 1 from public.acc_entities e where e.id = v_entity and e.org_id = p_org_id and e.active) then
    raise exception 'Entity not found.' using errcode = 'check_violation', hint = 'entity_unknown';
  end if;

  -- one caller at a time per source item
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || '|' || p_source_kind || '|' || p_source_id, 22));

  select * into v_existing from public.acc_journals
   where org_id = p_org_id and source_kind = p_source_kind and source_id = p_source_id and source_version = p_source_version;
  if found then
    return jsonb_build_object('id', v_existing.id, 'number', v_existing.number, 'status', v_existing.status,
                              'created', false, 'replaced', null);
  end if;
  if not app.acc_ledger_start_ok(v_entity, p_date, p_source_kind, null) then
    raise exception 'This item is dated before the ledger start; until then Tally is the book of record.'
      using errcode = 'check_violation', hint = 'before_ledger_start';
  end if;
  if exists (select 1 from public.acc_journals
             where org_id = p_org_id and source_kind = p_source_kind and source_id = p_source_id
               and source_version > p_source_version) then
    raise exception 'A newer version of this item is already posted.' using errcode = 'check_violation', hint = 'stale_version';
  end if;
  select * into v_old from public.acc_journals
   where org_id = p_org_id and source_kind = p_source_kind and source_id = p_source_id and status = 'posted';
  if found then
    perform app.acc_reverse_internal(p_org_id, v_old.id, null, greatest(p_date, v_old.journal_date),
                                     'replaced by version ' || p_source_version::text);
  end if;

  insert into public.acc_journals (org_id, entity_id, voucher_type, journal_date, narration, source_kind, source_id,
                                   source_version, tally_guid)
  values (p_org_id, v_entity, p_voucher_type, p_date, v_narration, p_source_kind, p_source_id, p_source_version,
          case when p_source_kind = 'tally_import' then p_source_id end)
  returning id into v_new;
  perform app.acc_write_lines(p_org_id, v_new, p_lines);
  v_res := app.acc_post_internal(v_new, null);
  return v_res || jsonb_build_object('created', true, 'replaced', v_old.id);
end;
$$;
revoke all on function public.acc_post_from_source(uuid, uuid, text, text, integer, date, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.acc_post_from_source(uuid, uuid, text, text, integer, date, text, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Posting rules, settings, status, preview, cursors
-- ---------------------------------------------------------------------------
-- Kinds and what key / qualifier mean (lib/accounting/posting/rules.ts RULE_KINDS holds the same list with labels):
--   revenue (service category / branch) -> income account        service_tax (service category / payer kind) -> tax code
--   receivable (payer kind / payer id)  patient_advance  payment_mode (Unite mode / branch)  discount  write_off
--   credit_note  rounding  vat_output  vat_input  expense (supplier category / branch) -> account [+ tax code]
--   payable (supplier id)  bank (pay-from key or bank account id / branch)  revshare_expense (doctor)  revshare_payable
--   (doctor)  provider_cost (provider kind)  provider_cost_offset (provider kind)  cashup_over_short (branch)
--   bank_charges (payment mode) -> account [+ tax code]  denial_writeoff (payer)  denial_allowance (payer)
-- '*' means "any". The most specific rule wins: (key, qualifier), (key, *), (*, qualifier), (*, *).
create table public.acc_posting_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  kind text not null check (kind in (
    'revenue', 'service_tax', 'receivable', 'patient_advance', 'payment_mode', 'discount', 'write_off', 'credit_note',
    'rounding', 'vat_output', 'vat_input', 'expense', 'payable', 'bank', 'revshare_expense', 'revshare_payable',
    'provider_cost', 'provider_cost_offset', 'cashup_over_short', 'bank_charges', 'denial_writeoff', 'denial_allowance')),
  key text not null default '*' check (char_length(key) between 1 and 80),
  qualifier text not null default '*' check (char_length(qualifier) between 1 and 80),
  account_id uuid references public.acc_accounts (id),
  tax_code_id uuid references public.acc_tax_codes (id),
  note text check (note is null or char_length(note) <= 200),
  origin text not null default 'manual' check (origin in ('seed', 'migrated', 'manual')),
  active boolean not null default true,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, kind, key, qualifier),
  check ((kind = 'service_tax') = (account_id is null)),
  check (kind <> 'service_tax' or tax_code_id is not null),
  check (tax_code_id is null or kind in ('service_tax', 'expense', 'bank_charges'))
);
create index acc_posting_rules_org_idx on public.acc_posting_rules (org_id, kind);
create trigger acc_posting_rules_set_updated_at before update on public.acc_posting_rules
  for each row execute function app.set_updated_at();

-- Keys are stored the way they are matched: trimmed; payment modes and branch qualifiers upper case, payer kinds lower
-- case. The account is an active ledger (not a group) of the same org; the tax code belongs to the org.
create or replace function app.acc_posting_rule_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.org_id is null then
    return new;
  end if;
  new.key := regexp_replace(btrim(coalesce(new.key, '')), '\s+', ' ', 'g');
  new.qualifier := regexp_replace(btrim(coalesce(new.qualifier, '')), '\s+', ' ', 'g');
  if new.key = '' then new.key := '*'; end if;
  if new.qualifier = '' then new.qualifier := '*'; end if;
  if new.kind in ('payment_mode', 'bank_charges') then
    new.key := upper(new.key);
  end if;
  if new.kind = 'receivable' then
    new.key := lower(new.key);
  end if;
  if new.kind = 'service_tax' then
    new.qualifier := lower(new.qualifier);
  end if;
  if new.kind in ('revenue', 'payment_mode', 'expense', 'bank', 'cashup_over_short') then
    new.qualifier := upper(new.qualifier);
  end if;
  if new.kind = 'receivable' and new.key not in ('*', 'insurance', 'self_pay', 'corporate') then
    raise exception 'A receivable rule is for insurance, self_pay or corporate.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  if new.kind = 'service_tax' and new.qualifier not in ('*', 'insurance', 'self_pay', 'corporate') then
    raise exception 'A service VAT rule is for any payer, insurance, self_pay or corporate.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  if new.account_id is not null and not exists (
    select 1 from public.acc_accounts a where a.id = new.account_id and a.org_id = new.org_id and not a.is_group) then
    raise exception 'Choose a ledger account (not a group) of this organisation.' using errcode = 'check_violation', hint = 'account_not_found';
  end if;
  if new.tax_code_id is not null and not exists (
    select 1 from public.acc_tax_codes t where t.id = new.tax_code_id and t.org_id = new.org_id) then
    raise exception 'Tax code not found.' using errcode = 'check_violation', hint = 'tax_code';
  end if;
  return new;
end;
$$;
revoke all on function app.acc_posting_rule_guard() from public, anon, authenticated;
create trigger acc_posting_rules_guard before insert or update on public.acc_posting_rules
  for each row execute function app.acc_posting_rule_guard();

create table public.acc_posting_settings (
  org_id uuid primary key references public.orgs (id) on delete cascade,
  -- OQ-126: a final denial consumes an expected-rejection allowance (contra receivable) instead of the write-off expense.
  -- Only the hook: the monthly allowance estimate is not posted in 22D. Off until Finance and the auditors decide.
  denial_allowance_enabled boolean not null default false,
  -- OQ-127: package invoices wait (contract liability, release per session) until the clinic says how packages work
  package_invoices text not null default 'hold' check (package_invoices in ('hold', 'post')),
  -- invoice total vs the sum of its lines: up to this goes to the rounding account; beyond it the invoice waits
  rounding_tolerance numeric(8, 2) not null default 1.00 check (rounding_tolerance between 0 and 100),
  -- Unite's VAT on a line vs the line's tax code rate
  vat_tolerance numeric(8, 2) not null default 0.05 check (vat_tolerance between 0 and 10),
  -- source kinds the runner leaves alone (an empty list = all)
  paused_sources text[] not null default '{}'
    check (paused_sources <@ array['unite_invoice', 'unite_payment', 'supplier_invoice', 'voucher', 'remittance', 'denial',
                                   'revshare_run', 'lab_charge', 'cashup', 'settlement']::text[]),
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now()
);
create trigger acc_posting_settings_set_updated_at before update on public.acc_posting_settings
  for each row execute function app.set_updated_at();

-- One row per sub-ledger item the runner has looked at. No patient identity: ids (an invoice number is an id), amounts,
-- dates, a reason code and a short detail (rule kind and key, e.g. "revenue: Dermatology").
create table public.acc_posting_status (
  org_id uuid not null references public.orgs (id) on delete cascade,
  source_kind text not null check (source_kind in (
    'unite_invoice', 'unite_payment', 'supplier_invoice', 'voucher', 'remittance', 'denial', 'revshare_run', 'lab_charge',
    'cashup', 'settlement')),
  source_id text not null check (char_length(source_id) between 1 and 200),
  state text not null check (state in ('posted', 'waiting', 'preview', 'nothing', 'withdrawn')),
  reason text check (reason is null or reason ~ '^[a-z_]{1,40}$'),
  detail text check (detail is null or char_length(detail) <= 300),
  source_date date,
  amount numeric(16, 2),
  version integer not null default 0 check (version >= 0),
  content_sha256 text check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
  journal_id uuid references public.acc_journals (id) on delete set null,
  attempts integer not null default 0 check (attempts >= 0),
  first_seen_at timestamptz not null default now(),
  last_attempt_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, source_kind, source_id),
  check ((state = 'waiting') = (reason is not null))
);
create index acc_posting_status_waiting_idx on public.acc_posting_status (org_id, last_attempt_at) where state = 'waiting';
create index acc_posting_status_state_idx on public.acc_posting_status (org_id, state, source_kind);

-- What Pulse WOULD post for an item dated before the ledger start (one row per item and account), replaced whenever the
-- item changes, removed once it posts, is withdrawn or waits. Compared month by month with the ledger (the Tally mirror).
create table public.acc_posting_preview (
  org_id uuid not null references public.orgs (id) on delete cascade,
  source_kind text not null,
  source_id text not null,
  entity_id uuid not null references public.acc_entities (id) on delete cascade,
  month date not null check (month = date_trunc('month', month)::date),
  account_id uuid not null references public.acc_accounts (id) on delete cascade,
  debit numeric(16, 2) not null default 0 check (debit >= 0),
  credit numeric(16, 2) not null default 0 check (credit >= 0),
  primary key (org_id, source_kind, source_id, account_id)
);
create index acc_posting_preview_month_idx on public.acc_posting_preview (org_id, month, account_id);

-- Where the runner got to, per org and source kind (service role only).
create table public.acc_posting_cursors (
  org_id uuid not null references public.orgs (id) on delete cascade,
  source_kind text not null,
  cursor_at timestamptz,
  cursor_id text,
  updated_at timestamptz not null default now(),
  primary key (org_id, source_kind)
);

alter table public.acc_posting_rules enable row level security;
alter table public.acc_posting_settings enable row level security;
alter table public.acc_posting_status enable row level security;
alter table public.acc_posting_preview enable row level security;
alter table public.acc_posting_cursors enable row level security;   -- service role only (no policy)

create policy acc_posting_rules_select on public.acc_posting_rules for select to authenticated using (app.acc_can_view(org_id));
create policy acc_posting_settings_select on public.acc_posting_settings for select to authenticated using (app.acc_can_view(org_id));
create policy acc_posting_status_select on public.acc_posting_status for select to authenticated
  using (app.acc_can_read_journals(org_id));
create policy acc_posting_preview_select on public.acc_posting_preview for select to authenticated
  using (app.acc_can_read_journals(org_id) or app.has_perm(org_id, 'accounting.reports.view'));

-- Indexes the runner's "changed since" queries use on the sub-ledgers (reads only; nothing here writes them).
create index if not exists fin_invoices_org_updated_idx on public.fin_invoices (org_id, updated_at);
create index if not exists fin_invoice_lines_org_updated_idx on public.fin_invoice_lines (org_id, updated_at);
create index if not exists fin_payments_org_updated_idx on public.fin_payments (org_id, updated_at);
create index if not exists ins_claim_activities_org_updated_idx on public.ins_claim_activities (org_id, updated_at);

-- ---------------------------------------------------------------------------
-- 3. Setting the ledger start (accounting.settings.manage; the server action asks for the typed word and audits)
-- ---------------------------------------------------------------------------
create or replace function public.acc_set_ledger_start(p_org_id uuid, p_entity_id uuid, p_user_id uuid, p_date date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  e public.acc_entities;
begin
  if not app.user_has_perm(p_org_id, p_user_id, 'accounting.settings.manage') then
    raise exception 'You cannot change accounting settings.' using errcode = 'check_violation', hint = 'not_permitted';
  end if;
  select * into e from public.acc_entities where id = p_entity_id and org_id = p_org_id for update;
  if not found then
    raise exception 'Entity not found.' using errcode = 'check_violation', hint = 'entity_unknown';
  end if;
  update public.acc_entities set ledger_start_date = p_date where id = e.id;
  -- the runner looks at every item again: what was a preview may now post, and the other way round
  delete from public.acc_posting_cursors c where c.org_id = p_org_id;
  return jsonb_build_object('entity_id', e.id, 'previous', e.ledger_start_date, 'ledger_start_date', p_date);
end;
$$;
revoke all on function public.acc_set_ledger_start(uuid, uuid, uuid, date) from public, anon, authenticated;
grant execute on function public.acc_set_ledger_start(uuid, uuid, uuid, date) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Default rules (idempotent: never overwrites a rule that exists) onto the 22A chart, plus a few ledgers it needs
-- ---------------------------------------------------------------------------
create or replace function app.acc_seed_rule(
  p_org_id uuid, p_kind text, p_key text, p_qualifier text, p_account_code text, p_origin text, p_account_name text default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account uuid;
  v_n integer;
begin
  if p_account_code is not null then
    select a.id into v_account from public.acc_accounts a
     where a.org_id = p_org_id and a.code = upper(btrim(p_account_code)) and not a.is_group and a.is_active;
  end if;
  if v_account is null and p_account_name is not null then
    select a.id into v_account from public.acc_accounts a
     where a.org_id = p_org_id and lower(btrim(a.name)) = lower(btrim(p_account_name)) and not a.is_group and a.is_active;
  end if;
  if p_kind is null or v_account is null or nullif(btrim(coalesce(p_key, '')), '') is null then
    return 0;
  end if;
  insert into public.acc_posting_rules (org_id, kind, key, qualifier, account_id, origin)
  values (p_org_id, p_kind, left(btrim(p_key), 80), left(coalesce(nullif(btrim(p_qualifier), ''), '*'), 80), v_account, p_origin)
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function app.acc_seed_rule(uuid, text, text, text, text, text, text) from public, anon, authenticated;

-- Which revenue account a service category most likely belongs to (an account mapping, never a tax treatment).
create or replace function app.acc_guess_revenue_account(p_category text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_category ~* 'consult' then '4100'
    when p_category ~* '(lab|patholog)' then '4120'
    when p_category ~* '(pharm|drug)' then '4130'
    when p_category ~* '(procedure|surg)' then '4110'
    else '4190' end;
$$;

create or replace function app.acc_guess_expense_account(p_category text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_category ~* 'rent' then '6200'
    when p_category ~* '(utilit|electric|water|dewa)' then '6300'
    when p_category ~* '(salar|payroll|wage)' then '6100'
    when p_category ~* '(consumable|medical suppl)' then '5120'
    when p_category ~* '(lab|referral|patholog)' then '5100'
    when p_category ~* '(bank charge|card charge)' then '6500'
    else null end;
$$;

create or replace function public.acc_seed_posting_rules(p_org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer := 0;
  v_accounts integer := 0;
  r record;
  v_code text;
begin
  if not exists (select 1 from public.acc_entities e where e.org_id = p_org_id and e.is_default) then
    return jsonb_build_object('rules_added', 0, 'accounts_added', 0);   -- no chart yet
  end if;
  -- ledgers the engine needs that the 22A chart does not have
  v_accounts := v_accounts
    + app.acc_seed_account(p_org_id, '1220', 'Corporate receivable', 'G-DEBT', false, 'asset', 'receivable', null, false, 100)
    + app.acc_seed_account(p_org_id, '2330', 'Patient advances and deposits', 'G-CL', false, 'liability', null, null, false, 100)
    + app.acc_seed_account(p_org_id, '4990', 'Sales credit notes', 'G-SAL', false, 'income', null, null, false, 100)
    + app.acc_seed_account(p_org_id, '6620', 'Insurance denials written off', 'G-IEXP', false, 'expense', null, null, false, 100)
    + app.acc_seed_account(p_org_id, '6920', 'Cash over and short', 'G-IEXP', false, 'expense', null, null, false, 100);

  -- 1. the old maps first, so a value Finance already chose wins over a default
  for r in select m.kind, m.key, m.account_code, m.account_name from public.fin_ref_account_map m where m.org_id = p_org_id loop
    v_n := v_n + app.acc_seed_rule(p_org_id,
      case r.kind when 'writeoff' then 'write_off' when 'refund' then null else r.kind end,
      case when r.kind = 'payment_mode' then upper(btrim(r.key))
           when r.kind in ('vat_output', 'writeoff', 'credit_note', 'rounding') then '*'
           else r.key end,
      '*', r.account_code, 'migrated', r.account_name);
  end loop;
  for r in select t.kind, t.key, t.ledger_name from public.fin_ref_tally_ledgers t where t.org_id = p_org_id loop
    v_n := v_n + app.acc_seed_rule(p_org_id,
      case r.kind when 'supplier' then 'payable' when 'category' then 'expense' when 'bank' then 'bank'
                  when 'vat_input' then 'vat_input' else null end,
      case when r.kind = 'vat_input' then '*' else r.key end,
      '*', null, 'migrated', r.ledger_name);
  end loop;

  -- 2. defaults on the 22A chart
  v_n := v_n
    + app.acc_seed_rule(p_org_id, 'receivable', 'insurance', '*', '1200', 'seed')
    + app.acc_seed_rule(p_org_id, 'receivable', 'self_pay', '*', '1210', 'seed')
    + app.acc_seed_rule(p_org_id, 'receivable', 'corporate', '*', '1220', 'seed')
    + app.acc_seed_rule(p_org_id, 'patient_advance', '*', '*', '2330', 'seed')
    + app.acc_seed_rule(p_org_id, 'discount', '*', '*', '6600', 'seed')
    + app.acc_seed_rule(p_org_id, 'write_off', '*', '*', '6610', 'seed')
    + app.acc_seed_rule(p_org_id, 'credit_note', '*', '*', '4990', 'seed')
    + app.acc_seed_rule(p_org_id, 'rounding', '*', '*', '6900', 'seed')
    + app.acc_seed_rule(p_org_id, 'vat_output', '*', '*', '2200', 'seed')
    + app.acc_seed_rule(p_org_id, 'vat_input', '*', '*', '2210', 'seed')
    + app.acc_seed_rule(p_org_id, 'payable', '*', '*', '2100', 'seed')
    + app.acc_seed_rule(p_org_id, 'bank', '*', '*', '1150', 'seed')
    + app.acc_seed_rule(p_org_id, 'revshare_expense', '*', '*', '5110', 'seed')
    + app.acc_seed_rule(p_org_id, 'revshare_payable', '*', '*', '2110', 'seed')
    -- the lab and referral cost is booked when the provider's bill is (20D); the statement moves it onto doctor and branch
    + app.acc_seed_rule(p_org_id, 'provider_cost', '*', '*', '5100', 'seed')
    + app.acc_seed_rule(p_org_id, 'provider_cost_offset', '*', '*', '5100', 'seed')
    + app.acc_seed_rule(p_org_id, 'cashup_over_short', '*', '*', '6920', 'seed')
    + app.acc_seed_rule(p_org_id, 'bank_charges', '*', '*', '6500', 'seed')
    + app.acc_seed_rule(p_org_id, 'denial_writeoff', '*', '*', '6620', 'seed')
    + app.acc_seed_rule(p_org_id, 'payment_mode', 'CARD', '*', '1300', 'seed')
    + app.acc_seed_rule(p_org_id, 'payment_mode', 'TABBY', '*', '1310', 'seed')
    + app.acc_seed_rule(p_org_id, 'payment_mode', 'EPG', '*', '1320', 'seed')
    + app.acc_seed_rule(p_org_id, 'payment_mode', 'ADVANCE', '*', '2330', 'seed')
    + app.acc_seed_rule(p_org_id, 'payment_mode', 'CASH', '*', '1100', 'seed');
  -- cash per branch
  for r in select b.code from public.fin_ref_branches b where b.org_id = p_org_id loop
    v_n := v_n + app.acc_seed_rule(p_org_id, 'payment_mode', 'CASH', r.code, '1100-' || r.code, 'seed')
               + app.acc_seed_rule(p_org_id, 'bank', 'cash', r.code, '1100-' || r.code, 'seed');
  end loop;
  -- every payment mode Unite, the cash-ups or the settlement rules use (upper case, as they are matched)
  for r in
    select distinct upper(btrim(m)) as mode from (
      select p.payment_mode as m from public.fin_payments p where p.org_id = p_org_id
      union select l.payment_mode from public.fin_cashup_lines l where l.org_id = p_org_id
      union select s.payment_mode from public.fin_ref_settlement_rules s where s.org_id = p_org_id
    ) x where nullif(btrim(m), '') is not null
  loop
    v_code := case when r.mode ~ 'TABBY' then '1310' when r.mode ~ 'EPG' then '1320'
                   when r.mode ~ '(CARD|VISA|MASTER|AMEX|POS)' then '1300' when r.mode ~ 'ADVANCE' then '2330' else null end;
    if r.mode ~ 'CASH' then
      for v_code in select b.code from public.fin_ref_branches b where b.org_id = p_org_id loop
        v_n := v_n + app.acc_seed_rule(p_org_id, 'payment_mode', r.mode, v_code, '1100-' || v_code, 'seed');
      end loop;
    elsif v_code is not null then
      v_n := v_n + app.acc_seed_rule(p_org_id, 'payment_mode', r.mode, '*', v_code, 'seed');
    end if;
  end loop;
  -- revenue per service category (an account guess; the VAT code is NEVER seeded, OQ-120)
  for r in
    select distinct s.service_category as cat from public.fin_ref_services s
    where s.org_id = p_org_id and s.service_category <> 'Unmapped'
  loop
    v_n := v_n + app.acc_seed_rule(p_org_id, 'revenue', r.cat, '*', app.acc_guess_revenue_account(r.cat), 'seed');
  end loop;
  -- expense per supplier / voucher category, where the name says clearly what it is
  for r in
    select distinct btrim(c) as cat from (
      select si.category as c from public.fin_supplier_invoices si where si.org_id = p_org_id
      union select v.category from public.fin_payment_vouchers v where v.org_id = p_org_id
      union select s.default_category from public.fin_suppliers s where s.org_id = p_org_id
    ) x where nullif(btrim(c), '') is not null
  loop
    v_n := v_n + app.acc_seed_rule(p_org_id, 'expense', r.cat, '*', app.acc_guess_expense_account(r.cat), 'seed');
  end loop;
  return jsonb_build_object('rules_added', v_n, 'accounts_added', v_accounts);
end;
$$;
revoke all on function public.acc_seed_posting_rules(uuid) from public, anon, authenticated;
grant execute on function public.acc_seed_posting_rules(uuid) to service_role;

-- New workspaces: after the 22A chart trigger (triggers on one event fire in name order). A new branch gets its cash rule.
create or replace function app.acc_seed_rules_on_org_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.acc_seed_posting_rules(new.id);
  return new;
end;
$$;
revoke all on function app.acc_seed_rules_on_org_insert() from public, anon, authenticated;
create trigger orgs_seed_finance_phase22d after insert on public.orgs
  for each row execute function app.acc_seed_rules_on_org_insert();

create or replace function app.acc_seed_rules_on_branch_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.acc_posting_rules r where r.org_id = new.org_id) then
    perform public.acc_seed_posting_rules(new.org_id);
  end if;
  return new;
end;
$$;
revoke all on function app.acc_seed_rules_on_branch_insert() from public, anon, authenticated;
create trigger fin_ref_branches_acc_seed_rules after insert on public.fin_ref_branches
  for each row execute function app.acc_seed_rules_on_branch_insert();

-- ---------------------------------------------------------------------------
-- 5. The runner's reads: candidates since a cursor, the sanitised records, the context, the keys that need a rule
-- ---------------------------------------------------------------------------
-- Items of one kind changed after (p_after, p_after_id), oldest first. Items changed in the last p_settle_seconds are
-- left for the next run (a transaction that commits late keeps its earlier timestamp). Items that disappeared but have a
-- live journal or preview come back too (their record is missing, so the runner withdraws them).
create or replace function public.acc_posting_candidates(
  p_org_id uuid, p_kind text, p_after timestamptz, p_after_id text, p_limit integer, p_settle_seconds integer default 120
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_after timestamptz := coalesce(p_after, '-infinity'::timestamptz);
  v_id text := coalesce(p_after_id, '');
  v_until timestamptz := now() - make_interval(secs => greatest(coalesce(p_settle_seconds, 120), 0));
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 1000);
  v_out jsonb;
begin
  with c(id, s) as (
    select i.inv_display_number, i.updated_at from public.fin_invoices i
     where p_kind = 'unite_invoice' and i.org_id = p_org_id and i.updated_at >= v_after
    union all
    select i.inv_display_number, l.updated_at from public.fin_invoice_lines l join public.fin_invoices i on i.id = l.invoice_id
     where p_kind = 'unite_invoice' and l.org_id = p_org_id and l.updated_at >= v_after
    union all
    select i.inv_display_number, a.updated_at from public.ins_claim_activities a join public.fin_invoices i on i.id = a.matched_invoice_id
     where p_kind = 'unite_invoice' and a.org_id = p_org_id and a.updated_at >= v_after
    union all
    select p.id::text, greatest(p.updated_at, i.updated_at) from public.fin_payments p join public.fin_invoices i on i.id = p.invoice_id
     where p_kind = 'unite_payment' and p.org_id = p_org_id and greatest(p.updated_at, i.updated_at) >= v_after
    union all
    select 'refund:' || p.id::text, greatest(p.updated_at, i.updated_at) from public.fin_payments p join public.fin_invoices i on i.id = p.invoice_id
     where p_kind = 'unite_payment' and p.org_id = p_org_id and greatest(p.updated_at, i.updated_at) >= v_after
       and (coalesce(p.refund, 0) <> 0 or exists (select 1 from public.acc_posting_status st where st.org_id = p_org_id
              and st.source_kind = 'unite_payment' and st.source_id = 'refund:' || p.id::text))
    union all
    select s.id::text, s.updated_at from public.fin_supplier_invoices s
     where p_kind = 'supplier_invoice' and s.org_id = p_org_id and s.updated_at >= v_after
    union all
    select v.id::text, v.updated_at from public.fin_payment_vouchers v
     where p_kind = 'voucher' and v.org_id = p_org_id and v.updated_at >= v_after
       and (v.status = 'paid' or exists (select 1 from public.acc_posting_status st where st.org_id = p_org_id
              and st.source_kind = 'voucher' and st.source_id = v.id::text))
    union all
    select b.id::text, b.created_at from public.ins_remittance_batches b
     where p_kind = 'remittance' and b.org_id = p_org_id and b.created_at >= v_after
    union all
    select d.id::text, d.updated_at from public.ins_denial_cases d
     where p_kind = 'denial' and d.org_id = p_org_id and d.updated_at >= v_after
       and (d.status in ('lost', 'written_off') or exists (select 1 from public.acc_posting_status st where st.org_id = p_org_id
              and st.source_kind = 'denial' and st.source_id = d.id::text))
    union all
    select r.id::text, r.updated_at from public.fin_revshare_runs r
     where p_kind = 'revshare_run' and r.org_id = p_org_id and r.updated_at >= v_after
    union all
    select 'payout:' || l.id::text, greatest(l.created_at, coalesce(l.paid_recorded_at, l.created_at), r.updated_at)
      from public.fin_revshare_lines l join public.fin_revshare_runs r on r.id = l.run_id
     where p_kind = 'revshare_run' and l.org_id = p_org_id
       and greatest(l.created_at, coalesce(l.paid_recorded_at, l.created_at), r.updated_at) >= v_after
       and (l.paid_on is not null or exists (select 1 from public.acc_posting_status st where st.org_id = p_org_id
              and st.source_kind = 'revshare_run' and st.source_id = 'payout:' || l.id::text))
    union all
    select s.id::text, s.updated_at from public.fin_provider_statements s
     where p_kind = 'lab_charge' and s.org_id = p_org_id and s.updated_at >= v_after
       and (s.status = 'posted' or exists (select 1 from public.acc_posting_status st where st.org_id = p_org_id
              and st.source_kind = 'lab_charge' and st.source_id = s.id::text))
    union all
    select c.id::text, greatest(c.updated_at, coalesce((select max(l.updated_at) from public.fin_cashup_lines l where l.cashup_id = c.id), c.updated_at))
      from public.fin_cashups c
     where p_kind = 'cashup' and c.org_id = p_org_id
       and greatest(c.updated_at, coalesce((select max(l.updated_at) from public.fin_cashup_lines l where l.cashup_id = c.id), c.updated_at)) >= v_after
    union all
    select m.id::text, greatest(m.decided_at, r.updated_at) from public.fin_bank_matches m join public.fin_bank_recs r on r.id = m.rec_id
     where p_kind = 'settlement' and m.org_id = p_org_id and m.expected_kind in ('collection', 'payout')
       and greatest(m.decided_at, r.updated_at) >= v_after
    union all
    -- a source row that vanished (an undone bank match, a removed remittance) while its journal or preview is live
    select st.source_id, st.updated_at from public.acc_posting_status st
     where st.org_id = p_org_id and st.source_kind = p_kind and p_kind in ('settlement', 'remittance')
       and st.state in ('posted', 'preview') and st.updated_at >= v_after
       and not exists (select 1 from public.fin_bank_matches m where p_kind = 'settlement' and m.id::text = st.source_id)
       and not exists (select 1 from public.ins_remittance_batches b where p_kind = 'remittance' and b.id::text = st.source_id)
  ), g as (
    select c.id, max(c.s) as s from c group by c.id
  ), picked as (
    select g.id, g.s from g
    where g.s < v_until and (g.s > v_after or (g.s = v_after and g.id > v_id))
    order by g.s, g.id
    limit v_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', picked.id, 'stamp', picked.s) order by picked.s, picked.id), '[]'::jsonb)
    into v_out from picked;
  return v_out;
end;
$$;
revoke all on function public.acc_posting_candidates(uuid, text, timestamptz, text, integer, integer) from public, anon, authenticated;
grant execute on function public.acc_posting_candidates(uuid, text, timestamptz, text, integer, integer) to service_role;

-- The records the builders need, sanitised: ids, codes, dates and amounts. Never the patient PIN, a name or a free-text
-- remark. A missing id is simply absent (the runner then withdraws it).
create or replace function public.acc_posting_load(p_org_id uuid, p_kind text, p_ids text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz text;
  v_out jsonb;
begin
  select coalesce(o.timezone, 'Asia/Dubai') into v_tz from public.orgs o where o.id = p_org_id;
  v_tz := coalesce(v_tz, 'Asia/Dubai');
  if p_kind = 'unite_invoice' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', i.inv_display_number, 'date', i.transaction_date, 'branch', i.branch_code, 'department', i.department,
      'doctor', i.doctor_dha_id, 'inv_type', i.inv_type, 'is_package', i.is_package, 'is_deleted', i.is_deleted,
      'total', i.total, 'write_off', i.write_off, 'credit_note', i.credit_note, 'version', i.version,
      'lines', coalesce((
        select jsonb_agg(jsonb_build_object('category', coalesce(s.service_category, 'Unmapped'),
                                            'discount', l.line_discount, 'net', l.line_net, 'vat', l.vat)
                         order by l.position, l.line_key)
        from public.fin_invoice_lines l
        left join public.fin_ref_services s on s.org_id = i.org_id and s.item_code = l.item_code
        where l.invoice_id = i.id and l.is_current), '[]'::jsonb),
      'claims', coalesce((
        select jsonb_agg(jsonb_build_object('payer_id', x.payer_id, 'amount', x.amount) order by x.payer_id)
        from (select a.payer_id, round(sum(coalesce(a.initial_net, a.net, 0)), 2) as amount
              from public.ins_claim_activities a
              where a.matched_invoice_id = i.id and a.match_status = 'matched'
              group by a.payer_id) x), '[]'::jsonb)
    )), '[]'::jsonb) into v_out
    from public.fin_invoices i where i.org_id = p_org_id and i.inv_display_number = any (p_ids);
  elsif p_kind = 'unite_payment' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', x.sid, 'part', case when x.sid like 'refund:%' then 'refund' else 'payment' end,
      'invoice', i.inv_display_number, 'inv_type', i.inv_type, 'branch', i.branch_code,
      'is_current', p.is_current, 'invoice_deleted', i.is_deleted,
      'mode', upper(coalesce(nullif(btrim(p.payment_mode), ''), '(UNKNOWN)')),
      'paid', p.paid, 'advance', p.advance_added, 'refund', p.refund,
      'date', case when x.sid like 'refund:%' then coalesce(p.refund_date, p.paid_date) else p.paid_date end
    )), '[]'::jsonb) into v_out
    from unnest(p_ids) as x(sid)
    join public.fin_payments p on p.org_id = p_org_id and p.id::text = regexp_replace(x.sid, '^refund:', '')
    join public.fin_invoices i on i.id = p.invoice_id;
  elsif p_kind = 'supplier_invoice' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', s.id, 'number', s.invoice_number, 'supplier_id', s.supplier_id, 'date', s.invoice_date, 'category', s.category,
      'net', s.net, 'vat', s.vat, 'currency', s.currency, 'branch', s.branch_code, 'doctor', s.doctor_dha_id, 'status', s.status
    )), '[]'::jsonb) into v_out
    from public.fin_supplier_invoices s where s.org_id = p_org_id and s.id::text = any (p_ids);
  elsif p_kind = 'voucher' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', v.id, 'voucher_no', v.voucher_no, 'status', v.status, 'date', v.payment_date, 'amount', v.amount,
      'currency', v.currency, 'supplier_id', v.supplier_id, 'category', v.category, 'branch', v.branch_code,
      'pay_from', v.pay_from, 'method', v.payment_method
    )), '[]'::jsonb) into v_out
    from public.fin_payment_vouchers v where v.org_id = p_org_id and v.id::text = any (p_ids);
  elsif p_kind = 'remittance' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'payer_id', b.payer_id, 'date', b.paid_on,
      'bank_account_id', (select a.id from public.fin_bank_accounts a where a.org_id = p_org_id and a.receives_insurance limit 1),
      'lines', coalesce((
        select jsonb_agg(jsonb_build_object('payer_id', y.payer_id, 'paid', y.paid) order by y.payer_id nulls first)
        from (select coalesce(nullif(btrim(l.payer_id), ''), b.payer_id) as payer_id, round(sum(l.paid_amount), 2) as paid
              from public.ins_remittance_lines l where l.batch_id = b.id group by 1) y), '[]'::jsonb)
    )), '[]'::jsonb) into v_out
    from public.ins_remittance_batches b where b.org_id = p_org_id and b.id::text = any (p_ids);
  elsif p_kind = 'denial' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', d.id, 'status', d.status, 'payer_id', d.payer_id, 'amount', d.rejected_amount,
      'date', (d.resolved_at at time zone v_tz)::date
    )), '[]'::jsonb) into v_out
    from public.ins_denial_cases d where d.org_id = p_org_id and d.id::text = any (p_ids);
  elsif p_kind = 'revshare_run' then
    select coalesce(jsonb_agg(z.o), '[]'::jsonb) into v_out from (
      select jsonb_build_object('id', r.id, 'part', 'run', 'month', r.month, 'status', r.status,
        'lines', coalesce((select jsonb_agg(jsonb_build_object('doctor', l.doctor_dha_id, 'payout', l.payout)
                                            order by l.doctor_dha_id)
                           from public.fin_revshare_lines l where l.run_id = r.id), '[]'::jsonb)) as o
      from public.fin_revshare_runs r where r.org_id = p_org_id and r.id::text = any (p_ids)
      union all
      select jsonb_build_object('id', 'payout:' || l.id, 'part', 'payout', 'month', r.month, 'status', r.status,
        'doctor', l.doctor_dha_id, 'payout', l.payout, 'paid_on', l.paid_on)
      from public.fin_revshare_lines l join public.fin_revshare_runs r on r.id = l.run_id
      where l.org_id = p_org_id and ('payout:' || l.id::text) = any (p_ids)
    ) z;
  elsif p_kind = 'lab_charge' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', s.id, 'month', s.month, 'status', s.status, 'provider_kind', p.kind,
      'allocation', coalesce((
        select jsonb_agg(jsonb_build_object('doctor', a ->> 'doctor', 'branch', a ->> 'branch', 'cost', (a ->> 'cost')::numeric))
        from jsonb_array_elements(coalesce(s.figures -> 'allocation', '[]'::jsonb)) a), '[]'::jsonb)
    )), '[]'::jsonb) into v_out
    from public.fin_provider_statements s join public.fin_providers p on p.id = s.provider_id
    where s.org_id = p_org_id and s.id::text = any (p_ids);
  elsif p_kind = 'cashup' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'branch', c.branch_code, 'date', c.business_date, 'status', c.status,
      'lines', coalesce((select jsonb_agg(jsonb_build_object('mode', upper(btrim(l.payment_mode)), 'variance', l.variance)
                                          order by l.payment_mode)
                         from public.fin_cashup_lines l where l.cashup_id = c.id), '[]'::jsonb)
    )), '[]'::jsonb) into v_out
    from public.fin_cashups c where c.org_id = p_org_id and c.id::text = any (p_ids);
  elsif p_kind = 'settlement' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', m.id, 'matched', m.status = 'matched' and r.status = 'signed', 'kind', m.expected_kind,
      'mode', upper(btrim(split_part(m.expected_key, '|', 2))), 'date', bl.value_date, 'bank_account_id', bl.account_id,
      'bank_amount', m.bank_amount,
      'gross', case
        when m.expected_kind = 'collection' then (
          select round(coalesce(sum(p.paid) filter (where p.paid_date = split_part(m.expected_key, '|', 3)::date), 0)
                       - coalesce(sum(p.refund) filter (where coalesce(p.refund_date, p.paid_date) = split_part(m.expected_key, '|', 3)::date), 0), 2)
          from public.fin_payments p join public.fin_invoices i on i.id = p.invoice_id
          where p.org_id = p_org_id and p.is_current and not i.is_deleted
            and lower(btrim(p.payment_mode)) = lower(btrim(split_part(m.expected_key, '|', 2)))
            and split_part(m.expected_key, '|', 3) ~ '^\d{4}-\d{2}-\d{2}$')
        else (
          select round(sum(sl.gross), 2) from public.fin_settlement_lines sl
          where sl.org_id = p_org_id
            and lower(btrim(sl.payment_mode)) = lower(btrim(split_part(m.expected_key, '|', 2)))
            and split_part(m.expected_key, '|', 3) ~ '^\d{4}-\d{2}-\d{2}'
            and sl.settlement_date = left(split_part(m.expected_key, '|', 3), 10)::date
            and coalesce(sl.reference, '') = substr(split_part(m.expected_key, '|', 3), 12))
        end
    )), '[]'::jsonb) into v_out
    from public.fin_bank_matches m
    join public.fin_bank_recs r on r.id = m.rec_id
    join public.fin_bank_lines bl on bl.id = m.bank_line_id
    where m.org_id = p_org_id and m.id::text = any (p_ids);
  else
    raise exception 'Unknown source kind.' using errcode = 'check_violation', hint = 'source_kind';
  end if;
  return v_out;
end;
$$;
revoke all on function public.acc_posting_load(uuid, text, text[]) from public, anon, authenticated;
grant execute on function public.acc_posting_load(uuid, text, text[]) to service_role;

-- Everything the builders resolve against: rules (with account and tax codes), tax codes, the settings, the entities
-- with their ledger start, and the known branches, doctors and payers (a dimension that is not known is left off a line).
create or replace function public.acc_posting_context(p_org_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'rules', coalesce((
      select jsonb_agg(jsonb_build_object('kind', r.kind, 'key', r.key, 'qualifier', r.qualifier,
                                          'account', a.code, 'tax_code', t.code) order by r.kind, r.key, r.qualifier)
      from public.acc_posting_rules r
      left join public.acc_accounts a on a.id = r.account_id
      left join public.acc_tax_codes t on t.id = r.tax_code_id
      where r.org_id = p_org_id and r.active), '[]'::jsonb),
    'tax_codes', coalesce((
      select jsonb_agg(jsonb_build_object('code', t.code, 'kind', t.kind, 'rate', t.rate, 'active', t.active,
                                          'output_account', o.code, 'input_account', i.code) order by t.code)
      from public.acc_tax_codes t
      left join public.acc_accounts o on o.id = t.output_account_id
      left join public.acc_accounts i on i.id = t.input_account_id
      where t.org_id = p_org_id), '[]'::jsonb),
    'settings', coalesce((
      select jsonb_build_object('denial_allowance_enabled', s.denial_allowance_enabled, 'package_invoices', s.package_invoices,
                                'rounding_tolerance', s.rounding_tolerance, 'vat_tolerance', s.vat_tolerance,
                                'paused_sources', to_jsonb(s.paused_sources))
      from public.acc_posting_settings s where s.org_id = p_org_id),
      jsonb_build_object('denial_allowance_enabled', false, 'package_invoices', 'hold', 'rounding_tolerance', 1.00,
                         'vat_tolerance', 0.05, 'paused_sources', '[]'::jsonb)),
    'entities', coalesce((
      select jsonb_agg(jsonb_build_object('id', e.id, 'is_default', e.is_default, 'ledger_start_date', e.ledger_start_date))
      from public.acc_entities e where e.org_id = p_org_id), '[]'::jsonb),
    'branches', coalesce((select jsonb_agg(b.code order by b.code) from public.fin_ref_branches b where b.org_id = p_org_id), '[]'::jsonb),
    'doctors', coalesce((select jsonb_agg(d.dha_id order by d.dha_id) from public.fin_ref_doctors d where d.org_id = p_org_id), '[]'::jsonb),
    'payers', coalesce((select jsonb_agg(p.payer_id order by p.payer_id) from public.fin_ref_payers p where p.org_id = p_org_id), '[]'::jsonb)
  );
$$;
revoke all on function public.acc_posting_context(uuid) from public, anon, authenticated;
grant execute on function public.acc_posting_context(uuid) to service_role;

-- The keys the sub-ledgers use today, so the Posting rules page can show what has no rule yet.
create or replace function public.acc_posting_needed_keys(p_org_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'service_categories', coalesce((
      select jsonb_agg(c order by c) from (
        select distinct s.service_category as c from public.fin_ref_services s where s.org_id = p_org_id
        union select 'Unmapped' where exists (
          select 1 from public.fin_invoice_lines l
          left join public.fin_ref_services s on s.org_id = l.org_id and s.item_code = l.item_code
          where l.org_id = p_org_id and l.is_current and s.item_code is null)
      ) x limit 500), '[]'::jsonb),
    'payment_modes', coalesce((
      select jsonb_agg(m order by m) from (
        select distinct upper(btrim(m)) as m from (
          select p.payment_mode as m from public.fin_payments p where p.org_id = p_org_id
          union select l.payment_mode from public.fin_cashup_lines l where l.org_id = p_org_id
          union select s.payment_mode from public.fin_ref_settlement_rules s where s.org_id = p_org_id
        ) y where nullif(btrim(m), '') is not null
      ) x limit 500), '[]'::jsonb),
    'expense_categories', coalesce((
      select jsonb_agg(c order by c) from (
        select distinct btrim(c) as c from (
          select si.category as c from public.fin_supplier_invoices si where si.org_id = p_org_id
          union select v.category from public.fin_payment_vouchers v where v.org_id = p_org_id and v.supplier_id is null
        ) y where nullif(btrim(c), '') is not null
      ) x limit 500), '[]'::jsonb),
    'provider_kinds', coalesce((
      select jsonb_agg(distinct p.kind) from public.fin_providers p where p.org_id = p_org_id), '[]'::jsonb),
    'branches', coalesce((select jsonb_agg(b.code order by b.code) from public.fin_ref_branches b where b.org_id = p_org_id), '[]'::jsonb)
  );
$$;
revoke all on function public.acc_posting_needed_keys(uuid) from public, anon, authenticated;
grant execute on function public.acc_posting_needed_keys(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Applying what the builders made, item by item (each in its own sub-transaction)
-- ---------------------------------------------------------------------------
create or replace function app.acc_posting_set_state(
  p_org_id uuid, p_kind text, p_id text, p_state text, p_reason text, p_detail text, p_date date, p_amount numeric,
  p_version integer, p_hash text, p_journal_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.acc_posting_status (org_id, source_kind, source_id, state, reason, detail, source_date, amount, version,
                                         content_sha256, journal_id, attempts)
  values (p_org_id, p_kind, p_id, p_state, p_reason, left(p_detail, 300), p_date, p_amount, coalesce(p_version, 0), p_hash,
          p_journal_id, case when p_state = 'waiting' then 1 else 0 end)
  on conflict (org_id, source_kind, source_id) do update set
    state = excluded.state, reason = excluded.reason, detail = excluded.detail,
    source_date = coalesce(excluded.source_date, public.acc_posting_status.source_date),
    amount = coalesce(excluded.amount, public.acc_posting_status.amount),
    version = greatest(excluded.version, public.acc_posting_status.version),
    content_sha256 = excluded.content_sha256, journal_id = excluded.journal_id,
    attempts = case when excluded.state = 'waiting' then public.acc_posting_status.attempts + 1 else 0 end,
    last_attempt_at = now(), updated_at = now();
end;
$$;
revoke all on function app.acc_posting_set_state(uuid, text, text, text, text, text, date, numeric, integer, text, uuid)
  from public, anon, authenticated;

-- p_items: [{ source_id, action: post | reasons | nothing | withdraw, date, voucher_type, narration, lines,
--             reasons: [{code, detail}], amount }]. Returns counts and one outcome per item.
--   post     dated before the entity's ledger start (or none set): stored as a preview (nothing posted); otherwise posted
--            through acc_post_from_source as the next version when its content changed (an unchanged item is left as it
--            is). A refusal (closed period, unknown dimension, ...) makes it wait with the database's reason.
--   reasons  waits with the builder's first reason.
--   nothing / withdraw  a live journal is reversed (dated p_today or later), any preview removed.
create or replace function public.acc_posting_apply(p_org_id uuid, p_kind text, p_items jsonb, p_today date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  it jsonb;
  v_id text;
  v_action text;
  v_date date;
  v_lines jsonb;
  v_entity uuid;
  v_start date;
  v_hash text;
  v_amount numeric;
  v_version integer;
  v_hint text;
  v_res jsonb;
  st public.acc_posting_status;
  live public.acc_journals;
  v_unknown integer;
  v_out jsonb := '[]'::jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_state text;
  v_reason text;
begin
  if p_kind not in ('unite_invoice', 'unite_payment', 'supplier_invoice', 'voucher', 'remittance', 'denial', 'revshare_run',
                    'lab_charge', 'cashup', 'settlement') then
    raise exception 'Unknown source kind.' using errcode = 'check_violation', hint = 'source_kind';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 1000 then
    raise exception 'The items are missing.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  for it in select x from jsonb_array_elements(p_items) x loop
    v_id := nullif(btrim(coalesce(it ->> 'source_id', '')), '');
    v_action := it ->> 'action';
    v_state := null;
    v_reason := null;
    continue when v_id is null or char_length(v_id) > 200;
    begin
      select * into st from public.acc_posting_status s
       where s.org_id = p_org_id and s.source_kind = p_kind and s.source_id = v_id for update;
      select * into live from public.acc_journals j
       where j.org_id = p_org_id and j.source_kind = p_kind and j.source_id = v_id and j.status = 'posted';
      if v_action = 'reasons' then
        delete from public.acc_posting_preview pv where pv.org_id = p_org_id and pv.source_kind = p_kind and pv.source_id = v_id;
        v_reason := coalesce(nullif(it -> 'reasons' -> 0 ->> 'code', ''), 'invalid');
        perform app.acc_posting_set_state(p_org_id, p_kind, v_id, 'waiting', v_reason,
          (select string_agg(coalesce(r ->> 'detail', r ->> 'code'), '; ') from jsonb_array_elements(coalesce(it -> 'reasons', '[]'::jsonb)) r),
          nullif(it ->> 'date', '')::date, nullif(it ->> 'amount', '')::numeric, st.version, null, live.id);
        v_state := 'waiting';
      elsif v_action in ('nothing', 'withdraw') then
        delete from public.acc_posting_preview pv where pv.org_id = p_org_id and pv.source_kind = p_kind and pv.source_id = v_id;
        if live.id is not null then
          perform app.acc_reverse_internal(p_org_id, live.id, null, greatest(coalesce(p_today, live.journal_date), live.journal_date),
                                           case when v_action = 'nothing' then 'nothing left to post' else 'source withdrawn' end);
        end if;
        if st.source_id is not null or live.id is not null then
          perform app.acc_posting_set_state(p_org_id, p_kind, v_id, case when v_action = 'nothing' then 'nothing' else 'withdrawn' end,
                                            null, null, nullif(it ->> 'date', '')::date, 0, st.version, null, null);
        elsif v_action = 'nothing' then
          perform app.acc_posting_set_state(p_org_id, p_kind, v_id, 'nothing', null, null, nullif(it ->> 'date', '')::date, 0, 0, null, null);
        end if;
        v_state := case when v_action = 'nothing' then 'nothing' else 'withdrawn' end;
      elsif v_action = 'post' then
        v_date := (it ->> 'date')::date;
        v_lines := it -> 'lines';
        if v_date is null or v_lines is null or jsonb_typeof(v_lines) <> 'array' then
          raise exception 'The journal is incomplete.' using errcode = 'check_violation', hint = 'invalid';
        end if;
        -- the entity the first branch on the lines books into, otherwise the default entity
        select eb.entity_id into v_entity from public.acc_entity_branches eb
         where eb.org_id = p_org_id
           and eb.branch_code = (select upper(btrim(l ->> 'branch_code')) from jsonb_array_elements(v_lines) l
                                 where nullif(btrim(coalesce(l ->> 'branch_code', '')), '') is not null limit 1);
        if v_entity is null then
          select e.id into v_entity from public.acc_entities e where e.org_id = p_org_id and e.is_default;
        end if;
        if v_entity is null then
          raise exception 'Entity not found.' using errcode = 'check_violation', hint = 'entity_unknown';
        end if;
        v_hash := encode(sha256(convert_to(jsonb_build_object(
          'date', v_date, 'type', it ->> 'voucher_type', 'narration', it ->> 'narration', 'lines', v_lines,
          'entity', v_entity)::text, 'UTF8')), 'hex');
        select coalesce(sum(coalesce(nullif(l ->> 'debit', '')::numeric, 0)), 0) into v_amount from jsonb_array_elements(v_lines) l;
        select e.ledger_start_date into v_start from public.acc_entities e where e.id = v_entity;
        if v_start is null or v_date < v_start then
          if live.id is not null then
            raise exception 'This item is dated before the ledger start but already has a posted journal.'
              using errcode = 'check_violation', hint = 'before_ledger_start';
          end if;
          select count(*) into v_unknown from jsonb_array_elements(v_lines) l
           where not exists (select 1 from public.acc_accounts a where a.org_id = p_org_id
                               and a.code = upper(btrim(coalesce(l ->> 'account_code', ''))) and not a.is_group);
          if v_unknown > 0 then
            raise exception 'An account was not found.' using errcode = 'check_violation', hint = 'account_not_found';
          end if;
          delete from public.acc_posting_preview pv where pv.org_id = p_org_id and pv.source_kind = p_kind and pv.source_id = v_id;
          insert into public.acc_posting_preview (org_id, source_kind, source_id, entity_id, month, account_id, debit, credit)
          select p_org_id, p_kind, v_id, v_entity, date_trunc('month', v_date)::date, a.id,
                 round(sum(coalesce(nullif(l ->> 'debit', '')::numeric, 0)), 2), round(sum(coalesce(nullif(l ->> 'credit', '')::numeric, 0)), 2)
          from jsonb_array_elements(v_lines) l
          join public.acc_accounts a on a.org_id = p_org_id and a.code = upper(btrim(l ->> 'account_code'))
          group by a.id;
          perform app.acc_posting_set_state(p_org_id, p_kind, v_id, 'preview', null, null, v_date, v_amount, st.version, v_hash, null);
          v_state := 'preview';
        elsif live.id is not null and st.content_sha256 = v_hash and st.journal_id = live.id then
          perform app.acc_posting_set_state(p_org_id, p_kind, v_id, 'posted', null, null, v_date, v_amount, st.version, v_hash, live.id);
          v_state := 'unchanged';
        else
          select coalesce(max(j.source_version), 0) + 1 into v_version from public.acc_journals j
           where j.org_id = p_org_id and j.source_kind = p_kind and j.source_id = v_id;
          v_res := public.acc_post_from_source(p_org_id, v_entity, p_kind, v_id, v_version, v_date,
                                               coalesce(nullif(it ->> 'voucher_type', ''), 'journal'),
                                               coalesce(nullif(btrim(it ->> 'narration'), ''), 'Posting from ' || p_kind), v_lines);
          delete from public.acc_posting_preview pv where pv.org_id = p_org_id and pv.source_kind = p_kind and pv.source_id = v_id;
          perform app.acc_posting_set_state(p_org_id, p_kind, v_id, 'posted', null, null, v_date, v_amount, v_version, v_hash,
                                            (v_res ->> 'id')::uuid);
          v_state := 'posted';
        end if;
      else
        raise exception 'Unknown action.' using errcode = 'check_violation', hint = 'invalid';
      end if;
    exception when others then
      get stacked diagnostics v_hint = pg_exception_hint;
      v_reason := coalesce(nullif(v_hint, ''), 'error');
      if v_reason !~ '^[a-z_]{1,40}$' then
        v_reason := 'error';
      end if;
      perform app.acc_posting_set_state(p_org_id, p_kind, v_id, 'waiting', v_reason, null,
                                        nullif(it ->> 'date', '')::date, null, null, null,
                                        (select j.id from public.acc_journals j where j.org_id = p_org_id and j.source_kind = p_kind
                                           and j.source_id = v_id and j.status = 'posted'));
      v_state := 'waiting';
    end;
    v_counts := jsonb_set(v_counts, array[v_state], to_jsonb(coalesce((v_counts ->> v_state)::integer, 0) + 1));
    v_out := v_out || jsonb_build_object('source_id', v_id, 'state', v_state, 'reason', v_reason);
  end loop;
  return jsonb_build_object('counts', v_counts, 'items', v_out);
end;
$$;
revoke all on function public.acc_posting_apply(uuid, text, jsonb, date) from public, anon, authenticated;
grant execute on function public.acc_posting_apply(uuid, text, jsonb, date) to service_role;

-- Moves a kind's cursor forward (never back).
create or replace function public.acc_posting_set_cursor(p_org_id uuid, p_kind text, p_at timestamptz, p_id text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.acc_posting_cursors (org_id, source_kind, cursor_at, cursor_id)
  values (p_org_id, p_kind, p_at, p_id)
  on conflict (org_id, source_kind) do update set cursor_at = excluded.cursor_at, cursor_id = excluded.cursor_id, updated_at = now()
  where (public.acc_posting_cursors.cursor_at, coalesce(public.acc_posting_cursors.cursor_id, ''))
        < (excluded.cursor_at, coalesce(excluded.cursor_id, ''))
     or public.acc_posting_cursors.cursor_at is null;
$$;
revoke all on function public.acc_posting_set_cursor(uuid, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.acc_posting_set_cursor(uuid, text, timestamptz, text) to service_role;

-- ---------------------------------------------------------------------------
-- 7. The parallel-run comparison: Pulse's preview against the ledger (before the ledger start that is the Tally mirror),
--    per account and month. Balances are debit minus credit.
-- ---------------------------------------------------------------------------
create or replace function public.acc_posting_preview_report(p_org_id uuid, p_entity_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_from date := date_trunc('month', p_from)::date;
  v_to date := (date_trunc('month', p_to) + interval '1 month' - interval '1 day')::date;
  v_out jsonb;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 800 then
    raise exception 'Choose up to two years.' using errcode = 'check_violation', hint = 'invalid';
  end if;
  with pv as (
    select p.account_id, p.month, sum(p.debit - p.credit) as amount
    from public.acc_posting_preview p
    where p.org_id = p_org_id and p.month between v_from and v_to and (p_entity_id is null or p.entity_id = p_entity_id)
    group by 1, 2
  ), lg as (
    select l.account_id, date_trunc('month', j.journal_date)::date as month, sum(l.debit - l.credit) as amount
    from public.acc_journal_lines l join public.acc_journals j on j.id = l.journal_id
    where j.org_id = p_org_id and j.status in ('posted', 'reversed') and j.journal_date between v_from and v_to
      and (p_entity_id is null or j.entity_id = p_entity_id)
    group by 1, 2
  ), k as (
    select account_id, month from pv union select account_id, month from lg
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'account_id', a.id, 'code', a.code, 'name', a.name, 'month', k.month,
           'preview', round(coalesce(pv.amount, 0), 2), 'ledger', round(coalesce(lg.amount, 0), 2),
           'difference', round(coalesce(pv.amount, 0) - coalesce(lg.amount, 0), 2))
         order by a.code, k.month), '[]'::jsonb)
    into v_out
  from k
  join public.acc_accounts a on a.id = k.account_id
  left join pv on pv.account_id = k.account_id and pv.month = k.month
  left join lg on lg.account_id = k.account_id and lg.month = k.month;
  return v_out;
end;
$$;
revoke all on function public.acc_posting_preview_report(uuid, uuid, date, date) from public, anon, authenticated;
grant execute on function public.acc_posting_preview_report(uuid, uuid, date, date) to service_role;

-- ---------------------------------------------------------------------------
-- 8. The runner: every 15 minutes (posts, previews, retries waiting items, and runs the automatic reversals of 22A)
-- ---------------------------------------------------------------------------
select cron.schedule('pulse:accounting_post', '7,22,37,52 * * * *', $$select app.ping_jobs('accounting_post')$$);

-- ---------------------------------------------------------------------------
-- 9. Every existing workspace gets its default rules now
-- ---------------------------------------------------------------------------
select public.acc_seed_posting_rules(id) from public.orgs;
