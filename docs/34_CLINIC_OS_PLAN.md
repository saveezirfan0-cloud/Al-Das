# 34 — Pulse as the clinic operating system: audit and plan

Date: 14 Oct 2026. Sources: six read-only audits run in parallel (front desk and branches; inbox, CRM and tasks;
finance and accounting; connections and go-live; UX simplicity; technical health), the owner's brief, and the
Nova Lux system app (`systemnovalux/system`) as the reference for navigation.

**Goal.** One system that runs Al Das's three branches day to day: reception, doctors, the call centre and marketing
(the Sanoflow part), finance and accounting, staff. New staff should be productive on day one with almost no training:
few choices on screen, the same patterns everywhere, nothing hidden.

## 1. Where Pulse stands

**Built.** Feature-complete in code against Sanoflow (inbox, templates, campaigns, flows, enquiries, appointments,
bots) and against the Airtable/Make back office. Finance, insurance and a full double-entry ledger with Tally are built
too. About 180 pages, ~3,100 unit tests, ~1,390 database tests. All 130 menu links open real pages (now enforced by
`tests/unit/nav-integrity.test.ts`). No TODO/FIXME stubs in the code.

**Not yet proven.**
- Nothing has been clicked through by a signed-in person in a browser, and the 14 end-to-end tests only cover
  signed-out redirects. CI never runs Playwright.
- No connection has been tried against a live account: Meta, Unite, Resend, Postmark, Google, SMS, payments, Tally,
  Web Push.
- The live database's migration state disagrees between `docs/09` §0 and §0b. It must be checked before anything else.

**The three structural gaps behind most of the owner's points:**
1. **Branches are not first-class.**
   - A branch is a `locations` row, and only the diary uses it.
   - Staff cannot be pinned to a branch, and the front desk shows all three branches on one board.
   - Channels, conversations, tasks, contacts, claims and payments have no branch.
   - Finance uses a separate `fin_ref_branches.code` list that nothing links to `locations`.
2. **The organisation is missing.**
   - Doctors exist only as `specialists` under Settings, Appointments.
   - There is no staff directory, HR record, duties, rota or payroll link (payroll costs live in `fin_cost_*` as amounts only).
   - There is no Doctor/Nurse role, so a doctor cannot see "my day".
3. **Too much on screen.**
   - Finance shows 44 menu entries and Accounting 43, with duplicate ideas under different names (two receivables
     ageings, two exceptions pages, three bank screens, two Tally screens).
   - Settings are spread over five places.
   - Everyone gets the same dashboard.
   - 117 list screens use plain tables instead of the shared DataGrid, and there are four different Save placements in drawers.

## 2. Defects to fix first (not features)

| # | Defect | Where | Effort |
|---|---|---|---|
| D1 | The unread-conversation alert e-mail puts the patient's name in the subject and bypasses `notify()` (breaks the PHI rule) | `lib/jobs/handlers/inbox-housekeeping.ts` | S |
| D2 | "Send location" can send the wrong branch (falls back to the first location by name) | `lib/front-desk/desk-send.ts`, `patient-card.tsx` | S |
| D3 | Lists and sums silently stop at 1,000 rows (Supabase `max_rows`). This affects finance summary totals, exception counts, exports, and erasure of patient media (privacy) | ~37 call sites with `.limit(>1000)` | M |
| D4 | Sentry is installed but never initialised, so there is no error visibility in production | `instrumentation.ts`, `next.config.ts` | S |
| D5 | Inbox list capped at 100 with no "load more"; the label filter runs after the cap | `lib/inbox/queries.ts` | S |
| D6 | Check-out never sets the appointment to Completed, so completion reports read low | `front-desk/actions.ts` | S |
| D7 | Notification links open the list page, not the item (tasks, appointments); push and in-app links disagree | `lib/notify/links.ts`, `push-payload.ts` | S |
| D8 | 46 What's new entries are dated in the future, so "unseen" counts are wrong | `lib/help/whats-new.ts` | S |

**Status (14 Oct 2026).** Fixed: D1–D8.
- D3 adds `lib/supabase/fetch-all.ts` and the guard test `tests/unit/no-large-limit.test.ts`.
- D4: Sentry is wired and off until a DSN is set.
- Also built: the Go-live checklist at `/settings/readiness`, and the extended preflight.

Still open in Phase A:
- The live-database check (the Pulse Supabase project is not reachable from this workspace's connector).
- The signed-in Playwright suite: first slice built (`tests/e2e/signed-in`, `.github/workflows/e2e.yml`, not a
  required check yet; tests/e2e/README.md). It covers the shell, front desk check-in and walk-in, booking and moving
  an appointment, inbox note and training-mode reply, the Patients list and drawer, and permission refusals, as Admin,
  Receptionist and Agent. Still to add: a synthetic Diligence/bank upload and the tax invoice PDF.

## 3. Target structure (what people will see)

Desktop: a slim rail of areas. Pointing at an area pops its pages out (done in this change). The pin docks that panel,
the same pattern as Nova Lux. A **branch switcher** sits at the top of the rail: *All branches* or one branch. It is
remembered per person and pre-set to their home branch.

| Area | Pages (target) |
|---|---|
| **Home** | Role-based: Receptionist → Front desk; Doctor → My day; Agent → Inbox; Finance → My work queue; CEO → Management |
| **Today** | Front desk, Appointments (calendar: day by doctor, week, month), Tasks, Clinical follow-ups (moved from Portal) |
| **Messaging** (the Sanoflow part) | Inbox, Templates, Campaigns, Flows, Recall, Media |
| **CRM** | *People:* Patients, Enquiries. *Organisation:* Doctors, Staff, Teams, Branches |
| **Finance** | Today's work, Claims & collections, Money, Month-end, Reports hub (Setup moves to Settings) |
| **Accounting** | Ledger, Banking, Sales & receivables, Purchases & payables, Close, Reports |
| **Insights** | Reports hub (operations + finance + accounting cards), Management dashboard, Portal |
| **Settings** | One place for every setting, with Finance and Accounting setup included and a Go-live checklist on top |

The phone keeps the drawer with the same tree plus the bottom tabs.

## 4. Plan in phases

Each phase is one or more PRs. Every phase ends with typecheck, lint, unit, database and the new end-to-end tests green,
docs and help guides updated, and the `nav-qa` agent run.

### Phase A — Safe to go live (1 week)
- Fix D1–D8.
- **Check the live database** against `supabase/migrations` and correct `docs/09` and `TODO_FOR_AL_DAS.md`.
- **Go-live checklist page** (`/settings/readiness`). One screen with every connection's status (WhatsApp, Unite,
  Resend, Postmark, Google, Push, SMS, payments, AI, Sentry), the cron last-runs, and the finance readiness steps.
  Each row is Required / Optional / Blocked by a decision. Built from `lib/cutover/preflight.ts`,
  `lib/integrations/catalog.ts` and the health entries.
- Extend the preflight checks (VAPID, Resend sender, embeddings, malware scanner, Vault secrets).
- **Signed-in Playwright suite** on a seeded demo workspace, as three roles. Covers: front desk check-in, inbox
  reply (simulator), book and move an appointment, a synthetic Diligence/bank upload, and the tax invoice PDF. Run it in CI.

### Phase B — Branches as a workspace dimension (2 weeks)
**Status (14 Oct 2026): second slice built.**
- Built:
  - Branch access per member (all branches, or one or several) with a home branch, under Settings, Users.
  - Enforcement in RLS and in the service-role loaders: front desk, appointments, enquiries, waiting list, handover notes
    and tasks.
  - The branch switcher in the rail and the phone drawer.
  - `locations.branch_code`, set under Settings, Appointment rules, Locations (picker of the finance codes, unique, audited).
  - `location_id` on channels, teams, contacts (home branch), tasks and conversations; `channels.default_team_id`.
    New conversations take their number's branch and route to its team first.
  - Inbox: branch filter (follows the switcher; "All my branches" or one branch), branch chip on rows, counts per branch.
  - Tasks: branch column and filter, new tasks default to the current branch, RLS and service-role reads by branch.
  - Contacts: home branch in the drawer, a column and a filter field.
  - Branch checks on `deleteBlock`, the quick-reply appointment lookup and the enquiry location pickers.
  - Ledger reports: branch filter (finance code) on trial balance, general ledger, balance sheet, cash flow and
    receivables ageing; the P&L's existing branch split is offered as "Branches side by side".
- Still to do in this phase:
  - Branch filter on claims and denials (Finance reports hub, built separately).
  - Settings per branch (working week and holidays, desk number and QR, reminder channel).
  - Front desk live updates through Realtime.

- **Data model.**
  - `locations.branch_code` → `fin_ref_branches.code`, so the clinical and finance branch lists meet. Needed before the
    10 Nov Unite code change (OQ-101).
  - `memberships.home_location_id` + `branch_scope` (`all` / `home`).
  - `location_id` on `channels`, `teams`, `contacts` (home branch), `tasks` and `conversations`.
- **Switcher.**
  - Branch switcher in the rail, kept in a cookie (the layout stays query-free).
  - Every list, board, calendar and report filters by the chosen branch.
  - Branch shown as a column and a chip.
- **Front desk per branch.**
  - Board, free slots, end-of-day sheet and handover notes.
  - Branch default in every dialog.
  - Live updates through Realtime instead of the 60 s poll.
- **Inbox per branch.**
  - Each WhatsApp number belongs to a branch, and each branch has a default team.
  - Branch folders and filter.
- **Reports per branch.** Branch filter on trial balance, balance sheet, cash flow, general ledger, ageing, claims and
  denials, plus a "three branches side by side" view.
- **Settings per branch.** Working week and holidays, the desk WhatsApp number and QR, the reminder channel.
- **Optional.** Enforce branch scope in RLS (`app.location_visible_to()`, like `enquiry_scope`) once OQ-119 is answered.

### Phase C — Organisation: doctors and staff in CRM (2 weeks)
**Status (14 Oct 2026): first slice built** (migration `20261202000100_organisation.sql`, paste file `81_organisation.sql`).
- Built:
  - Doctors directory (`/doctors`): specialty, branches, services, licence number/authority/expiry with a warning badge,
    linked user, working hours per branch, upcoming time off, today's count, calendar link
    (`/appointments?view=calendar&specialist=…`), performance and revenue-share links for finance holders. Licence and
    profile fields editable with `settings.manage` or `hr.manage`.
  - Staff (`/staff`): HR record without pay, duties checklist, shifts tab, history, archive and restore; `hr.view` /
    `hr.manage`; branch rule on the home branch.
  - Rota (`/staff/rota`): week grid per branch, add/edit/remove shifts, overlaps refused by the database.
  - Daily visa and licence reminders (`staff.document_expiring`, 60 days by default, set on the Staff page).
  - Doctor and HR roles; My day (`/my-day`) with the Doctor role landing there.
- Still to do in this phase:
  - Staff documents in a private bucket (same rules as patient documents).
  - Doctor photo in the directory.
  - Feeding the rota into the front-desk staffing view and the escalation on-call list.
  - Moving Teams and Branches pages from Settings into CRM.
  - Nurse preset; follow-up count on My day.

- **Doctors.**
  - Directory page built on `specialists`: photo, specialty, branches and days, services, working hours, linked
    Pulse user, licence number and expiry (DHA), upcoming leave.
  - The record opens to the doctor's calendar, today's patients, and revenue-share and performance links (permission-gated).
- **Staff (HR).**
  - `staff` table with:
    - person: name, job title, department, home branch, manager, linked user (optional), employment type,
      start date, contract and visa/licence expiry dates;
    - duties: a checklist per role or person;
    - documents: in a private bucket, the same rules as patient documents.
  - Reminders for expiring licences and visas via `notify()`.
  - New permissions `hr.view` / `hr.manage`. Pay amounts stay in finance (`finance.costs.compensation`), never on the HR screen.
- **Rota.** Shifts per branch and day (who is on the desk, which doctor in which room). Feeds front-desk staffing and
  the escalation on-call list.
- **Teams and branches** pages move here from Settings (the same data, just where people look for it).
- **Doctor/Nurse preset and "My day"**: own appointments today, check-in states, follow-up queue, tasks.

### Phase D — Simple to use (2 weeks, in parallel with B/C)
- **Navigation.**
  - Restructure areas as in §3 (Messaging area, CRM People/Organisation, Today gains Clinical follow-ups).
  - Hide Inbox from roles without inbox rights.
  - Add record search to Ctrl+K (patients by name or phone, enquiries, tasks) and the missing sub-pages.
- **Role homes.** `landingPathFor` by role. The dashboard shows only the tiles a person can act on, and adds
  "Today's appointments".
- **Finance menu from 44 to about 20.**
  - Merge overview pages into tabs.
  - One name per idea; cross-link the two receivables pages.
  - Move Setup pages into Settings.
  - "My work queue" landing.
- **One pattern for each job.**
  - Lists: DataGrid everywhere (start with finance/accounting lists), with a shared `EmptyState` that says what to do
    next and "showing first N" wherever a list is capped.
  - Drawers: one sticky Cancel/Save footer with an unsaved-changes guard.
  - Confirmations: `ConfirmDialog` instead of the browser's `confirm()` (44 places).
- **Words.** Finish the Patients rename (buttons, guide, permission labels). Use "doctor" in the UI rather than
  "specialist". Add a glossary tooltip for accounting terms.
- **Help.** A guide for every page that lacks one (portal queues, key finance pages) and a first-run checklist per role.

### Phase E — Front desk and appointments v2 (2 weeks)
**Status (14 Oct 2026): first slice built** (migration `20261204000100_front_desk_v2.sql`, paste file
`82_front_desk_v2.sql`; type-checked, linted, unit- and database-tested, production build; not yet driven in a browser,
on a phone or a printer).
- Built:
  - **Book at the desk** (`app/(app)/front-desk/book-drawer.tsx`): opens on the switcher's (or home / only) branch
    (`presetBranch`), offers only services someone at the branch does, and lists one day of free times per doctor from
    the slot engine (`getDeskDaySlots` → `slotsForDay` → `generateSlots` / `slotFits`; pure ordering in
    `lib/front-desk/book.ts`). Books through `bookAppointment` → `public.book_appointment` (per-doctor lock, capacity
    re-checked); the patient comes from the desk's search or card; the result offers Print slip.
  - **One cancel / no-show dialog** on `useConfirm()` (`visit-close.tsx`), used by the board and the patient card (with
    an optional "tell the patient" tick). Cancelling still runs `changeAppointmentStatus` → `scheduleSlotFreed()`. No
    cancel-reason list exists in Pulse, so none was invented. Every browser `confirm()` in the front desk and
    appointments folders is gone.
  - **Arrival check panel** on the board line at Arrived (`getArrivalChecks`, `lib/front-desk/arrival-check*.ts`):
    insurance card (patient documents on + `documents.view`; expiry and status only, never titles), eligibility
    (`fin_eligibility_checks`, read-only, `finance.eligibility.manage`) and consent forms (e-signature on + documents on +
    `documents.view`). Each fails closed to "Not checked (reason)".
  - **Walk-ins** without a phone or with another country's number (`walkInPhoneDecision`: blank, a UAE mobile, or a
    possible E.164 number with its country code). The WhatsApp tick is unticked by default and optional; a new record
    with a number and no tick gets `contacts.whatsapp_declined_at`, and appointment messages
    (`sendAppointmentTemplate`), reminders (excluded `no_whatsapp_consent`, no SMS fallback), waiting-list offers and the
    desk's location / running-late messages are then never queued. An existing patient found by number is not changed
    by an empty box. The card shows the flag and "Patient agrees to WhatsApp now" (`recordWhatsAppAgreement`, audited).
  - **Slip and payment record** at `/front-desk/slip/[id]` (`frontdesk.use` + `appointments.view`, branch rule,
    `recordAccess`): first name, day and time, doctor, branch and address, booking number; nothing clinical. With
    `finance.invoices.view`, `?kind=receipt` lists the Unite mirror's payments on the visit's invoices and paid payment
    links (`lib/front-desk/slip*.ts`), marked "not a tax invoice".
  - **End of day per branch** on `/front-desk/end-of-day`: booked, seen, no-shows, cancelled, walk-ins and the median
    Arrived → With doctor wait per branch (`lib/front-desk/day-summary.ts`), with a Cash-up link per branch for holders
    of `finance.cashup.manage` (branch finance code from `locations.branch_code`).
  - **Diary**: a check-in chip (In / Dr / Done / Out, dark-mode pairs) in Resource day, Branch week, the Specialist
    calendar, the agenda and the drawer; drag-and-drop in Resource day (mouse and pen; touch keeps scrolling) and the
    Specialist calendar (FullCalendar, still `next/dynamic`) through `moveAppointment` → `move_appointment`, put back
    with the reason on refusal, with a `useConfirm()` question before moving a confirmed booking whose reminder went out
    (`lib/appointments/drag-move.ts`) and a "Tell the patient when I drag" switch; a **Branch week** tab
    (`?view=week`) with every doctor of the branch from Monday to Sunday (`lib/appointments/week.ts`), branch-aware
    through `listRange`'s branch rule.
- **Not done, on purpose:** the Receptionist does NOT get `finance.cashup.manage`. The cash-up is not branch-scoped
  (`fin_cashups` RLS is `app.has_perm(org_id, 'finance.cashup.manage')` for every branch, and the page lists every
  branch), so the key would open every branch's cash-up and expected takings, and it falls under the finance access
  window. Granting it per branch needs a branch rule on `fin_cashups` / `fin_cashup_lines` and the page first.
- Still to do: rooms, the queue-token screen and the arrival kiosk (below); a browser, phone and printer pass.

- **Front desk.**
  - Book inside the desk: drawer with branch preset and one day of slots.
  - One cancel dialog instead of two `confirm()` pop-ups.
  - At Arrived: insurance card on file or expired, eligibility status, consent forms (e-signature when switched on).
  - Walk-in without WhatsApp consent or a UAE mobile.
  - Printable appointment slip and receipt.
  - End-of-day per branch, linked to cash-up; give the Receptionist the cash-up permission for their own branch.
- **Appointments.**
  - Diary shows check-in state.
  - Drag-and-drop move in the day grid.
  - A week view across all doctors of one branch.
  - Later: rooms as bookable resources, a queue-token screen and an arrival kiosk.

### Phase F — Inbox, CRM and tasks v2 (2 weeks)
- **Inbox.**
  - Snooze, first-response SLA ("waiting 12 m"), bulk assign/close.
  - "Someone else is replying" warning.
  - Message-text search.
  - Create task from any chat.
- **Patient 360.** Tasks, Invoices (permission-gated) and History tabs; owner and home branch; one merged timeline.
- **Tasks v2.**
  - Priority, status, branch and team, subtasks/checklists, comments with @mentions, attachments, recurrence.
  - Board and calendar views; `task.assigned` notification; `?task=` deep link.
  - **Daily opening/closing checklists per branch.**
- **Enquiries.** CSV import.

### Phase G — Finance and accounting for the finance team (2 weeks)
**Status (14 Oct 2026): first slice built (type-checked, linted, unit-tested; not yet driven in a browser or against
Resend).**
- Built:
  - Reports hub `/finance/reports` (first under Finance, Overview; a card under Insights, Reports): Management,
    Accounting, Receivables/RCM and Tax cards, each shown to holders of that report's own key. One picker (branch from
    the switcher or chosen, month / quarter / year, compare with the period before) that passes only the parameters each
    page already reads, with View and the existing Excel / CSV / PDF downloads (`lib/finance/reports-hub.ts`).
  - Invoice view: payer and TPA, insurer vs patient (or company) share and balance due from the ledger's own split
    (`splitReceivable` in `lib/accounting/posting/builders.ts`, used by `lib/finance/invoice-shares.ts`), the ledger
    posting status with the journal link (accounting readers), Print, and the internal PDF
    `/api/finance/invoices/<id>/pdf` ("Internal copy - not a tax invoice", `finance.invoices.view`, access and export
    logged, audited).
  - E-mail out: attachments in `lib/email.ts` (Resend shape, PDF / Excel / CSV only, size cap, idempotency key, the
    no-key behaviour kept), sent by the `notifications` queue (`finance_document_email` job: ids, dates and the SHA-256
    of the confirmed address only; the job re-reads the recipient, refuses a changed address and renders the document
    from stored data). Buttons with a confirmation naming the recipient: E-mail statement and E-mail balance
    confirmation (Accounting, Statements; business customers' `acc_customers.email`), E-mail close pack (Finance,
    Month-end close; the signers only). Each send checks the export's permission, is rate limited, audited and logged as
    an export.
  - Payables ageing and supplier statements (Accounting, Purchases & payables; `lib/accounting/payables-ageing.ts`, pure)
    over the 20D supplier invoices and paid vouchers, with Excel downloads; read with the existing ledger/report keys
    (`PAYABLES_READ`, no new key, no migration).
  - Excel downloads (every row, read in pages with `fetchAll`) of the invoices, claims, denials, journals, day book and
    general ledger lists.
- Still to do in this phase: scheduled report e-mails (daily flash, monthly summary), e-mailing a customer invoice, the
  one upload component, PDF and e-mail on more hub cards, and a run against a Resend sandbox (Phase H).

- **Reports hub.** One page of report cards (Management, Accounting, Receivables/RCM, Tax), with a shared branch,
  period and comparison picker. Each card can View, Excel, PDF and E-mail. Also listed in Insights.
- **Invoice view.** Payer, patient vs insurer share, balance due, posting status with journal link, Print and an internal PDF.
- **E-mail out.**
  - Attachments in `lib/email.ts`, sent through a queue with `recordExport`/`recordAudit`.
  - Buttons to e-mail a statement, invoice, balance confirmation or close pack (business customers only, never patient data).
  - Scheduled report e-mails (daily flash, monthly summary).
- **Upload, payables, exports.**
  - One upload component (drag-and-drop, preview, unknown columns, confirm) for bank, labs, costs, budgets.
  - Payables ageing and supplier statement.
  - Exports on the remaining lists.

### Phase H — Prove it live (runs alongside, mostly people)
Sandbox run per provider, using each notes file's "Before first use" list: Meta, Unite, Resend (plus Supabase Auth
SMTP), Postmark, Google OAuth, Web Push, SMS, payments, Tally test company. Then a three-role click-through, a
real-phone pass and a staging load test. Results are recorded in the notes files and in the Go-live checklist page.

## 5. Decisions only Al Das can make (blocking)
- **Accounts and access.**
  - WABA ownership and Meta System User token (OQ-38).
  - Fresh Unite credentials (OQ-26).
  - Hosting region / data residency (OQ-49).
  - AI processing approval (OQ-57).
- **Clinical.** Answers OQ-01..08, 14, 16, 36, 104. All clinical messaging stays off until then.
- **Finance and accounting.**
  - VAT per service (OQ-120).
  - UAE e-invoicing ASP (OQ-122; check the 30 Oct date).
  - Ledger cut-over date (OQ-117).
  - New Unite branch codes from 10 Nov (OQ-101).
  - Approval/signature model (OQ-90/91/121).
- **Branch scoping.** Should staff only see their branch (OQ-119)? HR: which staff fields Al Das wants to hold.
- **Accounts to open.** Resend (domain DNS), Postmark, Google Cloud OAuth, SMS sender ID, payment gateway, Sentry.

## 6. How the work is run
- **Agents** in `.claude/agents/`:
  - `ui-designer` builds UI changes; `accessibility-auditor` checks AA.
  - `nav-qa` (new) checks the menu, flyouts, pinned panel, phone drawer, Ctrl+K and per-role reachability.
  - `product-auditor` (new) reviews an area against the benchmark tools and this plan before and after each phase.
- **Order.**
  1. A first.
  2. B and D together.
  3. C.
  4. E, F and G in parallel by area.
  5. H continuously.
- **Guards that keep it simple.** The nav-integrity test (no dead or duplicate links) and the bundle budgets.
  To add: a lint that rejects `.limit(>1000)`, and a test that every page has a help guide.
