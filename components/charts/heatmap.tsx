import { formatNumber } from "@/lib/reports/format";

import { EmptyChart } from "./chart-card";

const DAYS = [
  { dow: 1, label: "Mon" },
  { dow: 2, label: "Tue" },
  { dow: 3, label: "Wed" },
  { dow: 4, label: "Thu" },
  { dow: 5, label: "Fri" },
  { dow: 6, label: "Sat" },
  { dow: 0, label: "Sun" },
];

const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;

/**
 * Weekday x hour grid. Sequential, one hue: the emptiest cell recedes into the surface, the busiest
 * is the full step. Every cell has a text tooltip; the report page also offers the data as a table.
 */
export function Heatmap({ cells }: { cells: Array<{ dow: number; hour: number; value: number }> }) {
  if (cells.length === 0) return <EmptyChart />;
  const byKey = new Map(cells.map((c) => [`${c.dow}-${c.hour}`, c.value]));
  const max = Math.max(...cells.map((c) => c.value), 1);
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[34rem]" role="table" aria-label="Patient messages by weekday and hour">
        <div className="grid grid-cols-[2.5rem_repeat(24,minmax(0,1fr))] gap-0.5 text-[10px]" role="row">
          <span />
          {Array.from({ length: 24 }, (_, h) => (
            <span key={h} className="text-muted-foreground text-center" role="columnheader">
              {h % 3 === 0 ? String(h).padStart(2, "0") : ""}
            </span>
          ))}
        </div>
        {DAYS.map((d) => (
          <div key={d.dow} className="mt-0.5 grid grid-cols-[2.5rem_repeat(24,minmax(0,1fr))] gap-0.5" role="row">
            <span className="text-muted-foreground self-center text-xs" role="rowheader">
              {d.label}
            </span>
            {Array.from({ length: 24 }, (_, h) => {
              const v = byKey.get(`${d.dow}-${h}`) ?? 0;
              const pct = v > 0 ? 14 + (v / max) * 86 : 0;
              return (
                <span
                  key={h}
                  role="cell"
                  title={`${d.label} ${hourLabel(h)}: ${formatNumber(v)} ${v === 1 ? "message" : "messages"}`}
                  aria-label={`${d.label} ${hourLabel(h)}: ${v}`}
                  className="bg-muted/50 h-6 rounded-[3px]"
                  style={v > 0 ? { background: `color-mix(in oklab, var(--viz-seq) ${pct}%, var(--card))` } : undefined}
                />
              );
            })}
          </div>
        ))}
        <div className="text-muted-foreground mt-3 flex items-center gap-2 text-xs">
          Fewer
          <span
            aria-hidden
            className="h-2 w-24 rounded-full"
            style={{ background: "linear-gradient(to right, color-mix(in oklab, var(--viz-seq) 14%, var(--card)), var(--viz-seq))" }}
          />
          More (peak {formatNumber(max)})
        </div>
      </div>
    </div>
  );
}
