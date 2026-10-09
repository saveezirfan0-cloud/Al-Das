# Phase 5 — Enquiries + Tasks: what was built and how to use it

Delivered in three steps on one branch: **5a** schema + domain logic, **5b** the Enquiries workspace, **5c** Settings → Enquiries, **5d** Tasks and the wire-ins (contact drawer, inbox sidebar, Phase 6 reminder failures).

## What exists now

| Area                                                                             | Where                                                                                                                                                                        |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema                                                                           | `supabase/migrations/20261009001000_enquiries.sql`: `pipelines`, `stages`, `enquiries`, `enquiry_counters`, `enquiry_stage_history`, `enquiry_views`, `tasks` (all with RLS) |
| Statuses, ordering, settings, SLA, assignment, filters, columns, export (pure)   | `lib/enquiries/{status,ordering,settings,sla,assignment,filter,columns,defaults,export,board}.ts`                                                                            |
| Server service (create, update, move, status, bulk, delete, board/table queries) | `lib/enquiries/service.ts`                                                                                                                                                   |
| Tasks (due logic, schemas, service)                                              | `lib/tasks/*`                                                                                                                                                                |
| Nightly-style sweep (SLA + task due)                                             | `lib/jobs/handlers/enquiries-housekeeping.ts`, cron `pulse:enquiries_housekeeping` every 5 min                                                                               |
| Enquiries UI                                                                     | `app/(app)/enquiries/*` (board, table, drawer, new dialog, filters, views, bulk bar)                                                                                         |
| Export                                                                           | `POST /api/enquiries/export` (enquiries or activity CSV)                                                                                                                     |
| Settings → Enquiries                                                             | `app/(app)/settings/enquiries/*`                                                                                                                                             |
| Tasks UI                                                                         | `app/(app)/tasks/*`                                                                                                                                                          |

## Behaviour worth knowing

- **Status vs stage.** Status is the outcome: Open, Won, Lost, Disqualified. Lost and Disqualified need a reason. Stage is the position inside a pipeline. The database enforces the invariants (closed time, reasons, stage belongs to the pipeline, same-org references) whatever wrote the row.
- **Default pipelines.** The first visit to `/enquiries` or Settings → Enquiries creates the clinic's operational queues (Reception, Awaiting patient, Doctor liaison, Escalation, Insurance review, Medical records, Pharmacy, Ready to close), each with New / In progress / Follow-up. They are plain data: rename, recolour, reorder, archive.
- **SLA.** "Open-enquiry SLA" (None, 1, 2, 4, 8 h) is the longest an Open enquiry may sit in one stage. Cards past it show an SLA badge; the assignee (or everyone with `enquiries.manage` when nobody owns it) is notified **once per stage visit**. Moving the stage re-arms it.
- **Assignment rule** for new enquiries: nobody, whoever creates it, or rotation through the pipeline's default team (the same round-robin function the inbox uses, so away/offline members are skipped).
- **Saved views** hold the Open/Closed switch and filters; private, shared with teams, or with everyone who can see enquiries.
- **Board**: drag between stages (optimistic, rolls back with a message on error); up to 50 cards per column with "Show more". Keyboard users change the stage from the drawer.
- **Table** reuses the shared `DataGrid` (column chooser, sort by whitelisted columns, saved layout under grid key `enquiries`).
- **Bulk**: up to 100 at a time: move to stage, assign, status (incl. disqualify with a reason), delete. Bulk changes and deletes are written to `audit_log`.
- **Export** needs `enquiries.manage`, is rate-limited (6 / min / user), audited, and capped at 5,000 rows (the response says when it truncated). Activity export lists stage / status / assignment events without any free-text.
- **Custom fields** for enquiries are managed on Settings → Custom fields → Enquiries and appear in the drawer, table and export.
- **Timeline.** Enquiry events are written to the patient's timeline (`timeline_events` with `enquiry_id`) so they show on both the enquiry and the contact.
- **Domain events**: `enquiry.created`, `enquiry.stage_changed`, `enquiry.status_changed`, `enquiry.assigned`, `task.created`, `task.completed` (listeners arrive with Flows and the public API).
- **Tasks**: My tasks / All open / Overdue / Done, filters (type, assignee, due range, search), drawer, link to a patient and an enquiry number. A task falls due → one in-app notification to the assignee; changing the due time or assignee re-arms it. Due state uses the **org timezone**.
- **Failed appointment reminders** now create one open "call patient" task per appointment (and still notify `appointments.manage`), as the Phase 6 notes asked.
- **Where else it shows up**: Contact drawer → Enquiries tab and timeline labels; Inbox sidebar → _Create enquiry_ (opens `/enquiries?new=<contact>`) and the patient's enquiries; Tasks nav item now needs `tasks.manage`.

## Permissions

Existing keys only: `enquiries.view` (read), `enquiries.manage` (create, move, edit, bulk, export), `tasks.manage`, `settings.manage` (Settings → Enquiries). RLS mirrors them; every server action also checks them.

## Tests

- Unit: status rules, ordering, settings, SLA, assignment, filter/search compilation (including injection attempts), columns, export (formula-safe), board moves, task due logic and schemas.
- DB (plain Postgres): `enquiries-rls` (tenant isolation, permission gating, numbering, invariants, history, view and task visibility), `enquiries-service` and `tasks-service` (the real service functions through PostgREST, incl. SLA/due sweeps and the reminder-failure task), `enquiry-settings-actions` (pipeline and stage rules with a stubbed session). The cron list and security-guard lists were updated.
- Browser smoke (mock data, not committed): Kanban drag and drop, keyboard open, reason dialog, filters, table, task form and checklist, settings editors.

## Not covered / follow-ups

- The authenticated pages were **not driven end to end in a browser** in the build sandbox (no Supabase Auth stack). Do a manual pass on a dev stack: create an enquiry from the inbox sidebar, drag it across the board, mark it lost, create a task, then `pnpm jobs:run enquiries_housekeeping`.
- No enquiry CSV **import** yet (Sanoflow had one); it belongs with the data-migration work.
- The pipelines rail has no per-pipeline counts (they would need an extra grouped query per page load).
- Tasks cannot be linked to appointments from the UI (the column exists and the reminder-failure task uses it).
- The Dashboard "Open tasks / Open enquiries" widgets arrive with Phase 10.
- The static security audit only sees mutations written in the action files themselves. Service-layer writes are covered by the DB tests and by explicit audit rows for deletes, bulk changes, exports and configuration.
