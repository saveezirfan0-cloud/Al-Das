"use client";

import { formatValue, type ValueFormat } from "@/lib/reports/format";

type Entry = { dataKey?: string | number; name?: string | number; value?: unknown; color?: string };

/** Shared tooltip: a small card, swatch + label + value, all in text tokens. */
export function ChartTooltip({
  active,
  payload,
  label,
  labelFormatter,
  format = "number",
  series,
}: {
  active?: boolean;
  payload?: Entry[];
  label?: unknown;
  labelFormatter?: (l: unknown) => string;
  format?: ValueFormat;
  series: Array<{ key: string; label: string }>;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-popover text-popover-foreground rounded-md border px-3 py-2 text-xs shadow-md">
      <div className="mb-1 font-medium">{labelFormatter ? labelFormatter(label) : String(label ?? "")}</div>
      <ul className="space-y-0.5">
        {payload.map((p) => {
          const name = series.find((s) => s.key === p.dataKey)?.label ?? String(p.name ?? p.dataKey);
          return (
            <li key={String(p.dataKey)} className="flex items-center gap-2">
              <span aria-hidden className="inline-block size-2.5 rounded-sm" style={{ background: p.color }} />
              <span className="text-muted-foreground">{name}</span>
              <span className="ml-auto pl-3 font-medium tabular-nums">{formatValue(p.value, format)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
