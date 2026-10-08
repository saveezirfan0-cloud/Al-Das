# Sanoflow Teardown & Feasibility Report

**Purpose:** a functional audit of Sanoflow (app.sanoflow.io), explored live on 8 Oct 2026 in the Al Das Medical Clinic workspace, plus a feasibility verdict on rebuilding an equivalent product with a native WhatsApp Business Platform (Meta Cloud API) integration.

> **Scope note.** The rebuild should match Sanoflow *functionally* (features, workflows, data model, UX patterns). It should use its own brand, name, logo, illustrations, copy and template library. Don't copy Sanoflow's assets, recommended-template text, or front-end code. Everything below describes behaviour, not source.

> **Data note.** This workspace holds live patient data. None of it (names, phones, chat content) is reproduced here, and none of it should be used as seed or test data.

---

## 1. Verdict (TL;DR)

| Area | Replicable? | Effort | Risk |
|---|---|---|---|
| CRM core (contacts, segments, custom fields, tags, import/export) | ✅ Yes | Medium | Low |
| Enquiries (multi-pipeline Kanban + table, stages, SLA, custom views) | ✅ Yes | Medium | Low |
| Appointments (locations → departments → services → specialists, calendar, reminders) | ✅ Yes | Medium–High | Low (FullCalendar resource view needs a paid licence, or use an alternative) |
| Tasks | ✅ Yes | Low | Low |
| Omnichannel Inbox (WhatsApp, FB Messenger, Instagram, web chat, SMS) | ✅ Yes | High | **Medium**: Meta App Review + Tech Provider onboarding |
| WhatsApp templates (create/submit/sync/status, media, carousel) | ✅ Yes | Medium | Low |
| Campaigns / broadcasts (segment or CSV, schedule, delivery analytics, retries) | ✅ Yes | Medium | Medium (rate limits, quality rating, opt-outs) |
| Flow builder (visual, 26 node types, 10 trigger types) | ✅ Yes | **High** | Medium (execution engine correctness) |
| AI (summaries, suggested reply, rewrite/translate, AI agents, knowledge base) | ✅ Yes | Medium–High | Medium (hallucination in a medical context) |
| Reports (~25 reports incl. CTWA ads, Meta ads insights) | ✅ Yes | Medium | Low–Medium (Ads API access) |
| Forms (lead-gen) and Payment Links | ✅ Yes | Low–Medium | Low |
| Integrations marketplace (HMS/EMR, payments, Salla, Google Calendar, CallGear, webhooks, API keys) | ⚠️ Partially | Each one is its own project | HMS APIs vary; some are closed or partner-only |
| Multi-org workspaces, roles, teams, round-robin, presence | ✅ Yes | Medium | Low |

**Overall: feasible.** Nothing in Sanoflow depends on private Meta capabilities. Everything sits on the public WhatsApp Business Platform (Cloud API + Business Management API + Embedded Signup), the Messenger/Instagram Platform, and standard SaaS patterns.

**The long pole is Meta onboarding, not code.** You need Business Verification, an approved Meta App with advanced access to the right permissions, and Tech Provider (or Solution Partner) status before you can onboard *client* numbers through Embedded Signup. Start that on day 1, in parallel with the build. Lead time is typically weeks.

**Realistic MVP:** about 10–12 weeks for one senior builder working with Claude Code, covering Inbox + WhatsApp + Contacts + Enquiries + Appointments + Templates + Campaigns + a v1 Flow engine + basic reports. Full parity is about 6–9 months.

---

## 2. Sanoflow tech stack (observed from the page)

| Layer | What Sanoflow uses | Implication for the rebuild |
|---|---|---|
| App framework | **Wappler** (low-code; `dmxAppConnect` components), server-rendered pages, Bootstrap 5, jQuery | A modern Next.js/React rebuild will be faster and more maintainable |
| Backend | Node.js (Wappler Server Connect). REST endpoints under `/api/<Module>/<action>` | Mirror the domain split, not the naming |
| Realtime | **Socket.io** (`/socket.io/`) | Socket.io or Supabase Realtime for the inbox, presence and typing |
| Calendar | **FullCalendar** (resource/day/week/month views) | Resource view = FullCalendar Premium licence, or build on an open alternative |
| Flow builder canvas | **JointJS**, plus jQuery QueryBuilder for conditions, a JSON editor, cron (quartz) builder | Use **React Flow (xyflow)** + a custom condition builder |
| Grids | **AG Grid** (column show/hide, widths, filters, pagination) | TanStack Table (free) or AG Grid Community |
| Rich text | Tiptap | Tiptap |
| Charts | Chart.js + ApexCharts | Recharts / ECharts |
| Uploads | S3 direct upload, Dropzone | S3 / Supabase Storage with presigned URLs |
| Push notifications | WonderPush (web push) | Web Push (VAPID) or OneSignal |
| Meta | Facebook JS SDK loaded on every page (Embedded Signup / FB Login for Business) | Same |
| Analytics | GA4 | Optional |
| BSP | Native Cloud API **and** Gupshup (separate channel type + "sync Gupshup templates") | MVP: native Cloud API only. Gupshup is optional later |

---

## 3. Information architecture

**Left nav:** Dashboard · Appointments · Contacts · Enquiries · Tasks · Inbox · Campaigns · Templates · Flows · Reports · Forms · Payments · *(workspace switcher)* · Settings

**Top bar:** help, notification bell (count badge, alert list with read status), avatar menu (online/away/offline status, logout).

**Multi-tenancy:** one user can belong to several organizations ("workspaces") and switch between them; there's an invite-accept flow.

### 3.1 Dashboard
- Team filter (All Teams / specific team).
- Widgets: **Open Tasks** (count + list), **Open Enquiries** (paged table: name, date, channel, assigned to, created by, stage), **Team Members** (filter by team and status Online/Away/Offline), **Conversations** chart (Open / Assigned / Unassigned), **Daily Enquiries** (last 30 days).

### 3.2 Appointments
- **Three views:**
  1. Resource day view: specialists as columns with avatars, working hours shaded.
  2. Week/Day/Month calendar for a single specialist.
  3. Table view: search, filter, column chooser, export (current/all), pagination.
- Filters: specialist, location.
- Table columns: Contact (+ID, link to profile), Phone, Channel, Status, Location, Specialist, Service, Notes, External ID.
- **New Appointment drawer:**
  - Tabs: *Single Appointment* and *Block Time Period* (block a specialist's calendar).
  - Fields: Contact (search, or "Add New Contact"), Location*, Specialist*, Service*, Date*, Start time* (slot list generated from availability), End time.
  - Options: "Notify contact via WhatsApp / Email", "Notify contact on early availability" (a waitlist flag), Notes.
- Status change with optional SMS/Email notification. Activity log per appointment.
- Statuses seen include Cancelled, Confirmed and Awaiting.

### 3.3 Contacts (≈38.7k records in this workspace)
- **Views:** All, Last interacted < 7 days, < 30 days, > 30 days, Mentions.
- **Segments:**
  - **Static** (manual lists with counts).
  - **Dynamic** (saved filter queries). Can be attached to a **drip flow** ("drip-shortcut-flow", "manage-flow").
- **Grid:** Name, Gender, Nationality, Tags, plus a configurable column set. Bulk select → bulk edit, bulk delete, add to segment.
- **Import/Export:** CSV import and export (current or all).
- **Filter builder:** grouped, with an **Exclusion Filters** toggle.
  - *Contacts:* Name, Gender, Nationality, Tags, Country, Phone, Email, Date of Birth, Birthday, Created Date, Created By, External ID, Stop marketing, Next due task, Source.
  - *Inbox:* Last interaction date, Channel name, Channel type, Conversation status, **AI Tags**.
  - *Enquiries:* Tags, Stage, Status, Lost reason, Est. value, Created/Closed date, Created by, Channel, Location, Specialist, Service, Source, Count of enquiries.
  - *Appointments:* Date, Status, Location, Specialist, Service, Department, Created date/by, Notify-on-early-availability, Notes.
  - *Payments:* Created date, Amount, Payment status, Transaction time.
- **Contact Details drawer:**
  - Left side:
    - Header with avatar, channel badge (WhatsApp + unread count), delete action and **Add Tag**.
    - Fields: First*, Last*, Label, Phone (country picker), **Promotions Opt-In** checkbox, Alternate contacts (multiple phones), Email, Nationality, Gender, Language, DOB, Contact Owner, Assignee, Source (e.g. Inbox, Webhook-WhatsApp), External ID, plus custom fields.
  - Right-side tabs:
    - **Task & Notes:** tasks list + Add Task, a **History** timeline (system events like "Conversation assigned to X by System", "Chat closed by Y"), and a comment box.
    - **Inbox:** this contact's chats.
    - **Enquiries**, **Appointments**, **Campaigns:** the campaigns this contact received.
  - Duplicate handling: **merge contacts** (merge suggestions).

### 3.4 Enquiries (leads/cases)
- **Multiple pipelines** in a left rail, each with its own stages. This clinic models operational queues as pipelines: reception, awaiting patient, doctor liaison, escalation, insurance review, medical records, pharmacy, ready-to-close.
- Views: **Kanban** (stage columns with counts, "Add Enquiry" per column, cards showing name, ID, phone, date, source, created by) and **Table**.
- Toolbar: search, filter, **Open/Closed** status switch, column chooser, import/export (incl. activity export), **custom views** (saved, shareable with teams), per-pipeline card-field show/hide.
- **Enquiry drawer:**
  - Header: title, ID, tag, **Stage dropdown**, **Status dropdown** (Open / Won / Lost / Disqualified with lost reason), delete.
  - **Enquiry Details:** name, phone, location/specialist/service/appointment date/department (editable together), assigned to, estimated value, source, plus custom fields.
  - **Pipeline:** "Move To" another pipeline.
  - Meta: created date/by.
  - **Contact Details** block (linked contact, unlink/relink).
  - Tabs: Task & Notes (tasks, history, comments) and Inbox.
- Bulk edit, bulk delete and disqualify.

### 3.5 Tasks
- Filter (Assigned to me / all…), search by name.
- Add Task fields: Type*, Date-time*, Subject, Assign To, Contact, Notes, "Mark as done".

### 3.6 Inbox (`/chat-inbox`)
- **Folders:** Open, My Inbox, Assigned to Me, **Assigned to ChatBot**, Unassigned, Waiting for Customer, Unread, Mentions, Closed.
- **Teams:** a queue per team.
- **Failed Messages Log.**
- Custom saved inbox views (shareable with teams). Filter panel. Status dropdown (Open/Closed…). Sort (Newest/Oldest). Search. "+" to start a new outbound conversation (template-first when outside the 24h window).
- **List items:** avatar with channel badge, name or phone, last-message preview, time, unread badge, and **coloured labels** (e.g. booked / closed / appointment request).
- **Thread:** contact-name link, **Close** button + dropdown (close with category/summary, reassign…), message bubbles with ticks (sent/delivered/read), media/documents, timestamps.
- **Composer:**
  - **Chat** vs **Comment** (internal note with @mentions).
  - **Channel selector** (which WhatsApp number or page sends).
  - **Summarize** (AI conversation summary).
  - `/` quick responses (saved replies, with add/delete).
  - Emoji, attachments, text formatting, voice note recording.
  - **AI panel:** "Ask AI…" free prompt, *Generate Suggested Reply*, actions *Change Tone*, *Change Language*, *Fix Spelling & Grammar*. Has thumbs-up/down feedback that feeds the knowledge base.
  - **Template picker** (WhatsApp templates with variable mapping).
  - **Flow shortcut:** runs a "Shortcut"-triggered flow on this contact and hands the conversation to the bot.
  - Also seen in the endpoints: **send catalogue products**, **send payment link**, **forward message**, **forward contacts**, typing indicator, **initiate employee call**, and **agent takeover from chatbot**.
- **Right sidebar tabs:** Contact Details (editable), Shared Media, Merge Suggestions, Enquiries (create from chat), Appointments (book from chat).
- **Workspace inbox settings:**
  - Conversation categories (optionally required on close).
  - Summary required on close (toggle).
  - Auto-remove labels after N hrs.
  - Auto-close conversations after N hrs.
  - Email alert for unread assigned conversations (15 min – 3 hrs).
  - "Show agent name in messages".
  - Saved replies, labels, tags.
- **Assignment:** round-robin routing ("RunRoundRobin"), team assignment, and user presence status.

### 3.7 Campaigns (broadcasts)
- **List:** ID, name, status (Scheduled, Queued, Sent…), channel, created, completed, scheduled time, delete. Filter and search. **Manage Templates** shortcut.
- **New Campaign:**
  - **Monthly campaign-message quota meter** (e.g. "3,905 of 20,000 used"), tied to the billing plan.
  - Fields: Name*, Channel*.
  - **Audience:** Select Segment *or* Upload File (CSV).
  - Message Template* (or create one inline).
  - Type: Send Immediately / Scheduled.
  - **Advanced:** automatic retry of failed messages (plan-gated; endpoints show up to 3 retry rounds).
  - **Test Template** (send to yourself), Start Campaign.
  - Live **phone preview**.
- **Campaign detail:** channel, created by, template, schedule, total, **Download Report**, status.
- **Recipients tab:** funnel KPIs (Total, Sent, Delivered, Read, Replied, Failed, as % and counts) and a per-recipient table with status.
- Scheduled campaigns have editable cron and play/stop controls.

### 3.8 Templates (WhatsApp Message Templates)
- Filter by WhatsApp channel (WABA number) and status, plus search.
- **Statuses** (mirrors Meta): Approved, Archived, Created, Disabled, Flagged, In Appeal, Limit Exceeded, Locked, Paused, Pending, Reinstated, Pending Deletion, Rejected, Submitted.
- **Columns:** title (name + language), message preview, category (MARKETING / UTILITY / AUTHENTICATION), status pill, updated. Row actions: edit, **variable mapping** (map `{{1}}` to contact fields), duplicate, delete.
- **Sync Templates** pulls from Meta. Gupshup sync is separate.
- **Template gallery** ("Choose WhatsApp Template"): categories (Recommended, Utility), filters by industry, language and use case, preview, then Next. Or **Start from Scratch**.
- **Builder fields:** Name*, Category*, Language* (EN/AR seen), Channel*, Template Type* (**Standard text**, **Media & Interactive**, **Carousel**), Body with B/I/S/code formatting, `@` to insert dynamic variables. Live phone preview.
- **Per-template settings:** SMS fallback, retry-on-fail, performance analytics, unarchive.

### 3.9 Flows (automation / chatbot)
- **List:** name, Type (Workflow), Trigger, Channel/Pipeline, Triggered counters (✅ success / ⚠️ failed / ⏳ waiting), Status (Draft / Paused / Active), duplicate, delete, logs.
- Workspace-level **Variables** (enable/disable, add).
- **Trigger types:**
  - Conversation Opened, Conversation Closed, Conversation Waiting
  - WhatsApp Template (button reply on a template)
  - Shortcut (manual, from the inbox)
  - Enquiry Added, Enquiry Stage Updated, Enquiry Status Updated
  - Incoming Webhook
  - Recurring (cron: daily/weekly/monthly/yearly with nth-weekday options)
- **Trigger conditions:** AND/OR groups. Categories: Source, Keyword, Ad (CTWA ad ID). Operators: equals, not equals, contains, not contains. Source values include channels, Google Ads, website, booking page, call center, etc.
- **Node palette (26):**
  - **Messaging:** Message, Question (with button/list options and fallback), Quick Reply, Template, Send AI Message
  - **Logic:** Branch, Wait, Office Hours Check (Inside/Outside), Run Flow, End Flow
  - **Conversation:** Assign To (user/team/bot), Close Conversation, Add Comment
  - **CRM:** Update Contact Field, Create Enquiry, Update Enquiry Field, Add Task
  - **Integrations:** **API Action** (GET/POST/PUT/… to any URL. This clinic calls Make.com webhooks), Send Notification, Payment Link, **Send Meta Event** (Conversions API)
  - **AI:** Support Agent, AI Agents, Appointment Agent, Enquiry Agent
- **Canvas:** zoom, undo/redo, Edit vs view mode, a properties panel per node, fallback edges, and Logs (`/flow/log/:id`).
- **WhatsApp Flows** (Meta's native forms) are listed through the API (`workflow/whatsapp-flows`) and reported on.

### 3.10 Reports
- **Dashboard:** Conversations Dashboard (KPIs: all conversations, unique contacts, returning contacts, open, closed; stacked bar by channel per day; donut by channel), Click-to-Chat Ads Dashboard (plan-gated), Agent Performance Dashboard, Appointments Dashboard, Enquiries Dashboard, AI Agent Dashboard.
- **Enquiries:** Enquiry Analytics, ROI Report, Stage Heatmap, Average Time per Stage, Funnel, Closing vs Creation, Cohort Analysis, Enquiry→Appointment Conversion.
- **Chats:** Conversation Analytics, Conversations Matrix, Response Performance, Conversation Heatmap, Agent Performance, Click-to-Chat Ads, WhatsApp Flows, WhatsApp Account Usage, User Logs, User Status Logs, Meta Ads Insights.
- **Appointments:** Appointment Analytics, Online Appointments by Status.
- Shared filters: period presets and channel.

### 3.11 Forms (plan-gated)
- A list of lead-generation forms (name, type "Lead Generation"). Embeddable on landing pages. Submissions create contacts/enquiries.

### 3.12 Payments → Payment Links (plan-gated)
- **Table:** contact, date, product/service, amount + currency (USD/SAR seen), channel/provider (Stripe), reference (Stripe `plink_…`), status.
- Links are created from the inbox or a flow node and sent in chat. Payment status comes back by webhook.

### 3.13 Settings
- **Account:** profile (name, email, designation, timezone, language), password, notification preferences.
- **Company:**
  - **Organization**
  - **Billing:** plan, add-ons, billing info, payment method, history. Usage meters for users, workflows and campaign messages.
  - **Users:** invite, team, role, active toggle, suspended state.
  - **Roles:** Admin, Manager, Agent, Receptionist, custom roles with descriptions.
  - **Teams.**
  - **Integrations**, **Knowledge Base**.
- **Knowledge Base:** source files/URLs (crawl status "Ready"), source groups (scoping which KB an agent uses), and feedback (from thumbs up/down in the inbox).
- **Platform → Enquiries:** open-enquiry SLA (None–8 hrs), enquiry notification rules, pipelines and stages, enquiry channels, **assignment rules**, custom fields.
- **Platform → Inbox:** see §3.6.
- **Platform → Appointments:**
  - **Locations** (photo, timezone) → **Departments** → **Services** → **Specialists** (photo, title, department, multiple locations, working hours).
  - **Booking rules:**
    - Three reminders, each "relative to appointment time, N hrs before".
    - Lead time (days/hrs/min), reschedule window, minutes-before-reschedule, minutes-before-cancel.
    - Auto-confirm toggle. Google Calendar sync.
  - **SMS & WhatsApp templates** used for booking/reminder notifications.

### 3.14 Integrations marketplace
| Category | Items |
|---|---|
| Messaging | **WhatsApp Cloud API**, **WhatsApp Business App Coexistence**, WhatsApp via Gupshup, Facebook (Messenger), Instagram (DMs), Chat Widget, SMS |
| HMS / EMR | Practo, Mediware, Unite, Tablet 10, Clinicorp, Simplex, Feegow |
| Payments | ClickPay, Stripe, Stone, InfinitePay |
| eCommerce | Salla |
| Other | Google Calendar, CallGear (telephony), API Key (generates access tokens for the public API), outbound **Webhooks** (event subscriptions) |

**WhatsApp channel "Manage" panel:**
- *Configuration:* channel name, number, **messaging limit tier** (e.g. 10K customers/24h) + **quality rating** (High), **Marketing Messages (MM Lite) eligibility check**.
- *Profile:* WABA profile photo, about, address, email, vertical, websites, description.
- *Catalogue:* Meta catalog ID for product messages.
- *Troubleshoot:* re-auth "Fix" via Embedded Signup, Meta help link.
- Disconnect and Remove actions.

---

## 4. WhatsApp & Meta feasibility, feature by feature

Everything Sanoflow does with WhatsApp maps to public Meta APIs:

| Sanoflow feature | Meta API / mechanism | Feasible? | Notes |
|---|---|---|---|
| Connect a client's number in a few clicks | **Embedded Signup** (FB JS SDK, `FB.login` with `config_id`, then exchange the code for a business token) | ✅ | Requires **Tech Provider** status + App Review. Subscribe your app to the WABA (`POST /{waba_id}/subscribed_apps`), register the number (`POST /{phone_id}/register`) |
| Keep using the WhatsApp Business *app* on the same number | **Coexistence** (Embedded Signup with the coexistence flow) | ✅ | Gives history sync + `smb_message_echoes` / `smb_app_state_sync` webhooks so phone-sent messages appear in the inbox. Some features are limited on coexistence numbers. Check current Meta docs |
| Send/receive text, media, location, contacts, reactions, stickers | Cloud API `POST /{phone_number_id}/messages`, `messages` webhook | ✅ | Media download via `GET /{media_id}`. Upload via `/media` |
| Interactive buttons / lists (Question node, Quick Reply) | `interactive` type `button` / `list` | ✅ | Max 3 reply buttons and 10 list rows. Design the Question node around those limits |
| Templates CRUD + status | WABA Management API `/{waba_id}/message_templates`, `message_template_status_update` + `template_category_update` + quality webhooks | ✅ | Map all Meta statuses (see §3.8) |
| Media & Interactive / Carousel templates | Template components: header (image/video/document), buttons (quick reply, URL, phone, copy-code, flow), carousel cards | ✅ | |
| 24-hour customer-service window | Logic in your app based on the last inbound message timestamp | ✅ | Outside the window, the composer must force a template |
| Delivery ticks, failed log | `statuses` webhook (sent, delivered, read, failed + error codes) | ✅ | Powers the campaign funnel and the Failed Messages Log |
| Campaigns at scale | Cloud API throughput (default ~80 mps per number, higher on request) + **messaging limit tiers** | ✅ | Needs a queue with per-number rate limiting and handling of 131048/131056/130429-type errors. Respect opt-out ("Stop marketing", Promotions Opt-In) |
| MM Lite eligibility | **Marketing Messages API** (`/marketing_messages` endpoint, same billing model) | ✅ | Route marketing campaigns through it when the WABA is onboarded |
| Messaging limit + quality on the channel card | `GET /{phone_number_id}?fields=quality_rating,messaging_limit_tier…`, `phone_number_quality_update` webhook | ✅ | |
| WABA business profile tab | `/{phone_number_id}/whatsapp_business_profile` | ✅ | |
| Catalogue / product messages | Commerce catalog linked to the WABA; `interactive` `product` / `product_list` | ✅ | |
| WhatsApp Flows (native forms) | Flows API (create/publish JSON flows, data-exchange endpoint, encryption keys) | ✅ | Optional for the MVP |
| Click-to-WhatsApp ads attribution + "Ad" trigger condition | `referral` object on the first inbound message (ad ID, headline, `ctwa_clid`) | ✅ | Ads dashboards also need the **Marketing API** (`ads_read`) |
| "Send Meta Event" node | **Conversions API** (business-messaging events using `ctwa_clid`) | ✅ | Closes the ad loop (Lead / Purchase) |
| Voice calls from the inbox ("initiate call") | **WhatsApp Business Calling API** (`calls` webhook, WebRTC or SIP) | ✅ (Phase 3) | User-initiated calls wherever Cloud API is available. Business-initiated calls are blocked in some countries (US, CA, EG, VN, NG). The UAE should be checked against Meta's supported list |
| Messenger + Instagram DMs | Messenger Platform + Instagram Messaging API (Page tokens, `messages` webhooks) | ✅ | Separate permissions (`pages_messaging`, `instagram_manage_messages`) |
| Pricing/usage report | Since July 2025 Meta bills per delivered template message (by category + country). Service replies are free; utility templates inside an open service window are free. Pull analytics via `/{waba_id}?fields=pricing_analytics` | ✅ | The "WhatsApp Account Usage" report |
| Gupshup channel | Gupshup partner API | Optional | Only needed for clients already on Gupshup |

### Meta onboarding checklist (start immediately)
1. A Meta Business Portfolio for *your* company. Complete **Business Verification**.
2. Create a Meta App (type: Business). Add the products WhatsApp, Facebook Login for Business, Messenger, Instagram, Webhooks and Marketing API.
3. Request **advanced access** via App Review:
   - WhatsApp: `whatsapp_business_management`, `whatsapp_business_messaging`
   - Messenger/Instagram: `pages_messaging`, `pages_manage_metadata`, `pages_show_list`, `instagram_basic`, `instagram_manage_messages`
   - Business: `business_management`
   - Ads (for the reports): `ads_read`
   - Record screencasts of each use case for the review.
4. Become a **Tech Provider** (direct, or via a Solution Partner if you want them to handle credit lines/billing). Configure **Embedded Signup** (a Facebook Login for Business configuration ID with WhatsApp Embedded Signup).
5. Set up an HTTPS webhook endpoint with a verify token and **validate `X-Hub-Signature-256`** on every webhook.
6. Billing: decide whether clients attach their own payment method to their WABA (simplest) or you resell via a partner credit line.

---

## 5. Key risks & mitigations

| Risk | Mitigation |
|---|---|
| Meta App Review / Tech Provider delays | Start on day 1. Build against a test WABA + test number from the Meta developer dashboard meanwhile |
| Healthcare data (UAE PDPL; DoH Abu Dhabi / DHA Dubai health-data rules; possibly a hosting-in-region requirement) | Host in a UAE/ME region if required. Encrypt PHI columns, keep audit logs, enforce role-based access, set a retention policy, and sign a DPA with clients. Get a local compliance opinion before go-live |
| AI agents giving medical advice | Hard guardrails in agent system prompts (no diagnosis, escalate to a human), KB-grounded answers only, human-handoff node, logging + feedback loop |
| Campaign quality-rating drops → number restricted | Enforce opt-in, frequency caps, auto-pause campaigns when quality goes to Medium/Low or the failure rate spikes |
| Flow engine bugs (double sends, stuck waits) | An idempotent step executor on a durable queue, a per-conversation lock, a per-run execution log (like Sanoflow's ✅ ⚠️ ⏳ counters) |
| HMS/EMR integrations (Unite, Practo…) | Out of MVP scope. Ship generic **Incoming Webhook trigger + API Action node + public API + outbound webhooks** first, which is how this clinic already bridges to its EMR via Make.com |
| FullCalendar resource view licence | Buy FullCalendar Premium, or build the day/resource grid yourself |

---

## 6. Observed API surface (for reference, renamed in the rebuild)

Grouped by domain, to show the size of the backend:

- **Common/lookup:** user-info, all-teams, all-pipelines, locations, categories, labels-and-tags, statuses, payment-methods, enquiry-setting, widget-details, user status + presence, round-robin, alerts, workspace change, invite accept, workflow variables.
- **Appointments:** time-slots, slot-end, specialist/location lists, all/one appointment, specialist calendar, confirm time, edit status (+SMS/email notify), activity list/edit, export (table/all), column prefs.
- **Contacts:** add/edit, custom fields, column prefs, export, static/dynamic segments (create/manage/remove member/attach drip flow), contact details (enquiries, appointments, tasks, campaigns, system notes, history), bulk update/delete, merge suggestions/merge.
- **Enquiries:** list, update stage/status/pipeline, disqualify, bulk edit/delete, custom views (manage/share/delete), pipeline card fields, export (+activity), CSV import, details edit, location-specialist-service edit, custom fields.
- **Tasks:** list, add/edit, delete.
- **Inbox:** all conversations, queue, patient chats, channel list, map/unmap chat to contact, update status, typing indicator, forward message/contacts, message sources, catalogue products, payment providers, shortcut flow (list/trigger), agent takeover from bot, canned messages, views (add/edit/share/delete), employee call, AI (suggestion, ask, actions, summary, languages), KB feedback.
- **Campaigns:** list, new details, audience contacts, test template, start, schedule play/stop, cron edit, recipients (+details), retry rounds 1–3, add recipient segment, delete.
- **Templates:** channels, WhatsApp templates, master/gallery templates, add/edit, variable mapper, sync (Meta/Gupshup/all), performance, SMS fallback, retry-on-fail, archive/unarchive, delete.
- **Workflows:** list, add/edit, duplicate, delete, status, flow templates, WhatsApp Flows, variables, channel settings, logs.
- **Reports:** common data, dashboard, enquiries, chats, appointments, ad accounts, ads.
- **Settings:** profile, notifications, org, billing, users/roles/teams, integrations, KB, platform settings (enquiries, inbox, appointments).

---

### Sources (WhatsApp/Meta research)
- [Meta: WhatsApp Business Calling API](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling)
- [Meta: Marketing Messages API overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/marketing-messages/overview)
- [Meta: Marketing Messages changelog](https://developers.facebook.com/documentation/business-messaging/whatsapp/marketing-messages/changelog)
- [360dialog: Conversations / pricing docs](https://docs.360dialog.com/partner/messaging/sending-and-receiving-messages/conversations)
- [Chakra: WhatsApp Coexistence explained (2026)](https://articles.chakrahq.com/article/whatsapp-business-app-api-coexistence-202)
- [Chakra: Calling API guide 2026](https://chakrahq.com/article/whatsapp-cloud-api-calling-feature-details/amp/)
