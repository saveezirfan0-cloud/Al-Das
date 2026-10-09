import { formatValue, type ValueFormat } from "@/lib/reports/format";

import { EmptyChart } from "./chart-card";

/**
 * Ranked horizontal bars as plain HTML: label, thin bar, value at the tip. One series, so one color
 * (slot 1) and no legend. Bars are value-proportional from a single baseline.
 */
export function HBarList({ items, format = "number" }: { items: Array<{ label: string; value: number }>; format?: ValueFormat }) {
  if (items.length === 0 || items.every((i) => i.value === 0)) return <EmptyChart />;
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <ul className="flex flex-col gap-2.5">
      {items.map((i) => (
        <li key={i.label} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 text-sm sm:grid-cols-[minmax(0,14rem)_1fr_auto]">
          <span className="truncate" title={i.label}>
            {i.label}
          </span>
          <span className="bg-muted/60 block h-2 overflow-hidden rounded-full" aria-hidden>
            <span className="block h-full rounded-full" style={{ width: `${(i.value / max) * 100}%`, background: "var(--viz-1)" }} />
          </span>
          <span className="min-w-10 text-right font-medium tabular-nums">{formatValue(i.value, format)}</span>
        </li>
      ))}
    </ul>
  );
}
