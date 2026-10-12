# Phase 14 notes: front desk, help and training mode

Built on branch `claude/nifty-brown-y9l5ry` (from `main` at `d88c102`, Phases 13 and 15 merged), 12 Oct 2026 session. Spec: `docs/10_NEXT_PHASE_PROMPTS.md`, Prompt 14, plus Prompt 12b item 6 (`pnpm demo:reset`). Everything below was built in a cloud sandbox with plain Postgres 16 and PostgREST. There was no browser, no phone, no Supabase Auth stack, no Docker and no real WhatsApp, so "verified" below means unit and database tests, a production build and a bundle check, not a click-through.

## What exists

### Front desk workspace (`/front-desk`)

| Spec item | Where it lives |
|---|---|
| Today board (arrivals by time, confirmed or not from reminder replies, no-shows, walk-ins, next free slots per doctor) | `app/(app)/front-desk/page.tsx`, `front-desk-workspace.tsx`; pure classification in `lib/front-desk/board.ts`; queries in `lib/front-desk/server.ts` |
| Check-in Arrived / With doctor / Done / Checked out, stored in Pulse only | columns on `appointments` (migration `20261014000100`); state machine in `lib/front-desk/checkin.ts`; action `setCheckin`. Unite is never written and the Unite sync does not touch these columns. |
| Screen pop (patient card beside the conversation) | `app/(app)/front-desk/patient-card.tsx` (lazy loaded), shown as the "Patient" tab in the inbox sidebar and in the workspace; data from `lib/front-desk/patient-card.ts` and `loadPatientCard` |
| One-tap actions: book, reschedule, cancel, call, send location, running late | `dialogs.tsx`, `actions.ts` (`cancelFromDesk`, `logCall`, `sendDeskMessageAction`), messages in `lib/front-desk/messages.ts`. Call is a `tel:` link that logs a call task. Send location needs coordinates or a maps link on the location (new fields under Settings, Appointments). |
| Walk-in registration | `walk-in-dialog.tsx`, `registerWalkIn`, validation in `lib/front-desk/walk-in.ts` (phone, name, language, consent tick) |
| Printable desk QR opening WhatsApp with a pre-filled message | `/front-desk/qr` (SVG made on the server with the `qrcode` library), `lib/front-desk/qr.ts` |
| End-of-day printable sheet and shift handover notes | `/front-desk/end-of-day`, `lib/front-desk/end-of-day.ts`, table `handover_notes`, actions `addHandoverNote` / `resolveHandoverNote` |
| Receptionist lands here | `app/page.tsx` + `lib/front-desk/landing.ts`; post-login defaults now go to `/` instead of `/dashboard` |
| Permission | `frontdesk.use` (group "Front desk"), granted by a data migration to the system roles Receptionist and Manager and in the presets. Every action also checks the permission of what it does (`appointments.manage`, `contacts.manage`, `tasks.manage`, `inbox.send`). |

### Waiting list and slot offers

- Tables `waitlist_entries` and `slot_offers` (migration `20261014000300`). Offers are written only by the service role.
- A cancellation or a reschedule (the old slot) calls `scheduleSlotFreed()`, which writes a durable `scheduled_jobs` row (`waitlist.freed`). The `appointments` queue handler dispatches it, ranks the waiting list (`lib/front-desk/waitlist.ts`) and sends offers through `queueOutbound` only: free text inside the 24 h window, the mapped template outside it, and if there is no usable template the offer is marked `failed` and nothing is sent. Opt-outs (`stop_marketing`) are skipped.
- An offer expires through a second `scheduled_jobs` row (`waitlist.expire`).
- A YES reply (button or text, via the `message.received` listener in the appointments handler) calls `public.accept_slot_offer()`. It takes the same per-specialist advisory lock as `book_appointment` / `move_appointment` (`pg_advisory_xact_lock(hashtextextended(specialist_id::text, 0))`, migration `20261012000100`), re-reads the offer, re-checks the slot is free, books through `book_appointment` and marks the sibling offers `taken`. Result is one of `booked | taken | expired | not_pending | not_found`.
- Offers are **off by default** (`front_desk.offers_enabled`, Settings, Front desk). A clinic should switch them on only after approving the template.
- A successful booking raises the new `waitlist.booked` notification (generic text, ids only).

### Households

- `household_links` (migration `20261014000200`): one guardian per dependant, no chains (trigger), dependants have no phone of their own because `contacts.phone_e164` is unique per org.
- Reminders and every other appointment message pick the recipient with `resolveRecipient()` (`lib/household/addressing.ts`): the guardian's phone, naming the patient ("Layla (for Omar)" in the contact variables unless the template maps `patient.*`). A guardian's Confirm tap counts for the dependant.
- Shared-phone matching (`lib/household/shared-phone.ts`): when exactly one contact holds a number and the incoming record has evidence (PIN or date of birth) that it is a different person, the importer and the Unite sync return an ambiguous result for review (reason `shared_phone`) instead of merging. The sync-review page has a new action, "Create as their dependant".
- `merge_contacts` refuses to merge a guardian into their own dependant and moves links; `contact_duplicate_candidates` no longer suggests household pairs or siblings.

### Quick replies

Bilingual (`text`, `text_ar`), `/` shortcuts in the composer, variables such as `{{first_name}}` rendered by `lib/inbox/quick-reply.ts` (pure, tested). Settings, Inbox warns about unknown variables.

### Help and training

- Help menu in the top bar (`components/help/*`): Training page (`/help/training`), the "?" button that opens the clip and one-page guide for the current page (`lib/help/clips.ts`, `lib/help/guides.ts`), a what's-new panel (`lib/help/whats-new.ts`), a feedback button (table `help_feedback`, rate limited), and a keyboard cheat sheet opened by `?` (`lib/help/shortcuts.ts`).
- Videos do not exist yet. Every clip is a "coming soon" placeholder until an admin pastes an https link under Settings, Training mode. No deploy is needed.
- **Training mode** (`orgs.is_training`, Settings, Training mode; typing TRAINING to enable and GO LIVE to disable, both audited). A banner shows on every page. Two independent layers block real WhatsApp: the outbound handler marks the message sent on screen with a `training:<id>` id and makes no Meta call, and `clientForChannel` throws `TrainingModeError` for a training org.

### `pnpm demo:reset`

`DEMO_RESET_OK=1 pnpm demo:reset --owner-email=<you>` (flags: `--slug`, `--name`, `--owner-id`, `--users`, `--receptionist-id`, `--finance-id`, `--check`). It refuses unless `DEMO_RESET_OK=1` and the Supabase URL is local or names a demo project; it refuses anything that says "prod"; it refuses an existing org with the same slug that is not a demo org. The SQL function `demo_wipe_org` is a second lock: it needs both `is_training` and the seed's own `settings.demo_seed` flag. It keeps the org, roles, memberships, teams, invites and the append-only logs, and deletes everything else.

Seed content (all synthetic, names like `Layla Demo-07`, numbers only in the Ofcom drama range `+44 7700 900000` to `900999`): doctors and locations, appointments for today and tomorrow in several check-in states, 30 conversations in different states, 3 enquiry pipelines, a waiting list, a household, a campaign with results, a recall programme in Test mode and finance rows from a synthetic invoice batch.

### Migrations

`20261014000100_front_desk_core.sql`, `…200_household.sql`, `…300_waitlist.sql`, `…400_demo_reset.sql`. The four are concatenated in `deploy/supabase-paste/14_phase_14_front_desk.sql`. `lib/supabase/types.ts` was patched from the test database (no Supabase CLI here), then formatted.

## How it was verified

- `pnpm typecheck`, `pnpm lint`, `pnpm test`, the full database suite on Postgres 16 with PostgREST, a production `pnpm build` with placeholder Supabase variables and `pnpm bundle:check`. Final counts are in `docs/09_STATUS_AND_ROADMAP.md`, section 1.
- **Slot-offer race, real concurrency.** `tests/db/front-desk.test.ts` opens separate connections and fires two YES replies at once (and a five-way race, and a staff booking against a YES). Exactly one booking exists, the others get `taken`. Removing the advisory lock from `accept_slot_offer` makes these tests fail, so they are not vacuous.
- **Household reminder addressing**: unit tests (`tests/unit/household.test.ts`) and the service test that sends through the real handler path to a guardian's number.
- **Permission gating**: `tests/unit/front-desk-permissions.test.ts` (every action refuses without `frontdesk.use` or the underlying permission) and the cross-org and role sweeps in `tests/db/front-desk.test.ts` and `tests/db/security-guard.test.ts` (`PHASE14_TABLES`, `seedPhase14Rows`).
- **demo:reset**: `tests/db/demo-reset.test.ts` runs the script as a child process against the test database, checks both locks, idempotence (wipe and re-seed twice) and that two demo orgs can coexist.
- **Paste file**: applied in one transaction on a database built from the pre-Phase-14 migrations; the resulting schema (pg_dump) equals a full build.
- Training mode: the outbound handler test proves no network call to Meta and the `training:` id; the channel test proves the client refuses.
- Bundle: `/front-desk` budget 235 kB (built at 218 kB); `/inbox` stayed at 294 kB because the patient card loads through `next/dynamic`.

## NOT verified

- No browser: nothing here has been looked at on a screen, at 390 px or 1440 px. The workspace has a render test (server-rendered markup), nothing more. No Playwright spec was added.
- No phone: the QR code has not been scanned, the `tel:` link has not been tapped, print layouts (`print:hidden`) have not been sent to a printer.
- No real WhatsApp: offers, "running late", location and reminders were exercised against the job handler with the Meta call stubbed. The offer template must be created and approved by Meta before offers can go out of the 24 h window.
- No Supabase Auth stack: the role landing page, the post-login redirect and the permission checks in pages are covered by unit tests with a mocked session, not a real sign-in.
- No Supabase CLI or Docker: `lib/supabase/types.ts` was generated from the plain-Postgres test database with a local script and patched. Regenerate with `pnpm db:migrate` on a real stack and expect at most formatting differences.
- The contacts drawer has no household UI yet. Links are made from the patient card and the sync-review page.
- The database suite occasionally flakes (`finance-diligence` has failed once without a code change). A failure there should be re-run before it is treated as a regression.

## Decisions to confirm

1. "Running late" is a message from the clinic to the patient ("we are running about N minutes behind"). The spec could also mean the patient telling the desk; that case is not built.
2. Waiting-list offers default OFF, and an offer with no approved template is marked failed rather than sent.
3. A cancellation that comes from the Unite sync can only match waiting-list entries that name a service (Unite's feed does not carry a Pulse service, so the freed slot has none; entries that accept any service are not matched from Unite cancellations).
4. Training mode blocks WhatsApp only. It does not block e-mail digests, outbound webhooks or Web Push. A training org should not be given real recipients.
5. The demo wipe keeps the audit and other append-only logs; the demo org's history is therefore never fully empty.
6. The hosted-URL guard cannot see a Supabase project name from the URL alone (it is a reference id), so a hosted target is accepted only when `SUPABASE_PROJECT_NAME` or `DEMO_PROJECT_NAME` contains `demo`.

## Open questions for the clinic

- Offer window length and the number of people offered at once (defaults are in Settings, Front desk).
- Wording and Arabic text of the offer, location and running-late templates, which then need Meta approval.
- Which roles besides Receptionist and Manager should see the front desk (the permission is `frontdesk.use`).
- Who records the training videos; the catalogue in `lib/help/clips.ts` lists the planned ones per role.
