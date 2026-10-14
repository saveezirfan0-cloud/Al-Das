# Finance views and the security advisor: notes

The Supabase security advisor reported `security_definer_view` (ERROR) for 14 finance views: Postgres runs a view with its owner's rights unless it is `security_invoker`. This change clears all 14 without giving anyone a row they could not see before.

Migration `supabase/migrations/20261119000100_finance_views_invoker.sql`; paste file `deploy/supabase-paste/59_finance_views_invoker.sql` (same SQL). Tests: `tests/db/finance-views-invoker.test.ts`.

## Why no view could simply be switched

Each view deliberately shows a permission holder more than the base tables' RLS gives them (`docs/05`, F1):

- Finance, CEO and **Medical Director** read the `finance.view` aggregates. The invoice tables need `finance.invoices.view` and the claim table `finance.claims.view`, which the Medical Director does not hold, so an invoker view would show them nothing.
- Insurance reads invoice fields without `finance.invoices.view`; Billing sees claim sums without `finance.claims.view`.
- The freshness view reads service-only tables (raw batches, capture settings, credentials).

Changing the tables' RLS instead would broaden access, so that was ruled out.

## What each view became

| View | Now | Why |
|---|---|---|
| `v_ins_invoice_match`, `v_ins_invoice_line_match`, `v_fin_revenue_daily`, `v_fin_adjustments_daily`, `v_fin_collections_daily`, `v_fin_monthly_summary` | **Revoked** from `anon` and `authenticated`; unchanged otherwise | No screen, route or job reads them. Every finance screen reads with the member's own client, and the service role never had rows in them (`app.has_perm` needs a signed-in user). `v_fin_monthly_summary` stays because the measures read it |
| `v_fin_receivables_ageing`, `v_fin_denials`, `v_fin_claims_status`, `v_fin_revenue_monthly`, `v_fin_monthly_measures`, `v_fin_data_freshness`, `v_fin_billing_readiness` | **`security_invoker`** view over `app.fin_view_<name>()` | The function (SECURITY DEFINER, `search_path = ''`, in the unexposed `app` schema, EXECUTE for `authenticated` and `service_role` only) holds the previous query. Same columns, grants and rows |
| `v_fin_invoice_list` | **`security_invoker`** over the tables; claim sums from `app.fin_invoice_claim_totals(invoice_id)` | Its gate (`finance.invoices.view`) is already the invoice and payment tables' RLS rule. Only the claim sums need owner rights, and the helper repeats the invoice gate |

The one rewrite inside the function bodies: a per-row `app.has_perm(x.org_id, p)` is written as `x.org_id in (select o.org_id from app.user_org_ids() o(org_id) where app.has_perm(o.org_id, p))`. This is the same test (`has_perm` needs an active membership, which is exactly what `user_org_ids` lists), but it runs once per organisation instead of once per row. It makes up for page filters (month, branch) that no longer reach inside the function.

## Proof and speed

- The tests read each view's previous definition from the migration that last created it and run it the way an owner-rights view ran: as the owner, with the member's JWT. The result must equal the new view's rows for an org A Admin, Finance, CEO, Medical Director, Billing, Insurance, a member with no finance permission, and org B's admin. The service role still sees nothing. A catalogue test repeats the advisor's rule: no view that `anon` or `authenticated` can read may lack `security_invoker`.
- Speed, on 80,000 synthetic invoices in one rolled-back transaction, timed as an Admin on a shared sandbox (so only roughly): the invoice-list page (25 rows, sorted) went from about 1.6 to 2.5 s down to 1.0 to 1.4 s, because the claim and payment sums are now worked out only for the rows on the page. Its count stayed at about 0.9 to 1.3 s. Revenue by month dropped from about 0.5 s to 0.2 s, and ageing, claims and denials from about 0.5 s each to under 0.15 s. Measures, readiness and freshness stayed about the same. One query got slower: summing the claim columns over every invoice at once (no screen does this).
- `app.has_perm` once per invoice row is still the main cost of the invoice list and its count, as it was before. That is not changed here.

## For new work

A view that signed-in users read must be `security_invoker`. If it has to show aggregates the reader cannot see row by row, put the query in an `app.*` SECURITY DEFINER function that applies `app.has_perm` itself, and select from it in an invoker view.
