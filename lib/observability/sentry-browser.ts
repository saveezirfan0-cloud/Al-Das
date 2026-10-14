import * as Sentry from "@sentry/nextjs";

import { sentryOptions } from "@/lib/observability/sentry-options";

/**
 * The browser SDK. Imported on demand (instrumentation-client.ts, app/global-error.tsx) and only when
 * NEXT_PUBLIC_SENTRY_DSN was set at build time, so builds without it never download it and the first-load bundle
 * does not carry it.
 */
let started = false;

export function startBrowserSentry(dsn: string): typeof Sentry {
  if (!started) {
    started = true;
    Sentry.init({
      ...sentryOptions(dsn, process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV),
      // No session replay, ever: it would record patient screens.
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
    });
  }
  return Sentry;
}
