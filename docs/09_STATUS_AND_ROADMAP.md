# Pulse: status, gaps and product roadmap

_Snapshot: 10 Oct 2026. Branch `claude/compassionate-mayer-fx0usn`. Written for Saveez (owner) and for Claude Code, which reads it at the start of each new session._

This is the single document to work from. Section 1 says where we are, 2 says what engineering work is left, **3 is the list of things only you can supply (keys, accounts, answers)**, 4 and 5 are the product improvements and the plan to deliver them, and 6 to 9 cover going live, demos, training recordings and the next actions. The copy-paste prompts for the next phases are in `docs/10_NEXT_PHASE_PROMPTS.md`. Client-facing material is in `docs/pitch/`.

---

## 1. Where we are

### 1.1 The short version

Phases 1 to 11 and Finance F0 to F6 are **built, tested and merged**. Pulse already contains everything the original spec asked for: WhatsApp inbox, patient CRM, enquiries and tasks, appointments with reminders, templates, campaigns, the flow builder, recall programmes (the Make replacements), the back-office portal (Airtable replacement), the clinical rules engine, AI assist, dashboards and reports, public API and webhooks, and the finance and insurance module.

**What is not yet true:** nothing has run against the real world. There is no Supabase project, no Meta credentials, no Unite credentials and no real data. Every external call is tested against fakes. The UI has never been clicked through in a browser in a build environment (there was no auth stack). So the honest status is **"feature-complete in code, not yet proven live"**. Sections 2 and 3 are the path from here to proven.

### 1.2 Numbers (measured this session)

| Measure | Value |
|---|---|
| SQL migrations | 44 |
| Tables in `public` | 126 |
| App pages | 59 (58 + the new Activity log) |
| HTTP routes (public API, webhooks, exports, jobs) | 18 |
| Background job handlers | 20 |
| TypeScript | about 108,000 lines |
| Permission keys | 40 (plus wildcards) |
| Unit test files / tests | 107 files / **1,245 passing** (includes the 19 added this session) |
| Database test files | 34 files (423 tests; they need a Postgres, skipped here) |
| Browser (Playwright) specs | 6 |
| `pnpm typecheck`, `pnpm lint`, `pnpm test` | **all clean** on a fresh install |

Not run this session: the database tests (no Postgres in the sandbox) and the browser tests (no auth stack). They passed when each phase landed.

### 1.3 Scorecard

| # | Module | Built | Not proven / missing |
|---|---|---|---|
| 1 | Foundation: auth, orgs, RLS, roles, teams, invites, jobs framework | Yes | Presence inactivity timeout; MFA not enforced |
| 2 | Patient CRM: grid, views, segments, filters, import/export, merge, custom fields, tags | Yes | Sanoflow export header names are guessed (`--map` overrides); real export needed |
| 3 | WhatsApp ingress and shared inbox | Yes | Never tested with real Meta traffic; BSUID (username) contract unverified; coexistence events only logged |
| 4 | Templates: builder, Meta submit and sync, 26 starter templates (13 in English and Arabic) | Yes | Needs `META_APP_ID` and a real WABA; no OTP, catalogue or flow-button templates |
| 5 | Enquiries and tasks: pipelines, Kanban, SLA, assignment, reminders, first-touch | Yes | No enquiry tags join table, no CSV import, no AI summary |
| 5b | Tasks API, booking conversion, failed reminder becomes a call task | Yes | None |
| 6 | Appointments, slot engine, reminders, button replies; read-only Unite sync; clinical rules engine; Follow-Up Queue; Clinical settings | Yes | No DB lock against simultaneous double-booking; clinical messaging deliberately OFF until sign-off; Unite sync OFF until credentials |
| 7 | Campaigns: audience snapshots, fan-out, throttling, funnel, retries | Yes | No recurring campaigns, A/B variants, per-recipient media headers |
| 8 | Flows (21 node types), recall programmes, parallel-run tooling | Yes | Live path untested; recall in Test mode only; Token and MRD-sync parallel runs need Make exports |
| 9 | Back-office portal and complete Airtable importer | Yes | Phase 6 importer mappers still `pending_phase6` (flip to ready); no portal bulk edit |
| 10 | AI assist and knowledge base, metrics, dashboards, reports, public API, webhooks | Yes | AI switch OFF until legal answer (OQ-57); WhatsApp cost report not built; no `ai_tags`; no scheduled digests |
| 11 | Hardening, load tests, reconciliation, cut-over tooling | Yes | Load tests only run against a mock Graph; live rehearsal not done |
| F0-F6 | Finance and insurance: Unite capture, Diligence upload and matching, exceptions E01-E10, summary | Yes | Unite capture is OFF by design; closed-month review with Saeed is a human step |

### 1.4 Changes made in this session

A first slice of the UX, mobile and audit work (this is "Phase 12a" below):

- **Grouped menu.** The sidebar is now organised as Today, Patients, Growth and Insight and back office, with Dashboard on top and Settings at the bottom. Group headers collapse to dividers when the sidebar is collapsed.
- **Quick search (Ctrl/Cmd + K).** Jump to any page you may open, including every Settings page. Search matches names and keywords (for example "calendar" finds Appointments).
- **Mobile bottom tab bar** (Inbox, Appointments, Tasks, Contacts, More) with safe-area padding; the inbox height was adjusted so the composer is not hidden behind it.
- **Installable app (PWA manifest and icon)** so staff can add Pulse to a phone or front-desk PC.
- **Loading skeletons, an error page and a not-found page** for the whole signed-in app, so navigation never looks frozen and one failing page no longer takes the sidebar with it.
- **Settings reorganised** into Personal, Workspace, Channels and integrations, Clinic operations, and Security and audit. One list now feeds the Settings menu and quick search so they cannot drift apart.
- **Activity log** (`/settings/activity`): who changed what and when, filterable by period, person, area and action, with expandable details, paginated, read-only, and visible only with `settings.manage`. Times show in the clinic timezone.
- **CI workflow** (`.github/workflows/ci.yml`): typecheck, lint, unit tests and a production build on every pull request. There was no CI before.
- 19 new unit tests (navigation rules, quick-search ranking, activity-log filter parsing).

Still to do on these: click through them on a real stack (section 2.2).

---

## 2. Engineering work still open

### 2.1 Blocked on something external (nothing to code until you act)

| Item | Blocked on | Details |
|---|---|---|
| Real data import (Airtable, Sanoflow) | Supabase project, `AIRTABLE_PAT`, UAE residency opinion (OQ-49) | Tooling is dry-run verified. `pnpm import:airtable --dry-run` then for real, then `pnpm reconcile` |
| Live WhatsApp on the new inbox | Meta System User token, WABA ownership (OQ-38) | `pnpm cutover:preflight` checks everything read-only |
| Unite sync (appointments, doctors, patients) | New Unite credentials (OQ-26) | Read-only, conservative rate limits, circuit breaker already built |
| Unite finance capture (deliver-once) | Token-coexistence test with Make, Unite field list, 2026 queue size | Stays OFF. Follow `docs/finance/go-live-runbook.md` exactly |
| Clinical messages to patients | Clinical sign-offs (OQ-01 to 06, 36) | Gate is built and fails closed |
| AI replies | Legal answer on sending text to Anthropic and Voyage (OQ-57) | Switch is OFF per org |
| Make parallel run | Make-side exports for Token and MRD sync | `/recall/parallel-run` is ready |

### 2.2 Verification that was never done

These are the most valuable things to do before any client sees the product, because every one is a likely source of embarrassing first-demo bugs.

1. **Run the whole app once on a real Supabase stack** (`supabase start`, `pnpm db:reset`, `pnpm dev`) and click every page as three different roles (admin, receptionist, finance). The phase notes all say the UI "was type-checked and built but not driven in a browser". Expect cosmetic and flow bugs.
2. **Run the database tests** (`pnpm test:db`) and the Playwright suite (`pnpm e2e`) on that stack. Add them to CI (a Postgres service with pgvector, PostgREST for the service-level tests).
3. **Real Meta round trip** on a test number: signed webhook in, message in the inbox in under 2 seconds, template out, ticks back. `pnpm wa:simulate` has only simulated this.
4. **Load rehearsal on staging**: `pnpm load:webhook`, `pnpm load:outbound` (20,000 messages against the mock Graph, then a small real batch).
5. **Accessibility pass** (WCAG 2.1 AA) and a **real-phone pass** (iOS Safari and Android Chrome).

### 2.3 Known gaps carried over from the phase notes

| Area | Gap |
|---|---|
| Appointments | No database-level lock against two staff booking the same slot at the same instant (add a per-specialist advisory lock RPC). Google Calendar sync not built |
| Inbox | Presence has no inactivity timeout (round-robin depends on people setting Away). Create enquiry and Book appointment buttons in the contact sidebar need checking now that the modules exist |
| Flows | Question node does not re-ask on an unmatched answer. A crash between "queued" and "step recorded" can resend once on replay. Outbound webhooks node and CRM nodes are wired, but untested live |
| Campaigns | One audience snapshot per campaign (no recurring); no A/B; no carousel |
| Templates | Positional variables only in the builder; no OTP or catalogue templates |
| Portal | No bulk edit; no per-object custom fields or tags |
| Reports | WhatsApp cost report (needs Meta `pricing_analytics`), scheduled email digests, AI tags |
| Public API | Rate limit is per key and fixed-window; reads are not audited; `promotions_opt_in` can be set without consent evidence; webhook and KB URLs allow any HTTPS port |
| AI | Rate limit can be exceeded by parallel calls; add an org daily cap |
| Finance | Several thresholds are placeholders until Sharaf agrees them; Unite IP allow-listing may need a fixed-IP relay (Vercel has no fixed outbound IPs) |
| Security | No MFA enforcement, no session list, no login history, no read-access log for patient records (see 4.11) |

### 2.4 Housekeeping

- `README.md` still says "Other module pages are placeholders until their phase", and `docs/06_PHASE_11_CUTOVER.md` / `docs/07_PHASE_11_NOTES.md` still say Phases 4 to 10 are not built. They are out of date. Update both (Phase 12 prompt includes this).
- Several docs share a number prefix (`05_*`, `06_*`, `08_*`). Harmless, but rename once the numbering settles.
- `app/(app)/dashboard/page.tsx` is not Prettier-formatted; run `pnpm format` in a dedicated commit so reviews stay clean.
- `docs/00_HOW_TO_USE.md` mentions `AlDas_InHouse_Clinic_Platform_Proposal.pdf`, which is not in the repo. The new pitch pack in `docs/pitch/` replaces it.

---

## 3. What I need from you

Everything below is outside what code can fix. Tick them off in this order: accounts first (they unblock the most), then answers, then data.

### 3.1 Accounts, keys and secrets

Never paste any of these into chat, GitHub, a doc or a screenshot. Put them in Vercel environment variables (Production and Preview) and in `.env.local` for local work. Variable names come from `.env.example`.

| # | What | How to get it | Variable(s) | Unblocks |
|---|---|---|---|---|
| 1 | **Supabase project** (Pro plan, region decided with legal, see OQ-49) with extensions `pgmq`, `pg_cron`, `pg_net`, `vector`; point-in-time recovery on | supabase.com, new project, then `supabase link` and `supabase db push` | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (server only) | Everything |
| 2 | **Vercel Pro project** linked to the GitHub repo, production domain (for example `pulse.<your domain>`) | vercel.com, import repo | `APP_URL` | Deploys, cron callbacks |
| 3 | **Two random secrets** | `openssl rand -base64 32` for the key; any 32+ character random string for the job secret | `ENCRYPTION_KEY`, `JOB_SECRET` | Encrypting channel and integration tokens; pg_cron calling `/api/jobs/*`. **Back up `ENCRYPTION_KEY` somewhere safe: losing it makes stored tokens unreadable** |
| 4 | **Meta (WhatsApp Cloud API)** under Al Das's own Business Portfolio: verified business, a Business-type app, a System User with a permanent token, the WABA and the three phone numbers | business.facebook.com, developers.facebook.com | `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` (you choose it), `META_SYSTEM_USER_TOKEN`, `META_GRAPH_VERSION`; plus WABA ID and phone number IDs entered in Settings, Channels | Inbox, templates, campaigns, reminders |
| 5 | **Unite EMR credentials for the platform** (fresh app id/key, not the ones in Make) | Ask Unite. The email draft is `docs/finance/unite-request-email.md` | `UNITE_BASE_URL`, `UNITE_APP_ID`, `UNITE_APP_KEY` (entered encrypted in Settings, Unite EMR) | Appointment, doctor and patient sync |
| 6 | **Anthropic API key** | console.anthropic.com | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | AI assist (after OQ-57) |
| 7 | **Embeddings key** (Voyage assumed) | voyageai.com | `EMBEDDINGS_API_KEY`, `EMBEDDINGS_PROVIDER`, `EMBEDDINGS_MODEL` | Knowledge-base search |
| 8 | **Resend** with the clinic's sending domain verified (SPF and DKIM) | resend.com | `RESEND_API_KEY`, `RESEND_FROM` | Invites, alerts, digests |
| 9 | **Sentry** project | sentry.io | `SENTRY_DSN` (and an auth token in Vercel for source maps) | Error monitoring |
| 10 | **Airtable personal access token**, read-only (`data.records:read`, `schema.bases:read`) on the 5 bases | airtable.com/create/tokens | `AIRTABLE_PAT` | Migration only. **Revoke after cut-over** |
| 11 | **Make API token**, read-only | Make profile, API | `MAKE_API_TOKEN`, `MAKE_ZONE=us2`, `MAKE_TEAM_ID=1494412` | Migration and parallel run only. **Revoke after cut-over** |
| 12 | **Sanoflow contact export (CSV) and tag/label list** | Sanoflow, Contacts, Export | file, not a secret | Contact import |
| 13 | **GitHub**: repo secrets only if CI later needs them; Vercel-to-GitHub integration enabled | github.com settings | none today | Preview deployments |

**Added by the roadmap (not needed for the first go-live):** VAPID key pair for browser push (generated by a script, Phase 13); an SMS provider account for fallback messages; a payment gateway merchant account for pay-by-link; a Google Cloud OAuth client for calendar sync and review requests; a Meta Marketing API token for ad reports.

**Rotate at cut-over:** the Unite keys that sit in plain text inside the Make blueprints, and the old Sanoflow API key.

### 3.2 Decisions and sign-offs (answers only you or the clinic can give)

Full register: `docs/audit/open-questions.md`. These are the ones that block something real.

| Decision | Who | Blocks |
|---|---|---|
| **Where may patient data be hosted?** DHA / DoH / UAE PDPL opinion on EU-region hosting (OQ-49) | Management and legal | First real patient row |
| **Does Al Das own the WhatsApp Business Account?** (OQ-38) | Saeed | Moving numbers off Sanoflow |
| **May patient messages be sent to Anthropic and Voyage?** DPA, zero retention (OQ-57) | Management and legal | AI assist |
| **Clinical thresholds**: recall interval 30/85/90 days (OQ-01), day-3 offset (OQ-02), probiotic days (OQ-03), feedback red-flag score (OQ-04), day-3 HALT score (OQ-05), side-effect keywords (OQ-06), all vitals thresholds (OQ-36) | Abdul and Snezana | Any patient-facing clinical message |
| **Working week and holidays** (OQ-07), **doctor to department lists** (OQ-08) | Abdul | Follow-up due dates, gynaecology rules |
| **Who works the follow-up queue, at what volume?** (OQ-14) | Abdul | Clinical go-live |
| **Meaning of Unite appointment status codes** (AAC, ACF, APH, CNR, CVI, YTC, NSW) (OQ-23) | Sharaf and Unite | No-show reports, reminders |
| **Reminder lead time**: keep the current ~24 h, or 48 h plus 24 h? (OQ-19) | Operations | Reminder schedule |
| **Birthday rules**: yearly or once ever; age bands; 29 Feb (OQ-17, 18) | Saeed and marketing | Birthday programme |
| **Marketing consent**: do marketing sends need a recorded opt-in, or only the absence of "stop marketing"? | Management and legal | Campaign go-live |
| **Finance thresholds** (E01 30, E04 14, E05 60 days), write-off "approved" value, `InvType` values, ordering vs performing doctor | Sharaf and finance | Finance tuning |
| **Names of the Billing and Finance users**, and the Medical Director and CEO view | Saeed | Finance roles |
| **Token coexistence with Make** (does Pulse refreshing the Unite token break Make's scenarios?) | You and Unite | Finance capture |

### 3.3 Data and content to supply

| Item | From |
|---|---|
| One unfiltered **Diligence export** (header row first, using `docs/finance/diligence-header-request.md`) | Sharaf |
| The three Unite **clinic long and short names** | You |
| **Working week, holiday calendar, doctor list with departments** | Abdul |
| **30 real patient questions with approved answers** to seed the AI knowledge base (and tune retrieval) | Operations |
| **Brand pack**: logo (SVG), colours, fonts, plus Arabic copy review for templates | Marketing |
| **Staff list** with names, roles and mobile numbers for invites | Saeed |
| **Two or three front-desk champions** for user testing and training videos | Operations |
| **Client name, contacts and any pricing/commercial terms** for the proposal (placeholders are marked in `docs/pitch/`) | You |

### 3.4 Legal and compliance paperwork

- Data processing agreements: Supabase, Vercel, Anthropic, Voyage, Resend, Sentry, Meta.
- Written position on health-data hosting, retention periods, patient consent wording for WhatsApp, and breach-notification contacts.
- Sign-off that **no real patient data** is used for demos: use the synthetic seed only.

---

## 4. Product review: what a senior reviewer would change

I went through the product as a clinic owner, a receptionist and a security reviewer. The first column says how it looks today, the rest is the improvement. Items marked **(done)** shipped in this session.

### 4.1 Design, UI and UX

| Today | Improvement |
|---|---|
| Neutral grey shadcn look with a blue primary; works, but nothing says "Al Das" | **Brand layer**: one set of tokens (logo, primary, accent, radius, type) so a client demo looks bespoke. Light and dark already exist; add the user-facing theme toggle |
| 14 flat menu items | **Grouped menu (done)**, plus per-role landing pages, favourites and recent items |
| Pages blank while loading | **Skeletons and error states (done)**; add empty states with a next action on every list |
| Settings was one long list | **Sectioned Settings (done)**; add a Settings home with search and an admin setup checklist |
| Finding things means knowing the menu | **Ctrl/Cmd+K (done)** for pages; extend to patients, appointments and templates ("find Ahmed", "book") |
| No "create" shortcut | A global **+ New** button: patient, appointment, enquiry, task, message |
| English only, left to right | **Arabic and RTL for staff screens** (templates and AI drafts already handle RTL). Essential for the UAE |
| Help lives in docs | **In-app help**: a "?" on every page that opens the matching training video and a one-page guide (section 8) |
| Dense tables everywhere | Comfortable/compact density toggle; card view on phones |
| No consistent confirmation pattern | Undo toasts instead of "are you sure?" for reversible actions |

### 4.2 Speed and optimisation

| Finding | Action |
|---|---|
| The signed-in layout runs two extra queries on every navigation (overdue-task count, 20 notifications) | Move badge counts to a client fetch plus Realtime, or cache per user for 30 s with a tag invalidated by task changes |
| The dashboard fires 11 separate count queries | One SQL function returning all tiles in a single round trip; cache for 30 s |
| Middleware calls `supabase.auth.getUser()` (a network call) on every request | Verify the JWT locally (`getClaims`) for page navigations; keep `getUser()` for sensitive actions |
| Heavy client libraries (FullCalendar, React Flow, Recharts, Tiptap) | `next/dynamic` so they load only on the pages that use them; run the bundle analyser and set a budget |
| Region | Put Vercel functions in the same region as Supabase |
| Database | Run `get_advisors` (performance) after the first real data; review indexes on `messages`, `conversations`, `contacts` (38.7k+ rows) and `audit_log` |
| Connections | Use the Supavisor transaction pooler URL for serverless functions |
| Measurement | Vercel Speed Insights and Sentry performance; targets: inbox opens under 1 s, p95 server action under 500 ms, LCP under 2.5 s on 4G |

Baseline from this session's production build (first-load JS): shared 102 kB; dashboard 232 kB; appointments 308 kB; inbox 286 kB; flow builder 273 kB. Phase 13 sets budgets from these numbers.

Already good: virtualised grids, keyset-style pagination in the inbox, materialised metrics refreshed every 15 minutes, queue-based sends, debounced Realtime on boards.

### 4.3 Mobile

Receptionists and doctors will use phones. Today: a drawer menu and responsive pages, but desktop-first tables and no installable app.

- **(done)** Bottom tab bar, safe-area padding, installable manifest and icon.
- Next: service worker (offline shell, push), pull-to-refresh, swipe actions in the inbox (assign, close), sticky composer that follows the keyboard, camera and gallery upload, voice-note recording, minimum 44 px tap targets, appointment day view defaulting to an agenda list on phones, and card layouts for the contacts and tasks grids.
- Passkey or PIN unlock for the installed app on shared devices.
- Test matrix: iOS Safari (installed PWA, for push) and Android Chrome; Lighthouse PWA audit in CI.
- Option later: a Capacitor wrapper if iOS push proves unreliable.

### 4.4 Notifications

Today: in-app bell with Realtime, task-due and enquiry-SLA reminders, e-mail through Resend, finance alerts.

| Add | Why |
|---|---|
| **Per-user preferences** (event by channel matrix, quiet hours) | Stops alert fatigue |
| **Web push** (service worker, VAPID) for new messages, mentions, assigned conversations, SLA breach, failed reminders | Staff are not watching the tab |
| **Sound and tab-title badge** for inbound WhatsApp | Front desk basics |
| **Escalation ladder**: unassigned for 5 minutes tells the team lead; 15 minutes tells the on-call | Nobody misses a patient |
| **Daily and weekly digests** (management dashboard by e-mail; flagged as unbuilt in Phase 10) | Management value without logging in |
| **Slack/Teams webhook** channel | Clinics that live in chat |
| **Notification centre** page with filters and snooze | The bell only shows 20 |
| **Staff WhatsApp alerts** for critical events only (ids, never patient content) | Last-resort reach |

### 4.5 The receptionist: a "Front desk" mode

This is the screen that sells the product. One page, built for someone answering a phone and WhatsApp at once.

1. **Today board**: arrivals expected, confirmed vs unconfirmed (from reminder replies), no-shows, walk-ins, next free slots.
2. **Check-in** with statuses Arrived, With doctor, Done, Checked out (a Pulse-side status; Unite stays the system of record and is read-only).
3. **Screen pop**: when a WhatsApp message arrives, a patient card shows the next appointment, last visit, open enquiry and any balance flag.
4. **One-tap actions**: book, reschedule, cancel, call (tel: link, logged as a task), send location, send directions, send "your doctor is running late".
5. **Waitlist and gap filling**: when an appointment cancels, offer the slot by WhatsApp to the waitlist in order. This directly earns money.
6. **Quick replies** with `/` shortcuts, bilingual, with variables.
7. **Walk-in registration** in under a minute: phone number, name, language, consent tick; QR on the desk that opens a WhatsApp chat with a pre-filled message to register themselves.
8. **Insurance card and ID capture** from the phone camera into the patient's documents (see 4.7).
9. **Household linking**: one phone number often serves a family. Allow dependants under a guardian contact so reminders reach the right person about the right patient.
10. **End-of-day sheet**: unconfirmed tomorrow, unanswered conversations, open call tasks, failed messages. Printable.
11. **Shift handover notes** pinned at the top of the board.
12. **Double-booking guard** (the advisory lock from 2.3) and a soft warning for overbooked slots.

### 4.6 AI and flows

Today: suggested replies grounded in the knowledge base, conversation summary, rewrite, translate, thumbs feedback, guardrails (no diagnosis, no dosing, escalate to staff), draft-only; a visual flow builder with 21 node types, simulation by Test mode and run logs.

Proposed, in order of value:

1. **Flow Copilot.** Type "If someone asks about prices, give the price list and offer a booking; outside office hours say we are closed" and get a draft flow in the builder. It generates the same graph JSON the builder uses, validated by the same graph checker, shown as a draft with the "Checks" panel; it is never auto-published. A **dry-run** button replays a sample conversation through the flow with no sends.
2. **Campaign Copilot.** Describe the audience in words ("patients not seen in 90 days, Arabic speakers, no marketing opt-out") and it produces the filter definition the audience builder already uses, with the matching count before anything is sent. It also drafts template copy in English and Arabic and lints it against Meta's category rules and our opt-out line.
3. **Intent detection** on inbound messages (booking, price, complaint, report request, emergency) to tag and route. Emergency wording escalates to a human immediately with a notification. Needs the sign-off in OQ-61.
4. **Voice notes**: transcribe to text for the agent (needs the consent and provider decision).
5. **Smart summaries** at hand-off and at close, written to the timeline.
6. **Reply quality loop**: weekly report of AI suggestions accepted, edited or rejected, and the questions with no good answer (to grow the knowledge base).
7. **Rules that stay**: clinic-specific only (Meta bans general chatbots), drafts for staff, no diagnosis or dosing, human takeover always one click, every AI call logged without patient content.

### 4.7 Media, files and data

Today: WhatsApp media goes to a private `wa-media` bucket with signed URLs; portal records can hold files.

Add a proper **Media Library** and **Patient documents**:

- **Media Library**: organisation-wide images, PDFs and videos with folders and tags, used for template headers, campaigns and quick replies. Validates against WhatsApp limits (image 5 MB, video 16 MB, document 100 MB), compresses images on upload, tracks where each file is used.
- **Patient documents tab** on every contact: referral letters, lab reports, insurance cards, consent forms, with category, expiry date (insurance cards expire), who uploaded, and **a log of every view and download**. Access is a permission, not a default.
- Camera capture on phones; image rotation and crop; PDF preview; thumbnails and lightbox in the conversation.
- Malware scan on upload, retention policy per category, storage usage dashboard, backups with a tested restore.
- Residency follows OQ-49: files are health data.
- Out of scope: imaging (DICOM) and storing clinical notes beyond what Unite holds.

### 4.8 Integrations worth planning

| Integration | Value | Notes |
|---|---|---|
| **Google/Outlook calendar** (doctors) | Doctors see their day on their phone | Two-way is harder; start with read-only feed (ICS) |
| **Google Business reviews** | Review request after a happy visit | Route unhappy feedback to a manager task instead |
| **Meta Lead Ads and click-to-WhatsApp attribution**, Conversions API | Know which ads bring patients | `referral` data arrives on the first message |
| **Instagram and Messenger DMs** | One inbox for social | Separate Meta permissions |
| **SMS fallback** (a UAE-registered sender) | Reach people when WhatsApp fails | Sender ID registration takes time |
| **Payments** (Stripe, Telr, PayTabs, Network International) | Pay-by-link in the chat; deposits | Merchant account needed |
| **Accounting** (Zoho Books, QuickBooks, Xero) | Invoice and receipt export | One-way |
| **Telephony** (WhatsApp Calling API, Zoom Phone) | Call log on the patient timeline | Check Meta's UAE availability |
| **Telehealth video** (Daily, Zoom) | Video appointment type with a join link | Consent and recording policy |
| **e-Signature** (DocuSign) | Consent forms signed from a link | Store signed PDF in patient documents |
| **Health information exchanges and e-claims** (DHA eClaimLink, DoH Shafafiya, Malaffi, NABIDH) | Direct claim and records exchange | Regulated; assess with a licensed partner before any build |
| **BI** (Power BI, Looker, BigQuery) | Management's own dashboards | Read replica or scheduled export |
| **Zapier/Make** | Anything else | Already possible through the public API and webhooks |
| **Website** forms, chat widget and booking widget | Leads straight into enquiries | Incoming-webhook entry points exist |

### 4.9 Clinic-level improvements

- **No-show reduction**: reminder-reply tracking (built), no-show risk flag, waitlist fill, deposit for repeat no-show patients.
- **Patient self-service in WhatsApp**: book, reschedule, cancel, ask for a report, pay, share location, in English and Arabic.
- **Feedback and reputation**: a rating after each visit; happy leads to a Google review request, unhappy creates a manager task within the hour; NPS trend by doctor and branch.
- **Preventive and chronic care**: recall programmes are built (birthday, chronic 90-day); add vaccination schedules, annual check-up and medication-refill reminders after clinical sign-off.
- **Referral and source tracking**: where each new patient came from (ad, website, walk-in, doctor referral, friend).
- **Utilisation**: slot utilisation by doctor and room, idle gaps, cancellations by reason.
- **Packages and vouchers**: sessions remaining, expiry reminders.
- **Complaints and incident register** with owner, due date and closure, for quality audits.
- **Consent management**: marketing consent, clinical-messaging consent, language preference, with evidence and date (the data model has these; add a clear UI).
- **VIP and special-needs flags** with care notes visible to the front desk only.

### 4.10 Insurance and billing

Built: Unite invoice capture (off), Diligence claim upload and matching, exception rules E01 to E10, aged receivables and monthly summary, data-health page, alerts.

| Improvement | What it does |
|---|---|
| **Pre-authorisation tracker** | Request, approved, expiry; linked to the appointment; task when about to expire |
| **Eligibility check step** | Card photo, payer, validity; blocks "ready to bill" if missing |
| **Denial management** | Reason-code taxonomy, owner, resubmission deadline countdown, AI-drafted appeal letter (draft only, human sends) |
| **Remittance reconciliation** | Match payment advice to claims, flag short payments against the payer's agreed price list |
| **Payer scorecards** | Denial rate, days-to-pay, top denial reasons by payer and by doctor |
| **Collections forecast** | Expected cash by week from ageing and payer history |
| **Self-pay recovery** | Outstanding-balance reminders by WhatsApp (opt-in, tone-reviewed), payment links, instalment tracking |
| **Month-end close pack** | One-click PDF/XLSX with sign-off by finance and the CEO; locks the month |
| **End-of-day cash-up** per branch | Reconcile payments by mode |
| **Revenue views** | By doctor, department, branch, service; estimate generator for patients |
| **Accounting export** | One-way to Zoho/QuickBooks |
| **Coding hints** | Draft suggestions for missing documentation (never auto-submitted) |

Rule that stays: Unite is the system of record, Pulse mirrors and flags. The deliver-once finance API is touched only by the guarded job.

### 4.11 Activity logs, history, user checks and access

| Have today | Gap and fix |
|---|---|
| `audit_log` (security and configuration events, append-only) | **(done) Activity log screen.** Next: CSV export with its own audit entry, saved filters |
| Contact timeline with field-level changes | A **History tab in every drawer** (appointments, enquiries, tasks, templates, flows, portal records) |
| Clinical settings history with signer | Same pattern for finance reference data and message templates |
| Roles with 40 permission keys, teams, invites, presence | **Login history** (time, IP, device, success/failure), **session list with revoke**, **MFA required** for admin, finance and clinical roles (Supabase TOTP) |
| Read access to patient records is not logged | **Record access log**: who opened which patient chart, every export, every file view. Health-information systems are normally expected to keep this |
| No periodic review | **Access review**: a page listing every user, role, last active, dormant accounts (30 days), API-key owners; quarterly attest-and-sign workflow |
| Anyone with the role keeps access until removed | Off-boarding checklist (suspend, revoke keys, reassign conversations and tasks); optional working-hours or IP restriction for finance |
| Alerts on job failures | **Anomaly alerts**: bulk export, off-hours access, many failed logins, role changes |
| Delete and merge exist | Soft-delete with restore window; patient data export and erasure request tooling |
| Backups are the host's | Written backup and restore drill, PITR on, annual test |

---

## 5. Roadmap

Each phase starts in Plan Mode and uses the prompt of the same number in `docs/10_NEXT_PHASE_PROMPTS.md`. Effort assumes one senior builder with Claude Code.

| Phase | Outcome | Needs from you | Effort |
|---|---|---|---|
| **12a** | UX foundation: grouped menu, quick search, mobile tabs, skeletons, error pages, PWA manifest, Activity log, CI. **Done in this session** | nothing | done |
| **12b** | Make it real: bring up the Supabase and Vercel stack, seed demo org, click every page as three roles, fix what breaks, DB and e2e tests in CI, update stale docs | accounts 1, 2, 3 | 1 week |
| **13** | Mobile, notifications and speed: service worker, web push, preference matrix, escalation ladder, digests, layout/dashboard query cuts, dynamic imports, performance budget | 12b | 1.5 weeks |
| **14** | Front desk mode, waitlist, walk-in registration, household linking, quick replies, in-app help and training mode | clinic input | 2 weeks |
| **15** | Security and audit: MFA, login history, sessions, record access log, access review, anomaly alerts, History tabs | none | 1.5 weeks |
| **16** | Media Library and patient documents | residency answer | 1.5 weeks |
| **17** | AI: Flow Copilot, Campaign Copilot, intent routing, reply-quality loop | OQ-57, OQ-61 | 2 weeks |
| **18** | Finance and insurance upgrades: pre-auth, denials, remittance, scorecards, month-end pack | Diligence export, thresholds | 2.5 weeks |
| **19** | Integrations: calendar feed, payments, SMS, reviews, ads attribution | the accounts in 4.8 | per integration |
| **Go-live** | Staging rehearsal, parallel run, number-by-number cut-over, retire Make, Airtable, Sanoflow | everything in section 3 | 3 weeks including the parallel week |

The pitch only needs 12b to be real. 13 to 15 turn it from "it works" into "I would trust it with my clinic".

---

## 6. Going live

1. **Accounts and secrets** (3.1), Supabase migrations pushed, Vercel deployed, cron schedules created.
2. **Staging rehearsal**: `pnpm cutover:preflight --stage pre-cutover` must report GO. Load tests on staging.
3. **Data**: Airtable and Sanoflow import with `--dry-run`, then real, then `pnpm reconcile --live-airtable`, sign-off file completed by operations, clinical and engineering.
4. **Parallel week**: Make and Pulse side by side in Test mode; `/recall/parallel-run` has to be clean before "Make off" unlocks.
5. **Cut over WhatsApp numbers one at a time**, lowest-traffic number first. Keep Sanoflow subscribed until the third number is stable.
6. **Retire** Make, then Airtable, then Sanoflow. Revoke the migration tokens. Rotate the Unite keys.
7. **Clinical messaging** switches on only after the clinical lead signs the validation period (OQ-16).

Definition of done is in `docs/02_CLAUDE_CODE_BUILD_PLAN.md` section 10 and `docs/06_PHASE_11_CUTOVER.md`.

---

## 7. Demo and MVP preview

For a client demo use a **demo org with synthetic patients only** (the seed already does this: `admin@pulse.local`). The script, the story order and the click path are in `docs/pitch/DEMO_SCRIPT.md`. The deck is `docs/pitch/Pulse_Pitch_Deck.pptx`.

Minimum bar before showing it live:
1. Phase 12b done: the stack is running, not a laptop prototype.
2. A test WhatsApp number connected, so the inbox moment (a real message arriving and a reply with ticks) is genuine.
3. Demo data reset script run the morning of the demo.
4. A recorded fallback video of the whole walkthrough in case Wi-Fi fails.

---

## 8. Recordings for training and for the pitch

Recorded walkthroughs of the product at work serve three audiences: receptionists learning the system, new hires later, and the client who wants to see it without a live demo.

**How to make them so they stay current**
- Script each walkthrough as a Playwright scenario against the demo org (synthetic data). The tool records video, so re-recording after a UI change is one command, not a re-shoot.
- Add on-screen captions and a cursor highlight in the script; add a voice-over (human or text-to-speech) in English and Arabic.
- Export MP4, host privately (Supabase Storage, Vimeo or unlisted YouTube), and surface them in the app: **Help, Training**, grouped by role, with a "?" on each page that opens the matching clip.
- Add a **Training mode**: a sandbox org with a banner so staff can practise without touching real patients.
- Pair each video with a one-page quick card (PDF) and a three-question check at the end.

**Receptionist curriculum (12 clips, 3 to 5 minutes each)**
1. Install Pulse on your phone and sign in
2. Your day at a glance (Front desk board)
3. Inbox basics: assign, reply, close, notes
4. The 24-hour rule and when to use a template
5. Booking, moving and cancelling an appointment
6. Handling reminder replies (Confirm, Reschedule, Cancel)
7. Call tasks and the daily call list
8. Registering a walk-in and linking family members
9. Finding and merging duplicate patients
10. Failed messages: what to do
11. End-of-day checklist and handover
12. Privacy rules: what you never put in a chat or a screenshot

Then similar short sets for managers (dashboards, campaigns), finance (uploads, exceptions) and admins (users, roles, activity log).

---

## 9. Immediate next actions

1. You: create the Supabase project and the Vercel project, and send me nothing secret; set the variables yourself (3.1 rows 1 to 3).
2. You: open Meta Business Manager and confirm WABA ownership (OQ-38). This is the longest lead time.
3. Me: run Phase 12b with those in place.
4. You: send the first questions to Abdul/Snezana (clinical thresholds), Sharaf (Diligence header row) and Unite (credentials, token coexistence).
5. Decide the client demo date; work back from it using section 7.
