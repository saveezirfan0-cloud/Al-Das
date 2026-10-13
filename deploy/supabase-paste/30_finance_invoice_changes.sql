-- Paste into Supabase > SQL Editor > New query, then Run. Needs 25_finance_insurance_followup.sql applied first.
-- The migration-history line is included at the bottom of this file.

-- Phase 20J part 1: the Unite invoice-change register with Operations approval (docs/20_FINANCE_CONTROL_PLAN.md, slice
-- 20J; deck slides 8 and 11: "zero unapproved invoice changes"; the authority matrix itself is open, OQ-96).
--
--   * finance.changes.view (Finance, CEO, Operations) reads the register; finance.changes.review (Finance, Operations)
--     records a decision on a change. A new "Operations" system role holds both (Abdul: Unite invoices, discounts,
--     cancellations and refunds).
--   * fin_ref_finance_settings: change_review_start_date (null = the register works but the "unapproved changes" measure
--     is not measured), change_review_min_amount (default 0 = every change needs an approval),
--     change_bulk_approve_max (default 0 = no bulk approval).
--   * fin_invoice_changes(org, from, to): the change events DERIVED from what Pulse already stores (Unite is read-only:
--     nothing here calls or writes Unite): discounts, cancellations, credit notes, write-offs and net reductions from the
--     invoice delivery history (fin_invoice_versions), and refunds (fin_payments). Ids, codes and amounts only.
--     SECURITY DEFINER, search_path = '', service role only, jsonb; the page, the CSV route and the actions call it after
--     can().
--   * fin_invoice_change_reviews: one decision per change (approved / rejected / explained) with a required reason
--     (redacted, bounded), the reviewer and whether the month was already locked. Written by a server action after
--     can(), audited; staff only read it.
--
-- A review attaches to one change through change_key = md5(invoice id | kind | delivery or payment id | amount). The
-- amount is part of the key on purpose: if the amount of a change moves (a refund edited in Unite, a late re-delivery
-- slotting in between two others), the old review no longer covers it and the change shows as not reviewed again.

-- ---------------------------------------------------------------------------
-- 1. Permissions for existing system roles (new orgs get them from lib/auth/permissions.ts) and the Operations role
-- ---------------------------------------------------------------------------
do $$
declare
  g record;
begin
  for g in
    select * from (values
      ('Finance', 'finance.changes.view'),
      ('Finance', 'finance.changes.review'),
      ('CEO', 'finance.changes.view'),
      ('Operations', 'finance.changes.view'),
      ('Operations', 'finance.changes.review')
    ) as t (role_name, perm)
  loop
    update public.roles r
       set permissions = r.permissions || to_jsonb(g.perm)
     where r.is_system and r.name = g.role_name and not (r.permissions ? g.perm);
  end loop;
end $$;

insert into public.roles (org_id, name, description, permissions, is_system)
select o.id, 'Operations',
       'Owns Unite invoice changes: reviews discounts, cancellations, credit notes, write-offs and refunds in the invoice-change register.',
       '["finance.changes.view","finance.changes.review"]'::jsonb, true
from public.orgs o
on conflict (org_id, name) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Settings (the authority matrix is not agreed yet, OQ-96: by default every change needs an approval)
-- ---------------------------------------------------------------------------
alter table public.fin_ref_finance_settings
  -- null = the register is shown but "unapproved changes" is not measured; changes before this date are never counted
  add column change_review_start_date date,
  -- a change below this amount needs no approval (0 = every change does)
  add column change_review_min_amount numeric(12, 2) not null default 0
    check (change_review_min_amount >= 0 and change_review_min_amount < 10000000),
  -- unreviewed changes up to this amount may be approved together (0 = no bulk approval)
  add column change_bulk_approve_max numeric(12, 2) not null default 0
    check (change_bulk_approve_max >= 0 and change_bulk_approve_max < 10000000);

-- ---------------------------------------------------------------------------
-- 3. Reviews
-- ---------------------------------------------------------------------------
create table public.fin_invoice_change_reviews (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  change_key text not null check (change_key ~ '^[0-9a-f]{32}$'),
  invoice_id uuid not null references public.fin_invoices (id) on delete cascade,
  kind text not null check (kind in ('discount', 'cancellation', 'credit_note', 'write_off', 'net_reduction', 'refund')),
  amount numeric(14, 2) not null check (amount >= 0),
  change_date date not null,
  decision text not null check (decision in ('approved', 'rejected', 'explained')),
  reason text not null check (btrim(reason) <> '' and char_length(reason) <= 500),   -- redacted; no patient names
  bulk boolean not null default false,
  -- the change's month was already locked (CEO sign-off) when it was reviewed; the review is evidence, not a figure
  month_locked boolean not null default false,
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz not null default now(),
  unique (org_id, change_key)
);
create index fin_invoice_change_reviews_invoice_idx on public.fin_invoice_change_reviews (invoice_id);
create trigger fin_invoice_change_reviews_invoice_org_check before insert or update of invoice_id, org_id on public.fin_invoice_change_reviews
  for each row execute function app.check_parent_org('fin_invoices', 'invoice_id');

-- RLS: holders of either key read their own org's reviews; nobody writes from the browser (the server action uses the
-- service role after can() and records the audit row).
alter table public.fin_invoice_change_reviews enable row level security;
create policy fin_invoice_change_reviews_select on public.fin_invoice_change_reviews for select to authenticated
  using (app.has_perm(org_id, 'finance.changes.view') or app.has_perm(org_id, 'finance.changes.review'));

-- the register reads deliveries by time
create index if not exists fin_invoice_versions_org_received_idx on public.fin_invoice_versions (org_id, received_at);

-- ---------------------------------------------------------------------------
-- 4. The register: change events in a period, with their review
--
--   Deliveries of one invoice are compared in the order they were taken from Unite (received_at, then version, then id),
--   each with the one before it. The first delivery is compared with nothing.
--     discount       first delivery: discount > 0 (amount = discount); later: discount rose (amount = the rise)
--     credit_note    the same for credit_note
--     write_off      the same for write_off
--     cancellation   is_deleted became true, or the first delivery was already deleted (amount = net before it, or the
--                    net delivered when first seen deleted). A delivery in which the invoice is, or stays, cancelled
--                    raises nothing else.
--     net_reduction  later deliveries only: net fell by more than the discount rose (amount = fall - discount rise), so
--                    a discount is never counted twice; lines removed, prices lowered
--     refund         a current payment row with refund > 0 (amount = refund)
--   Change date: the invoice's transaction date for the first delivery (the change was made when the invoice was
--   raised), the delivery date in the clinic's time zone for later ones, and refund date / paid date / transaction date
--   for refunds. Unite user: modified_by (first delivery: modified_by, else created_by); refunds carry none.
--   Increases (a discount reduced, an invoice restored) are not changes against the clinic and raise nothing.
-- ---------------------------------------------------------------------------
create or replace function public.fin_invoice_changes(p_org_id uuid, p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with s as (
    select (select change_review_start_date from public.fin_ref_finance_settings where org_id = p_org_id) as start_date,
           coalesce((select change_review_min_amount from public.fin_ref_finance_settings where org_id = p_org_id), 0) as min_amount,
           coalesce((select change_bulk_approve_max from public.fin_ref_finance_settings where org_id = p_org_id), 0) as bulk_max,
           coalesce((select o.timezone from public.orgs o where o.id = p_org_id), 'Asia/Dubai') as tz
  ), cand as (
    -- invoices raised in the period (first-delivery events) or delivered again in it (later events); a day either side
    -- of the window absorbs the time zone
    select i.id from public.fin_invoices i
    where i.org_id = p_org_id and i.transaction_date between p_from and p_to
    union
    select v.invoice_id from public.fin_invoice_versions v
    where v.org_id = p_org_id and v.received_at >= (p_from - 1)::timestamp and v.received_at < (p_to + 2)::timestamp
  ), d as (
    select v.id, v.invoice_id,
           (v.received_at at time zone (select tz from s))::date as received_on,
           coalesce((v.record ->> 'discount')::numeric, 0) as discount,
           coalesce((v.record ->> 'credit_note')::numeric, 0) as credit_note,
           coalesce((v.record ->> 'write_off')::numeric, 0) as write_off,
           coalesce((v.record ->> 'net')::numeric, 0) as net,
           coalesce((v.record ->> 'is_deleted')::boolean, false) as is_deleted,
           nullif(btrim(v.record ->> 'modified_by'), '') as modified_by,
           nullif(btrim(v.record ->> 'created_by'), '') as created_by,
           v.received_at, v.version
    from public.fin_invoice_versions v
    where v.org_id = p_org_id and v.invoice_id in (select id from cand)
  ), dp as (
    select d.*,
           row_number() over w = 1 as first,
           lag(d.discount) over w as p_discount, lag(d.credit_note) over w as p_credit_note,
           lag(d.write_off) over w as p_write_off, lag(d.net) over w as p_net, lag(d.is_deleted) over w as p_deleted
    from d
    window w as (partition by d.invoice_id order by d.received_at, d.version, d.id)
  ), ev as (
    -- cancellation
    select dp.invoice_id, 'cancellation'::text as kind, dp.id as source_id,
           case when dp.first then dp.net else dp.p_net end as amount,
           dp.first, dp.received_on, dp.modified_by, dp.created_by
    from dp where dp.is_deleted and (dp.first or not dp.p_deleted)
    union all
    -- discount, credit note, write-off: present on first receipt, or risen since the previous delivery
    select dp.invoice_id, x.kind, dp.id,
           case when dp.first then x.cur else x.cur - x.prev end,
           dp.first, dp.received_on, dp.modified_by, dp.created_by
    from dp
    cross join lateral (values ('discount', dp.discount, dp.p_discount),
                               ('credit_note', dp.credit_note, dp.p_credit_note),
                               ('write_off', dp.write_off, dp.p_write_off)) as x(kind, cur, prev)
    where not dp.is_deleted and (case when dp.first then x.cur else x.cur - x.prev end) > 0
    union all
    -- net reduction not explained by a discount rise
    select dp.invoice_id, 'net_reduction', dp.id,
           (dp.p_net - dp.net) - greatest(dp.discount - dp.p_discount, 0),
           false, dp.received_on, dp.modified_by, dp.created_by
    from dp
    where not dp.first and not dp.is_deleted and (dp.p_net - dp.net) - greatest(dp.discount - dp.p_discount, 0) > 0
  ), e as (
    select i.id as invoice_id, i.inv_display_number, i.branch_code, i.doctor_dha_id, i.inv_type, ev.kind,
           round(greatest(coalesce(ev.amount, 0), 0), 2) as amount,
           case when ev.first then coalesce(i.transaction_date, ev.received_on) else ev.received_on end as change_date,
           case when ev.first then coalesce(ev.modified_by, ev.created_by) else ev.modified_by end as unite_user,
           ev.source_id
    from ev join public.fin_invoices i on i.id = ev.invoice_id
    union all
    select i.id, i.inv_display_number, i.branch_code, i.doctor_dha_id, i.inv_type, 'refund',
           round(p.refund, 2), coalesce(p.refund_date, p.paid_date, i.transaction_date), null::text, p.id
    from public.fin_payments p join public.fin_invoices i on i.id = p.invoice_id
    where p.org_id = p_org_id and p.is_current and coalesce(p.refund, 0) > 0
      and coalesce(p.refund_date, p.paid_date, i.transaction_date) between p_from and p_to
  ), k as (
    select e.*, md5(e.invoice_id::text || '|' || e.kind || '|' || e.source_id::text || '|' || e.amount::text) as change_key
    from e
    where e.change_date between p_from and p_to
  )
  select jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'start_date', (select start_date from s),
    'min_amount', (select min_amount from s),
    'bulk_max', (select bulk_max from s),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
               'change_key', k.change_key, 'invoice_id', k.invoice_id, 'invoice_no', k.inv_display_number,
               'branch_code', k.branch_code, 'doctor_id', k.doctor_dha_id, 'inv_type', k.inv_type, 'kind', k.kind,
               'amount', k.amount, 'change_date', k.change_date, 'unite_user', k.unite_user,
               'month_locked', exists (select 1 from public.fin_period_closes pc
                                       where pc.org_id = p_org_id and pc.locked_at is not null
                                         and pc.month = date_trunc('month', k.change_date)::date),
               'review', (select jsonb_build_object('decision', r.decision, 'reason', r.reason, 'bulk', r.bulk,
                                                    'month_locked', r.month_locked, 'reviewed_by', r.reviewed_by,
                                                    'reviewed_at', r.reviewed_at)
                          from public.fin_invoice_change_reviews r
                          where r.org_id = p_org_id and r.change_key = k.change_key))
             order by k.change_date desc, k.inv_display_number, k.kind, k.change_key)
      from k), '[]'::jsonb)
  );
$$;
revoke all on function public.fin_invoice_changes(uuid, date, date) from public, anon, authenticated;
grant execute on function public.fin_invoice_changes(uuid, date, date) to service_role;

insert into supabase_migrations.schema_migrations (version, name) values ('20261031000100', 'finance_invoice_changes') on conflict (version) do nothing;
