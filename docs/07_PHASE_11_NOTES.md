# Phase 11 — Hardening, migration & cut-over: what was built and what is left

## Scope delivered

The repository contains Phases 1–3 only (tenancy, jobs, CRM and importers, WhatsApp ingress, Inbox). Phases 4–10 are not built, so this phase **hardened what exists, built the load-test, reconciliation and preflight tooling, and wrote the cut-over runbook**. The live steps (real imports, moving numbers, retiring Make/Airtable/Sanoflow) were deliberately not executed: they need real credentials and patient data and change systems Pulse does not own.

| Checklist item | Status |
|---|---|
| RLS on every table + cross-org suite | Done: `tests/db/security-guard.test.ts` (catalog rules + a sweep of every org-scoped table) |
| Service-role usage audited | Done, with a standing risk: static test over all 96 entry points; org filtering is still by convention ([`audit/security-pass.md`](audit/security-pass.md)) |
| Tokens encrypted | Done and tested; nothing new to encrypt until Unite lands (Phase 6) |
| Webhook signatures checked | Done: route-level tests, 1 MiB cap |
| Rate limits on the public API | Limiter built and applied to auth, export and failed-signature paths; the public API itself does not exist (Phase 10) |
| Audit-log coverage | Done: append-only trigger, coverage test, gaps closed |
| Load test: 20k campaign + 1k events/min webhook burst | Run locally and passing: 1,000 and 3,000 events/min with zero loss, and the full 20,000-message send (0 dead letters, limit held) — [`load-test.md`](load-test.md). The campaign engine itself is Phase 7, so the 20k test drives the same `outbound` lane directly; repeat it on staging |
| Final Airtable + Sanoflow import, reconciliation sign-off | Tooling done (`pnpm reconcile`, importer summaries, sign-off file check). Not run: needs the real systems. Only contact tables are importable today |
| Cut over numbers one at a time; Make parallel week; retire Make, Airtable, Sanoflow | Runbook + `pnpm cutover:preflight` done ([`06_PHASE_11_CUTOVER.md`](06_PHASE_11_CUTOVER.md)). Not executed. The Make parallel week needs Phase 8 |

## New and changed code

- **Migrations** `20261008001000_hardening` (rate limiter, append-only `audit_log`, revoke `anon` on two RPCs, send-slot reservation `reserve_send_slot` + `channel_send_cursor` + `channel_send_slots.booked`, `job_next_due`) and `20261008001100_reconcile` (`reconcile_snapshot`, counts only).
- **Libraries** `lib/rate-limit.ts`, `lib/redact.ts`, `lib/inbox/media-path.ts`, `lib/jobs/pacing.ts`, `lib/security/{static-audit,policy}.ts`, `lib/load/{stats,synthetic}.ts`, `lib/migration/reconcile.ts`, `lib/cutover/preflight.ts`.
- **Behaviour changes in Phase 1–3 code** (all covered by tests): job route drains until idle (`drainQueueUntilIdle`); outbound bulk lane books send slots instead of polling and uses 80 % of the number's limit; media paths validated; audit rows added to configuration actions; redaction on persisted errors; security headers; limiter calls in login, magic link, invite, onboarding, export, webhook and job routes.
- **Scripts** `audit-security`, `reconcile`, `cutover-preflight`, `load/{webhook-burst,outbound-20k,mock-graph}`; both importers now also write `import-summary-*.json`.
- **Tests** 130+ new: unit (rate limit, redaction, webhook route, static audit, token storage, media path, pacing, runner loop, load helpers, reconcile, preflight), DB (`security-guard`, `send-pacing`, `reconcile`).

## Decisions for you

1. **Send pacing redesign (needs your review).** Load testing showed the old design could not finish a 20,000-recipient campaign: saturated messages polled the queue (throughput collapsed to ~7 msg/s of 20) and gave up after 10 minutes. The bulk lane now books a future second once (`reserve_send_slot`), enforces the limit at send time, and takes at most 80 % of `send_rate_per_sec` so live chat is never starved. This touches the core send path; the details and numbers are in `load-test.md`. If you prefer to leave the send core alone until Phase 7, revert the `outbound.ts` branch and keep only the age-based expiry in `pacing.ts`.
2. **Make sends through Sanoflow**, so the parallel week must come *before* moving any number Make uses (runbook §0 and §7). Which numbers does Make send from?
3. **Scoped admin wrapper.** Recommend adding it before Phase 5 (security-pass residual risks).
4. **CSP** is report-only; pick a date to enforce.
5. **Retention of Sanoflow conversation history.** No tool imports it. Decide whether the archive export is enough before cancelling Sanoflow.

## Open items that block going live (unchanged from the register)

OQ-26 (Unite key rotation), OQ-38 (WABA ownership), OQ-49 (data residency), OQ-50 (accounts and tokens), and the clinical sign-offs OQ-01…06 and OQ-36. Phases 4–10 must exist before the Make parallel week, campaigns, reminders, recall and the back-office portal can replace their Airtable/Make/Sanoflow counterparts.

## How to run it

```bash
pnpm typecheck && pnpm lint && pnpm test            # includes the static security rules
TEST_DATABASE_URL=… bash scripts/test-db.sh && pnpm test:db   # catalog + cross-org + pacing + reconcile tests
pnpm audit:security                                  # regenerate docs/audit/security-pass.generated.md
# load tests: see docs/load-test.md
# cut-over: see docs/06_PHASE_11_CUTOVER.md
```

## Demo checklist

- [ ] `pnpm test` and `pnpm test:db` are green; `pnpm audit:security` reports 0 unguarded entry points.
- [ ] `pnpm load:webhook --yes-staging --rate 1000 --minutes 1` passes every row (no loss, no duplicates, p95 < 500 ms).
- [ ] `pnpm load:outbound --yes-staging --count 2000 --rate 20` (mock Graph running) finishes with 0 dead letters and a sustained rate near 16 msg/s.
- [ ] Sign in with a wrong password nine times: the ninth attempt shows "Too many attempts".
- [ ] `pnpm reconcile --org <slug> --source-counts docs/audit/source-counts.json` after a staging import prints a gap of 0 per table and no names or numbers.
- [ ] `pnpm cutover:preflight --org <slug> --stage pre-cutover --skip-graph` lists every blocker in plain language.
