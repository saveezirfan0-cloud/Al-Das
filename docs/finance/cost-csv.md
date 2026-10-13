# Cost CSV formats (Finance, Costs page)

Plain CSV, first row is the header. Header names are fixed; an unknown or missing header rejects the file. A file is saved
whole or not at all, and every problem is listed with its row number. Amounts have at most two decimals; thousands commas are
allowed ("1,234.50"). No patient data belongs in these files.

## Service costs (`finance.costs.manage`)

```
item_code,effective_from,unit_cost,note
T-100007,2026-01-01,12.50,lab kit
```

- `item_code` is Unite's ItemCode (upper-cased). `effective_from` is a real date. The latest row on or before the invoice date applies.
- `unit_cost` must be **above 0**. A zero would mean "no cost known"; leave the row out instead and the line shows as uncosted.
- Loading the same item and date again replaces the cost.

## Overheads (`finance.costs.manage`)

```
month,branch,pool,amount,basis,note
2026-09,,Rent,45000,invoices,shared across branches
2026-09,P,Cleaning,3000,,Palm only
```

- `month` is `yyyy-mm`. `branch` is a branch code (P, M, G) or blank for a cost shared across branches.
- `basis` (shared rows only): `revenue` (default), `invoices` (by invoice lines), or `equal`. Leave it blank on a branch row.
- Loading the same month, branch and pool again replaces the amount. An approved month cannot be changed until it is reopened.

## Doctor compensation (`finance.costs.compensation`, confidential)

```
month,doctor_dha_id,amount,note
2026-09,D1234,18000.00,
```

- One row per doctor and month, using the DHA licence id. Visible only to people holding the compensation permission.

## Approving a month (`finance.profit.approve`)

Finance → Costs → Months → Approve. An approved month's compensation and overheads cannot change; reopening is audited.
Profit figures are labelled **Provisional** until every month in the range is approved and every service line has a cost.
