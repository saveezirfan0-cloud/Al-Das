# Hosting: Vercel + Supabase (October 2026 move)

Pulse moved to a new Vercel team and a new Supabase project (created through the Vercel
Supabase integration). The code and this repository are unchanged; this page records the
new wiring and the one-time steps.

## Where things are
| | |
|---|---|
| Vercel team / project | `al-das` / `al-das` (`prj_fLnQeCclAfLsxpYblDu333hCkwan`), Git: `saveezirfan0-cloud/Al-Das`, production branch `main` |
| Production URL (`APP_URL`) | `https://al-das-al-das.vercel.app` |
| Supabase project | `dljdxwgmstxfxyhbpntz` (`https://dljdxwgmstxfxyhbpntz.supabase.co`), region us-east-1, managed through Vercel |
| Deployment protection | Vercel Authentication on previews and generated deployment URLs only; the production domain is public (Meta webhooks, pg_cron, sign-in). |

## Environment variables (Vercel)
- Set by the Supabase integration: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (the names the code reads) plus `POSTGRES_*` and others the code ignores.
- Set by the Resend integration: `RESEND_API_KEY`, `RESEND_EMAIL_DOMAIN`. Without `RESEND_FROM` the sender is `Pulse <no-reply@RESEND_EMAIL_DOMAIN>` (`resendFrom()` in `lib/env.ts`).
- Set by hand (Production): `APP_URL`, `JOB_SECRET`, `ENCRYPTION_KEY` (base64 of 32 bytes). Optional ones (Meta, Unite, Anthropic, VAPID) are listed in `CLAUDE.md`.
- A changed variable reaches the app only after a redeploy.

## Builds
- Vercel's build machine has 2 cores and 8 GB. With the Sentry source-map upload on, `next build`'s own type and lint pass ran out of memory (14 Oct), so on Vercel (`VERCEL=1`) the build skips it (`next.config.ts`). The Sentry source-map upload itself adds about 2.4 GB (peak 7.4 GB measured with it, 4.5 GB without), so on Vercel the build also turns on webpack's memory optimisations, keeps page-data work to one worker and uploads source maps once after the build (`useRunAfterProductionCompileHook`), which measured 6.9 GB. On 14 Oct, after Phases B to F, the same build measured 8.1 GB with the upload and 4.6 GB without, and Vercel killed it; `vercel.json` now runs the Vercel build with `NODE_OPTIONS=--max-old-space-size=4096` (Node collects earlier instead of growing to the machine's limit), which measured 6.9 GB with the upload. If builds still run out of memory, turn the upload off by removing `SENTRY_AUTH_TOKEN` from the Vercel build environment: error reporting keeps working, only stack traces stay minified. GitHub CI still runs `pnpm typecheck`, `pnpm lint` and a full `pnpm build` on every pull request; merge to `main` only through a pull request with green CI.

## Database
- Migrations reach production through `.github/workflows/db-migrate.yml` (`supabase db push`): on every merge to `main` that touches `supabase/migrations/`, or by hand under Actions, Database migrations, Run workflow. It needs the repository secret `SUPABASE_DB_URL` (Supabase, Connect, **Session pooler** URI with the database password).
- Vault: `app_url` and `finance_ref_key` are set. `job_secret` must equal Vercel's `JOB_SECRET`:
  ```sql
  select vault.create_secret('<JOB_SECRET from Vercel>', 'job_secret');
  ```
  Until it exists, the `pulse:*` cron jobs do nothing. The new project starts with no data; `finance_ref_key` is new, so finance `patient_ref` hashes do not match the old project's.

## Supabase Auth (dashboard, Authentication)
1. URL Configuration: Site URL `https://al-das-al-das.vercel.app`; Redirect URLs `https://al-das-al-das.vercel.app/**` and `http://localhost:3000/**`.
2. Sign In / Providers, Email: turn off "Allow new users to sign up". Staff join through Pulse invites, which create users with the admin API.
3. Emails, SMTP Settings: custom SMTP through Resend (host `smtp.resend.com`, port `465`, user `resend`, password = a Resend API key, sender `no-reply@<your Resend domain>`). The built-in sender only reaches the project's own team members and is limited to a few e-mails an hour.
4. Emails, Templates, Magic Link: subject `Your Pulse sign-in link`, body = `supabase/templates/magic_link.html`. This is the only Supabase e-mail Pulse triggers (sign-in by link). Invites and alerts are sent by Pulse through Resend.

## First sign-in
Authentication, Users, Add user (e-mail + password, auto-confirm). Set `ALLOW_WORKSPACE_CREATION=true` in Vercel, redeploy, sign in, create the workspace at `/onboarding`, then remove the variable and redeploy. Settings, System health should show every `pulse:*` cron row `succeeded` within a minute. Then follow the "Set up your clinic" card on the dashboard (or Settings, Go-live checklist): first branch, services, doctors and hours, invite the team.
