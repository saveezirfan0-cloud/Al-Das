# Follow-ups: one status per claim, rejection origin and avoidable

Follow-up 3 and the origin/avoidable part of follow-up 4 of `docs/47_W3_W5_INSURANCE_NOTES.md`. Migration `20261223000200_finance_claim_status_origin.sql` (deploy copy `deploy/supabase-paste/104_finance_claim_status_origin.sql`). No new table and no new permission.

## What changed

| Piece                                                                                                                                                                            | Where                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Status column, chip and Status filter on Claims; "Overpaid" chip; Diligence's own status kept as "Diligence status"                                                              | `app/(app)/finance/claims/page.tsx`                                                                                |
| Status card on the claim page (status, still owed, taken back, overpaid)                                                                                                         | `app/(app)/finance/claims/[id]/page.tsx`                                                                           |
| Status and Still owed columns, Status filter in the Claims Excel                                                                                                                 | `app/api/finance/claims/export/route.ts`, `parseClaimFilters` (`cstatus`)                                          |
| Row to facts, take-backs per claim, denial outcome, chip colours (pure, unit-tested)                                                                                             | `lib/finance/claim-status.ts` (`claimFactsFromRow`, `takenBackByClaim`, `denialOutcomeOf`, `CLAIM_STATUS_VARIANT`) |
| Loader: settings, take-backs, denial cases                                                                                                                                       | `lib/finance/claim-status-server.ts`                                                                               |
| Setting "Does Diligence's Remitted already deduct payments taken back?"                                                                                                          | `fin_ref_finance_settings.diligence_remitted_nets_takebacks`, Finance, Workflow settings, Claim status             |
| `origin` / `avoidable` columns on the denial codes, editable per code                                                                                                            | `fin_ref_denial_codes`, Workflow settings, Denial reason codes                                                     |
| `rejectionOrigin` reads the code's row (no table in code any more); `originBreakdown` (pure)                                                                                     | `lib/finance/denials.ts`                                                                                           |
| Origin column and breakdown (cases and amounts by origin; avoidable / not avoidable / not classified) on Denials; origin and avoidable on the case page and in the Denials Excel | `app/(app)/finance/denials/*`, `app/api/finance/denials/export/route.ts`                                           |
| One taxonomy loader for pages, export and the appeal drafter                                                                                                                     | `lib/finance/denial-taxonomy.ts`                                                                                   |
| Glossary: Claim status, Payment taken back, Rejection origin, Avoidable; guides updated                                                                                          | `lib/help/glossary.ts`, `lib/help/guides.ts`                                                                       |

### Claim status

- One status per claim ACTIVITY row (the Claims list is per activity; the advice lines and denial cases are linked by `claim_activity_id`).
- Facts: net, remitted, rejected, write-off (counted only when `write_off_status` is "approved", the existing convention), resubmissions and the last resubmission / remittance dates come from the Diligence row; `accepted` = Diligence status in `accepted_claim_statuses`; `takenBack` = the claim's negative `ins_remittance_lines.paid_amount`, summed in fils; the denial outcome = a case being worked is "open", else the latest case (lost, written off, otherwise none). Tolerance = `short_pay_tolerance_amount`.
- Access: the list and claim page read claims with the member's own client (RLS, `finance.claims.view`). Advice lines (`finance.remittance.manage`) and denial cases (`finance.denials.manage`) are read with the service role after `can(member, 'finance.claims.view')`, and only the summed take-back amount and case statuses per claim id leave the loader.
- The Status filter is worked out after the query, so it looks at the 5,000 most recent activities matching the other filters (the page says so when it is cut). The Excel computes it for every exported row.
- `bankReceived` is always false for now: the bank receipt is not linked to single claims (deposits are matched per payment reference / advice, follow-up 1). A claim paid in full therefore shows **Paid**; **Closed** appears only when its denial case was lost. The page says so.

### Take-back treatment (open question, Hardik)

`diligence_remitted_nets_takebacks`: null = unconfirmed (default), true = Remitted is after take-backs, false = Remitted is before take-backs. While null, the proposed treatment is used: Remitted is gross and Pulse deducts the take-backs itself (the same as false). With true, the take-backs are added back to Remitted first. The Claims list, claim page and Excel show "Unconfirmed" while it is null. Written only by the workflow settings server action with the service role after `requirePerm('finance.reference.manage')`, audited (`finance.workflow.claim_status_saved`); it is deliberately not in `app.fin_settings_user_columns()`, so a browser write is refused.

### Rejection origin and avoidable

- Data: `fin_ref_denial_codes.origin` (`front_desk`, `clinical`, `billing`, `payer`, or null) and `avoidable` (boolean or null). Null = **Not classified**, never "not avoidable".
- Seed: the migration fills every existing code (except category `other`) once from the PROPOSED table by category (`app.fin_denial_origin_proposal`, mirrored in `tests/unit/finance/fixtures/rejection-origin-proposal.synthetic.json`; a DB test keeps them equal). Starter placeholder rows that `seed_finance_reference()` inserts for a new organisation get the same proposal through the `fin_ref_denial_codes_origin_seed` BEFORE INSERT trigger (the seed function is not redefined). A code Finance adds afterwards stays Not classified until Finance picks a value.
- The case's origin is derived at read time from the CURRENT taxonomy (exact code, then family), like the code's meaning on the case page; it is not stored on the case.
- Edits: the denial-code form (same permission `finance.reference.manage`, same RLS write, audit now carries category, origin and avoidable).

## Assumptions

- The proposed treatment (Diligence Remitted is gross of take-backs) matches `claim-status.ts`'s documented input.
- `write_off_status = 'approved'` (case-insensitive) is the approved write-off, as everywhere else.
- The one-off seed also classifies codes Finance had already added (by their category), because that is what the in-code table did before; Finance should review them.
- The breakdown counts the cases matching the list's filters (default: cases being worked), at most 20,000.

## Open questions

| Question                                                                                                                                                            | Who confirms                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Does Diligence's Remitted already net payments taken back? (set the answer in Workflow settings, Claim status)                                                      | Hardik                                   |
| The proposed origin / avoidable per category (pricing = payer, avoidable unknown; medical necessity = clinical, not avoidable; documentation = clinical, avoidable) | Mohammed (insurance), Vineetha (finance) |
| Should "Closed" wait for the bank receipt per claim? Needs the deposit-to-reference link of follow-up 1                                                             | Vineetha                                 |
| Should the status be shown per claim (invoice) as well as per activity?                                                                                             | Mohammed                                 |

## Not done

- Bank receipt per claim (follow-up 1), so no claim is closed by a bank receipt yet.
- `paid_before` from earlier advices (follow-up 2), unmatched-deposit exceptions and the close-pack receivable comparison (rest of follow-up 4).
- A filter by origin on the Denials list (origin is derived from the taxonomy at read time; the breakdown covers the need for now).
