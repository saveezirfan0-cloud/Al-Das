// Browser error reporting. A no-op unless NEXT_PUBLIC_SENTRY_DSN was set at build time; the SDK then loads after the
// page, outside the first-load bundle (lib/observability/client.ts).
import { loadBrowserSentry } from "@/lib/observability/client";

type SentryModule = NonNullable<Awaited<ReturnType<typeof loadBrowserSentry>>>;

let sentry: SentryModule | null = null;
if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  void loadBrowserSentry().then((s) => {
    sentry = s;
  });
}

export function onRouterTransitionStart(href: string, navigationType: string) {
  sentry?.captureRouterTransitionStart(href, navigationType);
}
