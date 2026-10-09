"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { formatValue, type ValueFormat } from "@/lib/reports/format";

import { EmptyChart } from "./chart-card";
import { Legend } from "./legend";
import { AXIS_TICK, seriesColor, shortDay } from "./theme";
import { ChartTooltip } from "./tooltip";

type Row = Record<string, string | number | null>;

/**
 * Columns per x value. Thin (<= 24px), 4px rounded data end, square at the baseline, a 2px surface
 * gap between touching marks (stack segments and neighbours), hairline solid grid.
 */
export function BarsChart({
  data,
  xKey,
  series,
  stacked = false,
  format = "number",
  label,
  height = 240,
}: {
  data: Row[];
  xKey: string;
  series: Array<{ key: string; label: string }>;
  stacked?: boolean;
  format?: ValueFormat;
  label: string;
  height?: number;
}) {
  const hasData = data.some((d) => series.some((s) => Number(d[s.key] ?? 0) > 0));
  if (!hasData) return <EmptyChart />;
  const dense = data.length > 14;
  return (
    <figure aria-label={label} className="m-0">
      <Legend series={series} />
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={2} barCategoryGap="30%">
            <CartesianGrid vertical={false} stroke="var(--viz-grid)" strokeDasharray="" />
            <XAxis dataKey={xKey} tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: "var(--viz-grid)" }} tickFormatter={shortDay} interval={dense ? "preserveStartEnd" : 0} minTickGap={16} />
            <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} width={40} tickFormatter={(v) => formatValue(v, format)} />
            <Tooltip
              cursor={{ fill: "var(--accent)", opacity: 0.5 }}
              content={<ChartTooltip series={series} format={format} labelFormatter={shortDay} />}
            />
            {series.map((s, i) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                stackId={stacked ? "stack" : undefined}
                fill={seriesColor(i)}
                maxBarSize={24}
                // stacked: only the top segment has a rounded data end
                radius={!stacked || i === series.length - 1 ? [4, 4, 0, 0] : 0}
                stroke="var(--card)"
                strokeWidth={stacked ? 2 : 0}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
