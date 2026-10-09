# Phase 5 — Enquiries + Tasks: what was built and how to use it

> Numbering: this is the sixth doc but **Phase 5**. Phase 4 (Templates) was not built; it is independent of this phase and the `wa_templates` mirror from Phase 3 is untouched.

## Scope delivered

- **Migration** `supabase/migrations/20261009001000_enquiries.sql` (sorts after Phase 6 and Finance; it builds on Phase 6's `locations`, `departments`, `services` and `specialists` rather than creating its own):
  - **`pipelines`** (card fields, optional `sla_minutes` override, one default per org, archive) and **`stages`**.
  - **`enquiries`**: per-org `number` from `enquiry_counters` (trigger, gap-free per org), `status` (open / won / lost / disqualified) with DB-enforced reason and `closed_at`, `stage_entered_at` maintained by trigger, stage ↔ pipeline ↔ org consistency trigger, SLA columns (`sla_due_at`, `first_touch_at`, `sla_breached_at`), `custom jsonb`, soft delete. Every cross-table FK carries an org check.
  - **`enquiry_views`** (shape of `inbox_views`, plus `mode`, `columns`, `pipeline_id`), **`enquiry_assignment_rules`**, **`tasks`**.
  - **`timeline_events`** now has the `enquiry_id` FK, and `contact_id` is nullable (an enquiry need not have a contact; a CHECK requires one or the other).
  - **Search RPCs** `enquiries_search / _count / _ids / _stage_counts` (service role only, org-pinned, same fragment-compile contract as `contacts_search`).
  - Realtime for `enquiries` and `tasks`; backfill of `tasks.view` (everyone with `tasks.manage`) and `enquiries.export` / `enquiries.delete` (Manager) onto existing system roles.
- **Permissions**: new `enquiries.export`, `enquiries.delete`, `tasks.view`. Manager has all; Agent and Receptionist get `tasks.view`. The Tasks nav item is gated on `tasks.view`. Settings → Enquiries uses `settings.manage`. `supabase/seed.sql` role JSON is in step.
- **`lib/enquiries`** (pure, unit-tested unless noted): `status.ts` (reason rules), `assignment.ts` (first enabled rule by `sort`, AND across keys / OR within a list, fails closed on missing facts or invalid rules), `sla.ts`, `settings.ts` (`orgs.settings.enquiries`: default SLA, notification rules, sources, task reminder lead), `notify-plan.ts` (who is notified; the actor never is), `registry.ts` + `views.ts` (filter registry over alias `e`, Open/Closed/pipeline scoping), `custom.ts`, `export.ts`, `schemas.ts`, `datetime.ts`. Server-only: `service.ts` (single writer: create / update / moveStage / setStatus / movePipeline / bulk / delete), `pipelines.ts` (pipeline and stage administration), `query.ts`, `server.ts`, `notify.ts`.
- **`lib/tasks`**: `due.ts` (overdue / today / reminder timing and stale-reminder checks), `range.ts` (timezone-aware filter ranges, DST-safe), `service.ts`.
- **Domain events** (`lib/events/emit.ts`): `enquiry.created / assigned / stage_changed / status_changed / pipeline_changed / sla_breached`, `task.created / completed / due`. Importing `lib/enquiries/service` (or the reminder handler) registers the in-process notification listeners; Phase 8 attaches flow triggers and outbound webhooks the same way.
- **Jobs**: no timers. `enquiry.sla` is scheduled at `sla_due_at` and `task.due` at `due_at - lead` via `scheduled_jobs` (dedupe keys; a moved due time gets a new key). Both are routed to the existing `notifications` queue (`registerKind`) and handled in `lib/jobs/handlers/reminders.ts`, which **re-checks state at fire time**: closed, touched, completed or moved → no-op; a breach is claimed with a `null → timestamp` update so only one worker raises it.
- **Enquiries** (`/enquiries`):
  - Pipelines rail with counts (follows the Open / Closed / All switch) and saved views (mine / team / everyone).
  - **Kanban** on dnd-kit: stage columns with counts, “+” per column, per-pipeline card fields (admins edit them from the toolbar), 50 per column with “load more”, optimistic moves with rollback, keyboard drag, realtime refresh. **Table** on the shared DataGrid with column chooser, sorting, saved layout.
  - Search (ID, title, contact name, phone), filter builder (every enquiry field, custom fields, open-task count), Open / Closed / All, save and share views, CSV export (`enquiries.export`, audited).
  - **Drawer**: stage and status (Lost / Disqualified require a reason), details incl. location → department → specialist → service (department narrows the others) and appointment date, assignee, estimated value, custom fields, linked contact (link / unlink), move pipeline, tabs **Timeline** (with notes) / **Inbox** (the contact's conversations) / **Tasks**.
  - **Bulk**: assign, move stage or pipeline, reopen / won / lost / disqualify (reason), edit fields, delete (`enquiries.delete`), export selection. Each enquiry goes through the single-record path, so timeline, events and audit stay per enquiry.
  - Wiring: the contact drawer's Enquiries tab lists the contact's enquiries; the inbox sidebar's “Create enquiry” opens `/enquiries?new=1&contact=…&channel=…` prefilled; the shared `Timeline` component was extracted from the contact drawer.
- **Settings → Enquiries**: SLA default, task reminder lead, sources, notification rules (assignee / people / team, in-app / email); pipelines and stages (create, rename, drag to reorder, colours, per-pipeline SLA, default / archive / delete); assignment rules (user or team round-robin, ordered); enquiry custom fields (the contact custom-field UI is now entity-aware). Locations, departments, services and specialists are managed in Settings → Appointments (Phase 6).
- **Tasks** (`/tasks`): list with Assigned to me / Everyone, Open / Overdue / Due today / Done / All, type, subject search, sorting, pagination, quick done checkbox, bulk done / reopen / assign / delete, drawer for create and edit (type, due, subject, assignee, contact, enquiry, notes, done), realtime refresh, and an overdue badge on the sidebar.
- **`DataGrid`**: unsortable headers are now plain cells. The select-all checkbox used to sit inside a disabled sort button (invalid HTML and a hydration error on every grid, Contacts included).
- **Tests**: 51 new unit tests (status, assignment, SLA, settings, notify plan, registry → SQL, custom merge, task due, DST-safe ranges, reminder envelope); `tests/db/enquiries-rls.test.ts` (15: isolation on every new table, permission gates, cross-org FK triggers, per-org numbering, status/closed_at integrity, timeline CHECK, view sharing, RPCs service-role only and org-pinned); `tests/db/enquiries-service.test.ts` (16, needs PostgREST: services, assignment rules, notifications, SLA and task-due jobs, pipeline/stage administration); an e2e smoke for the new routes.

## Local happy path

```bash
pnpm db:reset                 # migrations + seed: 2 pipelines (Reception 30-min SLA, Insurance review 5-min SLA), 15 enquiries, 8 tasks, a rule, a shared view (it reuses Phase 6's seeded clinic, department, service and specialist)
pnpm dev
# /enquiries            Kanban of the default pipeline; drag a card, open it, mark it Lost (a reason is required)
# /enquiries?pipeline=all&scope=all&mode=table   select rows → bulk bar
# /tasks                overdue tasks in red, badge on the sidebar
# /settings/enquiries   pipelines, rules, SLA, notification rules, clinic lists
pnpm jobs:run scheduler       # moves due task.due / enquiry.sla jobs onto the notifications queue
pnpm jobs:run notifications   # delivers them (in-app notification for the assignee)
```

`pg_cron` already pings the `scheduler` queue every 10 seconds in a deployed project.

## Decisions and assumptions (please confirm)

- **SLA means time to first touch.** `sla_due_at = created_at + (pipeline SLA ?? org default)`. A first touch is an assignment by a person, a stage / status / pipeline change, or (planned) an outbound message. Sending a WhatsApp reply does **not** stop the clock yet: `markTouched()` exists in `lib/enquiries/service.ts` but the outbound handler does not call it. The Airtable audit implies a 5-minute SLA for “Insurance review”, hence the per-pipeline override.
- **No manual ordering inside a Kanban column**: cards are newest-in-stage first. Moving between columns is the only drag.
- **Clinic lists belong to Phase 6.** This phase originally created `locations`, `departments`, `services` and `specialists` early; once Phase 6 landed on `main` with its own versions (hours, booking rules, Unite ids, an `active` flag) the early copy was dropped. Enquiries reference Phase 6's tables, pickers hide inactive entries but keep one an enquiry already uses, and the lists are edited in Settings → Appointments.
- **Pipelines that held enquiries can only be archived**, and a stage with enquiries is deleted only after moving them (including soft-deleted ones, which still reference it).
- **Soft delete** for enquiries; their tasks and timeline remain. Hard delete only happens through org deletion.
- **Contact visibility**: an `enquiries.view` user without `contacts.view` cannot read contacts through RLS, so the enquiry loaders use the service role (after `can()`), show the linked contact's name and phone, and the contact picker needs `contacts.view`.
- **Email notifications** carry the enquiry number and a link only; titles can contain patient details and stay in the app.
- **Out of scope here**: enquiry tags (`tags.scope = 'enquiry'` exists but no join table), CSV import of enquiries, the enquiry funnel / stage-time report (`mv_enquiry_stage_times`, Phase 10), flows reacting to the new events (Phase 8), and public API / outbound webhooks (Phase 10).
- **Merged with Phase 6 / 11.** The security-guard tests from Phase 11 caught four things in this phase, now fixed: `enquiry_counters` is declared service-only, `enquiries` is covered by the cross-org suite (its consistency trigger runs before RLS), `deleteEnquiryView` now requires `enquiries.view`, and three mutating actions (view delete, card fields, rule reorder) write audit rows.
- **Custom roles are not backfilled** with the new permission keys; add `tasks.view` / `enquiries.export` / `enquiries.delete` to them in Settings → Roles.

## Demo checklist

- [ ] `/enquiries` shows Reception with New / Contacted / Awaiting patient / Booked; counts match the rail; two cards show “SLA breached”.
- [ ] Drag a card to another column: it stays there after reload, its timeline shows the stage change, and its SLA stops being “breached” (first touch).
- [ ] Open a card → Status → Lost: the dialog will not confirm without a reason; the card leaves the Open board and appears under Closed with the reason.
- [ ] Table view: select two rows → Status → Disqualify… → reason → both become Disqualified; Export downloads a CSV (and is refused for a role without `enquiries.export`).
- [ ] Save a view with a filter (e.g. Assigned to is empty), share it with a team; a teammate sees it in the rail.
- [ ] From the inbox sidebar, Create enquiry opens the dialog with the contact prefilled; the enquiry shows in the contact drawer's Enquiries tab.
- [ ] Settings → Enquiries: add a stage, drag it to the middle, delete a stage that has enquiries (you must pick where they go), create an assignment rule and create an enquiry that matches it.
- [ ] `/tasks`: complete a task (the sidebar badge drops), create one due in two minutes, run `pnpm jobs:run scheduler && pnpm jobs:run notifications` after it is due and see the notification.
- [ ] RLS: as a user from another org, none of `enquiries`, `tasks`, `pipelines`, … are visible (`pnpm test:db`).

## Open questions / follow-ups

- Should an outbound WhatsApp reply from the inbox count as the first touch (call `markTouched` from the outbound handler for the contact's open enquiries)?
- Enquiry-level AI summary, duplicates detection and “enquiry from CTWA ad” attribution are not started.
- Realtime on the board refreshes the whole board (debounced); a per-card patch would be gentler for very busy boards.
- The Kanban loads one query per stage; a pipeline with many stages and a huge backlog may want a single windowed query.
- `lib/events` listeners are in-process, so a notification rule only fires in processes that import `lib/enquiries/service` (server actions and the reminder handler do). Phase 8's persisted subscriptions remove that caveat.
