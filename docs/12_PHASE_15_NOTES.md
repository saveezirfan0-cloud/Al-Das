# Phase 15 notes: security, audit and access

Built on branch `claude/nifty-brown-y9l5ry` (from `main` at `8c45892`), 12 Oct 2026 session. Spec: `docs/10_NEXT_PHASE_PROMPTS.md`, Prompt 15. Everything below was built in a cloud sandbox with Postgres 16, pgvector and PostgREST but **no Supabase Auth, no Docker and no browser**. The sections "How it was verified" and "What was NOT verified" are the honest status.

## What exists

| # | Spec item | Where it lives |
|---|---|---|
| 1 | **MFA.** TOTP enrolment and verify pages; a per-role "require two-step verification" switch; enforced in the middleware | `app/(auth)/mfa/*`, `roles.require_mfa`, `lib/security/mfa.ts` (pure `mfaGate`), `lib/supabase/middleware.ts`, switch in Settings → Security |
| 2 | **`auth_events`** (sign-in, failure, sign-out, sign-out everywhere, password change, MFA enrol/remove/verify, other devices signed out), IP hash + user-agent family, raw IP nulled after 30 days; **Login history** tab in Settings → Account and the Sign-ins view of the Activity log | migration `…000100`, `lib/security/auth-events.ts`, `lib/security/ua.ts`, `public.security_maintenance()` |
| 3 | **Session list** with sign out this device, other devices, everywhere | `user_sessions`, `app/(app)/settings/account/*`, `lib/security/sessions.ts` |
| 4 | **`record_access_log`**: patient drawer, conversation, finance claim and invoice, portal record, enquiry, appointment, files, every export; list screens sampled; viewer with filters under Settings → Activity log → Record access; retention setting | `lib/security/access-log.ts`, `lib/security/sampling.ts`, hooks listed below, `public.security_maintenance()` |
| 5 | **Access review**: every user, role, last active, dormant (30 days, configurable), API-key owners; keep/revoke per person; typed-name attestation that writes a signed record and an audit entry | Settings → Access review, `access_reviews`, `lib/security/access-review*.ts` |
| 6 | **Off-boarding** in one confirmed step: suspend, revoke the API keys they created, hand open conversations and tasks to a colleague (or unassign), leave all teams, mark sessions revoked, audit | Settings → Users → "Off-board…", `public.offboard_member()` (one transaction) |
| 7 | **Anomaly alerts** via the notifications table: large export or burst of exports, off-hours record opens, five failed sign-ins, role changes, bulk API reads | `lib/security/anomaly.ts` (pure rules), `lib/security/alerts.ts`, `security_alerts` (unique `dedupe_key`), Activity log → Alerts |
| 8 | **History tab** in the appointment, enquiry, task, template, flow and portal-record drawers: one trigger-based `record_history` table, one component | migration `…000200`, `components/history/*`, `lib/security/history.ts` |
| 9 | **CSV export of the Activity log** (any view except API reads), itself audited and recorded as an export | `app/api/settings/activity/export/route.ts` |
| 10 | **Patient data export and erasure** requests, admin-only, two-person rule (application and a `CHECK` constraint), audited | Settings → Patient data requests, `privacy_requests`, `public.erase_contact()`, `lib/privacy/export-bundle.ts`, `POST /api/privacy/requests/[id]/export` |
| 11 | **Phase 10 gaps** (see below) | `lib/public-api/*`, `lib/net/url-guard.ts`, `lib/ai/usage.ts` |
| 12 | Guards and tests | `tests/db/security-guard.test.ts`, `tests/db/security-phase15.test.ts`, `lib/security/policy.ts`, static pass |

New permissions: `security.manage` (Security settings, Access review) and `privacy.manage` (Patient data requests). Both are in the new "Security & privacy" group and are held by Admin (`*`) only. No preset role gets them, so no data migration for existing roles was needed. The Activity log and its new views keep the existing `settings.manage` gate.

### Where access is recorded

Always (one record): `getContact` (patient drawer), the inbox page when a conversation is selected, finance claim and invoice pages, `getEnquiry`, `getAppointmentDetail`, `getRecordDetail` (portal), portal attachment download. Sampled lists: contacts list and search, enquiries, appointments, portal lists, the inbox conversation list, inbox media (as "document"). Every export route and `exportAppointments` call `recordExport`, which also drives the bulk-export alert. Repeats of the same open by the same person within 5 minutes count as one (the inbox re-renders on every realtime event). Phase 16's documents should call `recordAccess` with `entity: "document"`.

### Phase 10 gaps closed (docs/08)

1. **API reads audited in aggregate**: `api_read_log` (key, resource, hour, request and row counts, no record ids), shown under Activity log → API reads; a key reading 5,000 rows in an hour (setting) raises an alert.
2. **Consent evidence**: `promotions_opt_in: true` is refused unless the request carries `promotions_consent { source, obtained_at, reference? }`; it is stored on the contact with the API key id; withdrawing the opt-in clears it. Evidence without an opt-in is also refused.
3. **Port 443 only** for webhook and knowledge-base URLs, in the one function every outbound fetch goes through (`parsePublicHttpsUrl`). Existing webhook endpoints that use another port will now fail delivery and show in the delivery log.
4. **AI daily cap**: `ai.daily_cap` (default 500, workspace-wide, midnight in workspace time). It reuses the atomic `rate_limit_hit` counter and reserves the call before it is made, so parallel requests cannot overshoot it. The per-user per-minute limit is unchanged (still counted after the call).

## Decisions and deviations worth knowing

- **MFA switch is per role and optional for every role.** Sensitive roles (settings, security, privacy, any `finance.*`, `portal.clinical_*`, or a portal wildcard) are flagged on the Security page with a warning when the switch is off, but nothing is forced on at deploy time, which would lock out every admin on day one. Anyone who has enrolled an authenticator is challenged once per session whatever their role says. The check costs nothing for an already-verified (aal2) session; an aal1 session without a factor costs one small query per request.
- **Sessions.** Supabase Auth has no API to list sessions or to revoke one specific other device, so the list is our own `user_sessions` table (recorded at sign-in and when Settings → Account is opened). "Sign out other devices" and "everywhere" use Supabase's `signOut({ scope })`, which ends refresh tokens; an already-open screen can keep working until its access token expires (about an hour by default). Revoking one chosen other device is **not** offered.
- **Off-boarding** suspends the membership (which removes all access in every policy and in `getCurrentMember`) but cannot sign the person out of Supabase Auth itself (no admin API without their token). Sessions are marked revoked in our table only.
- **Auth events and orgs.** An event is attached to the user's oldest active membership (or the current org for in-app events). A failed sign-in for an e-mail that is not a member has no org: it is stored (hash only) but visible to nobody and raises no alert; the rate limiter still throttles it. Failed-sign-in bookkeeping runs after the response so its timing cannot reveal whether an e-mail exists.
- **Alerts use the `notifications` table** (realtime bell) through the existing `notifyMembersWithPermission`, not the pgmq `notifications` queue, which carries email and due-task work. Summaries contain counts only.
- **History actor.** Almost every write in this app uses the service-role client, where `auth.uid()` is empty. `createAdminClient(member.userId)` now sends an `x-pulse-actor` header, and the trigger trusts it only on service-role requests (checked against a real PostgREST in `tests/db/security-actor.test.ts`). The server actions of the six tracked areas were switched over; imports, jobs, the public API and the Unite sync write with no actor and show as "System". The history stores values, so notes and similar text live in a second table protected by the same permission as the record; the trigger cuts text at 500 characters and reduces large JSON (flow graphs, template components) to "(changed)".
- **Erasure is anonymisation, not deletion.** It clears names, phone numbers, e-mail, date of birth, notes, custom fields, message bodies, payloads, media references, summaries, timeline, mentions, flow-run context, campaign variables, recall notes, Unite review payloads and the history rows of the patient's appointments, enquiries and tasks; sets `stop_marketing`; marks the contact erased; deletes the media files from storage first (retryable). **Clinical records mirrored from Unite are kept** and reported in the result (OQ-63). Raw webhook payloads (`webhook_events_in`) are not touched; the existing housekeeping removes processed ones after 30 days. Database backups and Meta's own copies are outside the tool.
- **Export** is a JSON file with explicit column lists, generated on demand for an approved request and **single-use** (the request is claimed before the file is built). It is a POST so a link on another site cannot trigger it. Media files are listed by name, not included. Messages are capped at 20,000 and other sections at 5,000 rows; a `truncated` list says when.
- **Types** for the new tables were generated from the test database with a small script that mimics `supabase gen types` (checked identical for existing tables), not by the Supabase CLI. Relationships to views are omitted for the new tables. Regenerate with `pnpm db:migrate` on a machine with Docker.

## How it was verified

| Check | Result |
|---|---|
| `pnpm typecheck`, `pnpm lint` | clean |
| `pnpm test` | **119 files, 1,395 tests pass** (the 476 database tests are skipped without `TEST_DATABASE_URL`; 91 tests are new in nine `security-*` files plus additions to four existing ones: MFA gate, middleware with a mocked Supabase client, anomaly rules, sampling, access review, history parsing, privacy rules, activity filters and CSV, access log, alerts and auth events against an in-memory fake, API read audit, AI daily cap, URL port rule, consent evidence) |
| `bash scripts/test-db.sh` then `pnpm exec vitest run tests/db` | **35 files, 476 tests pass** (was 33 / 432). New: `security-phase15.test.ts` (38: RLS and cross-org isolation for all eight tables, every write denied, append-only guards, history trigger and actor rules, retention, `api_read_log_hit`, two-person constraint, `erase_contact`, `offboard_member`), `security-actor.test.ts` (3, through a real PostgREST), and additions to `security-guard.test.ts` (the new tables are swept, service-only functions are asserted not callable by signed-in users) and `jobs.test.ts` (new cron entry) |
| `pnpm build` with placeholder Supabase variables | passes; `next start` with the same variables redirects `/inbox`, `/mfa/enroll` and `/api/settings/activity/export` to `/login` and serves `/login` (middleware loads in the production runtime) |
| Static security pass | `pnpm audit:security`: 297 entry points, 0 unguarded; the six new authentication-only actions are listed with reasons in `lib/security/policy.ts`; every other new action or route uses `requirePerm`/`can` and writes an audit entry |
| The paste file | `deploy/supabase-paste/12_phase_15_security.sql` applied on top of a database built from the earlier migrations |
| PostgREST syntax of every new query | embeds, `or=`, `upsert … ignoreDuplicates` and the new RPCs run against a real PostgREST without error |

## What was NOT verified

- **Nothing was seen in a browser.** The Account tabs, MFA pages, Security, Access review, Patient data requests, the Activity log views, the History tabs and the off-boarding dialog were typechecked, linted and built, not clicked.
- **MFA against a real Supabase Auth.** Enrolment, the QR code, challenge and verify, removal, `getAuthenticatorAssuranceLevel()` inside the middleware, the `session_id` claim used by the session list, and the three `signOut` scopes were written from the documented API and never run. The middleware logic is tested with a mocked client. TOTP must also be switched on in the Supabase Auth settings (it is a dashboard setting, not code).
- **`x-pulse-actor` through Supabase's gateway.** It works through plain PostgREST; that Supabase's API gateway forwards the header to PostgREST is expected but unchecked.
- **`after()`** (failed-sign-in bookkeeping after the response) on Vercel; **pg_cron** for the nightly task (the harness has a stub); email or push delivery of alerts.
- **Performance.** The extra per-request work (aal check; membership lookup for aal1 sessions; one dedupe query per patient open) was not measured under load.
- **Large data.** Erasure and export were tested on a handful of rows, not on a patient with thousands of messages.
- **Types** were not produced by the Supabase CLI (see above).

## Open questions

OQ-62 to OQ-66 in `docs/audit/open-questions.md`: who holds `privacy.manage` and who is the second approver; what the law requires for Unite-mirrored clinical records on erasure (blocks the first real erasure); retention periods; which roles must use MFA and the clinic's working hours; whether inbox marketing sends need a recorded opt-in. Also: should `record_history` have a retention period (it is currently kept until the record's patient is erased), and should the access review email a reminder when a quarter passes unsigned (today it shows a banner).

## Before first use on the real stack

1. Apply `deploy/supabase-paste/12_phase_15_security.sql` (Pulse project only; check the project name first), or `supabase db push`.
2. Supabase Auth settings: enable TOTP enrolment and verification; keep access-token expiry at 1 hour or less.
3. Set `ENCRYPTION_KEY` (it keys the IP and e-mail hashes; `JOB_SECRET` is the fallback). Changing it later breaks correlation of old hashes, nothing else.
4. Create the cron secrets as usual (`app_url`, `job_secret`); the new `pulse:security_maintenance` schedule runs daily at 03:20 UTC.
5. Click through, as an Admin and as an Agent: sign in; enrol an authenticator; turn MFA on for a role; sign in as that role without an authenticator (expect the enrolment page); sign out other devices; open a patient and check Activity log → Record access; export contacts and check the alert and the audit entry; change a task and open its History; run an access review; off-boarding a test user; raise, approve (as a second admin) and run an export and an erasure on a synthetic patient.
