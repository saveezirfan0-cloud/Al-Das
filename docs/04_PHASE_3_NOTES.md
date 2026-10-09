# Phase 3 — WhatsApp + Inbox: what was built and how to use it

## Scope delivered

- **Migrations** (`supabase/migrations`, applied after Phase 1's six): 7. `contacts_core` — the slice of the Phase 2 CRM the inbox needs: `contacts` (BSUID + E.164, unique per org, soft delete), `contact_phones`, `tags` (scope contact / conversation / enquiry), `contact_tags`. Phase 2 adds custom fields, segments and timeline events in its own migrations. 8. `channels` — `channels` (one row per `phone_number_id`), `channel_secrets` (encrypted System User token, service role only), `channel_send_slots` + `claim_send_slot()` (atomic per-number, per-second rate limit), `webhook_events_in` (raw Meta posts), `wa_templates` (mirror of the WABA's templates; the Phase 4 builder edits these rows). 9. `inbox` — `conversations` (one live conversation per contact per number), `messages` (unique `wa_message_id`, forward-only status trigger + `apply_message_status()`), `conversation_labels`, `quick_replies`, `conv_categories`, `inbox_views`, `mentions`, `pick_round_robin_assignee()`, visibility helper `app.can_view_conversation()`, realtime publication, the private `wa-media` bucket, and the `pulse:inbox_housekeeping` cron.
- **`lib/whatsapp`** — `client.ts` (typed Cloud API: text/media/interactive/template/reaction/location/contacts, mark-read + typing, media upload/info/download, business profile, phone fields, `subscribed_apps`, templates CRUD, paging), `webhook-types.ts` + `parse.ts` (Zod parsers → flat typed events, BSUID/`user_id` handling, CTWA referral), `errors.ts` (Meta error map → retryable / stop-marketing / template-required), `window.ts` (24h + 72h CTWA free entry), `status.ts` (ladder mirror), `templates.ts` (variables, preview, send payload), `signature.ts` (HMAC), `phone.ts`, `channel.ts` (token resolution, client factory), `sync.ts` (phone fields + templates mirror). `lib/crypto.ts` is AES-256-GCM with `ENCRYPTION_KEY`.
- **Ingress + jobs** — `POST /api/webhooks/meta` verifies `X-Hub-Signature-256` over the raw body, stores the payload in `webhook_events_in`, `pgmq.send('meta_events')`, returns 200 (GET answers the verify challenge). Handlers: `meta_events` (inbound → contact match → conversation → message → routing; statuses; template status/category/quality; phone quality; account; `user_id_update`; business username), `media_fetch` (Meta → Storage `<org>/<conversation>/<message>.<ext>`), `outbound` / `outbound_priority` (window guard, send slot, agent-name prefix, media upload, template build, error map; 131050 sets `stop_marketing`). `inbox_housekeeping` (every 5 min via pg_cron → `/api/jobs/inbox_housekeeping`) auto-closes idle conversations, drops old labels, emails/notifies assignees about unread conversations and re-queues webhook rows that never reached the queue.
- **Domain events** — `lib/events/emit.ts` (`conversation.opened/closed/waiting/assigned`, `message.received/sent/failed`, `contact.created/stop_marketing`, `channel.quality_changed`, `template.status_changed`). Phase 5/8 attach flow triggers and outbound webhooks as listeners.
- **Settings → Channels** — add a number by `phone_number_id` + WABA ID (+ optional token, encrypted; otherwise `META_SYSTEM_USER_TOKEN`), probe Meta, subscribe the app to the WABA, sync templates; cards show quality, tier, verified name, profile, catalogue id, rate limit, token source, webhook subscription; dialogs edit the channel (name, catalogue, msg/s, pause, token) and the business profile (saved to Meta).
- **Settings → Inbox** — routing team + round-robin, require category/summary on close, auto-close hours, auto-remove labels hours, unread email alert (15–180 min), show agent name, move-to-waiting-on-reply; close categories, labels (colours), quick replies (`/shortcut`, `{contact.first_name}` variables).
- **Inbox** (`/inbox`, RLS-scoped: `inbox.view_all` sees everything, others see own/team/unassigned):
  - Folders (Open, My inbox, Assigned to me, Assigned to bot, Unassigned, Waiting, Unread, Mentions, Closed) with counts, team queues, saved views (private / teams / everyone), search (name, profile name, phone), filters (status, number, label, assignee), newest/oldest sort, “+” new conversation.
  - List: avatar + channel badge, unread count, labels, waiting/closed chips, assignee.
  - Thread: day separators, bubbles with ticks (queued/sent/delivered/read/failed + retry), quoted replies, media (signed URLs), templates, internal notes, CTWA banner, 24h-window countdown.
  - Composer: Chat / Comment (notes with `@` mentions → `mentions` rows + notifications), number selector (switches the contact to another number), `/` quick replies, emoji, attachments (direct-to-Storage signed upload), voice notes (MediaRecorder; ogg/opus or mp4 as audio, webm as document), template picker with variable inputs, defaults from `variable_map` and a phone-style preview; the composer forces templates outside the 24h window.
  - Close with category/summary (rules from settings), assign user/team, round-robin auto-assign, Waiting/Open, hand to bot / take over, labels.
  - Right sidebar: editable contact (contacts.manage), shared media, merge suggestions (same name / same alternate phone) with one-click merge, other conversations, placeholders for Create enquiry (Phase 5) and Book appointment (Phase 6).
  - `/inbox/failed`: Failed Messages log with error category and retry (hidden for window/opt-out failures).
  - Realtime: Supabase `postgres_changes` on `conversations`, `messages` (open thread) and `mentions` refresh the server-rendered data; opening a conversation clears unread and sends blue ticks.
- **`scripts/wa-simulate.ts`** + 31 fixtures in `scripts/wa-fixtures/` (every message type, statuses incl. 131047/131050, template status/category/quality, phone quality, account update, user_id_update, business username, a mixed batch). Signs and posts to `/api/webhooks/meta`.
- **Tests** — 54 new unit tests (parsers over every fixture, client against a mocked fetch, error map, window, status ladder, templates, crypto, signature, phone, folders, settings, mentions, send specs, media paths, events) and 10 DB tests (tenant isolation on every Phase 3 table, service-role-only tables, agent visibility by assignment, write denial, mention privacy, cross-org triggers, one-live-conversation index, status ladder, send slots, round-robin).

## Local happy path

```bash
pnpm db:reset                      # migrations + seed (fake channel 100000000000001, two contacts)
pnpm dev
# .env.local: META_APP_SECRET=anything-local, META_WEBHOOK_VERIFY_TOKEN=anything, ENCRYPTION_KEY=$(openssl rand -base64 32)
pnpm wa:simulate message-text      # → 200 {ok:true,id:…}
pnpm jobs:run meta_events          # inbound lands in /inbox (Open → "Test Patient")
pnpm wa:simulate message-image && pnpm jobs:run meta_events && pnpm jobs:run media_fetch   # media_fetch needs a real token to download
pnpm wa:simulate status-read --from 971500000001
```

Replies from the composer are queued on `outbound_priority`; drain with `pnpm jobs:run outbound_priority`. Without a real Meta token the send fails with a mapped error and shows up in the Failed Messages log, which is the expected offline behaviour.

## Going live with a real number

1. Env: `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `META_SYSTEM_USER_TOKEN` (permanent System User token with `whatsapp_business_management` + `whatsapp_business_messaging`), `ENCRYPTION_KEY`.
2. Meta app → WhatsApp → Configuration: callback URL `${APP_URL}/api/webhooks/meta`, verify token = `META_WEBHOOK_VERIFY_TOKEN`; subscribe the fields listed on Settings → Channels.
3. Settings → Channels → Add number (phone_number_id + WABA ID). The app subscribes itself to the WABA and mirrors the templates. Migrating from Sanoflow: remove their app from the WABA first, one number at a time, out of hours (docs/02 §5.9).
4. Supabase Storage: the `wa-media` bucket is created by the migration; confirm it exists on hosted projects (Storage → Buckets).

## Decisions and assumptions

- Phase 2 (Contacts) had not been built, so this phase ships the **contacts core** the inbox depends on (`contacts`, `contact_phones`, `tags`, `contact_tags`). Phase 2 extends it; nothing here needs to change.
- **BSUID handling:** `contacts.user_id` from the webhook is stored as `wa_bsuid`; `from`/`wa_id` that is not a possible phone number is treated as a BSUID. `user_id_update` rotates it. Replies to username users go to the BSUID as the recipient. Meta's exact payload shape for username users is still evolving; the parser is permissive (`passthrough`) and keeps the raw message.
- **Visibility:** RLS decides what a member sees; the app never widens it. All inbox writes are server actions with `can()` checks and the service role.
- **Rate limit:** `send_rate_per_sec` per channel (default 20) enforced in SQL; saturated sends are re-queued one second later rather than failed.
- **Tokens:** a channel without `channel_secrets` uses `META_SYSTEM_USER_TOKEN`. Tokens are never returned to the browser; the UI only shows “stored on channel” / “from environment”.
- **Mark-read / typing:** blue ticks are sent when an agent opens a conversation with unread messages (best effort).
- **Voice notes:** Chrome records WebM, which WhatsApp does not accept as audio; those are sent as documents and the agent is told. Firefox/Safari produce ogg/mp4 and are sent as voice notes.
- **Create enquiry / Book appointment** in the sidebar are disabled placeholders until Phases 5 and 6.
- **Shortcut flows, AI assist, catalogue/payment sends, calls** are later phases (8, 10, P2/P3).

## Demo checklist

- [ ] Settings → Channels shows the seeded dev number with GREEN / TIER_1K; “Add number” validates ids and reports Meta errors.
- [ ] `pnpm wa:simulate message-text` + `pnpm jobs:run meta_events` → the conversation appears in Open/Unread with an unread badge; opening it clears the badge.
- [ ] Reply → bubble shows a clock, then (with a token) single/double/blue ticks as statuses arrive (`status-sent`, `status-delivered`, `status-read` fixtures).
- [ ] `status-failed-stop-marketing` → the contact shows “Stop marketing”; the template picker hides MARKETING templates for them.
- [ ] Composer outside the 24h window (seeded “Sample Visitor”) blocks free text and offers the template picker; the preview fills `{{1}}` from the contact.
- [ ] Comment with `@` → the mentioned colleague gets a bell notification and the Mentions folder count.
- [ ] Close with category/summary → Closed folder; a new inbound (`message-text --from 971500000001`) reopens it.
- [ ] Assign → Auto-assign (round-robin) picks an online Front desk member; Settings → Inbox routes new conversations to that team.
- [ ] `/inbox/failed` lists the seeded 131047 failure without a retry button; a transient failure shows Retry.
- [ ] Agent role (no `inbox.view_all`) sees only own/team/unassigned conversations in every folder and in realtime.

## Open questions / follow-ups

- Hosted Supabase: confirm the `wa-media` bucket policies apply after `supabase db push` (storage schema present) — on a plain Postgres the block is skipped by design.
- Meta's username (BSUID) webhook contract: validate against a real username user once one writes in; adjust `resolveIdentity` if `from` carries something other than the BSUID.
- Coexistence numbers (`smb_message_echoes`, `history`) are parsed as `unknown` events and logged; wiring them is a Phase 2 roadmap item.
- Presence inactivity timeout (Phase 1 follow-up) still pending; round-robin relies on members setting Away/Offline.
