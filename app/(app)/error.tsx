"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";

/** Keeps the sidebar and top bar alive when one page fails, and says what to do next. */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Only the digest is logged: the message can carry patient data.
    console.error("[app] page error", { digest: error.digest });
  }, [error]);

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
