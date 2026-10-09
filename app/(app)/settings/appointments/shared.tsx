"use client";

import { useTransition } from "react";
import { toast } from "sonner";

import type { ActionResult } from "./actions";

export const NONE = "__none__";

/** Runs a server action inside a transition and reports the outcome with a toast. */
export function useRun() {
  const [pending, startTransition] = useTransition();
  function run(fn: () => Promise<ActionResult>, after?: () => void) {
    startTransition(async () => {
      const res = await fn();
      if (res.ok) {
        if (res.message) toast.success(res.message);
        after?.();
      } else toast.error(res.error);
    });
  }
  return { pending, run };
}

export function minutesToTime(min: number): string {
  const m = Math.min(Math.max(min, 0), 1440);
  return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function timeToMinutes(value: string, endOfDay = false): number {
  if (endOfDay && value === "00:00") return 1440;
  const [h, m] = value.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

export const WEEKDAYS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 7, label: "Sun" },
] as const;

export function timezoneOptions(): string[] {
  try {
    return (
      (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.(
        "timeZone",
      ) ?? ["Asia/Dubai", "UTC"]
    );
  } catch {
    return ["Asia/Dubai", "UTC"];
  }
}
