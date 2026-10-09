# Security pass — Phase 11

Scope: everything in the repository today (Phases 1–3: tenancy, jobs framework, CRM and importers, WhatsApp ingress, Inbox). Reviewed against CLAUDE.md rules 1, 2, 3, 4, 6, 9, 10 and 16. Phases 4–10 do not exist yet; their rows are listed at the end as work to repeat when they land.

How it is enforced from now on: the checks below are tests, not a one-off review. `pnpm test` (static + route + crypto tests), `pnpm test:db` (catalog and cross-org tests) and `pnpm audit:security` (regenerates [`security-pass.generated.md`](security-pass.generated.md), the entry-point table) fail the build when a new table, policy, function, server action or route breaks a rule.

## Checklist (from docs/02 Phase 11)

| Item | Result | How it is checked |
|---|---|---|
| RLS on every table | **Pass** | `tests/db/security-guard.test.ts` reads `pg_catalog`: all 37 public tables have RLS; every table with `org_id` has a policy or is on the explicit service-only list (and that list is verified to have no policy); every policy on an org table is scoped through `org_id` / `app.is_org_member` / `app.has_perm` / `app.user_org_ids` / `app.can_view_conversation` / `app.shares_org_with`; none is `using (true)`; none targets `anon`/`public`. |
| Cross-org test suite | **Pass** | Same file sweeps **every** org-scoped table: org B's admin sees 0 rows of org A, cannot insert into org A (RLS fires before NOT NULL; the probe is proven by a control that reaches the constraint), cannot update/delete org A rows or move B rows into A; a signed-in user with no membership sees nothing; `anon` sees nothing. Five tables guarded by consistency triggers (which raise before RLS) are covered by the dedicated suites in `rls.test.ts`, `crm-rls.test.ts`, `inbox-rls.test.ts`; the sweep checks those suites still mention them. |
| Service-role usage audited | **Pass with a standing risk** | `tests/unit/security-static.test.ts`: all 96 server-action / route entry points in 18 modules (29 modules in `app/`, `lib/` and `components/` call `createAdminClient`) call `requirePerm`/`can`/`assertCan`, or are on the reviewed exception list in `lib/security/policy.ts` with a reason (pre-auth login, token- or signature-authorised routes, caller's-own-data actions). Stale or unneeded exceptions fail the test. **Standing risk:** nothing mechanical forces a service-role query to filter on `org_id`. A hand review of the 91 `from(...)` chains without an `org_id` filter found each preceded by an org-scoped existence check (scope, then update by id) or operating on ids produced by a scoped query; no cross-org write path found. A `scopedAdmin(orgId)` wrapper that injects the filter is the right follow-up before Phases 5–9 add dozens more queries. |
| Tokens encrypted | **Pass** | `lib/crypto.ts` AES-256-GCM, versioned `v1:iv:tag:ct`. Tests: ciphertext round-trips, fresh IV each write, missing key refuses to store plaintext, a flipped bit fails authentication (`channel-token-storage.test.ts`). Static: the only module that touches `access_token_enc` is `lib/whatsapp/channel.ts`; only it and the channels page read `channel_secrets`; the page selects `channel_id` only; no client component imports the service-role client, crypto or reads a server secret. `channel_secrets` is service-role only (verified by the catalog test). |
| Webhook signatures | **Pass** | `tests/unit/webhook-route.test.ts` drives the real `POST /api/webhooks/meta`: missing, wrong, truncated and body-mismatched signatures → 401 and nothing stored or queued; valid → stored raw, one enqueue, 200; enqueue failure still 200 (sweep re-queues); store failure → 500 so Meta retries; non-JSON → 400; body over 1 MiB → 413 before hashing; unconfigured secret → 503; GET handshake only for the right verify token. Comparison is constant-time (`timingSafeEqual`). `/api/jobs/*` uses the same style of constant-time check on `X-Job-Secret`. |
| Rate limits on the public API | **Built, cannot be exercised yet** | `lib/rate-limit.ts` + `rate_limit_hit()` (Postgres, atomic, tested with 40 parallel callers). `RATE_RULES.publicApi` (120 req/min per key) is defined for `/api/public/v1` (Phase 10). Applied today to: failed webhook signatures (30/min/IP; genuine Meta traffic is never throttled), failed job secrets (20/min/IP), password sign-in (30/10 min/IP and 8/15 min/e-mail), magic link (5/15 min/e-mail), invite acceptance (15/10 min/IP), workspace creation (5/h/user), contacts export (6/min/user). Auth limiters fail **closed**; ingress limiters fail **open** so a limiter outage cannot drop patient messages. |
| Audit-log coverage | **Pass** | `audit_log` is now append-only even for the service role (trigger; only the user-deletion `SET NULL` and the org cascade are allowed). Every mutating entry point writes an audit row or is on the exception list with a reason; day-to-day record changes are attributed on the contact timeline / `messages.sent_by_user_id` instead. Coverage matrix: [`security-pass.generated.md`](security-pass.generated.md). |
| No tokens, full phone numbers or message bodies in logs | **Pass** | `lib/redact.ts` (tokens, bearer/JWT, query secrets, encrypted blobs, e-mails, phone numbers) is applied to everything persisted from job errors (`job_runs`, `dead_letters`) and to console output that includes third-party error text. A static test fails on `console.*` calls that name `token`, `secret`, `password`, `body`, `payload` or phone fields. |

## Findings fixed in this pass

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | High | `signedMediaUrl` checked only that the path *started with* the caller's org id, so `<org>/../<other-org>/…` style paths and any conversation in the org (including ones the caller cannot see) could be signed. | Strict `<uuid>/<uuid>/<file>` parser (`lib/inbox/media-path.ts`), org match, and the conversation must be visible to the caller through RLS. |
| 2 | High | `sendAttachment` used the same prefix check; the outbound job later downloads the path with the service role and uploads it to Meta, so a crafted path could send another org's file. | Same parser; path must equal `<org>/<this conversation>/<file>`. |
| 3 | Medium | `mark_all_notifications_read` and `set_presence` were executable by `anon` (Supabase default privileges grant it explicitly; `revoke … from public` does not remove it). Both use `auth.uid()` so impact was nil today. | `revoke execute … from anon`; catalog test now fails on any `SECURITY DEFINER` RPC in `public` that `anon` can run or that `authenticated` can run without being on the allowlist. |
| 4 | Medium | `audit_log` was append-only only through RLS, which the service role bypasses. | Trigger blocks UPDATE/DELETE. |
| 5 | Medium | No throttling on sign-in, magic link, invite acceptance, exports, webhook signature failures or job-secret guessing. | Postgres-backed limiter (above). |
| 6 | Medium | Persisted job errors and console output could carry tokens, phone numbers or e-mails from upstream error messages. | `redactText` / `redactMeta`. |
| 7 | Low | Webhook body size unbounded. | 1 MiB cap → 413. |
| 8 | Low | Configuration mutations without an audit row: inbox categories, quick replies and labels, tag creation, bulk segment edits, custom-field reorder, webhook subscription, workspace creation. | `recordAudit` added. |
| 9 | Low | No security headers. | HSTS, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy` (microphone only), CSP in **report-only** mode (enforce after a week of clean reports). |
| 10 | Availability | `/api/jobs/<queue>` read one batch per call, capping `meta_events` near 300 events/min against a 1,000/min target; saturated bulk sends polled and gave up after 10 minutes. | See `docs/load-test.md` findings 1–3. |

A production build also caught one mistake of mine: a Next.js route file may not export arbitrary constants, which unit tests cannot see. The constant now lives in `lib/whatsapp/signature.ts`.

## Residual risks and decisions

- **Service-role queries rely on convention** (see above). Recommended before Phase 5: a wrapper that injects `org_id`, plus a lint rule banning bare `createAdminClient()` in `app/`.
- **CSP is report-only.** Enforce once reports are clean. `script-src` still needs `'unsafe-inline'` for Next's inline bootstrap; moving to nonces is a later hardening step.
- **Fixed-window send limiter** can burst to 2× `send_rate_per_sec` across a second boundary. Keep `2 × rate` below the number's Meta throughput (`docs/load-test.md`, finding 3).
- **Rate-limit keys hash the client IP.** Behind Vercel the first `x-vercel-forwarded-for` hop is trusted; if the app is ever served behind a different proxy, review `clientIp()`.
- **Supabase Auth settings** (password policy, leaked-password protection, e-mail confirmation, JWT expiry, MFA for admins) are configured in the Supabase dashboard, not in this repository. Check them at cut-over; they are not covered by any test here.
- **Data residency** for UAE health data is unresolved (OQ-49) and blocks the first real patient row.
- **Backups and restore**: confirm point-in-time recovery is enabled on the Supabase plan and rehearse one restore before cut-over.

## To repeat when later phases land

| Phase | Add to this pass |
|---|---|
| 4 Templates | Template send path through the same `outbound` guards; template body variables never logged |
| 5 Enquiries / tasks | New tables appear in the catalog sweep automatically; add their actions to the static audit (automatic) |
| 6 Appointments / Unite | Unite credentials encrypted at rest (`integration_accounts`); every Unite call logged; the Finance API job behind its flag and writing raw payloads first (rule 7); read-only proof test |
| 7 Campaigns | Opt-out / `stop_marketing` filter, recipient snapshot permissions, auto-pause |
| 8 Flows | Executor unit tests; advisory lock; 200-step cap; webhook-in endpoints signed |
| 9 Portal | Generic object routes respect `portal_objects` permissions; CSV export audited |
| 10 Public API / AI | API keys hashed; per-key limits from `RATE_RULES.publicApi`; outbound webhooks HMAC-signed with retries; AI drafts only, no PHI beyond the feature itself |
