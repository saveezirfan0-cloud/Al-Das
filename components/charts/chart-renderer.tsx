"use client";

import type { ChartSpec } from "@/lib/reports/types";

import { BarsChart } from "./bars-chart";
import { ChartCard } from "./chart-card";
import { Heatmap } from "./heatmap";
import { HBarList } from "./hbar-list";
import { LineChart } from "./line-chart";

/** Maps a serializable ChartSpec (built on the server) to its component. */
export function ChartRenderer({ spec }: { spec: ChartSpec }) {
  return (
    <ChartCard title={spec.title} description={spec.description}>
      {spec.kind === "bars" && <BarsChart data={spec.data} xKey={spec.xKey} series={spec.series} stacked={spec.stacked} format={spec.format} label={spec.title} />}
      {spec.kind === "line" && <LineChart data={spec.data} xKey={spec.xKey} series={spec.series} format={spec.format} label={spec.title} />}
      {spec.kind === "hbars" && <HBarList items={spec.items} format={spec.format} />}
      {spec.kind === "heatmap" && <Heatmap cells={spec.cells} />}
    </ChartCard>
  );
}
