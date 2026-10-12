# Phase 12b notes: make it real (partial, 11 Oct 2026)

Run in a cloud sandbox with Postgres 16 and pgvector but **no Docker, no Supabase CLI and no auth stack**, so only part of 12b was possible. Everything below was run, not assumed.

## Verified

| Check | Result |
|---|---|
| All 44 migrations apply to a clean Postgres 16 with pgvector and the pgmq extension (`scripts/test-db.sh`) | Pass |
| Database tests, `tests/db`, including the 7 files that need PostgREST (RLS for every module, jobs, scheduler, flows, recall, finance, Unite sync, supabase-js paths, security guard) | **32 files, 423 tests, all pass** |
| `pnpm typecheck`, `pnpm lint` | Clean |
| Unit tests | 107 files, 1,245 tests pass |
| `pnpm build` (production build with placeholder Supabase variables) | Pass |

How to repeat the database run: see `supabase/test/README.md`, or let `.github/workflows/ci-db.yml` do it on every pull request (added in this phase; it installs Postgres 16 and pgvector, downloads pgmq and PostgREST, and runs `tests/db`).

## Not done (needs a machine with Docker or a Supabase project)

1. Generated types drift check (`supabase gen types` against a local stack).
2. Playwright (`pnpm e2e`) and the click-through of every page as Admin, Receptionist and Finance, on a phone and a desktop width. The new menu, Ctrl+K search, mobile tab bar, loading and error pages and the Activity log have been typechecked, built and unit-tested, **not seen in a browser**.
3. `pnpm demo:reset` (synthetic demo organisation). Not written yet.
4. Real Meta round trip, load rehearsal and the UI findings list (`docs/12b-ui-findings.md`).

Run those with the prompt in `docs/10_NEXT_PHASE_PROMPTS.md` once the Supabase and Vercel projects exist (or `supabase start` on a machine with Docker).

## Housekeeping done

- Stale statements fixed in `README.md`, `docs/06_PHASE_11_CUTOVER.md` and `docs/07_PHASE_11_NOTES.md` (they said Phases 4 to 10 were not built).
- `scripts/generate-secrets.sh` prints fresh `JOB_SECRET` and `ENCRYPTION_KEY` values. Run it on your own machine, never in chat.
