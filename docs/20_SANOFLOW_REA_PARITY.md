# Sanoflow parity pass (REA capture, 13 Oct 2026)

_Read after `CLAUDE.md`, `docs/01_FEASIBILITY_AND_TEARDOWN.md` and `docs/09_STATUS_AND_ROADMAP.md`. Data files: `docs/audit/sanoflow-surface.json` (declared endpoints and form fields) and `docs/audit/sanoflow-rea-shapes.json` (response shapes)._

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

Evidence is a code search of the repo on 13 Oct; confirm each row in Plan Mode before building.

| # | Area | Sanoflow has | Pulse today | Priority for Al Das |
|---|---|---|---|---|
| G1 | **Migration from Sanoflow** | Exports: contacts, appointments (all / table), enquiries + activity (per pipeline / all), campaign report download, quick replies, labels, tags, pipelines, custom fields, segments | `pnpm import:sanoflow` imports **contacts only** | **P0** (cut-over blocker) |
| G2 | Flow triggers | `new_message_received`, `whatsapp_flow`, `messaging_window_exit`, drip on segment | 14 triggers incl. appointment events and AI tag; drip FK exists on segments; no message-received, window-exit or WhatsApp-Flow trigger | P1 |
| G3 | Flow nodes | `update_enquiry_field`, `create_campaign`, payment link node, Meta event node, AI intent router, appointment / enquiry agents, set label | 20 node types; payment links and CAPI exist as integrations but not as nodes; no enquiry-update node; no AI router (copilots are draft-only by design) | P1 (router: P2, must stay inside CLAUDE.md rule 12) |
| G4 | Question node | validation (number, choice, regex), re-ask, store answer, request contact info | no answer validation; "does not re-ask" is a known gap in docs/09 §2.3 | P1 |
| G5 | Teams and routing | team auto-reply message, fallback team, per-user max open chats, restricted enquiry view, presence auto-away after N minutes | round-robin and teams exist; none of the five listed | P1 |
| G6 | Booking capacity | service pre/post buffer, concurrent patients, specialist slot length, multiple bookings per slot, ShowBusy, recurring blocks | per-specialist advisory lock, overrides; no buffers or per-slot capacity | P1 (wrong slots once Unite is the source of truth are expensive) |
| G7 | Google Calendar | two-way per specialist | read-only ICS feed (Phase 19a) | P2 |
| G8 | Templates | performance report, retry-on-fail, per-template SMS fallback, TTL, carousel, URL-button mappers, gallery | builder, gallery, sync, positional variables; no performance, carousel, TTL or per-template retry | P2 |
| G9 | Campaigns | 3 retry rounds, recurring (cron), CSV audience, test send, quota meter | single snapshot audience, no recurring, no A/B (docs/09) | P2 |
| G10 | Inbox close-with-enquiry | one dialog closes the chat and writes the enquiry (stage, status, lost reason, UTM) | close dialog with category and summary; enquiry is a separate action | P2 |
| G11 | Inbox extras | forward message / contact, unlink chat from contact, catalogue products, employee call | failed log, AI panel, quick replies, shortcut flows exist; forward and unlink to check | P3 |
| G12 | Channels | Instagram, Messenger, web chat widget, generic SMS, MM Lite | WhatsApp Cloud API; SMS fallback adapter; Instagram/Messenger still open (19, item 6); no widget; no MM Lite | P2 (widget), P3 (rest) |
| G13 | Reports | first/last-assign-to-close, AI engaged / closed by AI, user status log, cohort, template rates, Meta ads spend metrics | report registry, funnel, heatmap, ROI, CTWA, WhatsApp cost; check the listed metrics one by one | P2 |
| G14 | Lead-gen forms, booking page, payment-required booking | plan-gated in Sanoflow, not used by Al Das | not built | P3 |
| — | Billing, plans, Gupshup, Salla, non-Unite HMS | SaaS-only | out of scope (single tenant) | skip |

## 5. Recommended order

1. **20a Migration completeness (G1).** Without it the clinic loses open enquiries, future appointments and tagging on cut-over day.
2. **20b Flow parity (G2, G3, G4).** Al Das automations currently call Make through API Action; after Make is retired those become native nodes.
3. **20c Routing and booking capacity (G5, G6).**
4. **20d Templates and campaigns (G8, G9, G10).**
5. **20e Reports and channels (G12, G13, G7).**

Prompts: `docs/21_SANOFLOW_PARITY_PROMPTS.md`.

## 6. Response shapes (the data model) — captured 13 Oct

`docs/audit/sanoflow-rea-shapes.json` holds the JSON response shapes of 125 Sanoflow data endpoints: 78 with full field paths and types (1,173 fields), 30 that rejected the call without a record id (their `required_params` name the record key), 8 that need a record context (500/403). It was captured from the owner's logged-in browser with read-only GETs (no mutation, AI, export, sync or payment endpoints; at most 3 records per list), and every response was reduced to field paths and types **inside the browser**: no values, names, numbers or message text left the page. Sanoflow's own SaaS billing endpoints are left out.

What the shapes confirm or add to §4:

- **G5 routing (confirmed):** teams carry `auto_assign`, `auto_reply`, `auto_reply_msg`, `fallback_team`, `pipeline_id`, `org_channel_id`, `is_default`; users carry `max_assigned_chats`, `restrict_enquiry_view`, `restrict_inbox_view`, `default_inbox_view`, `is_agent`; the org has an inactivity value (`qUserInactive`).
- **G6 booking (confirmed):** services carry `apptduration`, `prebuffer`, `postbuffer`, `concurentpatients`, `enableonline`, `requiredpayment`, `price`, `currency`; specialists carry `timeslotduration`, `enable_multiple_bookings`, `max_bookings_per_slot`, `showbusy`, per-location weekly schedules, Arabic name fields and Google Calendar sync fields (`calendar_id`, sync token, webhook id).
- **Inbox list row** (`OCInbox/ChatQueue`): what one conversation row needs: assignee, team, label + colour, tags, unread count, `is_bot`, `open_chat_window`, `last_inbound_datetime`, `phone_stop_marketing`, language, timezone, nationality, contact-owner agent/team. Use it to check Pulse's inbox query returns the same.
- **Notifications:** per user and per event, four channels (`email_notif`, `browser_notif`, `sms_notif`, `whatsapp_notif`) in four groups (appointments, enquiries, inbox, other), plus sound settings. Pulse has in-app, e-mail and push; SMS/WhatsApp-to-staff is a new row (P3).
- **Roles:** a permission matrix per rule with `view_rec`, `manage_rec`, `delete_rec`, `export_rec`. Compare with Pulse's `can()` keys when mapping roles in 20a.
- **Dynamic segments:** the stored filter is a JSON object keyed by field (`tag_array`, `dob`, `gender`, `birthday` with conditions, `last_interaction_time`, `nationality_id`) with `filterType`/`type`/`dateFrom`/`dateTo`/`values`. The 20a segment report can translate these into Pulse's filter AST instead of listing them for manual rebuild.
- **Templates:** Meta template components stored as returned by Meta, plus Sanoflow's mapper fields (`all_mappers`, `mapper`, `header_mapper`, `button_mapper`, `button_mapper2`, `mapper_missing`) and a carousel card field.
- **Campaigns:** daily conversation limit per channel (`current_limit`, `max_daily_conversations_per_business`), monthly campaign quota (`limit_given`/`limit_used`), retry fields (`is_retry`, `retry_count`, `next_retry_time`), recurring (`cron`, `recurring_period`, `next_run_time`).
- **Security lesson:** Sanoflow returns channel access tokens and users' password-reset tokens to the browser. Pulse must keep doing the opposite (CLAUDE.md rules 9 and 17).

### Re-running it

`tools/rea-sanoflow.mjs` runs REA (`github.com/saveezirfan0-cloud/rea`, v6.4.0) on a computer: it opens a separate Chrome, waits for you to log in, and records value-free JSON shapes per screen with `rea inspect-web-page --include-json-body-shapes` and `rea analyze-web-bundle`. Use it to fill the 38 endpoints above that need a record id (open one record per screen while it runs). Keep its `raw/` folder outside the repo and delete it afterwards.
