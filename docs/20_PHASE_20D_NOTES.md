# Phase 20D notes: payables and zero-paper approvals

_Built 13 Oct 2026 on the 20D worktree branch (based on `claude/funny-clarke-6t7gee` at `72147a6`). Plan: `docs/20_FINANCE_CONTROL_PLAN.md`, slice 20D. Source: the CEO directive "Zero Paper. Full Accountability" (July 2026) and the finance meetings (section 1.1 of the plan)._

## What it replaces

Paper payment vouchers signed by hand, invoices carried between branches and the central office, approvals by e-mail or in person, and Althaf re-keying approved payments into Tally. The directive asks for: maker (Krishna for revenue, Althaf for costs) creates the voucher with the digital backup attached, the checker (Hardik, Finance Manager) verifies, the approver (CEO) authorises; Pending until authorised; rejection with mandatory remarks; a complete trail; bulk authorisation for routine items; delegation of authority by tier and special category; status and exception reports; documents stored digitally, never printed.

## What exists

| Piece | Where |
|---|---|
| Payment vouchers: tabs Drafts, To verify, To approve, Approved, Paid, Rejected; record drawer with the trail, documents, fingerprint and the next step; bulk verification of Tier 1; phone-friendly (cards, 44 px targets, full-width drawer) | `/finance/vouchers` (`page.tsx`, `voucher-ui.tsx`, `actions.ts`) |
| Status and exception report: pending by stage, approved, paid, rejected, average approval time (overall and per tier), unusual transactions, rejected vouchers with remarks, special categories | `/finance/vouchers/report` |
| Delegation of authority, approval mode, report thresholds; Tally ledgers and Tally company | `/finance/vouchers/settings` (`page.tsx`, `forms.tsx`, `actions.ts`) |
| Supplier invoices with their document (upload a PDF or a phone photo), "Pay with a voucher", void | `/finance/payables` (`page.tsx`, `forms.tsx`, `actions.ts`) |
| Suppliers | `/finance/suppliers` |
| Tally export: what the next file holds, missing ledger mappings, build the file, earlier files with checksum and download | `/finance/tally`, `GET /api/finance/tally/<id>` |
| Approval certificate PDF | `GET /api/finance/vouchers/<id>/certificate`, `lib/finance/voucher-certificate.ts` |
| The rules (pure, unit-tested): tier routing, state machine mirror, report and exception flags, numbering, labels | `lib/finance/vouchers.ts` |
| Content fingerprint (server only, `node:crypto`) | `lib/finance/voucher-hash.ts` |
| TallyPrime XML builder | `lib/finance/tally-xml.ts` |
| Finance documents (prepare, finalise with sha256 and scan hook, signed links with the access log) | `lib/finance/finance-documents.ts`, `components/finance/finance-upload.tsx`, paths in `lib/media/paths.ts`, limits in `lib/media/limits.ts` |
| Loaders (service role after the permission check) | `lib/finance/vouchers-server.ts` |
| Migration | `supabase/migrations/20261024000100_finance_payables.sql`, paste file `deploy/supabase-paste/23_finance_payables.sql`; review fixes `supabase/migrations/20261107000100_finance_fixes_payables.sql`, paste file `deploy/supabase-paste/37_finance_fixes_payables.sql` (see "Changes after review") |

**Permissions.**

| Key | Who (presets) | What |
|---|---|---|
| `finance.payables.view` | Finance, Finance Manager, CEO | read suppliers, supplier invoices, vouchers, documents, reports (special categories and inbox files: see "Who reads what") |
| `finance.payables.manage` | Finance, Finance Manager | suppliers and supplier invoices, their documents |
| `finance.vouchers.prepare` | Finance, Finance Manager | maker: create, edit, submit, reopen, cancel |
| `finance.vouchers.check` | Finance Manager | checker: verify or reject; bulk-verify Tier 1 |
| `finance.vouchers.approve_dept` | Department head | Tier 2 approval |
| `finance.vouchers.approve_ceo` | CEO | Tier 3, Tier 4 and special categories |
| `finance.vouchers.pay` | Finance, Finance Manager | record payment date and bank reference |
| `finance.vouchers.settings` | Finance Manager | delegation of authority, approval mode, thresholds |
| `finance.tally.export` | Finance, Finance Manager | Tally ledger mapping, Tally company, build and download exports |

Two new presets: **Finance Manager** (everything Finance holds plus `vouchers.check` and `vouchers.settings`, so the person who prepares vouchers is not automatically the one who verifies them) and **Department head** (`vouchers.approve_dept` only). Billing, Insurance, Medical Director and Cost / Payroll get none of these keys. Existing orgs get the grants and both roles from the migration; new orgs from `lib/auth/permissions.ts`.

**Tables** (all `fin_*`, RLS on `org_id`, select policies only; every write is a server action or a service-role function after `can()`):

- `fin_documents`: generic finance evidence (kind, source upload or e-mail, path `<org>/<document>.<ext>`, size, mime, sha256 unique per org, status pending / ready / rejected, scan status). Bytes in the private bucket `finance-documents` (no storage policies). No file name is stored. 20B (intake) uses the same table.
- `fin_suppliers`, `fin_supplier_invoices` (invoice number unique per supplier, net, VAT, generated total, `paid_amount` (paid so far; balance = total - paid_amount), branch, cost centre, optional doctor, document, status open / on_voucher / paid / void, Tally export link).
- `fin_payment_vouchers` (number `PV-<year>-<nnnn>`, payee, optional supplier, amount, category, special category, branch, cost centre, pay-from key, method, narration, status, route, the tier snapshot taken at submission, `content_sha256`, who and when for every step, rejection remarks, payment date and bank reference, Tally export link), `fin_voucher_invoices`, `fin_voucher_documents`, `fin_voucher_events` (append-only trail), `fin_voucher_counters` (service-only).
- `fin_ref_approval_tiers` (seeded per org with the directive's defaults, editable), `fin_ref_tally_ledgers` (Pulse key to Tally ledger name), `fin_tally_exports` (counts, total, sha256, the XML itself).
- `fin_ref_finance_settings` gains `approval_mode` (`pulse` default, or `tally`), `voucher_duplicate_window_days` (30), `voucher_mismatch_tolerance` (1.00), `voucher_large_amount` (50,000), `tally_company_name`, `tally_cost_category` ("Primary Cost Category").
- `record_access_log.entity` accepts `finance_document`.

**SQL** (SECURITY DEFINER, `search_path = ''`, service role only, jsonb results; errors carry a stable code in the HINT): `fin_voucher_save`, `fin_voucher_act` (submit, check, approve_dept, approve_ceo, reject, reopen, cancel, pay), `fin_voucher_bulk_check`, `fin_voucher_canonical` / `fin_voucher_compute_hash`, `fin_tally_record_export`. Helpers in `app`: `user_has_perm` (the acting user's permission, same wildcards as `can()`), `fin_voucher_rule`, `fin_voucher_is_maker`, guards for vouchers, links, events and supplier invoices.

## The rules

- **Delegation of authority** (`fin_ref_approval_tiers`, defaults from the directive): T1 up to 5,000 Finance Manager only (bulk allowed); T2 5,000.01 to 15,000 Finance Manager + department head; T3 15,000.01 to 50,000 and T4 above 50,000 Finance Manager + CEO; payroll, intercompany and related party at any amount Finance Manager + CEO. Bands are inclusive at both ends. **Fails closed**: no matching rule, or more than one, and the voucher cannot be submitted. The route is frozen on the voucher at submission; a later change to the tiers applies to later submissions. The settings page lists gaps, overlaps and special rules without the CEO.
- **The Finance Manager always verifies**, even for special categories (the directive's "CEO always" is in addition to the checker).
- **Different people at every step.** A maker is anyone who created, edited, submitted or reopened the voucher; a maker can neither verify, approve nor reject it. The checker, department head and CEO are three different people. Enforced in `fin_voucher_act` (and by check constraints on the table).
- **Bound to the content hash.** At submission the database computes the sha256 of the voucher's fields, its linked supplier invoices (id and total) and the sha256 of every attachment (its own and its invoices'). Verify, approve and pay must quote that hash and the database recomputes it; any difference is refused. Editing a submitted, verified or approved (unpaid, unexported) voucher returns it to draft and clears every approval; attachments and invoice links can change only in draft; the content of a voucher that left draft cannot change any other way (trigger, all roles).
- **Rejection needs remarks** (at least 3 characters) and sends the voucher back to the maker, who edits and resubmits or reopens it. Cancelling a draft or rejected voucher also needs remarks; vouchers are never deleted.
- **Bulk verification** only for vouchers whose rule allows it (Tier 1, not a special category); each voucher is bound to the hash the checker saw and succeeds or fails on its own.
- **Payment** records the payment date and the bank reference (the "payment reference" step of the revenue-share trail in the deck). **The voucher's maker never records its payment** (`same_person`), in either approval mode, so a Tally-route voucher still involves a second person in Pulse. An approved voucher can be paid before or after it is exported to Tally.
- **Part payments.** Paying a voucher spreads its amount over its linked supplier invoices oldest first (invoice date, then number, then id), each up to its balance; the allocation is kept on the link (`fin_voucher_invoices.paid_amount`) and summed on the invoice (`fin_supplier_invoices.paid_amount`). An invoice becomes paid only when its balance is settled within `voucher_mismatch_tolerance`; otherwise it is open again ("Part paid", with its balance) and the balance goes on a later voucher. A voucher with invoices cannot be submitted for more than their balance plus the tolerance (`amount_exceeds_invoices`). A part-paid invoice cannot be voided or deleted. `allocateVoucherPayment()` in `lib/finance/vouchers.ts` mirrors the database (parity-tested). The Board pack's unpaid supplier invoices count the balance as at the month end.
- **Month lock.** A locked month (`fin_period_closes`) freezes CONTENT: nothing dated in it can be created, and the amounts, dates, supplier / payee, category, branch, narration and document of a voucher or supplier invoice dated in it cannot change, nor can a voucher's links (database triggers, all roles); a supplier invoice in it cannot be voided or deleted. It does NOT freeze the workflow: such an invoice can still be put on a later month's voucher, paid or released when that voucher is cancelled, and such an invoice or voucher can still be exported to Tally (otherwise one item would block every export). A voucher's own steps (submit, approve, pay, cancel, edit) are refused while its OWN date is in a locked month (a September voucher may pay an August invoice). A payment date in a locked month is refused.
- **Zero paper.** A voucher cannot be submitted without at least one document (its own or its invoices'); a document the malware scan blocked is refused. Documents are kept (they are the evidence), opened only through 60-second signed links, and every open is in the access log. The same file is held once per organisation: a second upload of it reuses the existing document.
- **Approval mode (OQ-90).** `pulse` (default, the plan's recommendation): approvals happen in Pulse and vouchers reach Tally already authorised. `tally`: submission sends the voucher straight to "Sent to Tally for authorisation"; Pulse keeps the voucher, documents and trail and exports it, and Tally's Transaction Authorisation decides. Changing the mode needs the typed word and is audited.
- **Tally export** is one-way (the payment narration says "Approved in Pulse." only for vouchers Pulse approved; a Tally-route voucher says "To be authorised in Tally."): a TallyPrime import file (Purchase vouchers for supplier invoices: Dr expense with the branch cost centre, Dr input VAT, Cr supplier; Payment vouchers: Dr supplier, or the expense with its cost centre when the payee is not a supplier, Cr the pay-from bank or cash ledger). Debits are `ISDEEMEDPOSITIVE Yes` with a negative amount. Refused while any ledger or cost centre is unmapped. Deterministic; its sha256 is stored with the XML, checked again before every download, and the items are marked exported in the same transaction (a second export of the same item is refused).
- **Approval certificate** (OQ-91): built from the stored voucher and trail only: fields, approval route, supplier invoices, attachments by kind, size and sha256 (no file names), every step with person, time, status change, remarks and the hash it was bound to, the approved and the stored hash (a warning if they differ). It says it is not a DSC signature.
- **Notifications** through `notify()` with a fixed generic sentence and the voucher id only: `finance.voucher_to_check` (Finance Manager), `finance.voucher_to_approve_dept` (department heads), `finance.voucher_to_approve` (CEO), `finance.voucher_rejected` (the makers). The person who acted is not notified.
- **Unusual transactions** (report): amount differs from the linked invoices by more than the tolerance; same payee and amount within the duplicate window; the large amount without any invoice; special categories. Thresholds in `fin_ref_finance_settings`.

## Who reads what (changed after review)

- **Finance staff** (`payables.view`, `payables.manage`, `vouchers.prepare`, `vouchers.check`, `vouchers.approve_ceo`, `vouchers.pay`, `tally.export`): every supplier, supplier invoice and voucher that is not a special category, and their documents.
- **Special categories** (payroll, intercompany, related party: compensation and related-party data) and their documents also need `finance.vouchers.check`, `finance.vouchers.approve_ceo` or `finance.costs.compensation` (Finance, Finance Manager and CEO hold one; a person with only `tally.export` or `vouchers.pay` does not).
- **A department head** (`vouchers.approve_dept` only) reads only the Tier 2 vouchers waiting for a department head or that they approved or rejected, never a special category, with their trail, invoices and documents, plus the tiers. No suppliers, no other invoices or documents. The vouchers page, report and certificate show the same (`loadVoucherScope()` in `lib/finance/vouchers-server.ts`, rule `canReadVoucher()` in `lib/finance/vouchers.ts`, parity-tested against row level security).
- **Files waiting in the Finance inbox** (not yet on an invoice or voucher) need `finance.inbox.manage` or `finance.payables.manage`; once routed, a file follows the rules above. Opening a document (`openFinanceDocument`) asks row level security with the person's own client first.
- The Tally file itself still holds every exportable payment line, special categories included: exporting them is the exporter's job (the presets give `tally.export` only to Finance and the Finance Manager).

## Changes after review (migration 20261107000100)

1. The month lock freezes content, not status or the Tally export link (see "Month lock").
2. `fin_ref_finance_settings`: a write through the member's own client (PostgREST, role `authenticated`) may change only the Phase 18 columns the workflow settings page writes that way (`app.fin_settings_user_columns()`: the thresholds and the blueprint settings); any other column, including one added later, is refused (`42501`), and an insert must leave them at their defaults. A database test keeps the list equal to the columns `saveThresholds` / `saveBlueprintSettings` write. Every Phase 20 setting (approval mode, voucher thresholds, bank, labs, flash, close, and now also follow-up and change review) is written by a server action with the service role after `can()`.
3. The maker never records the payment; the Tally narration tells Pulse-approved and Tally-authorised payments apart.
4. Part payments (see "Part payments").
5. Read scope (see "Who reads what").

## How it was verified

- `tests/unit/finance/vouchers.test.ts` (36): routing at every tier boundary and for each special category, fail-closed cases, `tierProblems`, the 15 state-machine scenarios of the shared fixture `tests/unit/finance/fixtures/phase20d-vouchers.synthetic.json`, next-step and rejection permissions, the canonical text and hash, numbering, the unusual-transaction flags and the report.
- `tests/db/finance-payables.test.ts` (28, Postgres 16): the seeded tiers, routing parity with the pure rule, numbering per org and year, **SQL vs TypeScript content text and hash parity** (newline, backslash and non-ASCII narration), **all 15 fixture scenarios through `fin_voucher_save` / `fin_voucher_act` with the same outcome at every step**, the append-only trail (update / delete refused even for the service role, vouchers never deleted), attachments frozen after submission, bulk check (Tier 1 only, per-item hash, a maker without the permission verifies nothing), the atomic Tally export record, locked-month supplier invoices, sha256 uniqueness per org, who reads what (Finance, Finance Manager, department head, CEO yes; Billing, Medical Director, Cost / Payroll and another org no; nobody writes directly), the access-log entity, and the migration's grants and new roles equal to the code presets (idempotent).
- `tests/unit/finance/tally-xml.test.ts` (8): envelope, order and dates, signs and balance of every voucher, cost centres, escaping (including control characters and lone surrogates), determinism and checksum, refusal with the missing list.
- `tests/unit/finance/voucher-certificate.test.ts` (4): the PDF renders, is byte-identical on re-render, paginates; finance document paths and limits.
- `tests/db/finance-payables-fixes.test.ts` (review fixes): export and status moves in a locked month while content stays frozen; the settings allow-list (browser writes refused outside it, insert defaults, a column added later, the list equal to the actions' columns); the maker cannot pay (Pulse and Tally); part payments, the balance check, the allocation in parity with `allocateVoucherPayment()` and the Board pack balance; the department head, exporter, special-category and inbox read rules, and `canReadVoucher()` in parity with row level security for every person and voucher. Unit: `vouchers.test.ts` (allocation, read scope, the fixture's pay steps), `tally-xml.test.ts` (narration).
- `tests/unit/finance/nav.test.ts`: who sees the six pages. `tests/db/security-guard.test.ts`: the new tables in the cross-org sweeps (`PHASE20D_TABLES`, `seedPhase20DRows`), `fin_voucher_counters` service-only, the six functions service-role only.
- Typecheck, lint, the full unit suite, the full database suite, `pnpm audit:security` (0 unguarded), and `pnpm build` with `pnpm bundle:check` (all new pages under the 215 kB default; the storage client loads only when a file is uploaded).

## Not verified

- **Not clicked through in a browser** (no Supabase auth or storage stack here): the upload to the `finance-documents` bucket, the signed links and the drawer flow have only been typechecked and built.
- **The Tally file has not been imported into a real TallyPrime** (OQ-92). It follows TallyPrime's documented XML import format; ledger names must match Tally exactly, and the voucher type names "Payment" and "Purchase", the `PERSISTEDVIEW` and the cost-category allocation are the documented defaults. Import the first file into a test company.
- The certificate PDF layout was not checked in a viewer beyond rendering and pagination.
- No malware scanner is configured, so documents are stored "Not scanned" (flagged in the UI), as with Phase 16.

## Before first use

1. Apply `deploy/supabase-paste/23_finance_payables.sql` to the **Pulse** project (after 22). It creates the private `finance-documents` bucket when the storage schema exists.
2. Settings, Users: give Hardik the **Finance Manager** role (instead of Finance), the CEO the **CEO** role, Krishna and Althaf **Finance**, and each department head **Department head**. Check that no one who prepares vouchers also holds `finance.vouchers.check` unless intended (the database still stops them verifying their own).
3. Finance, Voucher settings: review the tiers (seeded with the directive's figures) and decide OQ-90 (approval mode; default Pulse).
4. Add the suppliers; map every category, supplier, pay-from account (bank keys, and `cash`), branch cost centre and the input VAT ledger to Tally ledger names (needs the ledger list, D8 / OQ-92); set the Tally company and cost category names.
5. Build a first Tally file with one or two vouchers and import it into a Tally test company before using it on the live company.
6. Decide OQ-91 (is the Pulse approval certificate enough for the auditors, or must Tier 3+ also carry a DSC signature in Tally or the e-signature provider?).
7. Optional: configure a malware scanner (`MALWARE_SCAN_PROVIDER`).

## Decisions worth knowing

- A **department head is not tied to a department**: anyone holding `finance.vouchers.approve_dept` can approve any Tier 2 voucher (Pulse has no department-to-person mapping yet). Restrict by giving the role to the right people; a per-department mapping can follow.
- Tier 3 and Tier 4 run the same route (Finance Manager then CEO), as the directive says; they stay separate rules so they can diverge and so the report splits them.
- The CEO reads all vouchers, suppliers and supplier invoices of the organisation. A department head reads only their Tier 2 queue and decisions (changed after review: payroll and related-party vouchers carry compensation data).
- Supplier bank details (IBAN, account numbers) are not stored in Pulse; they stay with the bank and Tally.
- Remarks are free text typed by finance staff about business payments; they are kept in the trail and on the certificate. Do not write patient details in them.
- Voucher dates drive the month lock and the report period; the Tally payment voucher uses the payment date when there is one.
- Abandoned uploads (pending over a day) are removed by the existing `documents_maintenance` task; a rejected upload keeps its row (status rejected, no file) for the record.
- Nothing is posted to Tally directly and nothing is read back; the optional connector (plan 4.2 step 2) is a later slice.
