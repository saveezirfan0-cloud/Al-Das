# Phase 20d: templates, campaigns, close-with-enquiry (G8, G9, G10, template rates of G13)

Closes the parity rows in `docs/20_SANOFLOW_REA_PARITY.md` §4 for templates (G8), campaigns (G9, recurring and the
monthly cap only), the inbox close-with-enquiry dialog (G10) and the template delivery/read/click rates of G13.
Retry rounds, CSV audience and test send were already built (re-checked) and are unchanged.

## What exists

### Templates (G8)

- **Delivery settings per template** (Templates, row menu, Delivery settings; `templates.manage`, audited as
  `template.delivery_updated`, written with `createAdminClient(member.userId)` so record history names the person):
  - **Retry on fail** wires the old `wa_templates.retry_on_fail`. A NON-campaign template message that fails with a
    retryable Meta code (the same list the campaign retry rounds use, `retryableErrorCodes()`) is copied and queued
    again after 10 minutes, then 1 hour (at most 2 retries per chain, `TEMPLATE_RETRY_DELAYS_SECONDS`). Rules are pure
    in `lib/templates/delivery.ts` (`templateRetryDecision`); the work is `lib/templates/retry.ts`
    (`maybeRetryTemplateMessage`), called from a `message.failed` listener in `lib/jobs/handlers/outbound.ts` (outbound
    job and status webhook both emit it). Appointment reminders and waiting-list offers are never retried (the visit
    or slot may change during the delay; a failed reminder keeps its call task and SMS fallback). Idempotent: the copy carries
    `messages.retry_of_message_id` (partial unique index), so a second caller gets `exists`. The copy goes through
    `queueOutbound` on the bulk lane with a durable pgmq delay, so every send-time guard runs again (training,
    opt-out, window, rate limit, TTL). Campaign messages are never retried here (they have retry rounds).
  - **SMS fallback switch**, `wa_templates.sms_fallback` (default **true**, so the Phase 19 reminder fallback behaves
    exactly as before until someone turns it off). It can only narrow the existing Phase 19a path:
    `queueSmsFallback()` now looks up the template of the failed message (or, when the reminder never became a
    message, the reminder template mapped in Settings, Appointments) and returns `skipped:template_off` when
    `smsFallbackAllowed()` says no. A MARKETING template (or an unknown category) never falls back, whatever the switch
    says; the action refuses to save the switch on for marketing. `smsDecision` is unchanged and still runs; no new
    SMS wording, no marketing SMS.
  - **Time limit (TTL)**, `wa_templates.ttl_seconds` (60 s to 30 days, null = none). The outbound job fails a template
    message that is older than the limit when it reaches it (code `-2`, Pulse-internal, `TTL_EXPIRED_CODE`), before a
    send slot is taken, and emits `message.failed` so a reminder still produces its call task. A retry chain counts
    from the first queueing (`payload.retry.origin_at`), and a retry is not even queued if it would leave after the
    limit.
- **Carousel sending.** `templateVariables()` now lists each card's variables as `card.N.header.media`,
  `card.N.body.M` and `card.N.button.K` (URL suffix), and `buildTemplateSend()` builds the Cloud API `carousel`
  component (one entry per card: header media, body params, buttons by index; quick-reply buttons get a fixed
  `card<i>_btn<j>` payload). Standard templates produce exactly the same payload as before (unit test). The phone
  preview substitutes card text. `resolveHeaderMedia()` / `checkMediaReferences()` handle every header slot, so a
  Media Library file (`media:<id>`) per card becomes its own one-hour signed link at send time. Carousels are no
  longer refused by campaigns (form and server).
- **Variable map UI.** The Map variables dialog shows what each non-text key is (header image, end of a button link,
  card N) and offers the Media Library for every header slot, cards included. The inbox template picker does the same
  for card headers; the inbox media-access check covers every slot.
- **Performance.** `public.report_template_performance(org, from, to, channels?, template?)` over the new view
  `v_template_message_facts` (ids, statuses, times only): messages, sent, delivered, read (cumulative like the
  campaign funnel), replied (an inbound message in the same conversation within 24 h), clicked (quick-reply taps
  answering that message), failed, still sending, retries, from campaigns. Shown per template from the row menu
  (Performance, date range) and as the registry report **Template performance** (`/reports/template-performance`,
  group WhatsApp, channel filter). Shaping is pure (`lib/templates/performance.ts`).
- `media_asset_usage()` now finds a library file in any key of a template mapping (card headers) and in an active
  recurring campaign's mapping (reported as kind `campaign`, name `Recurring: …`), so the delete block covers both.

### Campaigns (G9)

- **Recurring campaigns** (`campaign_recurrences`): New campaign, When and how, **Repeat**, with presets, a cron field,
  a plain-language summary (`describeCron`) and the next three runs (`upcomingRuns`) in the workspace timezone.
  Segment audiences only (an uploaded list cannot change between runs). At most one run a day
  (`checkRecurrenceSchedule`). List, play/pause and delete under Campaigns, **Recurring** (`/campaigns/recurring`,
  `campaigns.view` to see, `campaigns.create` to change; every change audited `campaign_recurrence.*`).
- **How a run works** (`lib/campaigns/recurring.ts`): a `scheduled_jobs` row `campaign.recurrence` (deduped per run)
  routed to `campaign_fanout`, plus a safety net in `campaign_tick` for runs whose job was lost. Each run re-reads
  the series (paused, deleted or rescheduled series ignore stale jobs), re-checks the guardrails
  (`recurrenceRunDecision`: number active, template approved / not archived / same WABA, segment exists, quality not
  red, library files usable, previous run not still sending, budget not used up), then claims the run atomically in
  SQL (`campaign_recurrence_claim`: moves `next_run_at` from this run to the next, creates the run's ordinary
  campaign with `recurrence_id` + `run_key`, unique per run). The audience is snapshotted from the segment at that
  moment and the campaign starts through the normal engine (consent re-check per recipient, retry rounds,
  guardrails, budget). A skipped run is recorded on the series (`last_run_outcome = skipped:<reason>`) and notifies
  the creator (except "previous run still sending"); the next run is always scheduled. Missed runs are not caught
  up: a late run schedules the next one from now.
- **Monthly message budget** (`orgs.settings.campaign_budget.monthly_limit`, set by `settings.manage` from the meter on
  Campaigns / Recurring, audited `campaign_budget.updated`). The fanout claims room BEFORE `campaign_dispatch`
  (`campaign_budget_claim`, row-locked per org and month in the org timezone, so concurrent fanouts cannot pass it);
  what is not granted stays pending and the campaign pauses with `BUDGET_PAUSE_REASON` (owners notified like any
  auto-pause); room claimed for recipients skipped at dispatch is refunded. No limit = counted only. A stored limit
  that is not a whole number fails closed (0). Counted: campaign messages (each retry round dispatch counts). Not
  counted: test sends, inbox, reminders, flows, retry-on-fail copies.

### Inbox close-with-enquiry (G10)

- The close dialog gains an **Enquiry** section for people with `enquiries.manage`: leave enquiries as they are, create
  one for the patient (pipeline, stage, title, status, reason, requested appointment date), or update one of the
  patient's open enquiries (stage, status, reason, appointment date). Lost / disqualified need a reason: the Settings,
  Enquiries `lost_reasons` pick-list as buttons, free text allowed.
- Server: `app/(app)/inbox/close-actions.ts` (`requirePerm("enquiries.manage")`, conversation visible through RLS with
  `inbox.send`, `contacts.view` to link a new enquiry) calls `closeWithEnquiry()` (`lib/inbox/close.ts`): validates
  first (pure `validateCloseEnquiry`: the enquiry must belong to the same patient, stage in the pipeline, reasons),
  writes the enquiry through the existing service functions (`createEnquiry`, `moveStage`, `updateEnquiry`,
  `setStatus`, which keep their own audit rows, history, timeline and events), then closes the conversation
  (`closeConversationRecord`, shared with the plain close) and writes one `conversation.closed_with_enquiry` audit
  row (ids, step names, category; never the summary). If the enquiry part fails, the conversation stays open.
- UTM: not part of this dialog (Pulse keeps attribution on the enquiry source / ad referral already).

### Files

- Migrations: `20261027000100_phase20d_template_delivery.sql`, `20261027000200_phase20d_recurring_campaigns_budget.sql`.
- New: `lib/templates/{delivery,retry,performance}.ts`, `lib/reports/template-performance.ts`,
  `lib/campaigns/{recurrence,recurring,budget}.ts`, `lib/inbox/{close,close-enquiry}.ts`,
  `app/(app)/templates/{delivery-dialog,performance-dialog}.tsx`, `app/(app)/campaigns/budget-meter.tsx`,
  `app/(app)/campaigns/recurring/{page,actions,recurrence-controls}.tsx|ts`, `app/(app)/inbox/close-actions.ts`.

## How it was verified

- `pnpm exec tsc --noEmit -p .` clean; eslint clean on every changed file; `pnpm audit:security`: 0 unguarded.
- Unit (`tests/unit/phase20d-*.test.ts`): carousel variables, payload and preview; card media resolution; retry
  eligibility (switch, campaign, codes, chain limit, TTL); TTL guard; SMS-fallback eligibility (marketing and unknown
  refused); performance shaping; cron summary, next run (Dubai, month/year ends, DST gap), once-a-day rule, run
  guardrails; budget grant split, meter, settings fail-closed; close-with-enquiry schema, validation and call order.
- DB, plain Postgres (`tests/db/phase20d.test.ts`): RLS on both new tables (own org with `campaigns.view` only, no
  write policy, functions not executable by browser roles); recurring audience drift across runs, one campaign per
  run, stale/paused/skipped runs; budget hard stop including 4 connections racing; template performance numbers,
  filters and org isolation; one retry per message; media usage for card headers and recurring campaigns.
- DB through PostgREST (`tests/db/phase20d-service.test.ts`, run locally with PostgREST 12.2.3 in front of the test
  database): `runRecurrence` end to end, budget pause inside `runFanout`, `maybeRetryTemplateMessage` chain and
  idempotency (pgmq delay checked), the TTL guard in `deliverOutbound`, the SMS fallback template switch through
  `queueSmsFallback`, and the close-with-enquiry audit trail (`enquiry.created`, `enquiry.status_changed`,
  `enquiry.stage_changed`, `conversation.closed_with_enquiry`, timeline) plus refusals that leave the conversation
  open. The whole `tests/db` suite (62 files) and the full unit suite pass on the same machine.

## What was NOT verified / not built

- **Meta template analytics** (Graph `template_analytics`) are not called: the numbers are Pulse's own messages and
  status webhooks. Link-button clicks are not reported by WhatsApp webhooks, so "clicks" are quick-reply taps only.
- **Meta's own template TTL** (a template-level setting in the management API, reported for authentication and later
  for utility/marketing templates) is NOT set or sent: its field and limits are not in the codebase or verified
  docs. Pulse stores `ttl_seconds` and enforces it in the outbound job only; a message Meta has already accepted is
  not recalled.
- **Carousel send payload** follows the Cloud API documentation (cards with `card_index`, header/body/button
  parameters); not verified against a live WABA. Quick-reply payloads on cards are included (harmless if optional).
  The builder still refuses variables in card text (synced templates with card variables are mapped and sent).
- No UI or browser test was run for the new dialogs and pages (no e2e for 20d); they were type-checked and linted.
- The new server action `closeConversationWithEnquiry` delegates every write (and its audit row) to
  `lib/inbox/close.ts`, so the static audit lists it as a non-mutating, guarded entry point.
- A/B tests (G9) were out of scope.

## Decisions

- SMS fallback switch defaults to on: turning a default-off column on for every existing template would silently stop
  the Phase 19 reminder fallback. It only ever narrows; marketing never falls back.
- Retry-on-fail is bounded at two retries (10 min, 1 h) on the bulk lane; campaigns keep their own rounds; a reminder
  follows its retry (the reminder row is re-pointed to the copy) and is only failed (call task, SMS) when retries are
  used up or not allowed.
- Recurring campaigns: segment audience only, at most once a day, a run is skipped (not queued) while the previous run
  is still sending, and missed runs are not caught up. Each run is an ordinary campaign, so history, funnel, report
  and the campaign drawer work unchanged.
- Budget: per calendar month in the org timezone, claimed before dispatch, `settings.manage` sets it. Exceeding it
  pauses (does not cancel) the campaign.
- Close-with-enquiry writes the enquiry before closing, so a refused enquiry never leaves a closed conversation behind.
