"use client";

import { CartesianGrid, Line, LineChart as RLineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { formatValue, type ValueFormat } from "@/lib/reports/format";

import { EmptyChart } from "./chart-card";
import { Legend } from "./legend";
import { AXIS_TICK, seriesColor, shortDay } from "./theme";
import { ChartTooltip } from "./tooltip";

type Row = Record<string, string | number | null>;

/** 2px lines, round joins; markers appear on hover (>= 8px with a 2px surface ring); crosshair + tooltip. */
export function LineChart({
  data,
  xKey,
  series,
  format = "number",
  label,
  height = 240,
}: {
  data: Row[];
  xKey: string;
  series: Array<{ key: string; label: string }>;
  format?: ValueFormat;
  label: string;
  height?: number;
}) {
  if (!data.some((d) => series.some((s) => Number(d[s.key] ?? 0) > 0))) return <EmptyChart />;
  return (
    <figure aria-label={label} className="m-0">
      <Legend series={series} />
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <RLineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--viz-grid)" strokeDasharray="" />
            <XAxis dataKey={xKey} tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: "var(--viz-grid)" }} tickFormatter={shortDay} interval="preserveStartEnd" minTickGap={24} />
            <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} width={40} tickFormatter={(v) => formatValue(v, format)} />
            <Tooltip
              cursor={{ stroke: "var(--viz-grid)", strokeWidth: 1 }}
              content={<ChartTooltip series={series} format={format} labelFormatter={shortDay} />}
            />
            {series.map((s, i) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                stroke={seriesColor(i)}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                dot={false}
                activeDot={{ r: 5, stroke: "var(--card)", strokeWidth: 2, fill: seriesColor(i) }}
                isAnimationActive={false}
              />
            ))}
          </RLineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
