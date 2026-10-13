-- Phase 20: new workspaces get the close checklist (20G) and the starter settlement rules (20C) too.
--
-- Both were seeded only for the workspaces that existed when their migrations ran (and by `pnpm finance:seed`), so a
-- workspace created later (including a demo workspace) started with an empty close timetable and no settlement rules.
-- This runs both seeds after every new org, beside the existing orgs_seed_finance trigger (triggers on the same event
-- fire in name order, so this one runs after the finance reference seed). Both seed functions are idempotent.

create or replace function app.fin_seed_phase20_on_org_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.fin_close_seed_steps(new.id);
  perform public.fin_seed_settlement_rules(new.id);
  return new;
end;
$$;
revoke all on function app.fin_seed_phase20_on_org_insert() from public, anon, authenticated;

create trigger orgs_seed_finance_phase20 after insert on public.orgs
  for each row execute function app.fin_seed_phase20_on_org_insert();

-- Workspaces created between those migrations and this one
select public.fin_close_seed_steps(id) from public.orgs;
select public.fin_seed_settlement_rules(id) from public.orgs;
