# W4: Parallel-run comparison (clinic plan of 16 Oct 2026)

"Existing manual processes stay until Pulse has been tested in parallel against historical and current months and the users are confident." `/finance/parallel-run` puts Pulse's figure for a finished month beside the manual figure Finance produces today, shows the difference and an explanation, and records per area the decision to rely on Pulse. **Nothing posts to the books, Unite is never called, and Pulse does not switch the manual process off**: the decision is a record.

## Objects

- `fin_parallel_figures` (org, area, month, `manual_amount numeric(14,3)`, note, entered_by/at; unique per org, area, month). Amounts and a short text only; the note goes through `redactStatementText` and the page warns not to type names.
- `fin_parallel_decisions` (one row per org and area; `running` or `switched`, note, decided_by/at). No row = not started. A reversal writes `running` again.
- `fin_ref_finance_settings.parallel_tolerance numeric(12,3)` default 1.000 AED (0 to 10,000). Edited on the page (Finance Manager). With no settings row the loader uses 0 (strictest).
- Both tables: RLS with a SELECT policy only; the policy asks for the area's own report key. Every write is a server action (service role after `can()`, audited with area and month only, never the amount or the note).
- Migration `20261222000200_finance_parallel_run.sql`. `lib/supabase/types.ts` was edited by hand (entries for the two tables and the settings column); regenerate it after the merge.

## Which loader feeds each area

| Area | Pulse figure | Source | View key |
| --- | --- | --- | --- |
| Revenue | net of current invoice lines for invoices dated in the month | `fin_revenue_breakdown(category)`, summed: the close pack's `totals.revenue_net` | `finance.revenue.view` |
| Collections | all payments dated in the month, before refunds | `fin_close_month_figures().collections[].paid`, summed: the pack's `totals.collected` | `finance.revenue.view` |
| Bank | `summary.matchedBank` of the frozen figures of reviewed or signed reconciliations | `fin_bank_recs.figures` (`runFigures`, `bank-recon.ts`) | `finance.bank.view` |
| Insurance receivable | outstanding on claims whose transaction month is the month, **as of today** | `fin_close_month_figures().by_branch[].outstanding`, summed: the pack's `totals.outstanding` | `finance.claims.view` |
| Labs | `summary.totalCost` of the frozen figures of reviewed or posted provider statements | `fin_provider_statements.figures` (`statementFigures`, `labs.ts`) | `finance.labs.view` |

Code: `lib/finance/parallel-run-server.ts` (`loadPulseFigures`, `loadParallelView`). No finance rule is derived again. Revenue, collections and insurance use the same two RPCs the close pack uses, so a month's figure equals the pack's total (the pack is built from the same data; a locked month's live figure can drift from its pack, and the close page already shows that drift).

**Not available yet** (shown as such, never zero): bank and labs for a month unless EVERY active bank account has a reviewed or signed reconciliation, and every active provider a reviewed or posted statement, for that month (a partial sum would pass for the whole). Insurance is a position as of today for the claims of that month, so an older month keeps moving as remittances arrive; Finance should enter the manual figure on the same basis (as of the day it is typed) and write that in the explanation.

## Rules (pure, `lib/finance/parallel-run.ts`, unit tested)

- Differences are worked out in whole fils (`fils()`), Pulse minus manual.
- **Agrees** = both figures exist and |difference| is within `parallel_tolerance`. A month nobody typed in is `no_manual` ("No manual figure yet"), never zero; a typed 0 is a real figure. A Pulse figure that does not exist or cannot be read is `no_pulse`.
- **Two consecutive months**: the area can be switched only when the last finished month AND the month directly before it both have a manual figure and both agree. A gap month, or a stale agreeing pair, does not count. The window is the last six finished months; the current month is never compared (and a manual figure for it is refused).
- **Switching** is checked again on the server when the button is pressed, from the stored figures and Pulse's live figures (never from the browser). It records who and when. **A later disagreement never un-switches silently**: the area stays Switched and shows a warning until someone presses "Back to running in parallel". Going back is always allowed.
- Pulse figures are labelled Provisional until the CEO sign-off locks the month (`lockLabel`, the same rule as the profit reports; a Provisional chip on each unlocked month).

## Permissions

- `finance.parallel_run.manage`: type or correct manual figures, set the tolerance, record the decision. **Finance Manager only** (and Admin through `*`): it is in the Finance Manager's own list in `FINANCE_ROLES`, not in `FINANCE_PRESET`, so Finance, Revenue & Collections and Costs & Expenses do not hold it (listed in the reporting-separation test). The migration adds it to existing Finance Manager roles. Every action also needs the area's own report key.
- Page: needs `finance.parallel_run.manage` (a tab under Month-end close, so the Medical Director and the revenue and cost roles do not get a new menu entry). Each area is then listed only if the member also holds that area's own report key (revenue and collections: `finance.revenue.view`; bank: `finance.bank.view`; insurance: `finance.claims.view`; labs: `finance.labs.view`), and RLS on both tables says the same, so a direct read by a role without the key returns nothing. Figures are clinic-wide (as the close pack is), not branch-scoped.

## How Finance uses it, month by month

1. After the month is finished and Pulse's data is in (Unite capture or uploads, Diligence, bank and lab reviews), open Finance, Parallel run.
2. For each area, type the figure Finance produced by hand, on the basis written under the area's name; add a short reason for any difference (no names).
3. Read the Result. Fix what differs (Pulse data or the manual sheet) and say so in the explanation.
4. When an area's two latest finished months, back to back, both agree, press "Mark as switched to Pulse". Until then the manual process continues.
5. Each month keep entering figures: a switched area that stops agreeing shows a warning.

## Not done on purpose

No Excel export (the neighbours' exports carry computed reports; this page is a small entry form). No deletion of a manual figure (overwrite it). The tolerance has no per-area value.
