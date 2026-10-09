# Phase 8 — Flows, recall programmes and the Make replacement: what was built and what is left

## Scope delivered

| Plan item (docs/02, Prompt 8)                                                                               | Status                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/flow-engine` with unit tests per executor                                                              | Done: 20 node types, graph validator, interpolation, conditions, cron, office hours, single-step runner                                                                                                                                                                                           |
| Flows list with ✅ / ⚠️ / ⏳ counters, status, Variables manager                                            | Done: `/flows`                                                                                                                                                                                                                                                                                    |
| Builder on `@xyflow/react`: palette, canvas, properties panel, trigger conditions, publish, undo / redo     | Done: `/flows/[id]`                                                                                                                                                                                                                                                                               |
| Logs page with step traces                                                                                  | Done: `/flows/[id]/logs`                                                                                                                                                                                                                                                                          |
| Inbox "Shortcut" action and human takeover                                                                  | Done: **Run a flow** and **Take over from bot** in the conversation menu; sending, assigning or closing as a person stops the bot                                                                                                                                                                 |
| Recall programmes engine (eligibility, template map, cadence, Test / Live) with Chronic 90-day and Birthday | Done: `/flows/recall`, call list at `/flows/recall/calls`                                                                                                                                                                                                                                         |
| The 48 h appointment reminder "on the recall engine"                                                        | **Deliberately not moved.** It already runs on the Phase 6 appointments engine (reminder rows, exclusions, test mode, failure notices). The recall page shows it as a read-only entry that points to Settings → Appointments. Re-implementing it would add a second engine for the same messages. |
| Each Make scenario as its native replacement                                                                | Five of six done (table below); the sixth is blocked on the vendor                                                                                                                                                                                                                                |
| Parallel-run report before retiring each scenario                                                           | Done: `/flows/parallel` (daily comparison by identifier, explanations, sign-off rules)                                                                                                                                                                                                            |

## How flows run

- **Graph**: React Flow JSON stored in `flows.draft_graph`. **Publish** validates it, copies it to an immutable `flow_versions` row and bumps `flows.version`; a run pins `(flow_id, flow_version)`, so editing never changes a run in progress.
- **One `flow_steps` job per node** (`lib/flow-engine/step.ts`). A step takes a lease on the conversation, executes the node, writes a `flow_run_steps` row, saves the run, then queues the next step. Waits park the run (`status = waiting`); timers are `scheduled_jobs` (`flow.timeout`, `flow.wake`), never in-memory.
- **Lease instead of a session advisory lock.** The plan says "advisory lock per conversation". The app talks to Postgres through PostgREST, which cannot hold a session lock across calls, so the lock is a lease row (`flow_locks`, `flow_lock_acquire` / `flow_lock_release`, 60 s TTL). Acquire is atomic and a crashed worker's lease simply expires. A step that finds the lease taken re-queues itself 2 s later (up to 10 times).
- **Idempotent steps.** A job carries the run's `step_count` it expects; a duplicate or late delivery is dropped as stale. A message queued by a step is keyed `flow_step` in its payload, so a retry after a crash does not send twice. A run whose next job was lost is re-queued by the one-minute recovery sweep.
- **200 steps per run.** The 201st is refused and the run fails with "Stopped after 200 steps (the flow loops)". A second guard refuses a sixth run of one flow for one patient inside a minute (event loops), and `run_flow` chains stop at depth 5.
- **One bot run per conversation** (partial unique index). A person sending, assigning, taking over or closing cancels it (`cancel_reason` says why).
- **Triggers** (`lib/flow-engine/triggers.ts`): conversation opened / closed / waiting, template button reply, shortcut, enquiry added / stage / status, appointment created / updated (status changes count as updated), incoming webhook, recurring. Domain events reach flows through `emit()` → `flow_steps` queue (durable, not an in-process listener). Each event starts a flow at most once (`trigger_key`).
- **Conditions** use the shared filter AST over the event context (`message.text`, `event.ad`, `contact.language`, `appointment.status`, `vars.*`…). Unsupported operators fail closed.
- **Interpolation**: `{contact.first_name}`, `{appointment.starts_at|date:"DD MMM HH:mm"}`, `{vars.KEY|default:"x"}`, `{steps.<node>.response.x}`. Objects never render; unknown paths render empty and the validator warns.

### Nodes

Messaging: Message, Question (free text, ≤3 buttons or ≤10 list rows, saves to a variable, `fallback` exit and optional timeout), Quick reply, Template. Logic: Branch, Wait (≤30 days), Office hours, Run flow (hand-over: the current run ends and the other flow continues with the same patient and variables), End flow. Conversation: Assign to, Close conversation, Add comment (internal note). CRM: Update contact field, Create / update enquiry, Add task, Create / update portal record, Book / update appointment. Integrations: API action (HTTPS to public hosts only), Send notification.

## Safety properties

- **No message text in logs.** Step traces hold structure only (exit taken, counts, ids). Errors pass `redactText` before they are stored.
- **Portal records**: the node writes through `lib/portal/service` as the flow's **publisher**, limited to exactly the write key of that object. Publishing is refused if the publisher cannot write the object, so a flow cannot widen anyone's access.
- **API action** goes through `safeRequest` (public HTTPS only, address validated at connect time, no redirects, 8 s timeout, 200 KB cap).
- **Marketing**: a Template step uses `classifyRecipient`: marketing templates need `promotions_opt_in` and no `stop_marketing`; unapproved templates and a template from another WABA are refused.
- **Incoming webhook**: the secret is the last path segment, shown once, only its hash is stored; unknown tokens are rate-limited per IP, accepted calls per flow, bodies capped at 16 KB, optional `Idempotency-Key`.
- All flow actions need `flows.manage` and write an audit row; the shortcut needs `inbox.send`, a conversation the caller can see, and is rate-limited.
- New tables have RLS (`flows`, `flow_versions`, `flow_runs`, `flow_run_steps`, `flow_variables`, `recall_*`, `parallel_run_*`; `flow_locks` is service-only). Recall sends, runs and the parallel-run tables are PHI-adjacent and are read-gated like the clinical tables.

## Recall programmes

A programme is **who** (a built-in rule), **what** (a template per segment), **when** (cron in the workspace time zone) and **Test / Live**.

| Rule        | Who                                                                                                                                                                                                                                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chronic`   | Chronic diagnoses (primary or secondary code on any visit, mapped through `ref_diagnoses` to a condition group) and last visit at least `chronic_recall_min_days` ago. Primary group = first messageable group by priority; segment = that group. Needs clinical-messaging consent, and the clinical gate open. |
| `birthday`  | Birthday today (29 Feb → 1 March in non-leap years), by gender and age band from the programme's config. Needs marketing opt-in.                                                                                                                                                                                |
| `visit_gap` | Last visit at least `min_days` ago (and optionally at most, gender, age range). Used for annual check-up, screenings and dormant patients. With no `min_days` it selects nobody.                                                                                                                                |
| `managed`   | Run by another engine (appointment reminders). Shown, not run.                                                                                                                                                                                                                                                  |

- **Pure rules** are in `lib/clinical/recall.ts` (rule 15): send mode, groups, bands, call-list timing, attribution windows. Thresholds come from `clinical_settings` and an unsigned one means nobody is selected.
- **Fail closed everywhere**: mode is Live only for the exact word `live`; a segment with no mapped, active template sends nothing; a template must be Meta-approved, and for chronic recall also clinically approved; there is no default template (OQ-24).
- **Only real sends use up a patient's cycle.** `recall_sends` rows exist only for messages that were queued. A closed clinical gate, an unmapped template or a "check" run is counted in `recall_runs` and nothing else, so opening the gate later does not find everyone already "done". Candidate paging skips patients who cannot be sent to, so they cannot starve the rest.
- **Test mode** reaches only contacts flagged `is_test_record`; Live never reaches them. The workspace setting is `recall_send_mode`; a per-programme override to Live needs `clinical.settings.manage`.
- **Delivery and attribution**: message status is copied onto the send; a patient's next reply is attributed to their latest unanswered recall inside `recall_reply_attribution_days`, a booking inside `recall_booking_attribution_days` (replacing Make's phone-only "Chronic Update" match, OQ-22). An unsigned window attributes nothing.
- **Call list**: live sends with no reply after `recall_followup_workdays` working days (clinic calendar) appear for a person to call; booking a call result fills the booking date.
- **Seeding**: `/flows/recall` → "Set up the standard programmes" (or `seed_recall_programmes(org)`). Everything starts off with no template. The screening programmes have **no thresholds**: the clinic must decide the interval, ages and gender for each.

## Make replacement map

| #    | Make scenario                                             | Native replacement                                                                                       | Status                                                                                                                                                                                                                                                     |
| ---- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Token (3576415)                                           | `lib/unite/auth.ts` refreshes on demand (Phase 6). Judged in the parallel run by Unite call success rate | Built; rotate the Unite keys at cut-over (OQ-26)                                                                                                                                                                                                           |
| 2, 3 | Appointment reminders, 12:00 and 18:00 (3613818, 3913219) | Unite appointment sync, reminder rows, `appointments` queue, exclusions, test mode (Phase 6)             | Built; compared by Unite appointment id                                                                                                                                                                                                                    |
| 4    | Agewise birthday message (4049277)                        | Recall programme **Birthday message**                                                                    | Built; needs templates mapped                                                                                                                                                                                                                              |
| 5    | Chronic recall, 90 day (5882746)                          | Recall programme **Chronic condition recall**                                                            | Built; needs the clinical gate, signed-off thresholds, clinically approved templates                                                                                                                                                                       |
| 6    | Chronic update webhook (5916036)                          | Reply and booking attribution on `recall_sends`                                                          | Built                                                                                                                                                                                                                                                      |
| 7    | Acute follow-up: MRD sync (5990863)                       | Unite medical-record sync into `visits` / `prescriptions`                                                | **Not built.** The Unite medical-records endpoint and its fields are undocumented, and Unite is live production and read-only for us (rule 7). The clinical engine and its ingest mapper exist and wait for the endpoint. Make stays on for this scenario. |

Inactive Make scenarios: screening and dormant reminders map to `visit_gap` programmes; "Birthday Offer Update" maps to an Incoming webhook flow; the no-show and post-visit scenarios have starter flows (**Missed appointment follow-up**, **After-visit check-in**). Lab, payment, insurance and antibiotic scenarios are not rebuilt (Phase 2 of the business plan, see `docs/audit/make-scenarios.md` §2).

**Sanoflow bots are not imported.** There is no export format in the repo and the importer reads contacts only; each Sanoflow flow has to be rebuilt in the builder. Flows that called Make webhooks become **API action** steps or Incoming-webhook flows.

## Parallel run (`/flows/parallel`)

1. **Create the checklist** (six scenarios). Mark the native version built and record the start date.
2. Turn on **Record who this would message** on the Birthday and Chronic programmes (Recall → settings). Each scheduled run then stores the Unite PINs it _would_ message, whatever the mode, and still only messages internal test patients. Reminders and "chronic update" are read from their own tables.
3. Each day paste what Make did (ids only: Unite PIN or appointment id, optionally with a date, from the Airtable log tables). Only the first two columns are kept.
4. **Compare the last 7 days.** Differences list the ids on each side. Every difference needs a one-line reason on its day (already messaged once, band not covered, excluded doctor…).
5. **Sign off** is allowed by the server only when: native built, ≥ 7 days since the start, ≥ 7 compared days with ≥ 5 days of activity, and no unexplained difference (or, for the token, ≥ 50 Unite calls at ≥ 99 % success). Then turn Make off and record the date; the page refuses "Make off" before a sign-off.
6. Native runs stay in **Test** until each scenario is signed off, so patients never get duplicates.

## Decisions for you

1. **Lease lock** instead of a literal advisory lock (reason above).
2. **Appointment reminders stay on the Phase 6 engine**; the recall page only shows them.
3. **MRD sync** waits for the Unite endpoint spec; who asks the vendor?
4. **Screening programme rules** (intervals, ages, gender) and **birthday bands** need the clinic's confirmation (OQ-17, OQ-18, OQ-24).
5. **Sanoflow flows** must be inventoried and rebuilt by hand; decide which are in scope before the WhatsApp number cut-over (`docs/06_PHASE_11_CUTOVER.md`).
6. **Role access**: Admin, Manager and Marketing have `flows.manage` (builder, recall, parallel run); the Care coordinator role has the clinical follow-up keys (the call list) but not `flows.manage`.

## Verification

- `pnpm typecheck`, `pnpm lint`, `pnpm build` pass. 1,624 tests pass, including the suites that need PostgREST: the flow runtime end to end on real Postgres (start, ask, wait, resume by button, timeout, duplicate delivery, takeover, lease, 200-step cap, loop guard, recurring, run hand-over, recovery), the recall engine (gate, Test / Live, thresholds, bands, 29 Feb, pagination, idempotency, attribution), RLS for every new table, and the parallel-run comparison.
- `pnpm audit:security`: 284 entry points, 0 unguarded or unreviewed.
- The builder and the Flows list were driven in a real browser against sample data (render, add, connect, delete, undo / redo, palette search, trigger settings, phone width). The run logs, recall, call-list and parallel-run pages were type-checked, built and covered by their data-layer tests but **not driven in a browser** (no sign-in stack in the build sandbox).
- Not verified: a real WhatsApp send from a flow or recall (needs the Meta token), and a full week of parallel run (needs the real systems).

## Demo checklist

- [ ] Flows → New flow → _Welcome and office hours_: the builder opens with six steps; Publish is refused until a team is chosen; choose one, Publish, make it live.
- [ ] Send a message to a test number: the flow runs; the log shows each step; the inbox shows the bot badge.
- [ ] Reply as a person: the bot stops (log shows "A person took over").
- [ ] A Question step with three buttons: tap one, the matching exit is taken; ignore it past the timeout, the _fallback_ exit is taken.
- [ ] Recall programmes → Set up the standard programmes → Chronic condition recall → Check eligibility: shows counts by group and reasons; nothing is queued while clinical messaging is not signed off.
- [ ] Map a clinically approved template to _hypertension_, sign off the gate in Clinical settings, Run now in Test mode: only an internal test patient is messaged.
- [ ] Parallel run → paste three ids for Birthday → Compare: the two lists differ as expected; Sign off stays disabled until seven days are explained.

## Operations

- New `pg_cron` jobs: `pulse:flows_recurring` and `pulse:recall_programmes` (every minute). Both appear on System Health.
- New dependency: `@xyflow/react`. `scripts/add-table-types.ts` adds typed entries to `lib/supabase/types.ts` from a migrated database when the Supabase CLI is not available; regenerate with `pnpm gen:types` on a machine that has it.
- The test database needs the `pgvector` extension (`apt install postgresql-16-pgvector`).
