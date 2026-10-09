# Load tests (Phase 11)

Two harnesses, both safe to run against a **local stack or staging only**. They write synthetic data (contacts in the reserved fake block `+971 50 09xx xxx`, generic message text) and refuse to run without `--yes-staging`. Nothing here ever touches Meta, Unite or real patient data.

| Test | Script | What it proves |
|---|---|---|
| Webhook burst | `pnpm load:webhook` | Ingress stays fast under 1,000 events/min, nothing is lost or duplicated, replayed deliveries are idempotent, the `meta_events` queue drains. |
| 20k outbound send | `pnpm load:outbound` + `pnpm load:mock-graph` | 20,000 template sends on the `outbound` queue all reach a final state, the per-number rate limit holds, no tick outruns the 60 s function limit, nothing is dead-lettered. |

The 20k test stands in for a **campaign** until Phase 7 exists. It exercises the same lane (`outbound`), the same guards (window, send slot, error map) and the same handler, but not recipient snapshotting, opt-out filtering or the auto-pause on a failure spike. Those are listed under "Blocked on later phases".

## Pass criteria

Webhook burst (`lib/load/stats.ts → evaluateWebhookRun`)

- every request returns 2xx (invalid-signature rejections do not count: the harness always signs)
- ingress p95 < 500 ms
- every unique message stored exactly once (no loss, no duplicates, including after replaying 5 % of the POSTs)
- every `webhook_events_in` row processed, none with an error
- `meta_events` queue empty and drained within 120 s of the last event

Outbound (`evaluateOutboundRun`)

- every message ends `sent` or `failed`; none left `queued`/`sending`
- zero dead letters
- per-number limit holds: busiest 1 s ≤ 2× `send_rate_per_sec` and busiest 10 s average ≤ 1.2× the bulk cap (see finding 3)
- sustained throughput ≥ 75 % of the configured rate
- no job tick exceeds the 60 s function limit

Both scripts print a markdown table and exit non-zero on any failure; `--report <file>` saves it.

## Running locally

```bash
# 1. stack: Postgres (supabase/test/README.md), PostgREST + proxy, or `supabase start`
# 2. app env (production build is representative; dev mode is several times slower)
export NEXT_PUBLIC_SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… JOB_SECRET=… META_APP_SECRET=… \
       ENCRYPTION_KEY=$(openssl rand -base64 32) META_SYSTEM_USER_TOKEN=mock \
       META_GRAPH_BASE_URL=http://127.0.0.1:4010      # loopback only; any other host is ignored
pnpm build && pnpm start
# 3. an org with a channel (phone_number_id 100000000000001) and an APPROVED template — `pnpm db:seed` creates both
# 4. webhook burst
pnpm load:webhook --yes-staging --rate 1000 --minutes 1 --org <slug>
# 5. 20k send
pnpm load:mock-graph --port 4010 --latency-ms 80 --fail-rate 0.01 &
pnpm load:outbound --yes-staging --count 20000 --rate 20 --org <slug> --cleanup
```

Useful flags: `--per-post N` (Meta batches several messages per webhook), `--senders N`, `--concurrency N`, `--replay-pct N`, `--tick-seconds N` (the harness fires drain ticks on a schedule like `pg_cron`, whether or not the previous tick finished), `--max-drain-seconds N`, `--timeout-minutes N`, `--template <name>`, `--phone-number-id <id>`.

`--cleanup` deletes the synthetic recipients (`source = 'load-test'`, label `LOADTEST …`); their conversations and messages cascade. Inbound-burst contacts are created by the normal inbound path and live in the reserved fake block; remove them with `delete from contacts where phone_e164 like '+9715009%'` on the staging project.

### Against a Vercel preview + hosted Supabase

Use the preview URL with `--url https://<preview>.vercel.app` and the preview environment's `META_APP_SECRET` / `JOB_SECRET`. The 20k test needs the app to call the mock, which only listens on loopback, so on a hosted preview run it with a **throwaway Meta test number** instead of the mock (rate-limited to the sandbox's allowance), or keep the outbound test local. Do not run either harness against the production project.

## Results (local stack, production build)

Environment: single-node Postgres 16 + PostgREST behind a thin proxy, one Next.js production server, mock Graph API at 80 ms latency and 1 % permanent failures. Absolute numbers will differ on Vercel + Supabase; the shape is what matters.

| Scenario | Result |
|---|---|
| Webhook burst, 1,000 events/min × 1 min, 5 % replays | 0 non-2xx; ingress p50 15 ms, p95 20 ms, p99 28 ms; 1,000/1,000 stored, no duplicates; backlog at the last event 77 rows; fully drained 1.0 s later |
| Webhook burst, 3,000 events/min × 1 min (3× target) | 0 non-2xx; p95 22 ms; 3,000/3,000 stored, no duplicates; backlog 273 rows at the last event; drained in 2.0 s |
| Outbound, 2,000 messages at 20 msg/s, before the pacing redesign (1 s polling, then backoff) | all reached a final state, but sustained only 7.4–9.6 msg/s (limit 20): retry churn crowded out useful work |
| Outbound, 2,000 messages at 20 msg/s, after (slot reservation + send-time claim) | 1,979 sent / 21 mock failures, 0 dead letters; 13.5 msg/s sustained against the 16 msg/s bulk cap; 1 s peak 32, busiest 10 s average 17.6 |
| **Outbound, 20,000 messages at 20 msg/s** | **PASS on every check.** 19,778 sent, 222 failed (the mock's 1 % injected permanent failures), 0 still queued, 0 dead letters; 24 min 5 s end to end; sustained 13.8 msg/s vs the 16 msg/s bulk cap; 1 s peak 32 (= 2 x 16, the fixed-window worst case), busiest 10 s average 17.6; slowest job tick 41.9 s (limit 60 s); 145 drain ticks |

The sustained rate sits below the cap because this single sandbox shares one CPU between Postgres, PostgREST, Next.js, the mock and the harness, and each message costs a first pass (to book its slot) plus a second pass (to send). Expect closer to the cap on Vercel + Supabase; treat 13.8 msg/s as a floor.

Repeat the 20,000-message run on your staging project before cut-over (it takes ~20 minutes) and attach the report to the go/no-go record.

## Findings from running these tests

1. **Queue drain capped throughput (fixed).** `/api/jobs/<queue>` read one batch per call and `pg_cron` calls it every 10 s, so `meta_events` (batch of 50) topped out near 300 events/min — below the 1,000/min target — and every other queue was capped the same way. The route now drains batches until the queue is empty, a batch fully fails, or a 40 s budget is spent (`drainQueueUntilIdle`, unit-tested). Overlapping ticks are safe because `pgmq.read` hides in-flight messages and handlers are idempotent.
2. **A saturated send slot could not finish a long campaign (fixed; please review).** A message that missed its second's slot re-queued itself after 1 s and gave up after 600 attempts. A 20k campaign at 20 msg/s needs ~17 minutes, so the tail would have failed, and re-reading the whole backlog every second cut real throughput to ~7 msg/s. Now the bulk lane (`outbound`) books a future second once with `reserve_send_slot` (O(1) per call via a per-channel cursor) and is re-queued with that delay; every send, booked or not, still passes `claim_send_slot` at send time, so a late or clumped message is simply re-booked and the limit holds. Bulk sends use at most 80 % of `send_rate_per_sec`, leaving headroom for live chat (`outbound_priority`, which keeps the 1 s retry). Messages expire by age (6 h) rather than attempt count. A drain tick that finds the queue idle waits for booked messages that fall due inside its 40 s budget (`job_next_due`), so sends go out evenly instead of in clumps at the next 10 s cron tick. This touches the core send path; it is covered by DB tests (`send-pacing`), unit tests and the runs above.
3. **Rate-limit semantics.** `claim_send_slot` counts per wall-clock second. Two adjacent seconds can both fill, so the real worst case in any 1 s window is **2× `send_rate_per_sec`**, and the harness observed bursts of 2× the cap (32 req/s against a bulk cap of 16). Keep `2 × send_rate_per_sec` below the number's Meta throughput (80 msg/s by default; higher after Meta upgrades it). The sustained average stays at or below the bulk cap (80 % of the limit).

## Blocked on later phases

- **Campaign engine (Phase 7):** recipient snapshot, opt-out/`stop_marketing` filtering, batch fan-out, retry rounds, auto-pause on a quality drop or failure spike. Re-run this test against `campaign_fanout` once it exists and add the auto-pause assertion (inject 5 % 131049/131050 errors via `--fail-rate` and confirm the campaign pauses).
- **Public API (Phase 10):** `RATE_RULES.publicApi` (120 req/min per key) is defined; add a request-flood test when `/api/public/v1` exists.
- **Flow engine (Phase 8):** 200-step runs and per-conversation advisory locks under burst.
