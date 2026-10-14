// Sentry for the edge runtime (middleware). Loaded by instrumentation.ts only when SENTRY_DSN is set.
import * as Sentry from "@sentry/nextjs";

import { sentryOptions } from "@/lib/observability/sentry-options";

const dsn = process.env.SENTRY_DSN;
if (dsn) {
  Sentry.init(sentryOptions(dsn, process.env.VERCEL_ENV ?? process.env.NODE_ENV));
}
