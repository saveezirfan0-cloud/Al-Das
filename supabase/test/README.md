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
- `pgmq` — the real SQL-only extension. Download it once: `curl -L -o supabase/test/ext-stubs/pgmq--1.5.1.sql https://raw.githubusercontent.com/pgmq/pgmq/v1.5.1/pgmq-extension/sql/pgmq.sql` (not committed; third-party code). The matching `pgmq.control` is committed.

Tests run as `set role authenticated` with `request.jwt.claims` set, exactly how PostgREST evaluates RLS. With the Supabase CLI stack running you can also point `TEST_DATABASE_URL` at it (skip the stub step: `pnpm exec vitest run tests/db`).

## Optional: supabase-js paths through PostgREST

`tests/db/supabase-js.test.ts` exercises the import writer, the matcher and the `contacts_search` / `merge_contacts` RPC calls with a real supabase-js client. It runs only when a PostgREST sits in front of the test database:

```bash
# 1. PostgREST (static binary from github.com/PostgREST/postgrest/releases)
printf '%s\n' 'db-uri = "postgresql://postgres@127.0.0.1:5432/pulse_test"' 'db-schemas = "public"' 'db-anon-role = "anon"' \
  'jwt-secret = "pulse-test-jwt-secret-pulse-test-jwt-secret"' 'server-port = 3999' > /tmp/pgrst.conf
postgrest /tmp/pgrst.conf &

# 2. supabase-js expects the API under /rest/v1 — this tiny proxy adds the prefix
node supabase/test/rest-proxy.mjs 3998 http://127.0.0.1:3999 &

# 3. A service-role JWT signed with the secret above (HS256, {"role":"service_role"})
export TEST_POSTGREST_URL=http://127.0.0.1:3998
export TEST_SERVICE_JWT=$(node -e 'const c=require("crypto"),b=(o)=>Buffer.from(JSON.stringify(o)).toString("base64url"),h=b({alg:"HS256",typ:"JWT"}),p=b({role:"service_role",exp:4102444800});console.log(h+"."+p+"."+c.createHmac("sha256","pulse-test-jwt-secret-pulse-test-jwt-secret").update(h+"."+p).digest("base64url"))')
pnpm exec vitest run tests/db/supabase-js.test.ts
```

With the same two values you can run the importers against the test database: `NEXT_PUBLIC_SUPABASE_URL=$TEST_POSTGREST_URL SUPABASE_SERVICE_ROLE_KEY=$TEST_SERVICE_JWT pnpm import:sanoflow --file=... --org=<slug> --dry-run`.
