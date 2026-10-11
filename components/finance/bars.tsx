import { moneyCompact } from "@/lib/finance/format";

/**
 * Server-rendered grouped bars (no chart library, no client JS). Every value is
 * also in the table next to it, so this is a visual aid, not the only source.
 */
export function GroupedBars({
  series,
  labels,
}: {
  series: Array<{ label: string; a: number; b: number }>;
  labels: { a: string; b: string };
}) {
  const max = Math.max(1, ...series.flatMap((s) => [s.a, s.b]));
  return (
    <figure className="flex flex-col gap-2" aria-label={`${labels.a} and ${labels.b} by month`}>
      <div className="flex h-40 items-end gap-2 overflow-x-auto">
        {series.map((s) => (
          <div key={s.label} className="flex min-w-10 flex-1 flex-col items-center gap-1">
            <div className="flex h-32 w-full items-end justify-center gap-1">
              <div
                className="bg-primary w-3 rounded-t"
                style={{ height: `${Math.max(2, (s.a / max) * 100)}%` }}
                title={`${labels.a}: ${moneyCompact(s.a)}`}
              />
              <div
                className="w-3 rounded-t bg-emerald-500"
                style={{ height: `${Math.max(2, (s.b / max) * 100)}%` }}
                title={`${labels.b}: ${moneyCompact(s.b)}`}
              />
            </div>
            <span className="text-muted-foreground text-[10px]">{s.label.slice(2)}</span>
          </div>
        ))}
      </div>
      <figcaption className="text-muted-foreground flex gap-4 text-xs">
        <span className="flex items-center gap-1">
          <span className="bg-primary inline-block size-2 rounded-sm" /> {labels.a}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block size-2 rounded-sm bg-emerald-500" /> {labels.b}
        </span>
      </figcaption>
    </figure>
  );
}

/** Horizontal bars for a few labelled amounts (ageing buckets, denial reasons). */
export function HorizontalBars({
  rows,
  tone = "primary",
}: {
  rows: Array<{ label: string; value: number; note?: string }>;
  tone?: "primary" | "danger";
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((r) => (
        <li key={r.label} className="grid grid-cols-[8rem_1fr_6rem] items-center gap-3 text-sm">
          <span className="truncate" title={r.label}>
            {r.label}
          </span>
          <span className="bg-muted h-2 rounded">
            <span
              className={`block h-2 rounded ${tone === "danger" ? "bg-destructive" : "bg-primary"}`}
              style={{ width: `${(r.value / max) * 100}%` }}
            />
          </span>
          <span className="text-right tabular-nums">
            {moneyCompact(r.value)}
            {r.note && <span className="text-muted-foreground block text-[10px]">{r.note}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}
