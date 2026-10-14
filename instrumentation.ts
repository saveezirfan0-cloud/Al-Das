import type { Instrumentation } from "next";

import { serverSentryDsn } from "./lib/observability/dsn";

/**
 * Error reporting (Sentry). Everything here is a no-op unless a DSN is set (SENTRY_DSN, else NEXT_PUBLIC_SENTRY_DSN): the SDK is not even imported.
 * PHI scrubbing lives in lib/observability/scrub.ts and runs on every event before it leaves the server.
 */
export async function register() {
  if (!serverSentryDsn()) return;
  if (process.env.NEXT_RUNTIME === "nodejs") await import("./sentry.server.config");
  if (process.env.NEXT_RUNTIME === "edge") await import("./sentry.edge.config");
}

/** Errors thrown in server components, route handlers, server actions and middleware. */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (!serverSentryDsn()) return;
  const { captureRequestError } = await import("@sentry/nextjs");
  captureRequestError(error, request, context);
};
