import Link from "next/link";

import { ago } from "@/lib/finance/format";
import type { Provenance } from "@/lib/finance/provenance";

/**
 * Source, refresh time, coverage and unresolved exceptions for the measures on a page, so incomplete coverage stays
 * visible (Integration Blueprint v2, p5).
 */
export function ProvenanceStrip({ p, exceptionsHref }: { p: Provenance; exceptionsHref?: string }) {
  return (
    <section
      aria-label="Where these figures come from"
      className="bg-muted/40 flex flex-col gap-1.5 rounded-md border px-3 py-2 text-xs"
    >
      <p className="flex flex-wrap gap-x-4 gap-y-1">
        <span className="text-muted-foreground font-medium">Sources</span>
        {p.sources.map((s) => (
          <span key={s.key}>
            {s.label}: {s.refreshedAt ? ago(s.refreshedAt) : (s.note ?? "no data yet")}
            {s.refreshedAt && s.note ? ` (${s.note})` : ""}
          </span>
        ))}
      </p>
      {p.coverage.length > 0 && (
        <p className="flex flex-wrap gap-x-4 gap-y-1">
          <span className="text-muted-foreground font-medium">Coverage</span>
          {p.coverage.map((c) => (
            <span key={c.label}>
              {c.label}: {c.from && c.to ? `${c.from} to ${c.to}` : "none yet"}
            </span>
          ))}
        </p>
      )}
      <p className="flex flex-wrap gap-x-4 gap-y-1">
        <span className="text-muted-foreground font-medium">Unresolved</span>
        <span>
          {exceptionsHref ? (
            <Link href={exceptionsHref} className="underline underline-offset-2">
              {p.openExceptions.toLocaleString()} open exceptions
            </Link>
          ) : (
            `${p.openExceptions.toLocaleString()} open exceptions`
          )}
          {p.escalatedExceptions > 0 ? `, ${p.escalatedExceptions.toLocaleString()} escalated` : ""}
        </span>
      </p>
      {p.cautions.map((c) => (
        <p key={c} className="text-amber-700 dark:text-amber-400">
          {c}
        </p>
      ))}
    </section>
  );
}
