"use client";

import NextError from "next/error";
import { useEffect } from "react";

import { reportClientError } from "@/lib/observability/client";

/**
 * Last-resort error page (the root layout itself failed). Same screen as Next's default; it also reports the error to
 * Sentry when NEXT_PUBLIC_SENTRY_DSN is set (scrubbed, see lib/observability/scrub.ts).
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    reportClientError(error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <NextError statusCode={0} />
      </body>
    </html>
  );
}
