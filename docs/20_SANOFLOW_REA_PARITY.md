# Sanoflow parity pass (REA capture, 13 Oct 2026)

_Read after `CLAUDE.md`, `docs/01_FEASIBILITY_AND_TEARDOWN.md` and `docs/09_STATUS_AND_ROADMAP.md`. Data file: `docs/audit/sanoflow-surface.json`._

## 1. Why this exists

`docs/01` was a visual teardown (8 Oct). Pulse has since shipped Phases 1 to 19b. This pass goes one level deeper: it reads Sanoflow's **declared server contract** (every Server Connect endpoint, its query parameters and its form field names) plus the **i18n vocabulary** each page ships, which exposes flow nodes, triggers, validation rules and report metrics that the UI only shows after many clicks. It then diffs that surface against what is in `main` (`dd9eb42`, Phase 19b).

## 2. Method and boundaries

- **Source:** the logged-in Al Das workspace at app.sanoflow.io. Page HTML was fetched read-only from the user's own browser session and parsed for `dmx-serverconnect url`, `dmx-param:*`, `serverconnect-form` field names, page routes, script inventory and translation keys. This is the same evidence REA's `inspect_web_page` + `analyze_web_bundle` produce for a server-rendered Wappler app (Sanoflow's logic is in HTML attributes, not in a JS bundle).
- **Not captured:** no API was called, no JSON responses read, no patient names, numbers or message text. Nothing in the data file is PHI.
- **Clean-room rule (CLAUDE.md rule 14 still applies):** the endpoint and field names describe behaviour. Do not reuse Sanoflow's names, copy, template texts, icons or code in Pulse. Use them to decide *what* to build and to write importers.
- **Coverage:** 25 pages, 333 endpoints (Settings 132, OCInbox 37, enquiry 28, Appointments 19, Common 19, Patients 18, contact-details 16, workflow 15, Campaigns 14, template 13, reports 8, other 14). The flow canvas, campaign detail and report sub-pages load data client-side and were captured through the vocabulary only; see §6 for the local REA deep dive.

## 3. What this pass found that `docs/01` did not have

1. **More flow surface.** Triggers `new_message_received`, `whatsapp_flow` (Meta Flow completion), `messaging_window_exit` (24 h window closing) and segment-attached **drip** flows. Nodes `update_enquiry_field`, `create_campaign`, an **AI intent router** (`ai_action`: list of intent label + intent prompt, system prompt, KB source group, tone, "send the AI reply before the next step"), `appointment_agent` with an initial action (create / confirm / reschedule / cancel), Question node with **answer validation** (number, multiple choice, regex) and `request_contact_info`, Wait with **wait-for-response**, a set-label / set-message-status action, and per-flow builder checks (each option connected, one condition per branch, trigger connected).
2. **Team behaviour.** Teams carry `auto_assign`, `fallback_team`, `auto_reply` + `auto_reply_msg`, channels and pipelines. Users carry `max_assigned_chats`, `restrict_enquiry_view` and a default view. The org has `inactive_time` (presence auto-away).
3. **Booking capacity.** Services have `PreBuffer`, `PostBuffer`, `ConcurrentPatients`, `OnlineBooking`, `require_payment`, price and currency. Specialists have `time_slot_duration`, `enable_multiple_bookings`, `max_bookings_per_slot`, `ShowBusy`, and recurring overrides (block time) with weekdays. Google Calendar is two-way per specialist (calendar id, revoke, delete override events).
4. **Templates.** Per-template `retry_on_fail`, `has_sms_fallback`, `time_to_live`, a **performance** endpoint (by template and date range), header/URL-button custom mappers, carousel cards (card count, header type, two button types), a master template gallery, unarchive.
5. **Campaigns.** Three retry rounds each with their own recipient list, recurring campaigns with cron edit and play/stop, CSV audience (CSVBox), test send, monthly quota.
6. **Inbox.** One endpoint (`UpdatePatientStatus`) closes a conversation **and** creates or updates the enquiry (stage, status, disqualify reason, UTM fields, appointment time) in one form. Also: forward message / contacts across channels, unlink chat from contact, catalogue products, employee call (CallGear), message sources, KB positive / negative feedback with the correct answer.
7. **Reports vocabulary.** First-assign-to-close and last-assign-to-close times, `ai_engaged` / `closed_by_ai`, owner removed, Meta ads metrics (CPM, reach, unique clicks, cost per delivered, cost per link click, website add-to-cart / checkout / purchase values), template delivery / read / link-click rates.
8. **Channels.** Web chat widget (domain, title, subtitle, welcome, colour, icon), generic HTTP SMS provider (method, URL, headers, auth, body, response path), MM Lite (Marketing Messages API) eligibility check, Gupshup, Instagram, Messenger, CallGear, HMS connectors with location/specialist fetch.
9. **Opaque settings keys** in `Settings/platform/edit-settings` (`olsla`, `TBAR1..3`, `tbba`, `tbbr`, `tbc`, `CPAA`, `MSGCA`, ...). The meanings in the JSON are **inferred** from the settings screens; confirm before relying on them.

## 4. Parity matrix against Pulse `main`

Evidence is a code search of the repo on 13 Oct, **re-verified against `main` (`dd9eb42`) on 13 Oct** at the start of Phase 20a; the "Pulse today" column below is the corrected version. File references are in §4.1.

| # | Area | Sanoflow has | Pulse today | Priority for Al Das |
|---|---|---|---|---|
| G0 | **Flow CRM nodes (found 13 Oct)** | n/a | `registerCrmAdapter` is never called, so the Create/update enquiry, Add task, Portal record and Book appointment nodes fail closed at run time, and so does the recall starter flow that uses `create_enquiry`. docs/09 §2.3 wrongly says they are wired | **P0 for Make retirement**: fix first in 20b |
| G1 | **Migration from Sanoflow** | Exports: contacts, appointments (all / table), enquiries + activity (per pipeline / all), campaign report download, quick replies, labels, tags, pipelines, custom fields, segments | **Closed in 20a** (docs/22): `pnpm import:sanoflow:all` imports config (pipelines, stages, enquiry fields, sources), tags, labels, categories, quick replies, contacts, static segments, enquiries, enquiry activity and future appointments. Dynamic segments are reported for rebuilding by hand. Campaign reports go to a read-only campaign archive. Wired into `pnpm reconcile` and `cutover:preflight`. Also added: enquiry tags, a lost-reason pick-list, Sanoflow items on the sync-review screen, and a reminder hold for imported appointments | ~~P0~~ done |
| G2 | Flow triggers | `new_message_received`, `whatsapp_flow`, `messaging_window_exit`, drip on segment | 14 triggers incl. appointment events and AI tag. An inbound message only resumes a waiting run or fires `template_button`. Meta Flow `nfm_reply` is parsed but triggers nothing. No window-exit job. `segments.drip_flow_id` exists (with FK) but no code reads it. The Recurring trigger can loop over a segment, capped at 200 members with no paging | P1 |
| G3 | Flow nodes | `update_enquiry_field`, `create_campaign`, payment link node, Meta event node, AI intent router, appointment / enquiry agents, set label | 20 node types. **The Create/update enquiry, Add task, Portal record and Book appointment nodes appear in the builder but fail at run time: `registerCrmAdapter` is never called (see G0).** No payment-link, Meta-event, router, set-label or campaign node. The contact `label` field can be set through Update contact field. AI intent tagging is a trigger, not a router | P1 (router: P2, must stay inside CLAUDE.md rule 12) |
| G4 | Question node | validation (number, choice, regex), re-ask, store answer, request contact info | Matches the choice by id or title and saves it to a flow variable, with an optional timeout. No typed or regex validation and no direct save to a contact field. An unmatched reply with no fallback edge waits silently, with no re-ask | P1 |
| G5 | Teams and routing | team auto-reply message, fallback team, per-user max open chats, restricted enquiry view, presence auto-away after N minutes | Round-robin over online members, per-member weight and team lead. None of the five listed. Enquiry RLS is one flat `enquiries.view` | P1 |
| G6 | Booking capacity | service pre/post buffer, concurrent patients, specialist slot length, multiple bookings per slot, ShowBusy, recurring blocks | Per-specialist advisory lock, one-off `time_blocks` plus org holidays, one org-wide slot step. Capacity is 1 (`assert_slot_free`). No buffers, per-specialist slot length, ShowBusy or recurring blocks | P1 (wrong slots once Unite is the source of truth are expensive) |
| G7 | Google Calendar | two-way per specialist | read-only ICS feed (Phase 19a) | P2 |
| G8 | Templates | performance report, retry-on-fail, per-template SMS fallback, TTL, carousel, URL-button mappers, gallery | Builder, gallery, sync, positional and named variables, URL-button suffix mapping. Carousel can be authored, previewed and synced, but not sent with values. A `retry_on_fail` column exists but nothing reads it. SMS fallback covers reminders only. No TTL or performance report | P2 |
| G9 | Campaigns | 3 retry rounds, recurring (cron), CSV audience, test send, quota meter | **Built:** up to 3 retry rounds, CSV audience, test send, a monthly-sent counter and a tier warning. **Missing:** recurring campaigns, A/B tests and a hard monthly cap | P2 (recurring + cap only) |
| G10 | Inbox close-with-enquiry | one dialog closes the chat and writes the enquiry (stage, status, lost reason, UTM) | close dialog with category and summary; enquiry is a separate action | P2 |
| G11 | Inbox extras | forward message / contact, unlink chat from contact, catalogue products, employee call | Failed log, AI panel, quick replies, shortcut flows and contact merge exist. No forward, unlink, catalogue send or calls; there is only a `catalog_id` setting | P3 |
| G12 | Channels | Instagram, Messenger, web chat widget, generic SMS, MM Lite | WhatsApp Cloud API only (`channels.type` check). SMS fallback uses a Twilio adapter, for reminders only. No Instagram, Messenger, widget, generic HTTP SMS or MM Lite | P2 (widget), P3 (rest) |
| G13 | Reports | first/last-assign-to-close, AI engaged / closed by AI, user status log, cohort, template rates, Meta ads spend metrics | 9 registry reports plus ad attribution and AI quality; heatmap, WhatsApp cost and enquiry-to-booking conversion. None of the listed metrics exist. Assignment history and a presence log are prerequisites | P2 |
| G14 | Lead-gen forms, booking page, payment-required booking | plan-gated in Sanoflow, not used by Al Das | Not built. The inbound flow webhook and public API v1 can accept posts from an external form | P3 |
| — | Billing, plans, Gupshup, Salla, non-Unite HMS | SaaS-only | out of scope (single tenant) | skip |

### 4.1 Evidence for the 13 Oct re-check

- G0: `lib/flow-engine/crm-registry.ts` (registry), `lib/flow-engine/supabase-deps.ts` (`crm: crmPort()` gets the empty port), `lib/flow-engine/executors/crm.ts` (fails closed), `lib/flow-engine/starter-flows.ts` (recall starter uses `create_enquiry`).
- G2: `lib/flow-engine/types.ts` (trigger list), `lib/flow-engine/triggers.ts` (an inbound message stops after resume / template button), `lib/whatsapp/parse.ts` (`nfm_reply`), `lib/jobs/handlers/flow-recurring.ts` (`.limit(200)`, no paging).
- G4: `lib/flow-engine/executors/messaging.ts` (question schema), `lib/flow-engine/run.ts` (answer matching, fallback edge).
- G5: `teams` / `team_members` / `memberships.presence` in `20261008000200_tenancy.sql`; `pick_round_robin_assignee` in `20261008000900_inbox.sql`.
- G6: `services` / `specialists` / `time_blocks` in `20261009000910_appointments.sql`; `app.assert_slot_free` in `20261012000100_appointment_booking_lock.sql`; `lib/appointments/slots.ts`.
- G8: `wa_templates.retry_on_fail` in `20261008000800_channels.sql` (unused); `lib/templates/builder.ts` (carousel); `lib/whatsapp/templates.ts` (`button.N`).
- G9: `20261010000100_campaigns.sql` (retry rounds, csv audience); `lib/campaigns/engine.ts`; `app/(app)/campaigns/actions.ts` (test send); `lib/campaigns/queries.ts` (monthly counter).
- G10: `app/(app)/inbox/close-dialog.tsx` sends category and summary only.
- G13: `lib/reports/registry.ts` (9 reports); `conversations` has no assignment history.
- docs/09 disagreements: §2.3 "CRM nodes are wired" (false, see G0); "no carousel" (authoring is built, sending is not); campaign retries, CSV audience and test send are built.

## 5. Recommended order

1. **20a Migration completeness (G1).** Without it the clinic loses open enquiries, future appointments and tagging on cut-over day.
2. **20b Flow parity (G0, G2, G3, G4).** Start with G0: the CRM adapters must be registered before any native node can replace a Make scenario. Al Das automations currently call Make through API Action; after Make is retired those become native nodes.
3. **20c Routing and booking capacity (G5, G6).**
4. **20d Templates and campaigns (G8, G9, G10).**
5. **20e Reports and channels (G12, G13, G7).**

Prompts: `docs/21_SANOFLOW_PARITY_PROMPTS.md`.

## 6. Going deeper with REA (local, optional)

REA attaches over the Chrome DevTools Protocol to a browser that **you** start and log into; it cannot run from a cloud session. Use it for the screens that load client-side (flow canvas JSON, campaign detail, report sub-pages, the AI agent settings) when a phase needs exact behaviour.

```bash
npx rea-agents@latest setup        # registers the REA MCP server with Claude Code
google-chrome --remote-debugging-port=9222 --user-data-dir=$HOME/.rea-sanoflow https://app.sanoflow.io/login
# log in yourself in that window, open the screen you want studied
```

**Scripted capture:** `node tools/rea-sanoflow.mjs` does the whole pass on your machine. It clones and builds REA if needed, opens a debug Chrome on loopback with its own profile and waits while you log in yourself. It then visits each route and writes `sanoflow-rea-shapes.json` outside the repo: request paths with no query and with id segments collapsed, plus JSON and WebSocket shapes (key paths and types, never values; keys that look like ids, numbers or e-mails are collapsed). The script refuses an `--out` folder inside a git work tree, and it will not write the summary if the file contains anything e-mail- or phone-like. Commit only that summary file, to `docs/audit/`. Delete `raw/` and `chrome-profile/` afterwards: they hold live data and your Sanoflow session.

Then in Claude Code: `list_browser_targets` → `inspect_web_page` (DOM, accessibility tree, network metadata, no bodies by default) → `observe_web_session` while you click through a flow edit → `analyze_web_bundle` for any script you select. Keep evidence bundles **outside the repo** (they can hold patient data from the live workspace) and copy only behaviour notes into `docs/audit/`.
