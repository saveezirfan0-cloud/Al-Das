"use client";

import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";
import { Loader2, Play, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

import { discardDeadLetter, retryDeadLetter, runQueueNow } from "./actions";

export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return (
    <Button variant="outline" size="sm" onClick={() => router.refresh()} aria-label="Refresh now">
      <RefreshCw /> Refresh
    </Button>
  );
}

export function RunNowButton({
  queue,
  label,
  size = "default",
}: {
  queue: string;
  label: string;
  size?: "sm" | "default";
}) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant={size === "sm" ? "ghost" : "secondary"}
      size={size}
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const res = await runQueueNow(queue);
          if (res.ok) toast.success(res.message);
          else toast.error(res.error);
        })
      }
    >
      {pending ? <Loader2 className="animate-spin" /> : <Play />} {label}
    </Button>
  );
}

export function DeadLetterActions({ id }: { id: number }) {
  const [pending, startTransition] = useTransition();
  function run(fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    startTransition(async () => {
      const res = await fn();
      if (res.ok) toast.success(res.message);
      else toast.error(res.error);
    });
  }
  return (
    <div className="flex justify-end gap-1">
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => run(() => retryDeadLetter(id))}
      >
        Retry
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={() => run(() => discardDeadLetter(id))}
      >
        Discard
      </Button>
    </div>
  );
}
