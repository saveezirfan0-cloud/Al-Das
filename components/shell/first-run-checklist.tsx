"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { firstRunStorageKey, type FirstRun } from "@/lib/help/first-steps";

import { OPEN_PALETTE_EVENT } from "./command-palette";

function readDismissed(key: string): boolean {
  try {
    return localStorage.getItem(firstRunStorageKey(key)) === "1";
  } catch {
    return false; // blocked storage: show the card; dismissing then lasts for this visit only
  }
}

function saveDismissed(key: string) {
  try {
    localStorage.setItem(firstRunStorageKey(key), "1");
  } catch {
    // private window or blocked storage: nothing to remember
  }
}

/**
 * The first-run checklist card (Phase D): a role's first steps (lib/help/first-steps.ts), hidden once dismissed on
 * this device. Renders nothing until it has read the device's choice, so it never flashes for people who dismissed it.
 */
export function FirstRunChecklist({ firstRun }: { firstRun: FirstRun }) {
  const [hidden, setHidden] = useState<boolean | null>(null);
  useEffect(() => setHidden(readDismissed(firstRun.key)), [firstRun.key]);
  if (hidden !== false || firstRun.steps.length === 0) return null;
  return (
    <section
      aria-labelledby="first-run-title"
      className="bg-card relative rounded-xl border p-4 shadow-sm print:hidden"
    >
      <div className="flex items-start gap-3">
        <Sparkles className="text-brand-accent mt-0.5 size-5 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <h3 id="first-run-title" className="text-sm font-semibold">
            {firstRun.title}
          </h3>
          <ol className="mt-2 flex flex-col gap-1.5 text-sm">
            {firstRun.steps.map((s, i) => (
              <li key={s.id} className="flex gap-2">
                <span className="text-muted-foreground w-4 shrink-0 tabular-nums">{i + 1}.</span>
                {s.palette ? (
                  <button
                    type="button"
                    onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE_EVENT))}
                    className="text-left hover:underline"
                  >
                    {s.text}
                  </button>
                ) : (
                  <Link
                    href={s.href}
                    className="group inline-flex items-start gap-1 hover:underline"
                  >
                    <span>{s.text}</span>
                    <ArrowRight
                      className="text-muted-foreground mt-0.5 size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 motion-reduce:transition-none"
                      aria-hidden
                    />
                  </Link>
                )}
              </li>
            ))}
          </ol>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground shrink-0"
          aria-label="Hide these first steps on this device"
          onClick={() => {
            saveDismissed(firstRun.key);
            setHidden(true);
          }}
        >
          <X aria-hidden />
        </Button>
      </div>
    </section>
  );
}
