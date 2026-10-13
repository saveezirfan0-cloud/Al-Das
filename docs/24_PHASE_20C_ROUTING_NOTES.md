# Phase 20c (routing half) and the G13 reports that depend on it

Read with `docs/20_SANOFLOW_REA_PARITY.md` §4 rows **G5** and **G13** and `docs/21_SANOFLOW_PARITY_PROMPTS.md` (20c routing half, 20e reports half). The booking-capacity half of 20c (G6) and the template rates of G13 are **not** in this phase; other work streams own them.

Before this phase, routing was round-robin over online members with a per-member weight and a team lead. It had no limit on open conversations, no fallback team and no auto-reply. Presence changed only when a person picked a status, so someone who walked away still received chats. Enquiry visibility was a single flat `enquiries.view`. Pulse kept no assignment history and no presence history, so none of the G13 metrics could be computed.

## What exists

### Migrations

| File                                  | What                                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20261025000100_routing_presence.sql` | columns, the two log tables and their triggers, presence RPCs and sweep, the routing functions, the restricted enquiry view (RLS + server helper) |
| `20261025000200_routing_reports.sql`  | three source views (`v_assignment_events`, `v_presence_events`, `v_conversation_engagement`) and five report functions                            |

### Schema

| Object                                                                          | Purpose                                                                                                                                                                    |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `teams.auto_reply_text` (1..1024 chars, null = none)                            | the team's auto-reply                                                                                                                                                      |
| `teams.office_hours` (jsonb, the Office Hours node's shape, null = always open) | when the team counts as open                                                                                                                                               |
| `teams.fallback_team_id` (same org, never itself; trigger + check)              | the overflow team                                                                                                                                                          |
| `memberships.max_open_conversations` (1..500, null = no limit)                  | limit used by round-robin                                                                                                                                                  |
| `memberships.enquiry_scope` (`all` default / `team` / `own`)                    | restricted enquiry view                                                                                                                                                    |
| `memberships.last_seen_at`, `memberships.presence_auto`                         | last browser heartbeat; true while the sweep (not the person) set them away                                                                                                |
| `conversations.auto_reply_sent_at`                                              | claimed atomically before the auto-reply is queued                                                                                                                         |
| `orgs.settings.inbox.auto_away_minutes` (5..480, null = off)                    | idle time before away (`lib/inbox/settings.ts`)                                                                                                                            |
| `conversation_assignment_events`                                                | one row per change of owner or team: kind (`assigned`, `reassigned`, `unassigned`, `team_changed`), from/to user and team, actor, source (`user`, `routing`, `system`), at |
| `member_presence_events`                                                        | one row per presence change: presence, previous, source (`manual`, `auto_away`, `auto_back`, `admin`), at                                                                  |

Both log tables have RLS, a SELECT policy only (`reports.view`; a member also sees their own presence rows), and no write policy. They are written only by the triggers `conversations_assignment_log` and `memberships_presence_log`, so every code path is covered: inbox actions, routing, flows, off-boarding, the public API and jobs. User and team ids in the logs are plain uuids on purpose. A foreign key would make deleting a profile or team fail, because the FK's own `SET NULL` on `conversations` fires the log trigger for the row being deleted (a test covers this). The actor is `auth.uid()`, or the `x-pulse-actor` header on a service-role request (`app.request_actor()`, the same rule as `record_history`). Inbox `assignConversation` and `startConversation` now use `createAdminClient(member.userId)` so the log can name the person.

### Routing (`public.route_conversation`, `lib/inbox/routing.ts`)

- A new conversation is inserted without an owner and then routed by ONE SQL call. In a single transaction it locks the conversation row, picks a member, applies the fallback and writes the owner. Callers: inbound webhook (`lib/inbox/inbound.ts`, new chats and the first reply to a campaign-only chat), `ensureConversation` (reminders etc.) and the public API template send. `routeNewConversation` (pick first, insert later) is gone.
- **Capacity:** `app.pick_team_assignee(org, team, check_capacity)` is the one picker. It takes online (idle-aware), active members with weight > 0, least recently assigned first. With a limit, it counts the member's open (non-closed, non-campaign-only) conversations under `pg_try_advisory_xact_lock('pulse:capacity:<org>:<user>')`. The lock is held until the routing transaction commits, so two webhooks in flight cannot both take the last place. A member whose lock is held elsewhere is skipped, never waited on, so there is no deadlock. The race test opens two transactions: the second routing goes to the fallback team.
- **Fallback (one hop, never chained):** used when round-robin found nobody (everyone away or at their limit) or when nobody in the team is online. If the fallback team has someone online (or round-robin found someone there), the conversation moves to it. Otherwise it stays in the first team, unowned, and the escalation ladder (Phase 13) covers it.
- `public.pick_round_robin_assignee` keeps its signature for enquiry assignment rules. It is now idle-aware but **not** capacity-limited, because the limit is about open conversations, not enquiries. `pick_round_robin_assignee_capped` is used by the inbox Auto-assign button.
- **Manual assignment ignores the limit:** a person can still assign more by hand.

### Team auto-reply

`sendTeamAutoReply()` uses the pure decision `autoReplyDecision()` in `lib/inbox/routing-rules.ts`. The reply goes only when the conversation was just opened and routed, the team it landed in has text, the auto-reply was not sent yet, the patient's message is inside the 24 h window, and the team is outside its office hours OR nobody in it is online. `auto_reply_sent_at` is claimed with `update … where auto_reply_sent_at is null` BEFORE `queueOutbound`, so a retried webhook job never sends it twice. A crash between the claim and the queue loses the reply rather than duplicating it (at most once). It is free-form text through `queueOutbound`, so training mode, pacing and the outbound handler's checks apply. A reaction never triggers it. It never fails the webhook.

### Presence auto-away

- The browser shell (`components/shell/shell-data.tsx`, client only, no layout query) calls `public.presence_heartbeat(org)` at most once a minute, and only while the tab is visible and there was input in the last 2 minutes (pure rule: `heartbeatDue()` in `lib/presence/idle.ts`). The RPC writes at most once per 30 s, brings back someone the sweep set away, and never overrides a status the person picked. The user menu repaints from the returned value.
- Routing treats `presence = 'online'` with no heartbeat for `auto_away_minutes` as away at once (`app.presence_is_online`; the TS mirror is `isPresenceOnline`).
- `pg_cron` runs `public.presence_auto_away_sweep()` every minute as plain SQL (`pulse:presence_auto_away`). It marks those members `away` with `presence_auto = true`, and the presence log records `auto_away`. No in-memory timers on the server.
- `set_presence` is unchanged in signature. It now also clears `presence_auto` and counts going online as being seen.

### Restricted enquiry view

- `app.enquiry_visible_to(org, user, assignee, created_by)` is the one rule. `all` sees everything. `own` sees enquiries assigned to them, or unassigned ones they created. `team` sees those assigned to them or to anyone sharing a team with them, plus all unassigned ones (so the team can pick up new leads). A non-member or suspended member sees nothing.
- **RLS:** `enquiries_select`, `enquiries_update` (USING) and `enquiries_delete` call it. The default `all` means no behaviour change for existing members.
- **Service-role reads:** `lib/enquiries/scope.ts` builds the predicate that calls the same SQL function. `lib/enquiries/query.ts` (`viewer` option) adds it to `enquiries_search / _count / _ids / _stage_counts`. `lib/enquiries/visibility.ts` (`enquiryViewer`, `visibleEnquiryIds`, `canSeeEnquiry`) filters ids through `public.enquiry_ids_visible_to`. It is applied in `app/(app)/enquiries/actions.ts` (list, board, column pages, select-all ids, filter preview count, pipeline counts, detail, every edit / stage / status / pipeline / note, bulk and delete, contact tab list), the CSV export route (`/api/enquiries/export`, including explicit ids) and the task "link an enquiry" search. The session loads `memberships.enquiry_scope` (`CurrentMember.enquiryScope`). When it is missing, the helper reads it, and an unreadable value counts as `own` (fail closed).

### Settings UI (existing pages, existing permission `settings.manage`)

- **Settings, Teams:** the team dialog has a Routing section with the fallback team, office hours (the same hours on ticked weekdays, in the workspace timezone; no days = always open) and the auto-reply text. Cards show an Auto-reply badge and the fallback team. Audited (`team.created` / `team.updated` with booleans and the fallback id, never the text).
- **Settings, Users:** the member menu has "Routing and enquiry view…" (`setMemberRouting`, `requirePerm('settings.manage')`, `recordAudit('membership.routing_updated')` with from/to). The table shows the limit and any restriction under Teams.
- **Settings, Inbox:** "Set people away when idle" (minutes).
- Ctrl+K keywords were added in `components/shell/settings-pages.ts`. No new pages. A help guide "Teams and routing" (`lib/help/guides.ts`) covers `/settings/teams` and `/settings/users`.

### Reports (G13, `lib/reports/registry.ts`, shared filters and CSV export)

| Key               | Group         | Filters       | Definition                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------- | ------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assign-to-close` | Conversations | team, user    | Conversations closed in the period (org-local day). First assign to close = `closed_at` − first time it got an owner. Last assign to close = `closed_at` − last time it got a new owner before close. Average and median, total and per owner at close. Shows how many closed conversations have an assignment record                                                                                      |
| `owner-removed`   | Conversations | team, user    | Assignment events that took a conversation from a person (`unassigned` or `reassigned`), per previous owner, split by staff vs routing/system                                                                                                                                                                                                                                                              |
| `ai-engagement`   | Conversations | channel, team | Closed conversations where: an AI draft was used (`ai_suggestion_outcomes`), a flow sent a message (`messages.flow_run_id`), either; closed without a staff reply (no outbound with `sent_by_user_id`); of those, handled by automation (some automated outbound) or with no reply at all. Pulse AI never sends, so "closed by AI" is reported as "closed without a staff reply" / "handled by automation" |
| `member-status`   | People        | team, user    | Online / away / offline seconds per member per org-local day from `member_presence_events`. The SQL returns one jsonb (seed state + changes, capped at 50 000), and the pure `presenceDurations()` (`lib/reports/presence.ts`) splits by day and never counts the future. The table is capped at 5 000 rows with a note                                                                                    |
| `enquiry-cohorts` | Enquiries     | user          | Enquiries created in the period (from `v_enquiry_facts`), by org-local creation month: created, open, won, lost, disqualified, win rate, won value, median days to close                                                                                                                                                                                                                                   |

The report functions are service-role only (`can('reports.view')` first, like the others). The source views are `security_invoker`, revoked from API roles and granted to `service_role`.

## How it was verified

- `NODE_OPTIONS=--max-old-space-size=3072 pnpm exec tsc --noEmit -p .`: clean.
- `pnpm exec eslint <every changed file>`: clean. Prettier was run only on new files and on changed files that were already prettier-clean at HEAD.
- New unit tests (pure):
  - `tests/unit/routing-rules.test.ts`: route outcome parsing, every auto-reply branch (outside hours, nobody online, staffed, already sent, no text, no team, window closed), office hours form round trip, and `sendTeamAutoReply` with a fake client (claim first, queue once, no queue when another delivery claimed it, no DB touch when the rule says no).
  - `tests/unit/presence-idle.test.ts`: idle rule and heartbeat throttling.
  - `tests/unit/reports-presence.test.ts`: day boundaries in Asia/Dubai, splitting across midnight, seed-only, never after now, malformed payloads.
  - `tests/unit/enquiry-scope.test.ts`: predicate binding and fail-closed scope.
- New DB test `tests/db/routing.test.ts` (real Postgres, RLS as `authenticated`, 16 tests):
  - fallback team validation;
  - capacity fill, then fallback, then stay when nobody is online, freed place after close, fallback when T is all away, unstaffed signal;
  - owned conversations left alone;
  - **two concurrent transactions racing for the last place** (the second goes to the fallback, carol never exceeds 1);
  - capped vs uncapped pickers;
  - auto-away: idle-aware routing, sweep, presence log sources, heartbeat back, a manual away never overridden, another org cannot heartbeat;
  - assignment log kinds, sources and actor via `x-pulse-actor`;
  - log RLS (reports.view only, own presence rows, no client writes, other org sees nothing);
  - deleting a team in the log works;
  - auto-reply claim exactly once;
  - restricted view in RLS for own / team / all and another org, update blocked outside the view, the same rule through `enquiries_search` and `enquiry_ids_visible_to`, suspended member sees nothing;
  - report functions' numbers (first/last assign medians ≈ 7200 s / 3600 s, owner removed, AI engagement, cohort totals, presence payload);
  - report functions and views denied to signed-in users.
- `tests/db/security-guard.test.ts`: the new tables are in `PHASE20C_TABLES` and seeded by `seedPhase20cRows()` (through the real triggers); `presence_heartbeat` is in `AUTHENTICATED_RPCS` (it touches only the caller's own membership); the four service-only functions are checked in a new "phase 20c service-role functions" block.
- Full DB suite on a fresh test database (`bash scripts/test-db.sh`, then `vitest run tests/db`): 44 files ran (624 tests passed), and 17 files were skipped because they need `TEST_POSTGREST_URL` (no PostgREST here). The one failure was `tests/db/jobs.test.ts`, whose list of cron jobs lacked the new `presence_auto_away`. The test was updated and re-run green, together with the routing, security-guard, inbox, enquiry and RLS suites (87 passed).
- `pnpm test` (unit suite, no database): 190 files, 2607 tests passed.
- `pnpm audit:security`: 0 unguarded and unreviewed (`setMemberRouting` is guarded and audited). The generated report was not committed.

## Not verified

- Nothing was run against a real Supabase project. Not exercised: PostgREST's handling of the new RPCs, Realtime load from heartbeats (each heartbeat updates `memberships`, which is in the `supabase_realtime` publication; at most one write per member per 30 s), and pg_cron really firing `pulse:presence_auto_away` (the test DB has a cron stub).
- The UI was not clicked through in a browser: the team dialog's routing section, the member routing dialog, the inbox settings row, the five reports pages and the presence dot repaint.
- Inbound end to end (`processInbound` → route → auto-reply → outbound handler) is covered only in pieces: SQL routing in the DB test and the auto-reply logic with a fake client. No webhook-simulator run.
- Report performance on production-sized data: `v_conversation_engagement` does EXISTS probes per closed conversation in range, and `report_presence_events` is capped at 50 000 changes.

## Decisions (conservative; change if Al Das wants otherwise)

1. Auto-reply uses the team the chat **landed in** (after fallback): its text and office hours. A fallback team without text sends nothing.
2. Auto-reply is **at most once** (claim before queue). It can stack with a flow's welcome message if both are set up; the admin chooses.
3. The fallback is one hop and only moves the chat when someone is online there.
4. The open conversation limit counts `open` and `waiting` (not closed, not campaign-only). Manual assignment is never blocked.
5. `pick_round_robin_assignee` (enquiry rules) is idle-aware but not capacity-limited.
6. Team scope includes unassigned enquiries; own scope includes unassigned ones the person created. The restriction applies on top of the role, also to administrators if someone sets it (default `all`).
7. `enquiry_tags` follows the view (migration `20261029000100_phase20_integration.sql`), and so does the inbox close-with-enquiry dialog (Phase 20d). Other child data of enquiries keeps its existing policies. This covers tasks linked to an enquiry (`tasks.view`), and timeline rows (fetched only after the detail check). Also not restricted: the Front desk patient card's "open enquiry" chip (`lib/front-desk/server.ts`, shows the latest open enquiry's number/title/stage to `frontdesk.use`), the Team lead dashboard's SLA count (a number), the public API (key-scoped, no member) and privacy exports (`privacy.manage`).
8. The presence log starts at deploy. For the status log, time before a member's first change counts as the state recorded with that change (`previous`), else their current state.
9. "Closed by AI" is not a Pulse concept (rule 12: drafts only). It is reported as closed without a staff reply, split into handled by automation vs no reply at all.

## Open questions

1. Should the auto-reply be bilingual (an Arabic field like quick replies), or chosen by the patient's language?
2. Should the open conversation limit also cap the escalation ladder or manual "Take"?
3. Do team leads need a live "who is at capacity" view in the Team lead dashboard?
4. Should a restricted enquiry view also hide the Front desk card's enquiry chip?
