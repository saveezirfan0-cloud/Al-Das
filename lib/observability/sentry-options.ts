import {
  scrubBreadcrumb,
  scrubEvent,
  type ScrubbableBreadcrumb,
  type ScrubbableEvent,
} from "@/lib/observability/scrub";

/**
 * Shared Sentry init options (server, edge and browser). Only called when a DSN is set: without one, Pulse never imports
 * or starts the SDK (instrumentation.ts, instrumentation-client.ts).
 *
 * Health data rules (CLAUDE.md 9 and 10): no default PII, every event, transaction and breadcrumb is scrubbed
 * (lib/observability/scrub.ts), a low trace sample rate, and no session replay.
 */
export const TRACES_SAMPLE_RATE = 0.1;

// Sentry's event and breadcrumb types are interfaces without index signatures; the scrubbers work on the same shape.
const beforeSend = <E>(event: E): E =>
  scrubEvent(event as unknown as ScrubbableEvent) as unknown as E;
const beforeBreadcrumb = <B>(crumb: B): B | null =>
  scrubBreadcrumb(crumb as unknown as ScrubbableBreadcrumb) as unknown as B | null;

export function sentryOptions(dsn: string, environment: string | undefined) {
  return {
    dsn,
    environment: environment || "development",
    sendDefaultPii: false,
    tracesSampleRate: TRACES_SAMPLE_RATE,
    // Local variables in stack frames could hold message text or a phone number.
    includeLocalVariables: false,
    maxBreadcrumbs: 50,
    beforeSend,
    beforeSendTransaction: beforeSend,
    beforeBreadcrumb,
  };
}
