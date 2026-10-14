# Phase 20g: ShowBusy (G6) and campaign A/B tests (G9)

Closes the two gaps left in `docs/20_SANOFLOW_REA_PARITY.md` §4: ShowBusy in row G6 (booking capacity, docs/25) and
A/B tests in row G9 (campaigns, docs/26). Both are small and stay on the existing engines.

## What exists

### ShowBusy (G6)

| Where                                  | What                                                                                                                                                                                                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orgs.settings.appointments.show_busy` | New booking setting, **default off**. Settings, Appointments, Booking rules: "Show taken times" (saved by the existing `saveBookingRules`, `settings.manage`, audited as `appointments.rules_updated`). No migration: it is a key in the existing settings JSON. |
| `lib/appointments/slots.ts`            | `BusyInterval.kind` (`booking` / `block`, display only), `slotTakenReason(candidate, busy)` and `generateSlots(input, { includeTaken })`. A taken slot is exactly one that `slotFits` refuses; it is listed with `taken: 'booked'                                | 'blocked' | 'full'`. `slotFits`and`app.slot_conflict` are unchanged. |
| `lib/appointments/availability.ts`     | `loadBusyContext` tags bookings and one-off blocks (weekly blocks are tagged by `expandRecurringBlocks`). `slotsForDay(admin, q, { includeTaken })`.                                                                                                             |
| `getFreeSlots` (appointments actions)  | New optional `includeTaken`. Taken slots are returned only when the caller asks **and** the org's `show_busy` is on. Only the booking drawer asks; the move dialogs and the front desk get exactly what they got before.                                         |
| Booking drawer                         | Taken times appear greyed out and disabled, with the reason under the time (`aria-label` "10:00, Booked"). A pre-clicked start is kept only when it is free.                                                                                                     |

Reasons: `blocked` when a one-off or weekly block is in the way (SQL also says `blocked`, and checks blocks first);
`full` when the smallest number of places involved is above 1 (a group slot with every place taken); otherwise
`booked`. SQL reports both `booked` and `full` as `full`. Closed days, holidays, the lead time, the past and times
outside working hours are never listed.

### Campaign A/B tests (G9)

| Where                                         | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `campaign_ab_variants` (new)                  | Version B of a one-off campaign: `template_id` (another approved template, or the same one), its own `variable_map` and `fallbacks`, `split_pct` (1 to 99, the share that gets B). One per campaign (unique `campaign_id`, cascade), template `on delete restrict`, org-consistency triggers. A guard trigger refuses any update and refuses an insert once the campaign has recipients. RLS: select with `campaigns.view`; no write policy (the `createCampaign` action writes it with the service role). |
| `campaign_recipients.variant` (new, nullable) | `a` / `b` for an A/B campaign, null otherwise (existing rows stay null). Set by a BEFORE INSERT trigger from `app.campaign_ab_bucket(campaign, contact)` (first 32 bits of md5 of `campaign:contact`, mod 100) `< split_pct`; a caller-supplied value is ignored. Changing it raises. So a retry round (`campaign_requeue_failed`), a resumed fanout or a repeated snapshot (`on conflict do nothing`) never flips anyone.                                                                                 |
| `public.campaign_ab_funnel(campaign)` (new)   | Service role only. `{a: {...}, b: {...}}` with total, eligible, pending, queued, sent, delivered, read (cumulative like `campaign_funnel`), replied, clicked (a quick-reply `button` message answering the recipient's `wa_message_id`, as in `report_template_performance`), failed, skipped.                                                                                                                                                                                                             |
| `media_asset_usage()`                         | Redefined from the 20d definition; a library file in a variant B mapping counts for its campaign (same kind `campaign`, same delete block).                                                                                                                                                                                                                                                                                                                                                                |
| `lib/campaigns/ab.ts` (pure)                  | `settingsForVariant` (a `b` recipient without a version B is skipped `variant_missing`, never sent A), `variantProblem` (same category as A, split 1 to 99, must differ from A), `parseAbFunnel`, `abRows`.                                                                                                                                                                                                                                                                                                |
| `lib/campaigns/engine.ts`                     | `loadCampaign` embeds `campaign_ab_variants(..., wa_templates(...))`. `runFanout` reads `variant` and resolves each recipient with its version's template, mapping and fallbacks; everything else (consent re-check by the category of the recipient’s own version, in-flight cap, tier limit, budget claim before `campaign_dispatch`, outbound guard, retry rounds) is the same code path. Guardrails pause the campaign when either version's template is not approved.                                 |
| `createCampaign` (campaigns actions)          | Optional `variant_b` (Zod: template id, maps, `split_pct` int 1 to 99). Still `requirePerm("campaigns.create")`. B goes through the same checks as A (`loadSendContext`: approved, not archived, same WhatsApp account; `mappingError`; `checkMediaReferences`) plus `variantProblem`. The variant row is inserted before the audience snapshot; on failure the campaign is deleted. The `campaign.created` audit row gains `ab: {template_id, split_pct}`.                                                |
| New campaign form                             | Card "A/B test" (hidden for Repeat): switch, version B template (same number and category; "same as A" allowed), share for B, then a second variable-mapping card for B (the mapping card is now one renderer used twice). The preview has Version A / Version B buttons and the test send sends the version shown.                                                                                                                                                                                        |
| Campaign drawer                               | "A/B test" table under the funnel: Sent, Delivered, Read, Replied, Clicked, Failed for A and B, each as % of that version's eligible recipients, plus version B's variables in Details.                                                                                                                                                                                                                                                                                                                    |

## Decisions

- **ShowBusy is an org booking setting**, not per specialist: it lives in the existing `appointments` settings JSON,
  needs no migration and no new UI beyond one switch. It only changes what the drawer displays; booking, the SQL
  re-check and the override are untouched.
- **The rule stays one rule.** `slotTakenReason` first calls `slotFits`; the reason is derived afterwards. The 20c
  parity sweep (`tests/db/booking-capacity.test.ts`) now also compares the reason with `app.slot_conflict`.
- **Assignment is in SQL, stored, and immutable.** Computing the variant at dispatch time would also be deterministic,
  but storing it makes the funnel a plain `group by` and makes "never flips" enforceable by a trigger.
- **Version B must have A's category when it is created** (action and form), because the audience snapshot is
  decided by A's category. A category can still change later (Meta's `template_category` webhook updates
  `wa_templates.category`), so the dispatch-time consent check (`classifyRecipient`) and the send-time opt-out guard
  (`guardCampaignMessage`) use the category of the template **that recipient gets**: a B recategorised to MARKETING
  on a UTILITY A skips B recipients without an opt-in (`no_opt_in`) and withdraws B messages to people who opted out.
  A B recipient whose version cannot be read is treated as marketing in the guard (fail closed). Version B's template
  name in the drawer is read with the service role after RLS let the member read the campaign.
- **A separate table, not columns on `campaigns`.** A second FK from `campaigns` to `wa_templates` would make every
  existing `campaigns → wa_templates(...)` embed ambiguous in PostgREST. `campaign_ab_variants` has its own id as the
  key, so PostgREST sees no many-to-many path; the service test runs the list, drawer and guard embeds through
  PostgREST to prove it.
- **Recurring campaigns ignore variants**: `createRecurringCampaign` has no `variant_b`, `campaign_recurrence_claim`
  creates plain campaigns, and the form hides the A/B card in Repeat mode.
- **No "send the winner to the rest"** (not required). The split is final once the audience exists.
- **Clicked** is quick-reply taps only (WhatsApp reports no URL-button clicks), as in the 20d template performance.
- The CSV "Download report" is unchanged (no variant column); the drawer table is the A vs B report.

## How it was verified

Test database `pulse_g6` (fresh from `scripts/test-db.sh` plus the new migration); PostgREST 12 on 3321 with
`supabase/test/rest-proxy.mjs` on 3320 for the service suite (both stopped afterwards).

- `tests/unit/sf20g-showbusy.test.ts` (12): off = old list exactly (default and `includeTaken:false`, no `taken` key),
  the free part of the ShowBusy list equals the old list, `isSlotAvailable` unchanged; reasons booked / blocked
  (one-off and weekly) / full, block wins, one-place service next to a group booking, buffers; `slotTakenReason` is
  null exactly when `slotFits` is true; holidays, closed days, lead time never listed; `show_busy` defaults off.
- `tests/unit/sf20g-ab.test.ts` (10): version picking (fails closed), `variantProblem`, funnel parsing and side-by-side
  rows.
- `tests/db/sf20g-ab.test.ts` (13, plain Postgres): RLS (own org with `campaigns.view`, no Agent, no other org, no
  direct writes, cross-org template refused); 300 recipients split 30% land in B exactly when the bucket is below the
  split (about 30%), caller values ignored; no flip after a repeated insert, a requeue or a direct update; another
  campaign reshuffles; the real `campaign_snapshot_segment` assigns too; plain campaigns stay null; guards (split
  range, one per campaign, no update, no variant after the audience, template delete blocked, cascade); the A/B funnel
  with replies and a quick-reply click (a quoted text reply is not a click); browser roles cannot call it; media
  usage and the delete block for a version B header file.
- `tests/db/sf20g-service.test.ts` (6, through PostgREST and the real `runFanout`): B recipients get B's template and
  mapping, A recipients A's; a retry round re-sends the same version; same-template variant with another mapping; a
  non-approved B template pauses the campaign; A UTILITY with B recategorised to MARKETING skips every B recipient
  without opt-in as `no_opt_in` while A recipients are queued, and the outbound guard withdraws a B message (not an A
  one) for a contact with `stop_marketing`; `listCampaigns`, `getCampaignDetail` (A/B numbers) and
  `guardCampaignMessage` still resolve their embeds.
- `tests/db/booking-capacity.test.ts`: the TS/SQL parity sweep also compares the display reason.
- `tests/db/security-guard.test.ts`: `SF20G_TABLES` / `seedSf20gRows` in the org sweeps; `campaign_ab_funnel` is
  service-role only.
- Also passing: `booking-capacity`, `phase20d`, `phase20d-service`, `campaigns`, `campaign-engine`,
  `appointments-service`, `front-desk`, `front-desk-service`, `media-documents`, `enquiry-campaign-reports`,
  `appointment-booking-lock` (14 files, 221 tests in one sequential run). Full unit suite: 3,428 pass; the one failure,
  `tests/unit/signing/signing.test.ts` (PAdES seal), is unrelated to this slice and fails the same way when run alone.
- `tsc --noEmit` clean, eslint clean on every changed file, `pnpm audit:security` 0 unguarded, `pnpm build` and
  `pnpm bundle:check` within the existing budgets.

## Not verified / not built

- The UI (settings switch, greyed slots, A/B card, B mapping card, preview toggle, drawer table) was type-checked and
  linted, **not clicked through in a browser**.
- No live WhatsApp send: messages were only queued.
- The split is per person by hash, so a small audience can be uneven (for example 3 of 10 in B at 50%).
- No statistical significance or winner hint is shown; the table shows counts and rates only.
- `createCampaign` with `variant_b` was not run end to end (it needs a signed-in session); its parts (`loadSendContext`,
  `mappingError`, `checkMediaReferences`, `variantProblem`, the variant insert and the snapshot trigger) are covered
  separately above.
