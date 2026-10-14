"use client";

import { CircleAlert, CircleCheck, CircleHelp, TriangleAlert } from "lucide-react";

import type { CheckLine, CheckTone } from "@/lib/front-desk/arrival-check";
import { cn } from "@/lib/utils";

const TONE: Record<CheckTone, string> = {
  ok: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
  warn: "bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200",
  alert: "bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300",
  unknown: "bg-muted text-muted-foreground",
};

const ICON: Record<CheckTone, typeof CircleCheck> = {
  ok: CircleCheck,
  warn: TriangleAlert,
  alert: CircleAlert,
  unknown: CircleHelp,
};

const TITLE: Record<CheckLine["key"], string> = {
  insurance: "Insurance card",
  eligibility: "Eligibility",
  consent: "Consent forms",
};

/** The compact check panel under a patient at Arrived: insurance card, eligibility, consent forms. */
export function ArrivalChecks({ lines, loading }: { lines?: CheckLine[]; loading?: boolean }) {
  if (loading && !lines)
    return <p className="text-muted-foreground w-full text-xs">Checking insurance and forms…</p>;
  if (!lines) return null;
  return (
    <ul className="flex w-full flex-wrap gap-1.5" aria-label="Arrival checks">
      {lines.map((l) => {
        const Icon = ICON[l.tone];
        return (
          <li
            key={l.key}
            className={cn(
              "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]",
              TONE[l.tone],
            )}
          >
            <Icon className="size-3" aria-hidden />
            <span className="sr-only">{TITLE[l.key]}: </span>
            {l.label}
          </li>
        );
      })}
    </ul>
  );
}
