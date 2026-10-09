# Phase 7 — Campaigns: what was built and how to use it

## Scope delivered

- **Migration** `20261008001000_campaigns.sql`
  - `campaigns` (status machine, schedule, retry rounds, guardrails, stored funnel) and `campaign_recipients` (the audience snapshot and per-recipient state: `pending → queued → sent → delivered → read`, `failed`, `skipped` + reason, timestamps, `replied_at`, `csv_data`). Both have RLS (`campaigns.view` reads; every write is a server action with `can()` and the service role) and org-consistency triggers.
  - `conversations.campaign_only`: a campaign send lands in a normal conversation (`waiting`) that stays **hidden from every inbox folder until the patient replies**; the first inbound clears the flag, routes it (team + round-robin) and opens it like a new conversation.
  - Trigger `messages → campaign_recipients` mirrors message status onto the recipient (forward only, latest message only). Trigger `mark_campaign_replied`: a patient message within 7 days of a campaign message in the same conversation sets `replied_at` (reactions do not count).
  - RPCs (service role only): `campaign_snapshot_segment`, `campaign_add_csv_rows`, `campaign_dispatch` (batched: conversation + queued template message + recipient update in one transaction, `SKIP LOCKED` so a replayed job never double-sends), `campaign_requeue_failed`, `campaign_funnel`, `job_enqueue_batch`, plus `pulse:campaign_tick` (cron, every 30 s).
- **`lib/campaigns`** — pure and unit-tested: `recipients.ts` (consent rules, CSV audience parser), `variables.ts` (`contact.*`, `custom.*`, `csv.*`, `text:` sources, fallbacks, Meta-safe sanitising), `guardrails.ts`, `funnel.ts` (percentages + CSV report), `constants.ts` (limits, status helpers, tier limits). Server side: `engine.ts` (lifecycle, fanout, stats, retry rounds, outbound guard), `audience.ts`, `queries.ts`.
- **Jobs** — `campaign_fanout` queue handler (ops `fanout`, `stats`, `start`, and the scheduler kinds `campaign.start` / `campaign.retry_round`) and the `campaign_tick` task. `outbound` now withdraws campaign messages whose campaign was paused/cancelled or whose contact opted out after dispatch.
- **UI**
  - `/campaigns`: list (status filter, search, progress, auto-refresh while anything is running) and a right-side **detail drawer** (`?c=<id>`): funnel tiles (Total / Sent / Delivered / Read / Replied / Failed), **Details** (number, template, audience, schedule, retries, safety, variable mapping) and **Recipients** (filter chips, per-recipient table, **Download report** CSV via `/api/campaigns/[id]/report`). Controls: Start now, Reschedule, Pause, Resume, Cancel, Delete.
  - `/campaigns/new`: name, number, template (approved ones for that number's WABA), audience = segment or CSV, **variable mapping with live phone preview**, send now / schedule (workspace timezone), retry rounds (0–3, delay), safety checks, **test send**.
  - `components/phone-preview` is now shared with the inbox template picker. The contact drawer's **Campaigns** tab lists the campaigns a contact was part of.

## How a campaign runs

1. **Create** (server action, `campaigns.create`): validates number/template/mapping, builds the audience **snapshot** in SQL (segment predicate from `lib/filters`, or CSV rows matched to contacts by primary/alternate phone), classifies each recipient (`pending` or `skipped` + reason), refuses empty/oversize audiences (max 50,000), then either enqueues `start` or schedules `campaign.start` in `scheduled_jobs`.
2. **Fanout** (`campaign_fanout`, drained every 30 s by cron): re-checks consent per recipient, resolves variables, dispatches in batches of 200 via `campaign_dispatch`, and pushes the new message ids to the `outbound` queue in bulk. It stops after 40 s and re-enqueues itself. Back-pressure: at most 400 queued-but-unsent messages per campaign (reminders and flows share `outbound`), and sending stays below 90 % of the number's 24-hour tier limit (waits 10 minutes, then tries again).
3. **Send**: the normal `outbound` handler — per-number send slots, template build, Meta error map (131050 sets `stop_marketing`). Statuses arrive through the existing webhook path and update recipients via the trigger.
4. **Tick** (`campaign_tick`, every 30 s): one `stats` op per live campaign refreshes the stored funnel, evaluates guardrails, re-pushes messages stuck in `queued` for 10 minutes, restarts a stalled fanout, and — when nothing is left in flight — either schedules the next retry round or completes the campaign. Completed campaigns keep refreshing for 3 days so late read receipts land.
5. **Retry rounds**: after `retry_delay_minutes`, `campaign.retry_round` re-queues recipients whose error is _retryable_ per `lib/whatsapp/errors.ts` (rate limits, Meta 5xx…). Opt-outs, invalid numbers and window errors are never retried.

## Guardrails (auto-pause, team notified, manual resume)

Counted over outcomes since the campaign started or was last resumed:

| Rule                                                         | Default                      |
| ------------------------------------------------------------ | ---------------------------- |
| Systemic failures (not the recipient's fault) share of sends | ≥ 15 % after 50 outcomes     |
| All failures share (bad list)                                | ≥ 40 % after 50 outcomes     |
| Auth/account errors (token, permission, WABA state)          | 3 failures, no sample needed |
| Number quality rating below where it was at start (or RED)   | on                           |
| Number paused/disconnected, template no longer APPROVED      | always                       |

The creator can change the first percentage and the quality rule in _Safety checks_. Pausing withdraws messages already queued (they go back to `pending`); resuming re-dispatches them.

## Consent and compliance

- **MARKETING** templates reach only contacts with `promotions_opt_in = true` and `stop_marketing = false`; other categories only need a phone or BSUID. Checked at snapshot time and again right before dispatch and right before sending. Unknown/blank data is skipped (fail closed). A SQL function mirrors `classifyRecipient()`; a DB test keeps them in step.
- **CSV audiences**: numbers already in Contacts keep their own consent record. Unknown numbers become new contacts (`source = campaign_csv`) only for non-marketing templates, or after the creator ticks _I confirm everyone in this file agreed to receive marketing messages_ (stored as `promotions_opt_in`, recorded on the campaign). Create/start/cancel/delete/report download/test send are written to `audit_log` (no phone numbers or message text).
- No patient data in fixtures: tests use fake numbers and names only. The report CSV contains name + phone and is gated by `campaigns.view`.

## Local happy path

```bash
pnpm db:reset && pnpm dev          # seeded fake channel; add an APPROVED template (Settings → Channels → sync, or insert one)
# Contacts → create a segment of opted-in contacts (promotions_opt_in) → Campaigns → New campaign
pnpm jobs:run campaign_fanout      # start + fanout (the form enqueues 'start')
pnpm jobs:run outbound             # offline this fails with a mapped error; recipients show as failed
pnpm jobs:run campaign_tick        # refreshes stats / completion (the tick enqueues 'stats' ops)
pnpm jobs:run campaign_fanout      # drains the stats ops
# status fixtures (status-sent / -delivered / -read / -failed) move the recipient whose message has the fixture's wa_message_id
# (set it on a campaign message in SQL to try them); pnpm wa:simulate message-text --from <phone> marks Replied
```

Tests: `pnpm test` (28 new unit tests), `pnpm test:db` (RLS, dispatch, snapshots, status sync, replies, retry re-queue, funnel). The engine tests (`tests/db/campaign-engine.test.ts`: fanout, consent re-check, auto-pause, completion, retry rounds, outbound guard, cancel) run when PostgREST is up in front of the test database (`supabase/test/README.md`).

## Decisions and assumptions

- **Audience is frozen at start**, also for scheduled campaigns (counts are exact and visible immediately). Consent is re-checked at send time, so a later opt-out is still honoured.
- **Hidden conversation** (`campaign_only`) instead of flooding Open/Waiting with thousands of rows; campaign failures are excluded from `/inbox/failed` (they have their own report).
- **Replied** = any non-reaction inbound within 7 days of the last campaign message in that conversation.
- **Quota meter**: there is no billing plan here, so the new-campaign header shows campaign messages sent this month; the real ceiling is Meta's tier limit, which the form and the fanout respect.
- Retry rounds start only when nothing is queued or pending; failures of an earlier round stay visible in the recipient's last error until re-sent.
- `serverActions.bodySizeLimit` is raised to 16 MB in `next.config.ts` for CSV audiences.
- Generated DB types were updated by hand (no Supabase CLI in the build environment); run `pnpm gen:types` once against a migrated database to replace them.

## Demo checklist

- [ ] New campaign → pick number + approved template; the variable table lists `{{n}}`; mapping `contact.first_name` fills the phone preview with the first eligible recipient.
- [ ] MARKETING template: contacts without opt-in or with _Stop marketing_ appear under "skipped" in the audience check and as _Skipped_ recipients; Start is disabled when nobody is eligible.
- [ ] CSV with an invalid row, a duplicate and an extra column: counts and ignored rows are shown; the extra column is offered as a variable source.
- [ ] Schedule for later → status _Scheduled_; Reschedule and _Start now_ work; Cancel skips every unsent recipient.
- [ ] Start → drain `campaign_fanout` + `outbound`; funnel tiles move with `status-*` fixtures; a `message-text` reply makes the recipient _Replied_ and opens a routed conversation in the inbox.
- [ ] Force failures (`status-failed` fixtures with a transient code) → campaign auto-pauses with a reason and a bell notification; Resume continues.
- [ ] Retry rounds: failures with a retryable code are re-sent after the delay; opt-out failures are not.
- [ ] Download report → CSV with one row per recipient; the contact drawer's Campaigns tab lists the campaign.
- [ ] A user with `campaigns.view` but not `campaigns.create` sees lists, drawers and reports but no controls; a user without `campaigns.view` gets no data (RLS).

## Open questions / follow-ups

- The UI was type-checked, linted and built but not clicked through in a browser in this environment (no Supabase Auth stack); walk the demo checklist locally.
- Per-recipient personalised media headers, carousel templates and A/B variants are not part of the MVP.
- Recurring (cron) campaigns, mentioned in the Sanoflow teardown, are not built; the engine runs one audience snapshot per campaign. Phase 8 recall programmes cover the recurring clinical cases.
- Reports (Phase 9) should read `campaign_recipients` directly; `mv_campaign_funnel` can aggregate `campaigns.stats`.
