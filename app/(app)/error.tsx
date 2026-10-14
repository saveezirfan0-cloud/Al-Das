"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, Lock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { FORBIDDEN_DIGEST } from "@/lib/auth/can";

/** Keeps the sidebar and top bar alive when one page fails, and says what to do next. */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const forbidden = error.digest === FORBIDDEN_DIGEST;
  useEffect(() => {
    // Only the digest is logged: the message can carry patient data. A missing permission is not a failure.
    if (!forbidden) console.error("[app] page error", { digest: error.digest });
  }, [error, forbidden]);

  if (forbidden) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center">
        <span className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
          <Lock className="size-6" aria-hidden />
        </span>
        <h2 className="text-lg font-semibold">You don’t have access to this page</h2>
        <p className="text-muted-foreground text-sm">
          Your role doesn’t include it. If you need it for your work, ask an administrator to change
          your role.
        </p>
        <Button asChild>
          <Link href="/">Go to my home page</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center">
      <span className="bg-destructive/10 text-destructive flex size-12 items-center justify-center rounded-full">
        <AlertTriangle className="size-6" aria-hidden />
      </span>
      <h2 className="text-lg font-semibold">This page didn’t load</h2>
      <p className="text-muted-foreground text-sm">
        Nothing was lost. Try again, and if it keeps happening tell your administrator
        {error.digest ? ` and quote reference ${error.digest}` : ""}.
      </p>
      <Button onClick={reset}>Try again</Button>
    </div>
  );
}
