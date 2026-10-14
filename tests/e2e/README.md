# End-to-end tests (Playwright)

Two suites live here:

| Suite | Files | Needs | Runs |
|---|---|---|---|
| Signed-out | `tests/e2e/*.spec.ts` | nothing but the dev server | `pnpm e2e` |
| Signed-in | `tests/e2e/signed-in/*` | Docker, the Supabase CLI, a seeded local stack | `E2E_SIGNED_IN=1 pnpm e2e` |

Without `E2E_SIGNED_IN=1` the signed-in projects are not even loaded (and every signed-in file also skips itself), so
`pnpm e2e` on a machine without a stack behaves exactly as before.

## What the signed-in suite covers

It signs in through the real login form (password tab) as three roles on the system presets
(`lib/auth/permissions.ts`), saves each session (`signed-in/auth.setup.ts`), then:

| Spec | Role | Checks |
|---|---|---|
| `shell.spec.ts` | Admin | rail areas render; pointing at CRM opens its flyout; the pin docks the panel (unpin, pin again); the branch switcher is hidden with one branch |
| `front-desk.spec.ts` | Receptionist | today's board shows the seeded appointment; Arrived → With doctor → Done updates the line and the row; the walk-in dialog opens |
| `appointments.spec.ts` | Admin | books the first free slot through the New appointment drawer, sees it in the resource day grid, moves it to the last free slot |
| `inbox.spec.ts` | Admin | opens the seeded conversation, adds an internal note; sends a WhatsApp reply, drains `outbound_priority` through `/api/jobs` and checks the training marker (`training:` id, `payload.training`, "Sent" tick) |
| `contacts.spec.ts` | Agent | the Patients list shows the seeded patient and the record drawer opens |
| `permissions.spec.ts` | all three | Admin opens Settings, Users; the Receptionist gets the no-access page there; the Agent is sent home from `/finance` and refused on `/finance/claims` |

Not covered yet (docs/34 Phase A): a synthetic Diligence or bank upload, and the tax invoice PDF.

## The seeded workspace

`pnpm e2e:seed` (`fixtures/seed.ts`) creates, on every run, three NEW logins (`<role>-<run id>@e2e.invalid`, random
passwords) and a NEW training workspace (`e2e-<run id>`, `orgs.is_training = true`) with one branch, one doctor working
08:00 to 20:00 every day, a 30-minute service, four synthetic patients (`Layla Demo-91` …, numbers
+44 7700 900091 … 900094), today's appointment, a WhatsApp channel with one open conversation, a team and a task. It
never edits or empties anything that already exists, and it refuses any Supabase URL that is not on this machine.

It writes `tests/e2e/.auth/seed.json` (ids, dates and the throwaway passwords) next to the saved sessions. The folder is
git-ignored. Because every seed is a fresh workspace, re-running only the specs reuses the last seed; the specs are
written to cope (the front desk spec resets its appointment first, bookings take the next free slot, notes and
replies carry a timestamp).

Nothing reaches a live service: the stack is local, training mode keeps WhatsApp sends on screen, and the test server
has no Meta, Unite or provider credentials. Data is synthetic only (CLAUDE.md rule 10).

## Run it locally

You need Docker running and the Supabase CLI.

```bash
supabase start                                   # applies supabase/migrations (and the dev seed.sql; harmless)
set -a; . <(supabase status -o env | grep -E '^[A-Z_][A-Z0-9_]*='); set +a
export NEXT_PUBLIC_SUPABASE_URL="$API_URL" \
       NEXT_PUBLIC_SUPABASE_ANON_KEY="$ANON_KEY" \
       SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY"
pnpm e2e:seed                                    # new logins + workspace, writes tests/e2e/.auth/seed.json
E2E_SIGNED_IN=1 pnpm e2e                         # dev server on :3100 (first page compiles are slow)
```

Faster and closer to CI, against a production build:

```bash
pnpm build && E2E_SIGNED_IN=1 E2E_SERVER=start pnpm e2e
```

Useful variations: `E2E_SIGNED_IN=1 pnpm e2e --project=setup --project=signed-in` (signed-in only),
`--headed`, `--ui`, `E2E_PORT=3200`. Locally an already running server on the port is reused, so stop a `pnpm dev`
that was started with other Supabase variables. `supabase db reset` clears old e2e workspaces.

## In CI

`.github/workflows/e2e.yml` ("End-to-end (signed in)", on pull requests and by hand; not a required check):

1. installs the Supabase CLI (`supabase/setup-cli@v1`) and starts the stack in the background with
   `supabase/config.toml` and `supabase/migrations` (the dev `seed.sql` switched off, Studio, imgproxy, edge runtime,
   logging and the pooler excluded) while `pnpm install` and the Playwright Chromium install run;
2. waits for it and exports `API_URL` and the keys from `supabase status -o env` as `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`;
3. builds the app (`PULSE_SKIP_BUILD_CHECKS=1`: the checks job already typechecks and lints; `.next/cache` is cached);
4. runs `pnpm e2e:seed`, then `pnpm e2e` with `E2E_SIGNED_IN=1 E2E_SERVER=start` (signed-out and signed-in suites,
   one retry in CI);
5. uploads the HTML report and traces when something fails.

## Writing a spec

- Put it in `tests/e2e/signed-in/`, start with `test.skip(!signedIn, SIGNED_IN_SKIP_REASON)` and pick a role with
  `test.use({ storageState: authFile("admin" | "receptionist" | "agent") })`.
- Read ids and names from `loadSeed()`; add what you need to `fixtures/seed.ts` (synthetic, demo conventions).
- Select by role and accessible name or label. Add a `data-testid` only where nothing has an accessible name.
- Use `adminDb()` only to set up or check state on the local stack, never to do what the screen should do.
- Never reach a provider: no real credentials in the test server, training mode for anything that would message.
