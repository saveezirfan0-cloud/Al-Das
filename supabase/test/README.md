# Plain-Postgres test harness

`pnpm test:db` runs the RLS and jobs tests against any Postgres 15/16 (no Docker needed):

```bash
export TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/pulse_test
bash scripts/test-db.sh      # (re)creates the database, installs stand-ins, applies every migration
pnpm exec vitest run tests/db
```

What `scripts/test-db.sh` installs:

- `auth-stub.sql` — the roles `anon / authenticated / service_role`, an `auth.users` table, `auth.uid() / role() / jwt()`, Supabase's default privileges and a `vault` stand-in. **Never run this on a real Supabase project.**
- `ext-stubs/` — `pg_cron` and `pg_net` *stubs* (catalog tables + no-op `cron.schedule` / `net.http_post`) so the cron migration applies. Copied into the server's extension directory when it is writable.
- `pgmq` — the real SQL-only extension. Download it once: `curl -L -o supabase/test/ext-stubs/pgmq--1.5.1.sql https://raw.githubusercontent.com/pgmq/pgmq/v1.5.1/pgmq-extension/sql/pgmq.sql` (not committed; third-party code).

Tests run as `set role authenticated` with `request.jwt.claims` set, exactly how PostgREST evaluates RLS. With the Supabase CLI stack running you can also point `TEST_DATABASE_URL` at it (skip the stub step: `pnpm exec vitest run tests/db`).
