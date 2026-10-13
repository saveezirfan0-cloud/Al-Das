# Phase 20B notes: finance intake (accounts mailbox and manual drop)

_Built 13 Oct 2026 (what's-new dated 3 Nov, the planned release) on a worktree of `claude/funny-clarke-6t7gee` at `d533cb5`. Plan: `docs/20_FINANCE_CONTROL_PLAN.md`, slice 20B._

## What it replaces

Supplier invoices (fewer than 100 a month) that arrive by e-mail to the accounts mailbox and are forwarded or printed by hand, paper invoices carried from the three branches to the central office, and bank statements and processor reports saved to shared folders. The meeting asked for "the data incoming part automated from e-mails; the manual one just a file drop". Patient-identifying reports (Diligence, remittance advice, lab reports with names) stay on their own upload pages, which parse them and delete the original at once; they never come here.

## What exists

| Piece | Where |
|---|---|
| Finance inbox: unrouted documents (newest first) with received time, source (e-mail from a domain, or dropped here), type, size, scan badge; label (supplier invoice, bank statement, processor report, other), Open (60-second link, logged), **Make a supplier invoice** (the 20D invoice form with the document attached), Discard; a multi-file drop zone; the note that patient reports never go here | `/finance/inbox` (`page.tsx`, `inbox-ui.tsx`, `actions.ts`) |
| Finance mailbox integration (OFF by default): Postmark inbound webhook with HTTP basic auth, allow-listed senders | catalogue entry `finance_mailbox` in `lib/integrations/catalog.ts`; Settings, Integrations, Finance mailbox |
| Webhook route | `POST /api/webhooks/integrations/finance_mailbox/<account id>` (through `receiveIntegrationWebhook`) |
| Message reading, allow-list, attachment checks (pure) | `lib/finance/mailbox.ts` |
| Storing attachments, the webhook spec | `lib/finance/mailbox-server.ts` |
| Inbox uploads, discard, inbox-only links | `lib/finance/finance-documents.ts` (20D helper, extended) |
| Upload code shared with 20D (`uploadFinanceFile`) | `components/finance/finance-upload.tsx` |
| Migration | `supabase/migrations/20261103000100_finance_intake.sql`, paste file `deploy/supabase-paste/33_finance_intake.sql` |

**Permission.** `finance.inbox.manage` (Finance and Finance Manager presets; granted to the existing system roles by the migration): see, drop, label, open and discard inbox documents. Making the supplier invoice still needs `finance.payables.manage` (the button only shows with it). Switching the mailbox on needs `integrations.manage` (Admin) and the typed words **ACCEPT MAILBOX ATTACHMENTS**.

**Data.** No new table: an inbox file is a `fin_documents` row (20D) with three new columns: `inbox_at` (came in through the inbox), `routed_at` (first linked to a supplier invoice or a voucher; set by a trigger) and `sender_domain` (e-mail only). Two new kinds: `processor_report` and `unclassified` (an inbox file until someone labels it). In the inbox = `inbox_at` set, `routed_at` null, status `ready`. A second select policy lets `finance.inbox.manage` read inbox documents (the 20D policy for payables and voucher staff is unchanged). The `finance-documents` bucket now accepts CSV.

## The rules

- **The mailbox keeps attachments only.** The webhook schema reads three things of a message: its MessageID (idempotency key), the sender's address (allow-list check; only the domain is stored) and the attachments. Body, subject, names, headers and file names are dropped before any code sees them and are never logged or stored (a test plants recognisable text in each and searches every stored row and call for it).
- **Allow-list.** Addresses (`accounts@supplier.example`) or whole domains (`supplier.example`, not its subdomains), separated by commas or spaces, at most 100. Mail from anyone else is acknowledged (200, so the provider does not retry) and dropped; the drop is counted on the integration page ("Messages dropped (sender not allowed)"). The sender address can be forged; that is why nothing is paid without the voucher approvals (20D) and every file is flagged until scanned.
- **Attachments are judged by their bytes**, never by the declared type: PDF, JPEG, PNG and Excel by their signatures (Excel = a zip holding `xl/workbook.xml`); CSV is plain text that the sender also called CSV (name or type), because text alone could be a calendar invitation or a note. Anything else is refused and counted. Empty or over 20 MB (`FINANCE_DOCUMENT_MAX_BYTES`, the 20D finance-document limit and the bucket's limit) is refused. Pictures embedded in the message body (an image with a content id: signature logos) are skipped.
- **Each accepted attachment** becomes one `fin_documents` row: source `email`, kind `unclassified`, the sender domain, sha256; the file goes to the private `finance-documents` bucket at `<org>/<document>.<ext>` (`lib/media/paths.ts`); the malware-scan hook runs; an `infected` file is removed with its row (never served, never kept). The same file already held by the organisation (sha256) is skipped as a duplicate. A pending row is written before the upload, so a crash leaves only a pending row that the nightly `documents_maintenance` removes.
- **Idempotent.** `receiveIntegrationWebhook` claims the MessageID once; a replay is answered 200 and stores nothing. If storing fails the claim is released and the route answers 500, so the provider retries; files already stored are then recognised by their sha256.
- **Training workspaces** store nothing (counted as refused).
- **Size.** A request over 4.5 MB is refused (413). That is Vercel's request-body limit for functions, and attachments travel base64-encoded, so about 3 MB of attachments fit in one e-mail. A bigger scan must be dropped on the page.
- **The drop zone** uses the 20D upload path (prepare, browser to a signed URL, finalise with sha256, content sniff and scan hook) with `inbox_at` set and kind `unclassified`. Several files at once; the same file twice is not added again.
- **Leaving the inbox.** The first supplier invoice or voucher that links a document marks it routed (database trigger, every path including a 20D upload that turned out to be a duplicate of an inbox file) and an unlabelled one becomes `supplier_invoice` / `voucher_backup`; a label already given is kept. The trigger refuses a link to a document that is not ready.
- **Discard** removes the file, then the row, audited. It is refused for a routed document, one that did not come through the inbox or one of another organisation. The row is claimed first (status `rejected`, fingerprint cleared) so a link made at the same moment is refused by the trigger; if the file cannot be removed the claim is undone.
- **Labels** (supplier invoice, bank statement, processor report, other) only describe the file for now; 20C will read bank statements and processor reports from here.

## How it was verified

- `tests/unit/finance/mailbox.test.ts` (15): parsing (body, subject, names and headers dropped; From fallback; malformed messages), the allow-list (address, domain, case, subdomains and look-alikes refused, bad entries named), type by content (each accepted type whatever it claims; executables, Word, other zips, GIF and HTML refused even when they claim to be PDF; CSV only when called CSV), size, inline pictures, base64, basic auth, the webhook address.
- `tests/unit/finance/mailbox-webhook.test.ts` (12): the real route over the in-memory database and storage (`tests/helpers/fake-admin.ts`): 404 unknown / malformed / switched off, 401 no or wrong password or user, 413, 400, four types stored with the domain only, no planted text anywhere, MessageID replay, duplicate files, dropped sender, refused types and sizes, skipped logos, training workspace, infected file (fake scanner), storage failure answering 500 with the claim released and a clean retry.
- `tests/unit/finance-inbox-actions.test.ts` (12): every action refuses a member without `finance.inbox.manage` before the service role is created (payables and voucher keys do not imply it); label; discard order (file, then row), refusals and the undo when storage fails; open is inbox-only, logged, and never for an infected file.
- `tests/db/finance-intake.test.ts` (6, Postgres 16): the grant (idempotent, equal to the code presets), the kinds and the sender-domain rule, the routing trigger for invoices (insert, unchanged edit, moved document) and vouchers, the refusal of a link to a rejected or pending document, who reads inbox documents (inbox key in its own org only; not other finance documents; nobody writes directly).
- `tests/unit/finance/nav.test.ts`, `tests/unit/integrations/catalog.test.ts`: the inbox entry and badge, the catalogue entry and its typed confirmation.
- Typecheck, lint, the full unit suite, the full database suite and `pnpm audit:security` (0 unguarded; the route is in `UNGUARDED_OK` with its reason).

## Not verified

- **No real Postmark account.** The payload shape (`MessageID`, `From`, `FromFull.Email`, `Attachments[]` with `Name`, `Content`, `ContentType`, `ContentID`) and basic auth in the webhook URL come from Postmark's documentation. Send one test message from Postmark's inbound settings before forwarding the real mailbox.
- **Not clicked through in a browser** (no Supabase auth or storage stack here): the drop zone, the signed upload, the inbox table and the invoice form opened from it were typechecked and linted, not used.
- **The 4.5 MB limit** is Vercel's documented request-body limit at the time of writing; check it on the deployed plan.
- No malware scanner is configured, so files are stored "Not scanned" and flagged, as in Phases 16 and 20D.

## Before first use

1. Apply `deploy/supabase-paste/33_finance_intake.sql` to the **Pulse** project (after 32).
2. Create a Postmark account (or use the clinic's) and an **inbound** message stream. Postmark gives it an inbound address such as `<hash>@inbound.postmarkapp.com`.
3. In Pulse, Settings, Integrations, Finance mailbox: generate a long random password (24 or more letters and digits), enter it as the webhook password, list the allowed senders (each supplier's accounts address, or its domain, and the bank and payment processors that send statements), Save.
4. Copy the webhook address shown on the page, replace `<webhook password>` with the password, and paste it as the inbound webhook URL of the Postmark stream (`https://pulse:<password>@<pulse host>/api/webhooks/integrations/finance_mailbox/<account id>`). Send a test from Postmark: it should answer 200; with the integration still off it answers 404.
5. Switch the integration on (type ACCEPT MAILBOX ATTACHMENTS).
6. In the mail system of the accounts mailbox, add a rule that forwards (or redirects) every incoming message to the Postmark inbound address. Keep the mailbox itself as it is. Note: a forwarded message may come "from" the accounts mailbox rather than the supplier, depending on how the rule forwards; a redirect keeps the original sender. If the mail system can only forward, allow the accounts mailbox's own address instead and rely on the review in the inbox.
7. Tell finance staff: patient reports (Diligence, remittance, lab reports with names) must not be sent to the accounts mailbox or dropped in the inbox; they have their own upload pages.

## Decisions worth knowing

- **No separate intake table.** The plan sketched `fin_intake_documents`; 20D's `fin_documents` already holds sha256, scan status, the private bucket and signed links, so inbox files are rows there with `inbox_at`. One store, one duplicate rule, one access path.
- **No routing to the Diligence / remittance / cost parsers** from the inbox: those files carry patient names and must be parsed and deleted at once on their own pages, never stored. The Unite daily revenue report upload (plan 20B, only if Unite capture stays off) was not built.
- **Dropped senders are counted, not listed.** Keeping the sender domain of mail Pulse refused would store data about third parties for no use; Postmark's activity log shows the details when finance asks why a supplier's invoice did not arrive.
- **The limit stays 20 MB per file** (the 20D finance-document and bucket limit), not 25 MB; in practice the 4.5 MB request limit is what binds for e-mail.
- **CSV is accepted** for finance documents generally (drop zone and 20D attachments too), because bank statements come as CSV.
- **A label does not route.** Only a supplier invoice or a voucher takes a document out of the inbox; a labelled bank statement stays until 20C reads it or someone discards it.
