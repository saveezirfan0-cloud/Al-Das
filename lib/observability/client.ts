/**
 * Browser error reporting without the SDK in the first-load bundle: the SDK is fetched on demand, and only when
 * NEXT_PUBLIC_SENTRY_DSN was set at build time (otherwise these are no-ops and the chunk is never requested).
 */
type SentryModule = typeof import("@sentry/nextjs");

let loading: Promise<SentryModule | null> | null = null;

export function loadBrowserSentry(): Promise<SentryModule | null> {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn) return Promise.resolve(null);
  loading ??= import("@/lib/observability/sentry-browser")
    .then((m) => m.startBrowserSentry(dsn))
    .catch(() => null);
  return loading;
}

/** Reports an error caught by an error boundary (scrubbed like every other event). */
export function reportClientError(error: unknown): void {
  void loadBrowserSentry().then((s) => s?.captureException(error));
}
