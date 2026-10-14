/**
 * The Sentry DSN for server and edge. A DSN is not a secret (it only lets an app send events), so when only the
 * public one is set (the Vercel Sentry integration creates NEXT_PUBLIC_SENTRY_DSN) the server uses it too.
 */
export function serverSentryDsn(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return env.SENTRY_DSN || env.NEXT_PUBLIC_SENTRY_DSN || undefined;
}
