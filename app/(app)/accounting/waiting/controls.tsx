"use client";

import { useRouter } from "next/navigation";

import { RunButton } from "@/components/finance/forms";
import type { PostingSource } from "@/lib/accounting/posting/types";

import { retryWaiting } from "./actions";

export function RetryButton({
  kind,
  id,
  reason,
  label = "Try again",
  variant = "outline",
}: {
  kind?: PostingSource;
  id?: string;
  reason?: string;
  label?: string;
  variant?: "default" | "outline" | "ghost";
}) {
  const router = useRouter();
  return (
    <RunButton
      action={() => retryWaiting({ kind, id, reason })}
      variant={variant}
      onDone={() => router.refresh()}
    >
      {label}
    </RunButton>
  );
}
