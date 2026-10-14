// Sentry for the edge runtime (middleware). Loaded by instrumentation.ts only when a DSN is set (lib/observability/dsn.ts).
import * as Sentry from "@sentry/nextjs";

import { sentryOptions } from "@/lib/observability/sentry-options";
import { serverSentryDsn } from "./lib/observability/dsn";

const dsn = serverSentryDsn();
if (dsn) {
  Sentry.init(sentryOptions(dsn, process.env.VERCEL_ENV ?? process.env.NODE_ENV));
}
