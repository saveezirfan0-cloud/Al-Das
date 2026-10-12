# Phase 13 notes: mobile, notifications and speed

Built on branch `claude/nifty-brown-y9l5ry` (from `main` at `5de4663`, Phase 15 merged), 12 to 13 Oct 2026 session. Spec: `docs/10_NEXT_PHASE_PROMPTS.md`, Prompt 13. Everything below was built in a cloud sandbox with Postgres 16, pgvector, pgmq and PostgREST but **no Supabase Auth, no Docker, no browser, no phone and no real push service**. "How it was verified" and "What was NOT verified" are the honest status; please read them before trusting a line of the mobile work.

## What exists

### Mobile

| Spec item | Where it lives |
|---|---|
| Service worker: offline page, update prompt | `public/sw.js`, `public/offline.html`, `components/shell/pwa.tsx` (registers in production only, shows the "new version" toast and an offline strip) |
| Complete install experience | `app/manifest.ts` (id, PNG and maskable icons, four shortcuts, categories), `public/icons/*` (regenerate with `node scripts/pwa-icons.mjs`), apple-touch icon and `appleWebApp` in `app/layout.tsx`, "Install app" in the user menu (browser prompt, or the Share / Add to Home Screen hint on iOS), `viewport-fit=cover` |
| Inbox on phones: list, then thread with a back button | already there (`inbox-shell.tsx`); an open conversation now takes the whole screen like a chat app |
| Composer follows the on-screen keyboard | `lib/hooks/use-visual-viewport.ts`, `inbox-shell.tsx` (the thread is `position: fixed`, sized to `visualViewport`), safe-area padding only while the keyboard is closed, 16 px composer text so iOS does not zoom |
| Pull to refresh | `components/shell/pull-to-refresh.tsx` on the conversation list (`router.refresh()`) |
| Swipe actions | `app/(app)/inbox/swipe-row.tsx`: right = take the conversation, left = close it (if the workspace demands a category or summary on close it opens the conversation instead). Same actions remain in the thread header for mouse and keyboard |
| Camera and gallery upload | two extra buttons in the composer on touch devices (`capture="environment"`, and a JPEG/PNG/MP4 picker so iOS converts HEIC); a HEIC file that slips through is refused with a clear message |
| DataGrid card view below `md` | `components/data-grid/data-grid.tsx`: first column is the title, up to six more are label/value pairs; selection and row click keep working. Applies to contacts, enquiries, tasks, appointments table and the portal grids at once |
| Appointments default to an agenda list on phones | `app/(app)/appointments/agenda-list.tsx` (a new "Agenda" tab; opens by default on phones unless `?view=` is given) |
| Tap targets of at least 44 px | `app/globals.css`, `@media (pointer: coarse)`: buttons, selects, tabs, inputs, menu items, sidebar and nav links get `min-height: 44px`; checkboxes and switches get an invisible 44 px hit area. Desktop is unchanged |

### Notifications

| Spec item | Where it lives |
|---|---|
| `notification_preferences` with RLS and a settings page | migration `20261013000100`; one row per (user, event, channel). The row with `event = '*'` is the **channel master switch and carries the quiet hours** for that channel. Users write only their own rows. Page: Settings, Notifications (`app/(app)/settings/notifications`) |
| Web Push with VAPID, `pnpm push:keys` | `scripts/push-keys.ts` + `lib/push/vapid.ts` (prints env lines, writes nothing), `web-push` behind the `PushSender` interface (`lib/push/types.ts`, `web-push-sender.ts`) |
| `push_subscriptions` encrypted at rest, removed on 404/410 | `lib/push/store-db.ts` (AES-256-GCM with `ENCRYPTION_KEY`; only a SHA-256 of the endpoint is in clear), `lib/push/deliver.ts` (404/410 delete the row; ten failures in a row also do). Endpoints must belong to FCM, Mozilla, Apple or Windows push hosts (`lib/push/endpoint.ts`): the server POSTs to whatever a browser registers, so an open endpoint would be an SSRF hole |
| Events: new inbound message on my conversation, assigned to me, mention, SLA breach, failed reminder, task due | catalogue in `lib/notify/events.ts` (`inbox.message`, `inbox.assigned`, `inbox.mention`, `sla.breach`, `reminder.failed`, `task.due`, plus `escalation`, `digest.daily`, `digest.weekly`); wired in `lib/inbox/inbound.ts`, `app/(app)/inbox/actions.ts` (assign, mention), `lib/flow-engine/supabase-deps.ts` (flow assignment), `lib/jobs/handlers/reminders.ts` (task due), `lib/jobs/handlers/appointments.ts` (failed reminder), `lib/enquiries/notify.ts` (SLA breach) |
| Only ids and generic text in push | `lib/notify/push-payload.ts` takes **ids only** (validated UUIDs); title and body are fixed sentences per event. E-mail notifications use the same generic sentence and a link. In-app rows may still carry context (the bell is private to the recipient and was already doing so) |
| Title badge and sound toggle for the inbox | `components/shell/shell-data.tsx` sets `(3) Inbox · Pulse` and the installed-app badge from the unread count of my conversations; the speaker button in the conversation list toggles a chime (per device, `localStorage`, **off by default**) |
| Escalation ladder on `scheduled_jobs` | `lib/notify/escalation.ts` (pure plan), `escalation-job.ts` (handler, kind `inbox.escalate`). A patient message into a conversation nobody owns schedules rung 1 (team lead, `teams.lead_user_id`) after N minutes, rung 1 schedules rung 2 (the on-call list, or administrators if the list is empty). `conversations.escalation_level` is claimed atomically, so a retried job never notifies twice, and assigning the conversation resets it. Off by default; configured in Settings, Notifications (administrators) |
| Daily and weekly management digest (Resend) | `lib/jobs/handlers/notification-digests.ts` (cron hourly at minute 5; due from 07:00 org time for four hours, weekly on Mondays), `lib/notify/digest.ts`. The numbers come from `loadManagementSummary()` in `lib/reports/management.ts`, which the Management dashboard page now also uses, so the e-mail and the page cannot disagree. Opt-in per person, needs `reports.view`, idempotent through `notification_digest_log` |
| Notification centre with filters and snooze | `/notifications`: status (all, unread, snoozed) and category filters, snooze for 1 h, 3 h, tomorrow 08:00 or next Monday 08:00 in the person's timezone, mark read/unread, dismiss. Snoozed items leave the bell and unread count and come back on their own (`notifications.snoozed_until`) |

### Speed

| Spec item | What was done |
|---|---|
| (a) Layout queries | `app/(app)/layout.tsx` no longer queries tasks or notifications. `ShellDataProvider` (browser, user's own session, RLS applies) fetches the 30 latest notifications, the overdue-task count and the inbox unread count, invalidated by Realtime (filters on `user_id` / `assignee_id`), with a 5-minute poll and a refresh when the tab returns (overdue and snooze change with the clock, not with a row). Last numbers are cached in `sessionStorage` for the first paint |
| (b) One SQL function for dashboard tiles | `public.dashboard_overview()` (migration `…200`, **security invoker**, so the caller's RLS still decides what they can count): one round trip instead of ten |
| (c) Local JWT verification | Middleware uses `getClaims()` for page navigations (GET/HEAD, not under `/api`). Server actions, other methods and every `/api` route still call `getUser()`. The mode is passed to `lib/auth/session.ts` in a request header that the middleware overwrites every time. `PULSE_VERIFY_JWT_LOCALLY=0` switches it off. **The Phase 15 `mfaGate` logic is untouched** and runs on both paths (tests below) |
| (d) `next/dynamic` | FullCalendar (appointments), React Flow (flow builder, via a client loader) and Recharts (every chart). **Tiptap is not used anywhere in the repo**, so there was nothing to split |
| (e) Analyser, baseline, budgets | `pnpm analyze` (`@next/bundle-analyzer`), baseline and result below, `scripts/check-bundle-budget.ts` + `scripts/bundle-budget.json` (parsed from the `next build` route table), wired into `.github/workflows/ci.yml` after the build |
| (f) Indexes | migration `…300`, reasoning below |
| (g) Speed Insights | `@vercel/speed-insights` installed (the network allowed it) and rendered in the root layout. It only reports when deployed on Vercel |

## Numbers

First-load JS from `next build`, measured on this machine at `5de4663` (before) and on the branch (after). Same command, same placeholder environment.

| Route | Before | After |
|---|---|---|
| Shared by all | 102 kB | 103 kB |
| `/dashboard` | 232 kB | **119 kB** |
| `/dashboard/management` | 306 kB | **193 kB** |
| `/reports/[report]` | 314 kB | **200 kB** |
| `/appointments` | 309 kB | **235 kB** |
| `/flows/[id]` (builder) | 278 kB | **113 kB** |
| `/inbox` | 286 kB | 291 kB (+5) |
| `/contacts` | 306 kB | 310 kB (+4) |
| `/tasks` | 321 kB | 322 kB |
| `/enquiries` | 386 kB | 387 kB |
| `/portal/[object]` | 328 kB | 331 kB |
| Middleware | 95 kB | 95.2 kB |
| `/notifications` (new) | | 175 kB |
| `/settings/notifications` (new) | | 176 kB |

The spec quoted 308 kB for appointments and 273 kB for flows; this checkout measured 309 and 278. The inbox, contacts and tasks went **up** slightly: the gesture code, the card view and the shell data hook ship with them. Charts, the calendar and the flow builder now load after the page is interactive, so their cost moved from "first load" to "when used" rather than disappearing (the dashboard shows a chart skeleton for a moment).

Other measured or counted changes:

| Measure | Before | After |
|---|---|---|
| Queries the signed-in layout adds to every page render | 2 (overdue tasks, notifications) | 0 (the browser fetches them once and Realtime keeps them fresh) |
| Count queries on the Overview dashboard | 10 | 1 |
| Supabase Auth round trips per page navigation | 2 (middleware, then `getCurrentUser` in the render) | 0 **with asymmetric JWT signing keys**; unchanged if the project still uses a shared-secret JWT, because `getClaims()` falls back to `getUser()` itself |
| Tasks "Done" view, 150,000 tasks in one org (EXPLAIN ANALYZE) | 18.7 ms, parallel seq scan | 0.09 ms, index scan |
| Activity log filtered by a person who made 1 in 500 of 300,000 audit rows (EXPLAIN ANALYZE) | 3.0 ms | 0.12 ms |

### What the bundle analyser showed (whole client build, parsed size)

app code 1,316 kB; `next` 517 kB; `recharts` 264 kB; `react-dom` 171 kB; `@fullcalendar/core` 159 kB; `lucide-react` 134 kB; `libphonenumber-js` 118 kB; `@supabase/auth-js` 107 kB; `zod` 94 kB; `@radix-ui/react-dialog` 93 kB; `@xyflow/react` + `@xyflow/system` 133 kB. The pages that are still heavy (`/enquiries` 387, `/portal/[object]` 331, `/tasks` 322, `/contacts` 310) are not heavy because of one library; they share dnd-kit, TanStack Table, date and phone libraries and a lot of form code. Candidates for a later pass, not done here: split the enquiries board from its grid, load the filter builder on demand, check which `lucide-react` icons are bundled per route, and confirm `libphonenumber-js` is only imported where a number is parsed. I did not touch them because each needs a look in a browser to be sure nothing visibly regresses.

### Budgets

`scripts/bundle-budget.json`: shared 115 kB; default 215 kB for any route not listed; explicit budgets (measured size plus about 7 percent, rounded up to 5) for the thirteen routes above the default and for the dashboard, management dashboard, flow builder, appointments, inbox and reports. `pnpm bundle:check build.log` fails on any route over its budget, on a budget for a route that no longer exists, and on a log that is not a build. To raise a budget, edit the JSON in the same commit and say why.

## Index review (f)

The Supabase performance advisor was not available in the sandbox, so this was done by reading code. A catalogue query for foreign keys with no index starting with that column returns about 150 rows (the advisor's "unindexed foreign key" list); nearly all are covered by an `(org_id, …)` composite every query uses, or are never filtered on. I read the queries behind the hot paths against the existing indexes and added what a real query needs (migration `20261013000300`):

| Index | Query it serves | Why |
|---|---|---|
| `clinical_followups (org_id, visit_id) where closed_at is null` | the clinical engine's open follow-ups of one visit, for up to 500 visits every 10 minutes | the existing indexes lead with `dedupe_key` or `call_status`, so each lookup scanned all open follow-ups of the org. **Not benchmarked** (needs a lot of clinical fixtures); the reasoning is from the plan shape |
| `tasks (org_id, due_at desc) where done` | Tasks page "Done" view | the open-tasks indexes are partial on `not done`; benchmarked above |
| `audit_log (org_id, user_id, at desc) where user_id is not null` | Activity log filtered by person | benchmarked above |
| `contacts (org_id, owner_id)` and `(org_id, assignee_id)`, partial | "my patients" filters and segments | both fields are in the filter builder; most contacts have neither set, so the indexes stay small. **Not benchmarked** |

I also considered and **rejected** indexes for `mentions.conversation_id` (the existing unread-by-user index already narrows it to a handful of rows), `conversation_labels.tag_id` (the label filter runs in memory), `team_members.user_id` (an `(org_id, user_id)` index exists) and `visits.contact_id` (`(org_id, contact_id, visit_date)` exists). The new tables use `(select auth.uid())` in their policies so Postgres evaluates it once per statement; the older policies still call `auth.uid()` per row and are worth a pass when the real advisor can run.

**A bug found on the way (fixed):** `lib/public-api/audit-read.ts` (Phase 15 follow-up on `main`) looked for recent audit rows with `.gte("created_at", …)`, but `audit_log` has no `created_at` (the column is `at`). PostgREST returned an error that the code treated as "no rows", so the 15-minute sampling never matched and **every public-API read wrote an audit row**. The unit test had the wrong column baked in. Fixed, test corrected, and a database test now proves two reads leave one row.

## Decisions and deviations worth knowing

- **Quiet hours hold push and e-mail, never the in-app record.** An escalation (nobody has picked up a conversation) ignores quiet hours. Digests are not held (07:00 is when people asked for them).
- **Org notification rules still own enquiry events.** The existing per-org rules decide who hears about an enquiry and whether by in-app or e-mail. For SLA breaches the new code only adds push on top (people can switch it off in their preferences). The other five events go through `notify()` entirely, so the preference matrix controls their in-app, e-mail and push delivery.
- **E-mail defaults to off for every event** (it was never sent for these before); in-app defaults to on; push defaults to on but only reaches someone who registered a device.
- **"Unassigned" means no person owns it** (`assignee_user_id` is null), including conversations routed to a team but not to anyone.
- **On call is a list, not a rota.** Administrators tick who is on call and update it when the rota changes. A calendar rota is a later job.
- **Pages are never cached by the service worker.** They hold patient data and a shared front-desk PC must not keep them. So the "offline shell" is a branded offline page plus cached build assets, not an app that works offline. Server actions and API calls are never intercepted.
- **Local token checks mean a session ended elsewhere keeps working for page views until its access token expires** (an hour by default). Before, middleware asked Auth on every request and noticed immediately. Mutations still ask Auth, `/api` routes still ask Auth, and Supabase's own data API (PostgREST) never checked revocation, so a stolen cookie could already read through it until expiry. If that trade is not acceptable, set `PULSE_VERIFY_JWT_LOCALLY=0`.
- **Push for the "unread conversation" alert and the enquiry rules' e-mail** were not migrated to the preference matrix (`inbox.unread` from the housekeeping job is still in-app plus e-mail by its own setting). Conversation-level SLA (the Team lead dashboard's "past the SLA" count) is not pushed; the escalation ladder covers conversations nobody owns, `inbox.unread` covers owned-but-unread.
- **Types** for the new tables and columns were produced the same way as in Phase 15 (a script that reads the test database and mimics `supabase gen types`, then Prettier), not by the Supabase CLI. Run `pnpm db:migrate` on a machine with Docker to confirm there is no drift.

## How it was verified

| Check | Result |
|---|---|
| `pnpm typecheck`, `pnpm lint` | clean |
| `pnpm test` | **129 files, 1,497 tests pass** (was 119 / 1,395 at Phase 15; 1,402 on `main` after #31); 509 database tests are skipped without `TEST_DATABASE_URL` |
| `bash scripts/test-db.sh` then `pnpm exec vitest run tests/db` (with PostgREST) | **38 files, 509 tests pass** (was 484). One run failed `finance-diligence` ("expected 'staged' to be 'duplicate'"), which passes alone (twice) and passed in the next two full runs. I could not reproduce it; treat it as an unexplained flake in a file this phase did not touch |
| `pnpm build` with placeholder Supabase variables | passes; `pnpm bundle:check` passes against its log |
| `pnpm audit:security` | 308 entry points, 0 unguarded and unreviewed; the new actions are in `lib/security/policy.ts` with reasons, the mutating ones that matter (`saveEscalation`, `setTeamLead`) call `requirePerm` and `recordAudit` |
| The paste file | `deploy/supabase-paste/13_phase_13_notifications_speed.sql` applied cleanly on top of a database built from the earlier migrations |

What the new tests cover:

- **Pure rules (unit):** preference resolution (defaults, per-event switches, master switches, quiet hours across midnight and across timezones, urgent bypass, unknown events fail closed), preference input validation, push payloads (ids only, hostile values dropped, generic text, same-origin URLs), dispatch with fakes (membership, duplicates, actor exclusion, channel limits, e-mail never carries the in-app copy), push delivery with a fake sender (404/410 removal, failure counting, undecryptable rows), push endpoint allowlist and subscription shape, VAPID key format against web-push's own validation, escalation plan and settings, digest scheduling by timezone and ISO week, digest content and HTML escaping, snooze presets, gestures, title badge, dashboard JSON parsing, auth mode, bundle budget parsing and checking.
- **Middleware (unit, mocked Supabase):** page navigations call `getClaims` and never `getUser`; actions, other methods and `/api` call `getUser`; the MFA gate gives the same answer on both paths; a header the browser sets is overwritten; the opt-out works.
- **Service worker (unit, in a Node `vm` with a fake worker scope):** what it precaches, what it refuses to touch (writes, other origins, API, RSC fetches), the offline fallback, push display (generic, malformed payloads, off-site URLs refused, quiet when the app is in front), notification clicks.
- **Database (real Postgres, RLS as `authenticated`):** all three new tables (own rows only, no client writes where there are no policies, constraints, cascades), snooze, the escalation columns and trigger, `dashboard_overview` (the same numbers as the old queries, RLS decides, other orgs see nothing, anon cannot call it), the three tables in the cross-org sweeps, the new cron entry.
- **Services through PostgREST:** push store (ciphertext at rest, idempotent, failures, removal, someone else cannot remove your device), `notify()` (no patient details in the queue), the escalation ladder end to end (lead then on-call, claimed once, stands down when assigned or closed, administrator fallback), the inbound hook through `processInbound` (first unread only, no PHI in the push, ladder scheduled once and only when enabled), the digest task (one per person and period, only people with `reports.view`), the notification centre's real PostgREST filter syntax as a signed-in user, and the audit-read fix.

## What was NOT verified

- **Nothing was seen in a browser or on a phone.** The settings page, notification centre, inbox on a phone, pull to refresh, swipe, the keyboard behaviour, camera and gallery pickers, card grids, the agenda and the 44 px targets were typechecked, linted, built and (for the pure parts) unit-tested. Whether the visual viewport trick holds on iOS Safari and Android Chrome, whether `touch-action: pan-y` and the swipe coexist with scrolling on real glass, and whether the layout looks right are unknown.
- **The service worker has not run in a real browser.** Its logic is tested in a `vm`; registration, the update flow (`SKIP_WAITING`, `controllerchange` reload), caching, the install prompt and `appinstalled` are untested. The icon files were generated and one was looked at.
- **No real push service.** Web Push to FCM, Mozilla and Apple was never exercised; the real `web-push` sender is not called by any test. iOS only delivers web push to an installed (Home Screen) app on iOS 16.4 or later; the settings page says so but it is untested. `pushsubscriptionchange` (the browser rotating a subscription) is not handled; the device would drop until someone turns push on again.
- **Supabase Auth and Realtime.** `getClaims()` was never run against a real project; whether the project uses asymmetric signing keys decides if the middleware change helps at all. The Realtime filters in `shell-data.tsx` (`user_id`, `assignee_id`, `assignee_user_id`) follow the documented syntax and the tables are in the publication, but no live socket was opened. `x-pulse-auth` through Vercel's edge is expected to pass but is unchecked.
- **pg_cron.** The hourly digest and the existing schedules are stubs in the test harness; the real `app.ping_jobs('notification_digests')` call is unproven until deployed. Resend delivery of the digest is unproven (the task only queues the job; the queue handler's e-mail path is the existing one).
- **Lighthouse, Core Web Vitals, Speed Insights.** No numbers. The only performance measurements are the build's bundle sizes and two EXPLAIN ANALYZE runs on synthetic data; the clinical follow-up and contact indexes were not benchmarked.
- **Large data.** The notification centre and the shell queries were tried on a handful of rows. The notification list is never pruned (see open questions).
- **Accessibility.** Targets and labels were written with care (aria labels on switches, status text on the offline strip, list semantics in the centre) but no screen reader or WCAG audit was run.

## Open questions

1. **JWT signing keys.** Is the Pulse project on asymmetric signing keys? If not, the local verification does nothing until it is (Supabase dashboard, JWT keys).
2. **Session revocation window.** Is "a session ended elsewhere can still load pages for up to an hour" acceptable for page views? (Actions and APIs check immediately.)
3. **On-call.** A ticked list is enough to start. Does the clinic want a weekly rota the app follows?
4. **Digest time.** 07:00 org time, same for everyone. Per-person time? Which sections should the weekly digest add?
5. **Which people get the escalation lead role,** and should the lead also be told when a conversation is owned but unanswered for a long time (today only `inbox.unread` e-mail/in-app handles that)?
6. **Notification retention.** Nothing prunes `notifications`; suggest deleting read ones after 90 days in `security_maintenance` or a similar job.
7. **Sound default.** Off by default so a shared front desk is not startled; should it be on for the Receptionist role?
8. **Staff phones.** Will staff install the app on their own phones (needed for iOS push) or use shared devices? That decides whether push is worth the support effort, and whether the passkey or PIN unlock in section 4.3 of `docs/09` matters first.
9. **Tiptap** is in the spec's dynamic-import list but nothing uses it; confirm it is not planned for Phase 14 or 16 before anyone adds it eagerly.

## Before first use on the real stack

1. Apply `deploy/supabase-paste/13_phase_13_notifications_speed.sql` (Pulse project only; check the project name first), or `supabase db push`.
2. Run `pnpm push:keys` on your own machine; put `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` in Vercel (Production and Preview). Never paste the private key into chat or git. Without them the settings page says push is not set up and everything else works.
3. Check `ENCRYPTION_KEY` is set (device registrations are encrypted with it) and the cron secrets exist (the new `pulse:notification_digests` schedule runs hourly).
4. In Settings, Notifications as an administrator: set a lead for each team, tick the on-call people, then switch escalation on.
5. Click through on a phone and a desktop: install the app; turn on push; "Send me a test"; assign yourself a conversation from another account and watch the bell, badge, push and sound; try a quiet-hours window; open the inbox on the phone with the keyboard up; swipe a row each way; pull to refresh; upload a photo from the camera and from the gallery; open Appointments on a phone (agenda) and Contacts (cards); open the notification centre, snooze, and come back; opt in to the daily digest and check what arrives next morning.
