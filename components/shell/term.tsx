"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { GLOSSARY, type GlossaryKey } from "@/lib/help/glossary";

/**
 * A finance or accounting word with its plain-words meaning on hover or keyboard focus (Phase D):
 * `<Term k="accrual" />` shows "Accrual", `<Term k="debit">Dr</Term>` shows "Dr". Meanings live in lib/help/glossary.ts.
 * The word is a focusable button so keyboard and screen-reader users get the same explanation.
 */
export function Term({ k, children }: { k: GlossaryKey; children?: React.ReactNode }) {
  const entry = GLOSSARY[k];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="decoration-muted-foreground/60 focus-visible:ring-ring cursor-help rounded-sm underline decoration-dotted underline-offset-4 outline-none focus-visible:ring-2"
        >
          {children ?? entry.term}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-left font-normal normal-case">
        <span className="font-medium">{entry.term}:</span> {entry.meaning}
      </TooltipContent>
    </Tooltip>
  );
}
